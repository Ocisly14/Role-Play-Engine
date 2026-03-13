/**
 * Hook for managing WebSocket connection for multiplayer game.
 *
 * Handles multiplayer-specific WS message types:
 * - round_processing / round_complete
 * - keeper_stream_start / delta / end
 * - scene_image_ready / game_ending_update
 * - combat_start / combat_end
 */

import { useEffect, useRef } from "react";
import type { DiceRollInfo } from "../components/DiceAnimation";
import type {
  Message,
  PendingDiceRolls,
  SceneRoomInfo,
} from "../types/gamechat";

export interface MultiplayerWSMessage {
  type: string;
  [key: string]: any;
}

export interface SkillSelectionRequiredData {
  roundTurnId: string;
  sceneRoomId: string;
  players: Record<string, { requiredBy: string }>;
}

export interface SkillSelectionUpdateData {
  sceneRoomId: string;
  playerId: string;
  selectedSkill: string;
  allResolved: boolean;
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
  onSkillSelectionRequired?: (data: SkillSelectionRequiredData) => void;
  onSkillSelectionUpdate?: (data: SkillSelectionUpdateData) => void;
  roomId?: string;
  onSceneRoomSplit?: (newRooms: any[]) => void;
  onSceneRoomMerged?: (survivingRoomId: string, removedRoomId: string) => void;
  setMessagesForRoom?: (
    sceneRoomId: string,
    updater: Message[] | ((prev: Message[]) => Message[])
  ) => void;
  currentPlayerId?: string | null;
  setRoundStatus?: React.Dispatch<
    React.SetStateAction<{
      submittedCount: number;
      totalCount: number;
      pendingPlayerNames: string[];
    } | null>
  >;
  /** Called when WS reconnects so the caller can re-fetch missed messages */
  onReconnect?: () => void;
  /** Called when the current player's scene room changes due to split/merge */
  onMySceneRoomChanged?: (newSceneRoomId: string) => void;
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
  onSkillSelectionRequired,
  onSkillSelectionUpdate,
  roomId,
  onSceneRoomSplit,
  onSceneRoomMerged,
  setMessagesForRoom,
  currentPlayerId,
  setRoundStatus,
  onReconnect,
  onMySceneRoomChanged,
}: UseMultiplayerWebSocketParams): void {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(true);
  const hasConnectedOnceRef = useRef(false);
  const currentSessionIdRef = useRef<string | null>(null);
  const currentSceneRoomIdRef = useRef<string | null>(null);
  const onNarrativeCompleteRef = useRef(onNarrativeComplete);
  onNarrativeCompleteRef.current = onNarrativeComplete;
  const onSkillSelectionRequiredRef = useRef(onSkillSelectionRequired);
  onSkillSelectionRequiredRef.current = onSkillSelectionRequired;
  const onSkillSelectionUpdateRef = useRef(onSkillSelectionUpdate);
  onSkillSelectionUpdateRef.current = onSkillSelectionUpdate;
  const onSceneRoomSplitRef = useRef(onSceneRoomSplit);
  onSceneRoomSplitRef.current = onSceneRoomSplit;
  const onSceneRoomMergedRef = useRef(onSceneRoomMerged);
  onSceneRoomMergedRef.current = onSceneRoomMerged;
  const setMessagesForRoomRef = useRef(setMessagesForRoom);
  setMessagesForRoomRef.current = setMessagesForRoom;
  const setRoundStatusRef = useRef(setRoundStatus);
  setRoundStatusRef.current = setRoundStatus;
  const currentPlayerIdRef = useRef(currentPlayerId);
  currentPlayerIdRef.current = currentPlayerId;
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;
  const onMySceneRoomChangedRef = useRef(onMySceneRoomChanged);
  onMySceneRoomChangedRef.current = onMySceneRoomChanged;

  useEffect(() => {
    if (!sessionId || !sceneRoomId || isGameEnded) return;

    // Skip if already connected for the same session + sceneRoom
    if (
      currentSessionIdRef.current === sessionId &&
      currentSceneRoomIdRef.current === sceneRoomId &&
      wsRef.current &&
      wsRef.current.readyState === WebSocket.OPEN
    ) {
      return;
    }

    currentSessionIdRef.current = sessionId;
    currentSceneRoomIdRef.current = sceneRoomId;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const isViteDev = import.meta.env.DEV && window.location.port === "5173";
    const host = isViteDev
      ? `${window.location.hostname}:3000`
      : window.location.host;

    const token = localStorage.getItem("accessToken");
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
    const roomIdParam = roomId ? `&roomId=${encodeURIComponent(roomId)}` : "";
    const wsPath = `${protocol}//${host}/ws?sessionId=${encodeURIComponent(sessionId)}&sceneRoomId=${encodeURIComponent(sceneRoomId)}${tokenParam}${roomIdParam}`;

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
          // On reconnect (not first connect), re-fetch turn history to catch missed messages
          if (hasConnectedOnceRef.current) {
            console.log("[MP WebSocket] Reconnected — triggering history sync");
            onReconnectRef.current?.();
          }
          hasConnectedOnceRef.current = true;
        };

        ws.onmessage = (event) => {
          try {
            const msg: MultiplayerWSMessage = JSON.parse(event.data);

            // Route messages to correct state store:
            // - Own room → flat setMessages (rendered by component)
            // - Other rooms → setMessagesForRoom (Map, for tab switching)
            const targetSetMessages = (
              eventSceneRoomId: string | undefined,
              updater: Message[] | ((prev: Message[]) => Message[])
            ) => {
              if (
                eventSceneRoomId &&
                eventSceneRoomId !== currentSceneRoomIdRef.current &&
                setMessagesForRoomRef.current
              ) {
                // Different room — route to Map for tab viewing
                setMessagesForRoomRef.current(eventSceneRoomId, updater);
              } else {
                // Own room or no sceneRoomId — update the rendered flat state
                setMessages(updater);
              }
            };

            switch (msg.type) {
              case "connected":
                console.log("[MP WebSocket] Connection confirmed");
                break;

              case "player_input_submitted": {
                const eventSceneRoomId = msg.sceneRoomId as string;
                const playerId = msg.playerId as string;
                const playerName = msg.playerName as string;
                const content = msg.content as string;
                const inputType = msg.inputType as "input" | "skip";

                // Update round status banner (only for own room)
                if (
                  setRoundStatusRef.current &&
                  eventSceneRoomId === currentSceneRoomIdRef.current
                ) {
                  setRoundStatusRef.current({
                    submittedCount: msg.submittedCount as number,
                    totalCount: msg.totalCount as number,
                    pendingPlayerNames: msg.pendingPlayerNames as string[],
                  });
                }

                // Don't add duplicate message for the local player
                if (playerId === currentPlayerIdRef.current) break;

                // Add this player's message to chat
                const maxTurn =
                  messagesRef.current.length > 0
                    ? Math.max(...messagesRef.current.map((m) => m.turnNumber))
                    : 0;

                if (inputType === "skip") {
                  targetSetMessages(eventSceneRoomId, (prev) => [
                    ...prev,
                    {
                      role: "character" as const,
                      content: "",
                      timestamp: msg.timestamp || new Date().toISOString(),
                      turnNumber: maxTurn + 1,
                      playerName,
                      isSkip: true,
                    },
                  ]);
                } else {
                  targetSetMessages(eventSceneRoomId, (prev) => [
                    ...prev,
                    {
                      role: "character" as const,
                      content,
                      timestamp: msg.timestamp || new Date().toISOString(),
                      turnNumber: maxTurn + 1,
                      playerName,
                    },
                  ]);
                }
                break;
              }

              case "round_processing":
                // Only affect UI state for own room (ignore other rooms' processing)
                if (
                  msg.sceneRoomId &&
                  msg.sceneRoomId !== currentSceneRoomIdRef.current
                )
                  break;
                setIsWaiting(true);
                if (setRoundStatusRef.current) {
                  setRoundStatusRef.current(null);
                }
                break;

              case "round_complete": {
                // Only affect UI state for own room
                if (
                  msg.sceneRoomId &&
                  msg.sceneRoomId !== currentSceneRoomIdRef.current
                )
                  break;
                setIsWaiting(false);
                if (setRoundStatusRef.current) {
                  setRoundStatusRef.current(null);
                }
                if (onNarrativeCompleteRef.current) {
                  onNarrativeCompleteRef.current();
                }
                break;
              }

              case "keeper_dice_rolls": {
                // Only show dice rolls for own scene room
                if (
                  msg.sceneRoomId &&
                  msg.sceneRoomId !== currentSceneRoomIdRef.current
                )
                  break;
                const diceRolls = msg.diceRolls as
                  | Array<string | DiceRollInfo>
                  | undefined;
                const turnId = (msg.roundTurnId ?? msg.turnId) as
                  | string
                  | undefined;
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
                const turnId = (msg.roundTurnId ?? msg.turnId) as
                  | string
                  | undefined;
                if (!turnId) return;
                // Only update streaming state for own room
                if (
                  !msg.sceneRoomId ||
                  msg.sceneRoomId === currentSceneRoomIdRef.current
                ) {
                  setStreamingTurnId(turnId);
                }
                targetSetMessages(msg.sceneRoomId, (prev) => {
                  const existing = prev.find(
                    (m) => m.turnId === turnId && m.role === "keeper"
                  );
                  if (existing) {
                    return prev.map((m) =>
                      m.turnId === turnId && m.role === "keeper"
                        ? { ...m, isStreaming: true }
                        : m
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
                const turnId = (msg.roundTurnId ?? msg.turnId) as
                  | string
                  | undefined;
                const delta = msg.delta;
                if (!turnId || !delta) return;

                if (streamingBlockedRef.current.has(turnId)) {
                  const existing = streamingBufferRef.current.get(turnId) || "";
                  streamingBufferRef.current.set(turnId, existing + delta);

                  targetSetMessages(msg.sceneRoomId, (prev) => {
                    const found = prev.find(
                      (m) => m.turnId === turnId && m.role === "keeper"
                    );
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

                targetSetMessages(msg.sceneRoomId, (prev) => {
                  let found = false;
                  const next = prev.map((m) => {
                    if (m.turnId === turnId && m.role === "keeper") {
                      found = true;
                      return {
                        ...m,
                        content: m.content + delta,
                        isStreaming: true,
                      };
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
                const turnId = (msg.roundTurnId ?? msg.turnId) as
                  | string
                  | undefined;
                if (!turnId) return;
                targetSetMessages(msg.sceneRoomId, (prev) =>
                  prev.map((m) =>
                    m.turnId === turnId && m.role === "keeper"
                      ? { ...m, isStreaming: false }
                      : m
                  )
                );
                // Only update UI state for own room
                if (
                  !msg.sceneRoomId ||
                  msg.sceneRoomId === currentSceneRoomIdRef.current
                ) {
                  setStreamingTurnId((cur) => (cur === turnId ? null : cur));
                  setIsWaiting(false);
                  if (onNarrativeCompleteRef.current) {
                    onNarrativeCompleteRef.current();
                  }
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
                const combatTurnId = (msg.roundTurnId ?? msg.turnId) as
                  | string
                  | undefined;
                targetSetMessages(msg.sceneRoomId, (prev) => {
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
                      ((combatTurnId && m.turnId === combatTurnId) ||
                        (!combatTurnId && m.turnNumber === resolvedTurnNumber))
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
                      turnId: combatTurnId,
                    },
                  ];
                });
                break;
              }

              case "skill_selection_required":
                console.log("[MP WebSocket] Skill selection required:", msg);
                onSkillSelectionRequiredRef.current?.(msg as any);
                break;

              case "skill_selection_update":
                console.log("[MP WebSocket] Skill selection update:", msg);
                onSkillSelectionUpdateRef.current?.(msg as any);
                break;

              case "round_error": {
                console.error("[MP WebSocket] Round error:", msg.error);
                setIsWaiting(false);
                if (setRoundStatusRef.current) {
                  setRoundStatusRef.current(null);
                }
                const errorContent =
                  msg.error ?? "An error occurred processing the round.";
                const maxTurn =
                  messagesRef.current.length > 0
                    ? Math.max(...messagesRef.current.map((m) => m.turnNumber))
                    : 0;
                targetSetMessages(msg.sceneRoomId, (prev) => [
                  ...prev,
                  {
                    role: "keeper" as const,
                    content: `⚠️ Error: ${errorContent}`,
                    timestamp: new Date().toISOString(),
                    turnNumber: maxTurn,
                  },
                ]);
                break;
              }

              case "scene_room_split": {
                console.log(`[MP WebSocket] Scene room split`);
                const newRooms: SceneRoomInfo[] = [];
                if (msg.stayerChildRoom) {
                  newRooms.push({
                    sceneRoomId: msg.stayerChildRoom.sceneRoomId,
                    scenarioName: null,
                    memberPlayerIds: msg.stayerChildRoom.playerIds || [],
                    roundNumber: 0,
                    isBattle: false,
                  });
                }
                for (const mover of msg.moverChildRooms || []) {
                  newRooms.push({
                    sceneRoomId: mover.sceneRoomId,
                    scenarioName: mover.targetSceneName || null,
                    memberPlayerIds: mover.playerIds || [],
                    roundNumber: 0,
                    isBattle: false,
                  });
                }
                onSceneRoomSplitRef.current?.(newRooms);

                // Detect which child room contains the current player
                if (currentPlayerIdRef.current) {
                  const myNewRoom = newRooms.find((r) =>
                    r.memberPlayerIds.includes(currentPlayerIdRef.current!)
                  );
                  if (myNewRoom) {
                    onMySceneRoomChangedRef.current?.(myNewRoom.sceneRoomId);
                  }
                }

                onNarrativeCompleteRef.current?.();
                break;
              }

              case "scene_room_merged": {
                console.log(`[MP WebSocket] Scene room merged`);
                const frozenIds = msg.frozenSceneRoomIds || [];
                const survivingId = msg.mergedChildRoom?.sceneRoomId;
                if (survivingId && frozenIds.length > 0) {
                  for (const removedId of frozenIds) {
                    onSceneRoomMergedRef.current?.(survivingId, removedId);
                  }
                }

                // Detect if current player is in the merged child room
                if (
                  currentPlayerIdRef.current &&
                  msg.mergedChildRoom?.playerIds?.includes(
                    currentPlayerIdRef.current
                  )
                ) {
                  onMySceneRoomChangedRef.current?.(
                    msg.mergedChildRoom.sceneRoomId
                  );
                }

                onNarrativeCompleteRef.current?.();
                break;
              }

              case "scene_room_joined":
                console.log(`[MP WebSocket] Scene room joined`);
                onNarrativeCompleteRef.current?.();
                break;

              case "rest_frozen":
                console.log("[MP WebSocket] Rest frozen:", msg.message);
                setIsWaiting(true);
                break;

              case "rest_unfrozen":
                console.log("[MP WebSocket] Rest unfrozen:", msg.message);
                setIsWaiting(false);
                onNarrativeCompleteRef.current?.();
                break;

              case "scene_change_processing":
                // Scene transition in progress — sceneTransition hook handles UI
                break;

              case "game_stopped":
                console.log("[MP WebSocket] Game stopped by host");
                setIsGameEnded(true);
                break;

              case "time_drift_blocked":
                console.log(
                  "[MP WebSocket] Time drift blocked:",
                  msg.driftMinutes,
                  "minutes"
                );
                setIsWaiting(true);
                break;

              case "time_drift_resumed":
                console.log("[MP WebSocket] Time drift resumed");
                setIsWaiting(false);
                onNarrativeCompleteRef.current?.();
                break;

              case "player_time_unfrozen":
              case "player_joined_via_time_bubble":
                onNarrativeCompleteRef.current?.();
                break;

              case "map_image_ready":
                // Similar to scene_image_ready — trigger sidebar refresh
                onNarrativeCompleteRef.current?.();
                break;

              case "pong":
                break;

              case "error":
                console.error(
                  "[MP WebSocket] Error:",
                  msg.message || msg.error
                );
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
