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
