import { useCallback, useEffect, useRef } from "react";

export interface SimulationEvent {
  id: string;
  sessionId: string;
  tick: number;
  gameDay: number;
  gameTime: string;
  type: string;
  actorNpcId: string;
  targetNpcId?: string;
  location: string;
  data: Record<string, unknown>;
  timestamp: string;
}

interface UseSimulationWebSocketParams {
  sessionId: string | null;
  onEvent: (event: SimulationEvent) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export function useSimulationWebSocket({
  sessionId,
  onEvent,
  onConnected,
  onDisconnected,
}: UseSimulationWebSocketParams) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const reconnectDelayRef = useRef(1000);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    if (!sessionId) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws?sessionId=${sessionId}&type=simulation`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectDelayRef.current = 1000;
      onConnected?.();
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "simulation_event" && message.event) {
          onEventRef.current(message.event);
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      onDisconnected?.();
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectDelayRef.current = Math.min(
          reconnectDelayRef.current * 2,
          30000
        );
        connect();
      }, reconnectDelayRef.current);
    };
  }, [sessionId, onConnected, onDisconnected]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current)
        clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect]);
}
