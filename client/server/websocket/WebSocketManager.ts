import type http from "http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import { verifyToken } from "../auth/jwt.js";
import { ServerState } from "../core/ServerState.js";
import { handleClientMessage } from "./handlers.js";

export interface WSClient {
  ws: WebSocket;
  sessionId: string;
  lastHeartbeat: Date;
}

const HEARTBEAT_INTERVAL_MS = 60000; // Send heartbeat every 60 seconds

/**
 * WebSocket server manager
 * Handles client connections, message routing, and heartbeat mechanism
 */
export class WebSocketManager {
  private static instance: WebSocketManager | null = null;
  private wss: WebSocketServer;
  private clients = new Map<string, WSClient>();

  // Multiplayer: Map<sceneRoomId, Map<userId, WSClient>>
  private multiplayerClients = new Map<string, Map<string, WSClient>>();

  // Room-level (waiting lobby): Map<roomId, Map<userId, WSClient>>
  private roomClients = new Map<string, Map<string, WSClient>>();

  // Simulation viewers: Map<sessionId, Map<clientId, WSClient>>
  private simulationClients: Map<string, Map<string, WSClient>> = new Map();

  constructor(server: http.Server) {
    WebSocketManager.instance = this;
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
    });

    this.setupConnectionHandling();
    this.startHeartbeat();
  }

  /**
   * Setup WebSocket connection event handlers
   */
  private setupConnectionHandling(): void {
    this.wss.on("connection", async (ws: WebSocket, req) => {
      const sessionId = this.extractSessionId(req);
      const token = this.extractToken(req);
      const sceneRoomId = this.extractParam(req, "sceneRoomId");
      const roomId = this.extractParam(req, "roomId");
      const connectionType = this.extractParam(req, "type");

      // Simulation viewer connection: no auth required, register and return early
      if (connectionType === "simulation" && sessionId) {
        const clientId = randomUUID();
        const client: WSClient = { ws, sessionId, lastHeartbeat: new Date() };
        this.registerSimulationClient(sessionId, clientId, client);

        ws.send(JSON.stringify({ type: "connected", sessionId, timestamp: new Date().toISOString() }));

        ws.on("close", () => {
          this.removeSimulationClient(sessionId, clientId);
        });
        ws.on("error", (error) => {
          console.error(`[WebSocket] Simulation viewer error for session ${sessionId}:`, error);
        });
        return;
      }

      const creds = token ? this.verifyTokenCreds(token) : null;
      const userId = creds?.userId ?? null;
      const email = creds?.email ?? null;

      if (!userId || !email) {
        ws.close();
        return;
      }

      // Room-level connection (waiting lobby): roomId but no sessionId
      if (roomId && !sessionId) {
        const isMember = await this.isRoomMember(roomId, userId);
        if (!isMember) {
          ws.close();
          return;
        }

        const clientKey = `room:${roomId}:${userId}`;
        console.log(`🔌 [WebSocket] Room client connected: ${clientKey}`);
        this.handleNewConnection(ws, clientKey);

        const client = this.clients.get(clientKey);
        if (client) {
          this.registerRoomClient(roomId, userId, client);
          ws.on("close", () => {
            const current = this.roomClients.get(roomId)?.get(userId);
            if (current && current.ws === ws) {
              this.removeRoomClient(roomId, userId);
            }
          });
        }
        return;
      }

      if (!sessionId) {
        ws.close();
        return;
      }

      const owned = await this.isSessionOwnedByUser(sessionId, userId, email);
      if (!owned) {
        ws.close();
        return;
      }

      // For multiplayer, use sessionId:userId as key so multiple players can coexist
      const isMultiplayer = sessionId.startsWith("multi-");
      const clientKey = isMultiplayer ? `${sessionId}:${userId}` : sessionId;

      console.log(`🔌 [WebSocket] Client connected: ${clientKey}${sceneRoomId ? ` sceneRoom=${sceneRoomId}` : ""}`);

      this.handleNewConnection(ws, clientKey);

      // Register as multiplayer client if sceneRoomId provided
      if (sceneRoomId) {
        const client = this.clients.get(clientKey);
        if (client) {
          this.registerMultiplayerClient(sceneRoomId, userId, client);

          // Also register for all other active scene rooms so client gets cross-room events
          if (roomId) {
            this.registerMultiplayerClientForAllRooms(roomId, userId, client);
          }

          // On close, remove multiplayer registration only if this ws is still the current one
          ws.on("close", () => {
            const current = this.multiplayerClients.get(sceneRoomId)?.get(userId);
            if (current && current.ws === ws) {
              this.removeMultiplayerClient(sceneRoomId, userId);
            }
          });
        }
      }
    });
  }

  /**
   * Handle new WebSocket connection
   * @param ws - WebSocket connection
   * @param sessionId - Session ID for this connection
   */
  private handleNewConnection(ws: WebSocket, sessionId: string): void {
    // Close existing connection for this sessionId if any
    const existingClient = this.clients.get(sessionId);
    if (existingClient && existingClient.ws.readyState === WebSocket.OPEN) {
      console.log(
        `⚠️  [WebSocket] Closing existing connection for session ${sessionId}`
      );
      // Remove from map first to prevent race condition
      this.clients.delete(sessionId);
      existingClient.ws.close();
    }

    // Store client connection
    const client: WSClient = {
      ws,
      sessionId,
      lastHeartbeat: new Date(),
    };
    this.clients.set(sessionId, client);

    // Send welcome message
    ws.send(
      JSON.stringify({
        type: "connected",
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
      })
    );

    // Setup event handlers
    ws.on("message", (data: Buffer) =>
      handleClientMessage(data, client, this.clients)
    );
    ws.on("close", () => this.handleDisconnection(sessionId, ws));
    ws.on("error", (error) =>
      console.error(`[WebSocket] Error for client ${sessionId}:`, error)
    );

  }

  /**
   * Handle client disconnection
   * @param sessionId - Session ID of disconnected client
   * @param ws - WebSocket connection that was closed
   */
  private handleDisconnection(sessionId: string, ws: WebSocket): void {
    console.log(`🔌 [WebSocket] Client disconnected: ${sessionId}`);

    // Only delete if this is still the current client for this sessionId
    // (prevents race condition where old connection's close event deletes new connection)
    const currentClient = this.clients.get(sessionId);
    if (currentClient && currentClient.ws === ws) {
      this.clients.delete(sessionId);

    }
  }

  /**
   * Extract sessionId from WebSocket upgrade request URL
   * @param req - HTTP upgrade request
   * @returns Session ID or null if not found
   */
  private extractSessionId(req: any): string | null {
    return req.url?.split("sessionId=")[1]?.split("&")[0] || null;
  }

  private extractToken(req: any): string | null {
    return req.url?.split("token=")[1]?.split("&")[0] || null;
  }

  private extractParam(req: any, name: string): string | null {
    const regex = new RegExp(`${name}=([^&]*)`);
    const match = req.url?.match(regex);
    return match ? decodeURIComponent(match[1]) : null;
  }

  private verifyTokenCreds(
    token: string
  ): { userId: string; email: string } | null {
    try {
      const payload = verifyToken(decodeURIComponent(token));
      return { userId: payload.userId, email: payload.email };
    } catch (error) {
      return null;
    }
  }

  private async isSessionOwnedByUser(
    sessionId: string,
    userId: string,
    email: string
  ): Promise<boolean> {
    // Multiplayer sessions: verify user is a room member
    if (sessionId.startsWith("multi-")) {
      const prisma = getPrismaClient();
      // Find a room whose in-memory state has this sessionId
      // Or just check if user is a member of any multiplayer room
      const member = await prisma.multiplayerRoomMember.findFirst({
        where: { userId },
        select: { roomId: true },
      });
      return Boolean(member);
    }

    const serverState = ServerState.getInstance();
    const activeState = serverState.getDynamicGameState(userId);
    if (activeState?.sessionId === sessionId) {
      return true;
    }

    const prisma = getPrismaClient();
    const ownedCharacters = await prisma.character.findMany({
      where: { emailId: email, isNpc: false },
      select: { characterId: true },
    });
    const ownedCharacterIds = ownedCharacters.map((row) => row.characterId);
    if (ownedCharacterIds.length === 0) {
      return false;
    }

    const turn = await prisma.gameTurn.findFirst({
      where: {
        sessionId,
        characterId: { in: ownedCharacterIds },
      },
      select: { turnId: true },
    });

    return Boolean(turn);
  }

  /**
   * Start heartbeat mechanism to keep connections alive and detect dead connections
   */
  private startHeartbeat(): void {
    setInterval(() => {
      for (const [sessionId, client] of this.clients.entries()) {
        if (client.ws.readyState === WebSocket.OPEN) {
          try {
            client.ws.ping();
          } catch (error) {
            console.error(
              `[WebSocket] Error sending ping to ${sessionId}:`,
              error
            );
            this.clients.delete(sessionId);
          }
        } else {
          // Remove dead connections
          this.clients.delete(sessionId);
        }
      }

    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Get all connected clients
   */
  public getClients(): Map<string, WSClient> {
    return this.clients;
  }

  // ─── Multiplayer methods (additive) ──────────────────────────────────────

  /**
   * Register a multiplayer client for a specific sceneRoom.
   */
  public registerMultiplayerClient(
    sceneRoomId: string,
    userId: string,
    client: WSClient
  ): void {
    if (!this.multiplayerClients.has(sceneRoomId)) {
      this.multiplayerClients.set(sceneRoomId, new Map());
    }
    this.multiplayerClients.get(sceneRoomId)!.set(userId, client);
  }

  /**
   * Remove a multiplayer client from a sceneRoom.
   */
  public removeMultiplayerClient(sceneRoomId: string, userId: string): void {
    this.multiplayerClients.get(sceneRoomId)?.delete(userId);
    if (this.multiplayerClients.get(sceneRoomId)?.size === 0) {
      this.multiplayerClients.delete(sceneRoomId);
    }
  }

  /**
   * Get all multiplayer clients for a sceneRoom.
   */
  public getMultiplayerClients(sceneRoomId: string): Map<string, WSClient> {
    return this.multiplayerClients.get(sceneRoomId) ?? new Map();
  }

  /**
   * Get all sceneRoom client maps (for broadcasting to all rooms of a room).
   */
  public getMultiplayerClientsByRoom(
    sceneRoomIds: string[]
  ): Map<string, WSClient>[] {
    return sceneRoomIds
      .map((id) => this.multiplayerClients.get(id))
      .filter((m): m is Map<string, WSClient> => Boolean(m));
  }

  /**
   * Register a multiplayer client for all active (non-frozen) scene rooms in a game room.
   */
  public async registerMultiplayerClientForAllRooms(
    roomId: string,
    userId: string,
    client: WSClient
  ): Promise<void> {
    try {
      // Dynamic import to avoid circular deps (ESM — cannot use require)
      const { multiplayerSessionStore } = await import(
        "../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameStateLoader.js"
      );
      const manager = multiplayerSessionStore.get(roomId);
      if (!manager) return;

      const state = manager.getState();
      for (const room of Object.values(state.sceneRooms) as any[]) {
        if (!room.isFrozen) {
          this.registerMultiplayerClient(room.sceneRoomId, userId, client);
        }
      }
    } catch (err) {
      console.warn("[WebSocket] Failed to register client for all rooms:", err);
    }
  }

  /**
   * Register all existing clients of one scene room into a newly created scene room.
   * Called when a scene room splits so every connected client receives events from the new room.
   */
  public registerAllClientsForNewSceneRoom(
    existingSceneRoomId: string,
    newSceneRoomId: string
  ): void {
    const existingClients = this.multiplayerClients.get(existingSceneRoomId);
    if (!existingClients) return;

    for (const [userId, client] of existingClients) {
      this.registerMultiplayerClient(newSceneRoomId, userId, client);
    }
  }

  // ─── Room-level (waiting lobby) methods ──────────────────────────────

  /**
   * Register a client for a room-level (waiting lobby) connection.
   */
  public registerRoomClient(
    roomId: string,
    userId: string,
    client: WSClient
  ): void {
    if (!this.roomClients.has(roomId)) {
      this.roomClients.set(roomId, new Map());
    }
    this.roomClients.get(roomId)!.set(userId, client);
  }

  /**
   * Remove a client from a room-level connection.
   */
  public removeRoomClient(roomId: string, userId: string): void {
    this.roomClients.get(roomId)?.delete(userId);
    if (this.roomClients.get(roomId)?.size === 0) {
      this.roomClients.delete(roomId);
    }
  }

  /**
   * Get all clients connected to a room (waiting lobby).
   */
  public getRoomClients(roomId: string): Map<string, WSClient> {
    return this.roomClients.get(roomId) ?? new Map();
  }

  // ─── Simulation viewer methods ────────────────────────────────────────

  /**
   * Register a simulation viewer client for a specific session.
   */
  public registerSimulationClient(sessionId: string, clientId: string, client: WSClient): void {
    if (!this.simulationClients.has(sessionId)) {
      this.simulationClients.set(sessionId, new Map());
    }
    this.simulationClients.get(sessionId)!.set(clientId, client);
  }

  /**
   * Remove a simulation viewer client.
   */
  public removeSimulationClient(sessionId: string, clientId: string): void {
    const clients = this.simulationClients.get(sessionId);
    if (clients) {
      clients.delete(clientId);
      if (clients.size === 0) this.simulationClients.delete(sessionId);
    }
  }

  /**
   * Get all simulation viewer clients for a session.
   */
  public getSimulationClients(sessionId: string): Map<string, WSClient> {
    return this.simulationClients.get(sessionId) ?? new Map();
  }

  private async isRoomMember(
    roomId: string,
    userId: string
  ): Promise<boolean> {
    const prisma = getPrismaClient();
    const member = await prisma.multiplayerRoomMember.findFirst({
      where: { roomId, userId },
      select: { id: true },
    });
    return Boolean(member);
  }

  /**
   * Get current WebSocketManager instance (if initialized)
   */
  public static getInstance(): WebSocketManager | null {
    return WebSocketManager.instance;
  }

  /**
   * Close WebSocket server and all connections (for graceful shutdown)
   */
  public close(): void {
    // Close all client connections
    for (const [sessionId, client] of this.clients.entries()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.close();
      }
    }
    this.clients.clear();

    // Close WebSocket server
    this.wss.close(() => {
      console.log("WebSocket server closed");
    });
  }
}
