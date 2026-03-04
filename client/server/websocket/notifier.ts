import { WebSocket } from "ws";
import type { WSClient } from "./WebSocketManager.js";

/**
 * Notify WebSocket clients about events
 * @param sessionId - Session ID of the client to notify
 * @param clients - Map of all WebSocket clients
 * @param message - Message to send to the client
 */
export function notifyClients(
  sessionId: string,
  clients: Map<string, WSClient>,
  message: any
): void {
  const client = clients.get(sessionId);
  if (client && client.ws.readyState === WebSocket.OPEN) {
    try {
      client.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error(
        `[WebSocket] Error sending message to client ${sessionId}:`,
        error
      );
    }
  }
}

/**
 * Broadcast a message to all clients in a multiplayer sceneRoom.
 * @param sceneRoomId - sceneRoom identifier (for logging only)
 * @param clients - Map<userId, WSClient> for this sceneRoom
 * @param message - Message object to broadcast
 */
export function notifySceneRoom(
  sceneRoomId: string,
  clients: Map<string, WSClient>,
  message: object
): void {
  const payload = JSON.stringify(message);
  for (const [userId, client] of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(payload);
      } catch (error) {
        console.error(
          `[WebSocket] Error broadcasting to sceneRoom ${sceneRoomId} user ${userId}:`,
          error
        );
      }
    }
  }
}

/**
 * Broadcast a message to all clients in a room-level (waiting lobby) connection.
 * @param roomId - Room identifier (for logging only)
 * @param clients - Map<userId, WSClient> for this room
 * @param message - Message object to broadcast
 */
export function notifyRoom(
  roomId: string,
  clients: Map<string, WSClient>,
  message: object
): void {
  const payload = JSON.stringify(message);
  for (const [userId, client] of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(payload);
      } catch (error) {
        console.error(
          `[WebSocket] Error broadcasting to room ${roomId} user ${userId}:`,
          error
        );
      }
    }
  }
}
