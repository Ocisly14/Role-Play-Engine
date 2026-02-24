/**
 * Hook for managing WebSocket connection for game progression
 */

import { useEffect, useRef } from "react";
import type { DiceRollInfo } from "../components/DiceAnimation";
import { filterDiceRollsForPlayer } from "../components/gamechat/utils";
import type {
  Message,
  PendingDiceRolls,
  WebSocketMessage,
} from "../types/gamechat";
import type { SceneTransitionKind } from "./useSceneTransition";

export interface UseWebSocketParams {
  sessionId: string | null;
  apiBaseUrl: string;
  isGameEnded: boolean;
  characterName: string;
  messagesRef: React.RefObject<Message[]>;
  onNarrativeCompleteRef: React.RefObject<(() => void) | undefined>;
  fetchGameEndingRef: React.RefObject<(() => Promise<void>) | null>;
  streamingBlockedRef: React.MutableRefObject<Set<string>>;
  streamingBufferRef: React.MutableRefObject<Map<string, string>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setStreamingTurnId: React.Dispatch<React.SetStateAction<string | null>>;
  setPendingDiceRolls: React.Dispatch<
    React.SetStateAction<PendingDiceRolls | null>
  >;
  setShowingDiceAnimation: React.Dispatch<React.SetStateAction<boolean>>;
  setDiceAnimationCompleted: React.Dispatch<React.SetStateAction<boolean>>;
  startSceneChanging: (kind: SceneTransitionKind) => void;
  setIsSending: React.Dispatch<React.SetStateAction<boolean>>;
  clearSceneChanging: (kind?: SceneTransitionKind | "fallback") => void;
}

