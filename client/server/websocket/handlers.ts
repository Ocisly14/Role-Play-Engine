import type { WSClient } from "./WebSocketManager.js";
import { checkAndTriggerSimulate } from "./progressionChecker.js";

/**
 * Handle incoming WebSocket messages from clients
 * @param data - Raw message data from client
 * @param client - Client connection info
 * @param clients - Map of all connected clients
 */
export async function handleClientMessage(
  data: Buffer,
  client: WSClient,
  clients: Map<string, WSClient>
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
    } else if (message.type === "check_progression") {
      // Client requests immediate progression check
      console.log(
        `📨 [WebSocket] Received check_progression request from ${client.sessionId}`
      );

      const triggered = await checkAndTriggerSimulate(
        client.sessionId,
        clients
      );

      if (!triggered) {
        console.log(
          `⏸️  [WebSocket] No simulate trigger needed (conditions not met)`
        );
        client.ws.send(
          JSON.stringify({
            type: "progression_check_result",
            triggered: false,
            timestamp: new Date().toISOString(),
          })
        );
      }
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
