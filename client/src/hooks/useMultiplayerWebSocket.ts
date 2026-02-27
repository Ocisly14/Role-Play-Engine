/**
 * Hook for managing WebSocket connection for multiplayer game.
 *
 * Handles multiplayer-specific WS message types:
 * - round_processing / round_complete
 * - keeper_stream_start / delta / end
 * - scene_image_ready / game_ending_update
 * - combat_start / combat_end
 */

import { useCallback, useEffect, useRef } from "react";
import type { DiceRollInfo } from "../components/DiceAnimation";
import { filterDiceRollsForPlayer } from "../components/gamechat/utils";
import type { Message, PendingDiceRolls } from "../types/gamechat";

export interface MultiplayerWSMessage {
  type: string;
  [key: string]: any;
}

export interface UseMultiplayerWebSocketParams {
  sessionId: string | null;
  sceneRoomId: string | null;
  isGameEnded: boolean;
  characterName: string;
  messagesRef: React.RefObject<Message[]>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setIsWaiting: React.Dispatch<React.SetStateAction<boolean>>;
  setIsGameEnded: React.Dispatch<React.SetStateAction<boolean>>;
  onNarrativeComplete?: () => void;
  streamingBlockedRef: React.MutableRefObject<Set<string>>;
  streamingBufferRef: React.MutableRefObject<Map<string, string>>;
  setStreamingTurnId: React.Dispatch<React.SetStateAction<string | null>>;
  setPendingDiceRolls: React.Dispatch<
    React.SetStateAction<PendingDiceRolls | null>
  >;
  setShowingDiceAnimation: React.Dispatch<React.SetStateAction<boolean>>;
  setDiceAnimationCompleted: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useMultiplayerWebSocket({
  sessionId,
  sceneRoomId,
  isGameEnded,
  characterName,
  messagesRef,
  setMessages,
  setIsWaiting,
  setIsGameEnded,
  onNarrativeComplete,
  streamingBlockedRef,
  streamingBufferRef,
  setStreamingTurnId,
  setPendingDiceRolls,
  setShowingDiceAnimation,
  setDiceAnimationCompleted,
}: UseMultiplayerWebSocketParams): void {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(true);
  const onNarrativeCompleteRef = useRef(onNarrativeComplete);
  onNarrativeCompleteRef.current = onNarrativeComplete;

  useEffect(() => {
    if (!sessionId || !sceneRoomId || isGameEnded) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const isViteDev = import.meta.env.DEV && window.location.port === "5173";
    const host = isViteDev
      ? `${window.location.hostname}:3000`
      : window.location.host;

    const token = localStorage.getItem("accessToken");
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
    const wsPath = `${protocol}//${host}/ws?sessionId=${encodeURIComponent(sessionId)}&sceneRoomId=${encodeURIComponent(sceneRoomId)}${tokenParam}`;

    shouldReconnectRef.current = true;

    const connectWebSocket = () => {
      if (!shouldReconnectRef.current) return;

      try {
        if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
          shouldReconnectRef.current = false;
          wsRef.current.close();
        }

        const ws = new WebSocket(wsPath);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log("[MP WebSocket] Connected");
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
        };

        ws.onmessage = (event) => {
          try {
            const msg: MultiplayerWSMessage = JSON.parse(event.data);

            switch (msg.type) {
              case "connected":
                console.log("[MP WebSocket] Connection confirmed");
                break;

              case "round_processing":
                setIsWaiting(true);
                break;

              case "round_complete": {
                setIsWaiting(false);

                // Append keeper narrative if present
                if (msg.keeperNarrative) {
                  const turnNumber = msg.turnNumber ?? 0;
                  setMessages((prev) => [
                    ...prev,
                    {
                      role: "keeper" as const,
                      content: msg.keeperNarrative,
                      timestamp: msg.timestamp || new Date().toISOString(),
                      turnNumber,
                      turnId: msg.turnId,
                      gameDay: msg.gameDay ?? null,
                      gameTime: msg.gameTime ?? null,
                      diceRolls: msg.diceRolls,
                    },
                  ]);
                }

                // Trigger sidebar refresh
                if (onNarrativeCompleteRef.current) {
                  onNarrativeCompleteRef.current();
                }
                break;
              }

              case "keeper_dice_rolls": {
                const diceRolls = filterDiceRollsForPlayer(
                  msg.diceRolls as Array<string | DiceRollInfo> | undefined,
                  characterName
                );
                const turnId = msg.turnId;
                if (!diceRolls || diceRolls.length === 0) return;

                if (turnId) {
                  streamingBlockedRef.current.add(turnId);
                  setStreamingTurnId(turnId);
                }

                const turnNumber =
                  typeof msg.turnNumber === "number"
                    ? msg.turnNumber
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
                  timestamp: msg.timestamp || new Date().toISOString(),
                  gameDay: msg.gameDay ?? null,
                  gameTime: msg.gameTime ?? null,
                  isStreaming: true,
                });
                setShowingDiceAnimation(true);
                setDiceAnimationCompleted(false);
                break;
              }

              case "keeper_stream_start": {
                const turnId = msg.turnId;
                if (!turnId) return;
                setStreamingTurnId(turnId);
                setMessages((prev) => {
                  const existing = prev.find((m) => m.turnId === turnId);
                  if (existing) {
                    return prev.map((m) =>
                      m.turnId === turnId ? { ...m, isStreaming: true } : m
                    );
                  }
                  const nextTurnNumber =
                    typeof msg.turnNumber === "number"
                      ? msg.turnNumber
                      : prev.length > 0
                        ? Math.max(...prev.map((m) => m.turnNumber)) + 1
                        : 1;
                  return [
                    ...prev,
                    {
                      role: "keeper" as const,
                      content: "",
                      timestamp: msg.timestamp || new Date().toISOString(),
                      turnNumber: nextTurnNumber,
                      turnId,
                      isStreaming: true,
                      gameDay: msg.gameDay ?? null,
                      gameTime: msg.gameTime ?? null,
                    },
                  ];
                });
                break;
              }

              case "keeper_stream_delta": {
                const turnId = msg.turnId;
                const delta = msg.delta;
                if (!turnId || !delta) return;

                if (streamingBlockedRef.current.has(turnId)) {
                  const existing =
                    streamingBufferRef.current.get(turnId) || "";
                  streamingBufferRef.current.set(turnId, existing + delta);

                  setMessages((prev) => {
                    const found = prev.find((m) => m.turnId === turnId);
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
                        turnId,
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
                  const next = prev.map((m) => {
                    if (m.turnId === turnId) {
                      found = true;
                      return { ...m, content: m.content + delta, isStreaming: true };
                    }
                    return m;
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
                      turnId,
                      isStreaming: true,
                      gameDay: null,
                      gameTime: null,
                    });
                  }
                  return next;
                });
                break;
              }

              case "keeper_stream_end": {
                const turnId = msg.turnId;
                if (!turnId) return;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.turnId === turnId ? { ...m, isStreaming: false } : m
                  )
                );
                setStreamingTurnId((cur) => (cur === turnId ? null : cur));
                setIsWaiting(false);
                if (onNarrativeCompleteRef.current) {
                  onNarrativeCompleteRef.current();
                }
                break;
              }

              case "scene_image_ready":
              case "scene_image":
              case "map_update":
                if (onNarrativeCompleteRef.current) {
                  onNarrativeCompleteRef.current();
                }
                break;

              case "game_ending_update":
                setIsGameEnded(true);
                break;

              case "combat_start":
              case "combat_end": {
                const bannerType =
                  msg.type === "combat_start"
                    ? ("combat_start" as const)
                    : ("combat_end" as const);
                setMessages((prev) => {
                  const resolvedTurnNumber =
                    typeof msg.turnNumber === "number"
                      ? msg.turnNumber
                      : prev.length > 0
                        ? Math.max(...prev.map((m) => m.turnNumber))
                        : 0;
                  const dup = prev.some(
                    (m) =>
                      m.role === "banner" &&
                      m.bannerType === bannerType &&
                      ((msg.turnId && m.turnId === msg.turnId) ||
                        (!msg.turnId && m.turnNumber === resolvedTurnNumber))
                  );
                  if (dup) return prev;
                  return [
                    ...prev,
                    {
                      role: "banner" as const,
                      content: "",
                      bannerType,
                      timestamp: msg.timestamp || new Date().toISOString(),
                      turnNumber: resolvedTurnNumber,
                      turnId: msg.turnId,
                    },
                  ];
                });
                break;
              }

              case "pong":
                break;

              case "error":
                console.error("[MP WebSocket] Error:", msg.message || msg.error);
                break;

              default:
                console.log("[MP WebSocket] Unhandled message type:", msg.type);
            }
          } catch (error) {
            console.error("[MP WebSocket] Parse error:", error);
          }
        };

        ws.onerror = (error) => {
          console.error("[MP WebSocket] Error:", error);
        };

        ws.onclose = () => {
          console.log("[MP WebSocket] Closed");
          wsRef.current = null;
          if (shouldReconnectRef.current) {
            reconnectTimeoutRef.current = window.setTimeout(
              connectWebSocket,
              5000
            );
          }
        };
      } catch (error) {
        console.error("[MP WebSocket] Connect failed:", error);
        if (shouldReconnectRef.current) {
          reconnectTimeoutRef.current = window.setTimeout(
            connectWebSocket,
            5000
          );
        }
      }
    };

    connectWebSocket();

    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        const ws = wsRef.current;
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
    };
  }, [
    sessionId,
    sceneRoomId,
    isGameEnded,
    characterName,
    messagesRef,
    setMessages,
    setIsWaiting,
    setIsGameEnded,
    streamingBlockedRef,
    streamingBufferRef,
    setStreamingTurnId,
    setPendingDiceRolls,
    setShowingDiceAnimation,
    setDiceAnimationCompleted,
  ]);

  // Heartbeat
  useEffect(() => {
    if (isGameEnded) return;
    const interval = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ping" }));
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [sessionId, isGameEnded]);
}
