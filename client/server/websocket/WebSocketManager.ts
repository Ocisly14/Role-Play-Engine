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
      const connectionType = this.extractParam(req, "type");

      // Simulation viewer connection: no auth required, register and return early
      if (connectionType === "simulation" && sessionId) {
        const clientId = randomUUID();
        const client: WSClient = { ws, sessionId, lastHeartbeat: new Date() };
        this.registerSimulationClient(sessionId, clientId, client);

        ws.send(
          JSON.stringify({
            type: "connected",
            sessionId,
            timestamp: new Date().toISOString(),
          })
        );

        ws.on("close", () => {
          this.removeSimulationClient(sessionId, clientId);
        });
        ws.on("error", (error) => {
          console.error(
            `[WebSocket] Simulation viewer error for session ${sessionId}:`,
            error
          );
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

      if (!sessionId) {
        ws.close();
        return;
      }

      const owned = await this.isSessionOwnedByUser(sessionId, userId, email);
      if (!owned) {
        ws.close();
        return;
      }

      console.log(`🔌 [WebSocket] Client connected: ${sessionId}`);
      this.handleNewConnection(ws, sessionId);
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
    const serverState = ServerState.getInstance();
    const activeState = serverState.getDynamicGameState(userId);
    if (activeState?.sessionId === sessionId) {
      return true;
    }

    const prisma = getPrismaClient();
    const ownedSession = await prisma.session.findFirst({
      where: { sessionId, emailId: email },
      select: { sessionId: true },
    });

    return Boolean(ownedSession);
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

  // ─── Simulation viewer methods ────────────────────────────────────────

  /**
   * Register a simulation viewer client for a specific session.
   */
  public registerSimulationClient(
    sessionId: string,
    clientId: string,
    client: WSClient
  ): void {
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
    this.simulationClients.clear();

    // Close WebSocket server
    this.wss.close(() => {
      console.log("WebSocket server closed");
    });
  }
}