export function useWebSocket({
  sessionId,
  apiBaseUrl,
  isGameEnded,
  characterName,
  messagesRef,
  onNarrativeCompleteRef,
  fetchGameEndingRef,
  streamingBlockedRef,
  streamingBufferRef,
  setMessages,
  setStreamingTurnId,
  setPendingDiceRolls,
  setShowingDiceAnimation,
  setDiceAnimationCompleted,
  startSceneChanging,
  setIsSending,
  clearSceneChanging,
}: UseWebSocketParams): void {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef<boolean>(true);
  const currentSessionIdRef = useRef<string | null>(null);

  // WebSocket connection effect
  useEffect(() => {
    if (!sessionId || isGameEnded) return;

    // Check if we already have a connection for this sessionId
    if (
      currentSessionIdRef.current === sessionId &&
      wsRef.current &&
      wsRef.current.readyState === WebSocket.OPEN
    ) {
      console.log(
        `[WebSocket] Already connected for session ${sessionId}, skipping...`
      );
      return;
    }

    // Get WebSocket URL from apiBaseUrl
    let wsUrl: string;
    if (apiBaseUrl.startsWith("/")) {
      // Relative path - use current protocol and host (skip Vite ws proxy in dev)
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const isViteDev = import.meta.env.DEV && window.location.port === "5173";
      const host = isViteDev
        ? `${window.location.hostname}:3000`
        : window.location.host;
      wsUrl = `${protocol}//${host}`;
    } else {
      // Absolute URL - convert to WebSocket URL
      wsUrl = apiBaseUrl
        .replace("/api", "")
        .replace("http://", "ws://")
        .replace("https://", "wss://");
    }
    const token = localStorage.getItem("accessToken");
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
    const wsPath = `${wsUrl}/ws?sessionId=${sessionId}${tokenParam}`;

    console.log(`[WebSocket] Connecting to ${wsPath}`);

    // Mark that we should reconnect if connection closes (unless cleanup disables it)
    shouldReconnectRef.current = true;
    currentSessionIdRef.current = sessionId;

    const connectWebSocket = () => {
      // Check if we should still connect (might have been cancelled by cleanup)
      if (
        !shouldReconnectRef.current ||
        currentSessionIdRef.current !== sessionId
      ) {
        console.log(
          `[WebSocket] Connection cancelled or session changed, aborting...`
        );
        return;
      }

      try {
        // Close existing connection if any
        if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
          console.log(
            `[WebSocket] Closing existing connection before creating new one`
          );
          shouldReconnectRef.current = false; // Prevent auto-reconnect from old connection
          wsRef.current.close();
        }

        const ws = new WebSocket(wsPath);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log("[WebSocket] Connected");
          // Clear any reconnect timeout
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
        };

        ws.onmessage = (event) => {
          try {
            const message: WebSocketMessage = JSON.parse(event.data);
            console.log("[WebSocket] Received message:", message);

            if (message.type === "connected") {
              console.log(
                `[WebSocket] Connection confirmed for session ${message.sessionId}`
              );
            } else if (message.type === "keeper_dice_rolls") {
              const diceRolls = filterDiceRollsForPlayer(
                message.diceRolls as Array<string | DiceRollInfo> | undefined,
                characterName
              );
              const turnId = message.turnId;
              if (!diceRolls || diceRolls.length === 0) return;

              if (turnId) {
                streamingBlockedRef.current.add(turnId);
                setStreamingTurnId(turnId);
              }

              const turnNumber =
                typeof message.turnNumber === "number"
                  ? message.turnNumber
                  : messagesRef.current && messagesRef.current.length > 0
                    ? Math.max(
                        ...messagesRef.current.map((m) => m.turnNumber)
                      ) + 1
                    : 1;

              setPendingDiceRolls({
                turnNumber,
                turnId,
                diceRolls,
                narrative: "",
                timestamp: message.timestamp || new Date().toISOString(),
                gameDay: message.gameDay ?? null,
                gameTime: message.gameTime ?? null,
                isStreaming: true,
              });
              setShowingDiceAnimation(true);
              setDiceAnimationCompleted(false);
            } else if (message.type === "keeper_stream_start") {
              const turnId = message.turnId;
              if (!turnId) return;

              setStreamingTurnId(turnId);
              setMessages((prev) => {
                const existing = prev.find((msg) => msg.turnId === turnId);
                if (existing) {
                  return prev.map((msg) =>
                    msg.turnId === turnId ? { ...msg, isStreaming: true } : msg
                  );
                }

                const nextTurnNumber =
                  typeof message.turnNumber === "number"
                    ? message.turnNumber
                    : prev.length > 0
                      ? Math.max(...prev.map((m) => m.turnNumber)) + 1
                      : 1;

                return [
                  ...prev,
                  {
                    role: "keeper" as const,
                    content: "",
                    timestamp: message.timestamp || new Date().toISOString(),
                    turnNumber: nextTurnNumber,
                    turnId: turnId,
                    isStreaming: true,
                    gameDay: message.gameDay ?? null,
                    gameTime: message.gameTime ?? null,
                  },
                ];
              });
            } else if (message.type === "keeper_stream_delta") {
              const turnId = message.turnId;
              const delta = message.delta;
              if (!turnId || !delta) return;

              if (streamingBlockedRef.current.has(turnId)) {
                const existing = streamingBufferRef.current.get(turnId) || "";
                streamingBufferRef.current.set(turnId, existing + delta);

                setMessages((prev) => {
                  const found = prev.find((msg) => msg.turnId === turnId);
                  if (found) return prev;
                  const nextTurnNumber =
                    prev.length > 0
                      ? Math.max(...prev.map((m) => m.turnNumber)) + 1
                      : 1;
                  return [
                    ...prev,
                    {
                      role: "keeper" as const,
                      content: "",
                      timestamp: new Date().toISOString(),
                      turnNumber: nextTurnNumber,
                      turnId: turnId,
                      isStreaming: true,
                      gameDay: null,
                      gameTime: null,
                    },
                  ];
                });
                return;
              }

              setMessages((prev) => {
                let found = false;
                const next = prev.map((msg) => {
                  if (msg.turnId === turnId) {
                    found = true;
                    return {
                      ...msg,
                      content: msg.content + delta,
                      isStreaming: true,
                    };
                  }
                  return msg;
                });

                if (!found) {
                  const nextTurnNumber =
                    prev.length > 0
                      ? Math.max(...prev.map((m) => m.turnNumber)) + 1
                      : 1;
                  next.push({
                    role: "keeper" as const,
                    content: delta,
                    timestamp: new Date().toISOString(),
                    turnNumber: nextTurnNumber,
                    turnId: turnId,
                    isStreaming: true,
                    gameDay: null,
                    gameTime: null,
                  });
                }

                return next;
              });
            } else if (message.type === "keeper_stream_end") {
              const turnId = message.turnId;
              if (!turnId) return;

              setMessages((prev) =>
                prev.map((msg) =>
                  msg.turnId === turnId ? { ...msg, isStreaming: false } : msg
                )
              );

              setStreamingTurnId((current) =>
                current === turnId ? null : current
              );

              // Clear all loading states to prevent frontend from getting stuck
              setIsSending(false);
              clearSceneChanging("fallback");

              // Refresh game state
              if (fetchGameEndingRef.current) {
                fetchGameEndingRef.current();
              }
            } else if (message.type === "scene_change_start") {
              startSceneChanging("scene");
            } else if (message.type === "scene_change_end") {
              clearSceneChanging("scene");
            } else if (message.type === "worldline_update_start") {
              startSceneChanging("worldline");
            } else if (message.type === "worldline_update_end") {
              clearSceneChanging("worldline");
            } else if (message.type === "scene_image") {
              if (onNarrativeCompleteRef.current) {
                onNarrativeCompleteRef.current();
              }
            } else if (message.type === "map_update") {
              // Macro map was incrementally updated after a scene switch –
              // trigger a sidebar refresh so the new map is fetched from the server.
              if (onNarrativeCompleteRef.current) {
                onNarrativeCompleteRef.current();
              }
            } else if (
              message.type === "combat_start" ||
              message.type === "combat_end"
            ) {
              const bannerType =
                message.type === "combat_start"
                  ? ("combat_start" as const)
                  : ("combat_end" as const);
              console.log(
                `[WebSocket] Combat banner received: ${bannerType}`,
                message
              );
              setMessages((prev) => {
                const resolvedTurnNumber =
                  typeof message.turnNumber === "number"
                    ? message.turnNumber
                    : prev.length > 0
                      ? Math.max(...prev.map((m) => m.turnNumber))
                      : 0;

                const duplicate = prev.some(
                  (msg) =>
                    msg.role === "banner" &&
                    msg.bannerType === bannerType &&
                    ((message.turnId && msg.turnId === message.turnId) ||
                      (!message.turnId &&
                        msg.turnNumber === resolvedTurnNumber))
                );
                if (duplicate) return prev;

                return [
                  ...prev,
                  {
                    role: "banner" as const,
                    content: "",
                    bannerType,
                    timestamp: message.timestamp || new Date().toISOString(),
                    turnNumber: resolvedTurnNumber,
                    turnId: message.turnId,
                  },
                ];
              });
            } else if (message.type === "pong") {
              // Heartbeat response
              console.log("[WebSocket] Heartbeat received");
            } else if (message.type === "progression_check_result") {
              console.log(
                "[WebSocket] Progression check result:",
                message.triggered
              );
            } else if (message.type === "error") {
              console.error(
                "[WebSocket] Error:",
                message.message || message.error
              );
            }
          } catch (error) {
            console.error("[WebSocket] Error parsing message:", error);
          }
        };

        ws.onerror = (error) => {
          console.error("[WebSocket] Error:", error);
        };

        ws.onclose = () => {
          console.log("[WebSocket] Connection closed");
          wsRef.current = null;

          // Only reconnect if we should and session hasn't changed
          if (
            shouldReconnectRef.current &&
            currentSessionIdRef.current === sessionId
          ) {
            console.log("[WebSocket] Attempting to reconnect in 5 seconds...");
            reconnectTimeoutRef.current = window.setTimeout(() => {
              connectWebSocket();
            }, 5000);
          } else {
            console.log(
              "[WebSocket] Reconnect disabled or session changed, not reconnecting"
            );
          }
        };
      } catch (error) {
        console.error("[WebSocket] Failed to connect:", error);
        // Retry connection after 5 seconds only if we should reconnect
        if (
          shouldReconnectRef.current &&
          currentSessionIdRef.current === sessionId
        ) {
          reconnectTimeoutRef.current = window.setTimeout(() => {
            connectWebSocket();
          }, 5000);
        }
      }
    };

    connectWebSocket();

    // Cleanup on unmount or when dependencies change
    return () => {
      console.log(
        `[WebSocket] Cleanup: disabling reconnect and closing connection`
      );
      shouldReconnectRef.current = false; // Disable auto-reconnect

      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (wsRef.current) {
        const ws = wsRef.current;
        // Remove event handlers to prevent onclose from triggering reconnect
        ws.onclose = null;
        ws.onerror = null;

        // Only close if not in CONNECTING state to avoid the warning
        if (ws.readyState === WebSocket.CONNECTING) {
          // Wait for connection to establish or fail before closing
          const closeTimer = setTimeout(() => {
            if (ws.readyState !== WebSocket.CLOSED) {
              ws.close();
            }
          }, 100);

          // But if it opens quickly, close it immediately
          ws.onopen = () => {
            clearTimeout(closeTimer);
            ws.close();
          };
        } else if (ws.readyState !== WebSocket.CLOSED) {
          ws.close();
        }

        wsRef.current = null;
      }
    };
  }, [
    sessionId,
    apiBaseUrl,
    isGameEnded,
    characterName,
    messagesRef,
    onNarrativeCompleteRef,
    fetchGameEndingRef,
    streamingBlockedRef,
    streamingBufferRef,
    setMessages,
    setStreamingTurnId,
    setPendingDiceRolls,
    setShowingDiceAnimation,
    setDiceAnimationCompleted,
    startSceneChanging,
    setIsSending,
    clearSceneChanging,
  ]);

  // Send heartbeat ping every 60 seconds
  useEffect(() => {
    if (isGameEnded) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const heartbeatInterval = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ping" }));
        console.log("[WebSocket] Sent heartbeat ping");
      }
    }, 60000); // Send ping every 60 seconds

    return () => clearInterval(heartbeatInterval);
  }, [sessionId, isGameEnded]);
}
