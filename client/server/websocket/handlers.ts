import type { WSClient } from "./WebSocketManager.js";

/**
 * Handle incoming WebSocket messages from clients
 * @param data - Raw message data from client
 * @param client - Client connection info
 */
export async function handleClientMessage(
  data: Buffer,
  client: WSClient
): Promise<void> {
  try {
    const message = JSON.parse(data.toString());

    if (message.type === "ping") {
      // Heartbeat ping - update last heartbeat and respond with pong
      client.lastHeartbeat = new Date();
      client.ws.send(
        JSON.stringify({
          type: "pong",
          timestamp: new Date().toISOString(),
        })
      );
    } else {
      console.log(
        `⚠️  [WebSocket] Unknown message type from ${client.sessionId}: ${message.type}`
      );
    }
  } catch (error) {
    console.error(
      `[WebSocket] Error parsing message from ${client.sessionId}:`,
      error
    );
  }
}
