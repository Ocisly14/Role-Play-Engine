/**
 * Lightweight WebSocket hook for the multiplayer waiting room (lobby).
 *
 * Connects with roomId only (no sessionId / sceneRoomId).
 * On any room-level event the caller's `onEvent` callback is invoked so it
 * can refetch the room overview or react to game-starting.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type RoomWSEventType =
  | "room_member_joined"
  | "room_module_selected"
  | "room_character_selected"
  | "room_member_confirmed"
  | "room_member_unconfirmed"
  | "room_game_starting";

export interface RoomWSEvent {
  type: RoomWSEventType;
  [key: string]: any;
}

export interface UseMultiplayerLobbyWsParams {
  roomId: string | null;
  /** Called whenever a room-level WS event arrives */
  onEvent: (event: RoomWSEvent) => void;
}

export function useMultiplayerLobbyWs({
  roomId,
  onEvent,
}: UseMultiplayerLobbyWsParams) {
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const shouldReconnectRef = useRef(true);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const cleanup = useCallback(() => {
    shouldReconnectRef.current = false;
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      const ws = wsRef.current;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      if (ws.readyState === WebSocket.CONNECTING) {
        const t = setTimeout(() => {
          if (ws.readyState !== WebSocket.CLOSED) ws.close();
        }, 100);
        ws.onopen = () => {
          clearTimeout(t);
          ws.close();
        };
      } else if (ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
      wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  useEffect(() => {
    if (!roomId) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const isViteDev =
      import.meta.env.DEV && window.location.port === "5173";
    const host = isViteDev
      ? `${window.location.hostname}:3000`
      : window.location.host;

    const token = localStorage.getItem("accessToken");
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
    const wsUrl = `${protocol}//${host}/ws?roomId=${encodeURIComponent(roomId)}${tokenParam}`;

    shouldReconnectRef.current = true;

    const connect = () => {
      if (!shouldReconnectRef.current) return;

      try {
        if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
          shouldReconnectRef.current = false;
          wsRef.current.close();
        }

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log("[LobbyWS] Connected");
          setIsConnected(true);
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "connected" || msg.type === "pong") return;
            onEventRef.current(msg as RoomWSEvent);
          } catch {
            // ignore parse errors
          }
        };

        ws.onerror = (error) => {
          console.error("[LobbyWS] Error:", error);
        };

        ws.onclose = () => {
          console.log("[LobbyWS] Closed");
          setIsConnected(false);
          wsRef.current = null;
          if (shouldReconnectRef.current) {
            reconnectTimeoutRef.current = window.setTimeout(connect, 5000);
          }
        };
      } catch (error) {
        console.error("[LobbyWS] Connect failed:", error);
        if (shouldReconnectRef.current) {
          reconnectTimeoutRef.current = window.setTimeout(connect, 5000);
        }
      }
    };

    connect();

    return cleanup;
  }, [roomId, cleanup]);

  // Heartbeat
  useEffect(() => {
    if (!roomId) return;
    const interval = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ping" }));
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [roomId]);

  return { isConnected };
}
