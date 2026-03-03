/**
 * MultiplayerGameChat — mirrors GameChat exactly, but uses multiplayer APIs.
 *
 * Differences from single-player GameChat:
 *   1. Uses useMultiplayerWebSocket instead of useWebSocket + useTurnPolling
 *   2. Submits input via POST /rooms/:roomId/scene-rooms/:sceneRoomId/input
 *   3. Adds Skip button + waiting-for-others state
 *   4. Loads turn history from multiplayer turn endpoint
 *   5. Fetches game state from multiplayer gamestate endpoint
 *   6. Save checkpoint via multiplayer checkpoint endpoint
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { useDiceAnimation } from "../hooks/useDiceAnimation";
import { useInputCollapse } from "../hooks/useInputCollapse";
import { useMultiplayerSceneRooms } from "../hooks/useMultiplayerSceneRooms";
import { useMultiplayerRoundPolling } from "../hooks/useMultiplayerRoundPolling";
import { useMultiplayerWebSocket } from "../hooks/useMultiplayerWebSocket";
import { useSceneTransition } from "../hooks/useSceneTransition";
import { useSkillSelection } from "../hooks/useSkillSelection";
import type { GameEndingInfo, Message } from "../types/gamechat";
import { SceneRoomTabs } from "./gamechat/SceneRoomTabs";
import { authFetch } from "../utils/authFetch";
import { InputArea } from "./gamechat/InputArea";
import { MessageList } from "./gamechat/MessageList";
import { SessionInfoBar } from "./gamechat/SessionInfoBar";
import { SkillSelectionModal } from "./gamechat/SkillSelectionModal";

export interface MultiplayerGameChatProps {
  roomId: string;
  sessionId: string;
  sceneRoomId: string;
  characterId: string;
  characterName?: string;
  onNarrativeComplete?: () => void;
  onSceneRoomChanged?: (newSceneRoomId: string) => void;
  language?: "en" | "zh";
}

export function MultiplayerGameChat({
  roomId,
  sessionId,
  sceneRoomId,
  characterId,
  characterName = "Investigator",
  onNarrativeComplete,
  onSceneRoomChanged,
  language = "en",
}: MultiplayerGameChatProps) {
  const { t } = useTranslation("game");

  // ── Local component state (mirrors GameChat) ──────────────
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isGameEnded, setIsGameEnded] = useState(false);
  const [currentGameState, setCurrentGameState] = useState<{
    gameDay?: number;
    timeOfDay?: string;
    isBattle?: boolean;
    staminaState?: {
      minutesSinceLastRest: number;
      fatigueActive: boolean;
      fatigueStartedAtGameTime?: string;
    };
  } | null>(null);
  const [isResting, setIsResting] = useState(false);
  const [restModalOpen, setRestModalOpen] = useState(false);
  // ── Multiplayer skill selection (two-phase commit) ──
  const [skillSelectionRequest, setSkillSelectionRequest] = useState<{
    roundTurnId: string;
    requiredBy: string;
  } | null>(null);
  const [restSelectedHours, setRestSelectedHours] = useState<number | null>(null);
  const [restCustomHours, setRestCustomHours] = useState("");
  const [restShowCustomInput, setRestShowCustomInput] = useState(false);

  // ── Round progress banner state ──
  const [roundStatus, setRoundStatus] = useState<{
    submittedCount: number;
    totalCount: number;
    pendingPlayerNames: string[];
  } | null>(null);

  // Messages
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Refs
  const messagesRef = useRef<Message[]>([]);
  const onNarrativeCompleteRef = useRef(onNarrativeComplete);
  const fetchGameEndingRef = useRef<(() => Promise<void>) | null>(null);
  const streamingBufferRef = useRef<Map<string, string>>(new Map());
  const streamingBlockedRef = useRef<Set<string>>(new Set());

  // ── Multi-room tab state ──────────────────────────────
  const {
    activeTabId,
    setActiveTabId,
    sceneRooms: sceneRoomStates,
    isViewingOwnRoom,
    sortedSceneRooms,
    setMessagesForRoom,
    handleSceneRoomSplit,
    handleSceneRoomMerged,
    saveScrollPosition,
  } = useMultiplayerSceneRooms({
    roomId,
    mySceneRoomId: sceneRoomId,
    initialMessages: messages,
  });

  const messageListRef = useRef<HTMLDivElement>(null);

  const handleTabChange = useCallback(
    (tabId: string) => {
      // Save current scroll position
      if (messageListRef.current) {
        saveScrollPosition(messageListRef.current.scrollTop);
      }
      setActiveTabId(tabId);
    },
    [saveScrollPosition, setActiveTabId]
  );

  // ── API base paths ──────────────────────────────────
  const apiBaseUrl = `/api/multiplayer/rooms/${roomId}`;

  // ── Hooks (mirrors GameChat hooks) ──────────────────
  const {
    isInputCollapsed,
    handleInputAreaMouseEnter,
    handleInputAreaMouseLeave,
  } = useInputCollapse({ inputValue });

  const {
    isSceneChanging,
    sceneChangingTextKey,
  } = useSceneTransition();

  const {
    pendingDiceRolls,
    setPendingDiceRolls,
    showingDiceAnimation,
    setShowingDiceAnimation,
    diceAnimationCompleted,
    setDiceAnimationCompleted,
    handleDiceAnimationComplete,
  } = useDiceAnimation({
    onNarrativeCompleteRef,
    streamingBlockedRef,
    streamingBufferRef,
    setMessages,
    setStreamingTurnId,
  });

  const {
    availableSkills,
    setAvailableSkills,
    selectedSkill,
    setSelectedSkill,
    isSkillAuto,
    setIsSkillAuto,
    suggestedSkills,
    isSuggesting,
    isSkillPickerOpen,
    setIsSkillPickerOpen,
    normalizeSkills,
  } = useSkillSelection({
    apiBaseUrl,
    inputValue,
    isGameEnded,
    language,
  });

  // ── Current player ID (userId from auth context) ──────────
  const { user: authUser } = useAuth();
  const currentPlayerId = authUser?.id ?? null;

  // ── Round-result polling (fallback for WS) ─────────
  const {
    roundResult,
    startPolling: startRoundPolling,
    stopPolling: stopRoundPolling,
  } = useMultiplayerRoundPolling(roomId, sceneRoomId);

  // Called on WS reconnect — re-fetch turn history to catch missed messages
  const handleWsReconnect = useCallback(async () => {
    if (!sceneRoomId) return;
    try {
      const res = await authFetch(
        `/api/multiplayer/rooms/${roomId}/scene-rooms/${sceneRoomId}/turns`
      );
      const data = await res.json();
      if (data.success && data.messages) {
        setMessages(data.messages as Message[]);
      }
    } catch {
      // Non-critical — WS may deliver the updates anyway
    }
    // Also refresh game state
    if (fetchGameEndingRef.current) {
      fetchGameEndingRef.current();
    }
  }, [roomId, sceneRoomId, setMessages]);

  // ── WebSocket ──────────────────────────────────────
  // Wrap setIsWaiting so we can also track isProcessing (keeper actually working)
  // The WS hook calls setIsWaiting(true) for round_processing, rest_frozen, time_drift_blocked
  // We only want the "keeper thinking" indicator for round_processing, not for "waiting for players"
  const wrappedSetIsWaiting: React.Dispatch<React.SetStateAction<boolean>> = useCallback(
    (value) => {
      setIsWaiting(value);
      // When the WS hook sets waiting=true due to round_processing, isProcessing should also be true
      // When it clears (round_complete/error/stream_end), isProcessing should also clear
      setIsProcessing(value);
    },
    []
  );

  useMultiplayerWebSocket({
    sessionId,
    sceneRoomId,
    isGameEnded,
    characterName,
    messagesRef,
    setMessages,
    setIsWaiting: wrappedSetIsWaiting,
    setIsGameEnded,
    onNarrativeComplete,
    streamingBlockedRef,
    streamingBufferRef,
    setStreamingTurnId,
    setPendingDiceRolls,
    setShowingDiceAnimation,
    setDiceAnimationCompleted,
    roomId,
    onSceneRoomSplit: handleSceneRoomSplit,
    onSceneRoomMerged: handleSceneRoomMerged,
    setMessagesForRoom,
    currentPlayerId,
    setRoundStatus,
    onReconnect: handleWsReconnect,
    onMySceneRoomChanged: onSceneRoomChanged,
    onSkillSelectionRequired: useCallback(
      (data) => {
        if (!currentPlayerId) return;
        const myRequest = data.players[currentPlayerId];
        if (myRequest) {
          setSkillSelectionRequest({
            roundTurnId: data.roundTurnId,
            requiredBy: myRequest.requiredBy,
          });
        }
      },
      [currentPlayerId]
    ),
    onSkillSelectionUpdate: useCallback(
      (data) => {
        if (data.allResolved) {
          setSkillSelectionRequest(null);
        }
      },
      []
    ),
  });

  // ── Ref syncing ────────────────────────────────────
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    onNarrativeCompleteRef.current = onNarrativeComplete;
  }, [onNarrativeComplete]);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Handle polling result (primary narrative delivery) ────────
  useEffect(() => {
    if (!roundResult || roundResult.status !== "completed") return;
    const roundTurnId = roundResult.roundTurnId;
    if (!roundTurnId) return;

    stopRoundPolling();
    setIsWaiting(false);
    setIsProcessing(false);

    if (roundResult.keeperNarrative) {
      setMessages((prev) => {
        // Case 1: streaming already created a message → update final content
        const existingIdx = prev.findIndex(
          (m) => m.turnId === roundTurnId && m.role === "keeper"
        );
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = {
            ...updated[existingIdx],
            content: roundResult.keeperNarrative!,
            isStreaming: false,
            gameDay: roundResult.gameDay ?? updated[existingIdx].gameDay ?? null,
            gameTime: roundResult.gameTime ?? updated[existingIdx].gameTime ?? null,
            diceRolls: roundResult.diceRolls?.length
              ? roundResult.diceRolls
              : updated[existingIdx].diceRolls,
          };
          return updated;
        }

        // Case 2: no streaming message → create new
        const turnNumber = roundResult.turnNumber ??
          (prev.length > 0 ? Math.max(...prev.map((m) => m.turnNumber)) + 1 : 1);
        return [
          ...prev,
          {
            role: "keeper" as const,
            content: roundResult.keeperNarrative!,
            timestamp: roundResult.completedAt || new Date().toISOString(),
            turnNumber,
            turnId: roundTurnId,
            gameDay: roundResult.gameDay ?? null,
            gameTime: roundResult.gameTime ?? null,
            diceRolls: roundResult.diceRolls,
          },
        ];
      });

      setStreamingTurnId((current) =>
        current === roundTurnId ? null : current
      );
    }

    onNarrativeCompleteRef.current?.();
    fetchGameEndingRef.current?.();
  }, [roundResult, setMessages, stopRoundPolling]);

  // ── Load turn history on mount ─────────────────────
  useEffect(() => {
    if (!sceneRoomId) return;
    const loadHistory = async () => {
      try {
        const res = await authFetch(
          `/api/multiplayer/rooms/${roomId}/scene-rooms/${sceneRoomId}/turns`
        );
        const data = await res.json();
        if (data.success && data.messages) {
          setMessages(data.messages as Message[]);
        }
      } catch {
        // Non-critical
      }
    };
    loadHistory();
  }, [roomId, sceneRoomId]);

  // ── Fetch game state (mirrors GameChat.fetchGameEnding) ─
  const fetchGameEnding = useCallback(async () => {
    try {
      const response = await authFetch(`${apiBaseUrl}/gamestate`);
      if (!response.ok) return;

      const data = await response.json();
      const endingInfo: GameEndingInfo | null =
        data?.gameState?.gameEnding ?? null;
      setIsGameEnded(Boolean(endingInfo?.isEnded));

      if (data?.gameState) {
        setCurrentGameState({
          gameDay: data.gameState.gameDay,
          timeOfDay: data.gameState.timeOfDay,
          isBattle: data.gameState.isBattle === true,
          staminaState: data.gameState.staminaState ?? undefined,
        });
        const skills = normalizeSkills(data.gameState.playerCharacter?.skills);
        setAvailableSkills(skills);
        if (
          selectedSkill &&
          !skills.find((s) => s.name === selectedSkill)
        ) {
          setSelectedSkill("");
        }
      }
    } catch (err) {
      console.error("[MultiplayerGameChat] Failed to fetch game state:", err);
    }
  }, [
    apiBaseUrl,
    selectedSkill,
    normalizeSkills,
    setAvailableSkills,
    setSelectedSkill,
  ]);

  useEffect(() => {
    fetchGameEndingRef.current = fetchGameEnding;
  }, [fetchGameEnding]);

  useEffect(() => {
    setIsGameEnded(false);
    if (sessionId && fetchGameEndingRef.current) {
      fetchGameEndingRef.current();
    }
  }, [sessionId, apiBaseUrl]);

  // ── Game ending ────────────────────────────────────
  useEffect(() => {
    if (!isGameEnded) return;
    setIsSending(false);
  }, [isGameEnded]);

  // ── Battle auto-disable skill auto ─────────────────
  useEffect(() => {
    if (currentGameState?.isBattle && isSkillAuto) {
      setIsSkillAuto(false);
    }
  }, [currentGameState?.isBattle, isSkillAuto, setIsSkillAuto]);

  // ── Combat end banner detection ────────────────────
  const prevIsBattleRef = useRef<boolean>(false);
  useEffect(() => {
    const curr = currentGameState?.isBattle ?? false;
    const prev = prevIsBattleRef.current;
    prevIsBattleRef.current = curr;
    if (prev === true && curr === false) {
      setMessages((msgs) => {
        const maxTurnNumber =
          msgs.length > 0 ? Math.max(...msgs.map((m) => m.turnNumber)) : 0;
        const hasCombatEndBanner = msgs.some(
          (m) =>
            m.role === "banner" &&
            m.bannerType === "combat_end" &&
            m.turnNumber === maxTurnNumber
        );
        if (hasCombatEndBanner) return msgs;
        return [
          ...msgs,
          {
            role: "banner" as const,
            content: "",
            bannerType: "combat_end" as const,
            timestamp: new Date().toISOString(),
            turnNumber: maxTurnNumber,
          },
        ];
      });
    }
  }, [currentGameState?.isBattle, setMessages]);

  const isCombatSkillRequired = currentGameState?.isBattle === true;
  const canSendInCombat = !isCombatSkillRequired || selectedSkill.trim().length > 0;

  // ── Send message ───────────────────────────────────
  const handleSendMessage = useCallback(async () => {
    if (!inputValue.trim() || isSending || isWaiting || isGameEnded) return;

    const messageText = inputValue.trim();
    const trimmedSkill = selectedSkill.trim();
    const hasSelectedSkill = trimmedSkill.length > 0;
    if (isCombatSkillRequired && !hasSelectedSkill) return;
    const skillToSend = hasSelectedSkill ? trimmedSkill : null;
    const skillSelectionMode = hasSelectedSkill
      ? "manual"
      : isSkillAuto
        ? "auto"
        : "manual";

    setInputValue("");
    setIsSending(true);
    setIsSkillPickerOpen(false);

    const nextTurnNumber =
      messages.length > 0
        ? Math.max(...messages.map((m) => m.turnNumber)) + 1
        : 1;
    const userMessage: Message = {
      role: "character" as const,
      content: messageText,
      timestamp: new Date().toISOString(),
      turnNumber: nextTurnNumber,
      gameDay: currentGameState?.gameDay ?? null,
      gameTime: currentGameState?.timeOfDay ?? null,
    };

    setMessages((prev) => [...prev, userMessage]);

    try {
      const res = await authFetch(
        `/api/multiplayer/rooms/${roomId}/scene-rooms/${sceneRoomId}/input`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            characterId,
            inputType: "input",
            content: messageText,
            selectedSkill: skillToSend,
            skillSelectionMode,
            language,
          }),
        }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to send");

      setSelectedSkill("");
      if (data.status === "waiting" || data.status === "processing") {
        setIsWaiting(true);
        // Start polling as fallback for WS
        if (typeof data.roundNumber === "number") {
          startRoundPolling(data.roundNumber);
        }
      }
      setIsSending(false);
    } catch (err) {
      console.error("Failed to send message:", err);
      setIsSending(false);
      setMessages((prev) =>
        prev.filter(
          (msg) =>
            !(
              msg.role === "character" &&
              msg.content === messageText &&
              msg.turnNumber === userMessage.turnNumber
            )
        )
      );
      alert(
        "Failed to send message: " +
          (err instanceof Error ? err.message : "Unknown error")
      );
    }
  }, [
    inputValue,
    isSending,
    isWaiting,
    isGameEnded,
    selectedSkill,
    isCombatSkillRequired,
    isSkillAuto,
    messages,
    currentGameState,
    roomId,
    sceneRoomId,
    characterId,
    language,
    setMessages,
    setSelectedSkill,
    setIsSkillPickerOpen,
    startRoundPolling,
  ]);

  // ── Skip ───────────────────────────────────────────
  const handleSkip = useCallback(async () => {
    if (isSending || isWaiting || isGameEnded) return;
    setIsSending(true);

    const nextTurnNumber =
      messages.length > 0
        ? Math.max(...messages.map((m) => m.turnNumber)) + 1
        : 1;
    const skipMessage: Message = {
      role: "character" as const,
      content: "",
      timestamp: new Date().toISOString(),
      turnNumber: nextTurnNumber,
      isSkip: true,
    };
    setMessages((prev) => [...prev, skipMessage]);

    try {
      const res = await authFetch(
        `/api/multiplayer/rooms/${roomId}/scene-rooms/${sceneRoomId}/input`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            characterId,
            inputType: "skip",
            language,
          }),
        }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to skip");
      if (data.status === "waiting" || data.status === "processing") {
        setIsWaiting(true);
        if (typeof data.roundNumber === "number") {
          startRoundPolling(data.roundNumber);
        }
      }
      setIsSending(false);
    } catch (err) {
      console.error("[MultiplayerGameChat] Skip failed:", err);
      setIsSending(false);
      // Remove optimistic skip message on failure
      setMessages((prev) =>
        prev.filter(
          (msg) =>
            !(
              msg.role === "character" &&
              msg.isSkip === true &&
              msg.turnNumber === nextTurnNumber
            )
        )
      );
      alert((err as Error).message);
    }
  }, [isSending, isWaiting, isGameEnded, messages, roomId, sceneRoomId, characterId, language, setMessages, startRoundPolling]);

  // ── Key handler ────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (e.nativeEvent.isComposing) return;
        handleSendMessage();
      }
    },
    [handleSendMessage]
  );

  // ── Rest ───────────────────────────────────────────
  const handleRest = useCallback(
    async (restHours: number) => {
      if (isResting || isSending || isWaiting || isGameEnded) return;
      const hours = Math.max(1, Math.min(24, Math.round(restHours)));
      const restMessageText =
        language === "en" ? `Rest for ${hours} hours` : `休息${hours}小时`;

      setIsResting(true);
      setIsSending(true);
      setIsSkillPickerOpen(false);
      const nextTurnNumber =
        messages.length > 0
          ? Math.max(...messages.map((m) => m.turnNumber)) + 1
          : 1;

      try {
        const userMessage: Message = {
          role: "character" as const,
          content: restMessageText,
          timestamp: new Date().toISOString(),
          turnNumber: nextTurnNumber,
          gameDay: currentGameState?.gameDay ?? null,
          gameTime: currentGameState?.timeOfDay ?? null,
        };
        setMessages((prev) => [...prev, userMessage]);

        const res = await authFetch(
          `/api/multiplayer/rooms/${roomId}/scene-rooms/${sceneRoomId}/input`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              characterId,
              inputType: "input",
              content: restMessageText,
              selectedSkill: null,
              skillSelectionMode: "manual",
              language,
            }),
          }
        );
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Failed to send rest action");

        setSelectedSkill("");
        if (data.status === "waiting" || data.status === "processing") {
          setIsWaiting(true);
          if (typeof data.roundNumber === "number") {
            startRoundPolling(data.roundNumber);
          }
        }
      } catch (err) {
        console.error("[handleRest] Error:", err);
        setIsSending(false);
        setMessages((prev) =>
          prev.filter(
            (msg) =>
              !(
                msg.role === "character" &&
                msg.content === restMessageText &&
                msg.turnNumber === nextTurnNumber
              )
          )
        );
        alert(
          `Failed to submit rest action: ${err instanceof Error ? err.message : "Unknown error"}`
        );
      } finally {
        setIsResting(false);
        setIsSending(false);
      }
    },
    [
      isResting,
      isSending,
      isWaiting,
      isGameEnded,
      roomId,
      sceneRoomId,
      characterId,
      language,
      messages,
      currentGameState,
      setMessages,
      setSelectedSkill,
      setIsSkillPickerOpen,
      startRoundPolling,
    ]
  );

  const openRestModal = useCallback(() => {
    setRestModalOpen(true);
    setRestSelectedHours(null);
    setRestShowCustomInput(false);
    setRestCustomHours("");
  }, []);

  const closeRestModal = useCallback(() => {
    setRestModalOpen(false);
    setRestSelectedHours(null);
    setRestShowCustomInput(false);
    setRestCustomHours("");
  }, []);

  const handleRestConfirm = useCallback(() => {
    const selectedHours = restShowCustomInput
      ? Number(restCustomHours)
      : restSelectedHours;
    if (
      !selectedHours ||
      Number.isNaN(selectedHours) ||
      selectedHours < 1 ||
      selectedHours > 24
    ) {
      return;
    }
    closeRestModal();
    handleRest(selectedHours);
  }, [restShowCustomInput, restCustomHours, restSelectedHours, closeRestModal, handleRest]);

  const isRestConfirmDisabled = restShowCustomInput
    ? !restCustomHours ||
      Number(restCustomHours) < 1 ||
      Number(restCustomHours) > 24
    : restSelectedHours === null;

  // ── Save checkpoint ────────────────────────────────
  const handleSaveCheckpoint = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const response = await authFetch(
        `/api/multiplayer/rooms/${roomId}/checkpoints/save`,
        { method: "POST" }
      );
      const data = await response.json();
      if (!data.success) throw new Error(data.error || "Failed to save checkpoint");
      setSaveMessage(`✓ ${t("session.saveSuccess")}`);
      setTimeout(() => setSaveMessage(null), 3000);
    } catch (err) {
      console.error("Failed to save checkpoint:", err);
      setSaveMessage(
        `${t("session.saveFailed")}: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, roomId, t]);

  // ── Render (identical structure to GameChat) ───────
  return (
    <div className="game-chat-container backdrop-blur-sm border border-slate-200 shadow-md rounded-lg">
      {isSceneChanging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="rounded-2xl border border-white/60 bg-white/30 px-6 py-4 backdrop-blur-xl shadow-[0_12px_34px_rgba(15,23,42,0.3)] flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-slate-600 border-t-transparent rounded-full animate-spin" />
            <span className="text-base text-slate-800 font-medium">
              {t(sceneChangingTextKey)}
            </span>
          </div>
        </div>
      )}

      <SessionInfoBar
        characterName={characterName}
        isSaving={isSaving}
        saveMessage={saveMessage}
        onSaveCheckpoint={handleSaveCheckpoint}
      />

      <SceneRoomTabs
        sceneRooms={sortedSceneRooms}
        activeTabId={activeTabId}
        mySceneRoomId={sceneRoomId}
        onTabChange={handleTabChange}
      />

      <MessageList
        messages={messages}
        characterName={characterName}
        showingDiceAnimation={showingDiceAnimation}
        pendingDiceRolls={pendingDiceRolls}
        diceAnimationCompleted={diceAnimationCompleted}
        handleDiceAnimationComplete={handleDiceAnimationComplete}
        isSending={false}
        isPolling={isProcessing}
        streamingTurnId={streamingTurnId}
        error={null}
        messagesEndRef={messagesEndRef}
        isSceneChanging={isSceneChanging}
        isInputCollapsed={isInputCollapsed}
      />

      {/* Round progress banner */}
      {roundStatus && roundStatus.submittedCount < roundStatus.totalCount && (
        <div className="mx-2 mb-1 px-4 py-2 rounded-lg bg-amber-900/40 border border-amber-700/50 backdrop-blur-sm text-center">
          <span className="text-amber-200 text-sm font-medium">
            {roundStatus.submittedCount}/{roundStatus.totalCount}{" "}
            {t("multiplayer.playersSubmitted", {
              defaultValue: "players submitted",
            })}
          </span>
          {roundStatus.pendingPlayerNames.length > 0 && (
            <span className="text-amber-400/70 text-sm ml-2">
              — {t("multiplayer.waitingFor", { defaultValue: "Waiting for:" })}{" "}
              {roundStatus.pendingPlayerNames.join(", ")}
            </span>
          )}
        </div>
      )}

      {isViewingOwnRoom ? (
        <InputArea
          inputValue={inputValue}
          setInputValue={setInputValue}
          selectedSkill={selectedSkill}
          setSelectedSkill={setSelectedSkill}
          isSkillAuto={isSkillAuto}
          setIsSkillAuto={setIsSkillAuto}
          suggestedSkills={suggestedSkills}
          isSuggesting={isSuggesting}
          isSkillPickerOpen={isSkillPickerOpen}
          setIsSkillPickerOpen={setIsSkillPickerOpen}
          availableSkills={availableSkills}
          isSending={isSending}
          isPolling={isWaiting}
          isGameEnded={isGameEnded}
          isCombatSkillRequired={isCombatSkillRequired}
          canSendInCombat={canSendInCombat}
          isInputCollapsed={isInputCollapsed}
          isSceneChanging={isSceneChanging}
          language={language}
          isBattle={currentGameState?.isBattle ?? false}
          isResting={isResting}
          handleInputAreaMouseEnter={handleInputAreaMouseEnter}
          handleInputAreaMouseLeave={handleInputAreaMouseLeave}
          handleSendMessage={handleSendMessage}
          handleKeyDown={handleKeyDown}
          onOpenRestModal={openRestModal}
          onSkip={handleSkip}
          isWaitingForOthers={isWaiting && !isProcessing}
        />
      ) : (
        <div className="px-4 py-2.5 bg-black/40 backdrop-blur-sm border-t border-amber-900/30 text-center">
          <span className="text-amber-400/60 text-sm italic">
            {t("multiplayer.watchingRoom", {
              scene: sceneRoomStates.get(activeTabId)?.info.scenarioName || "...",
              defaultValue: "Watching {{scene}}",
            })}
          </span>
        </div>
      )}

      {/* Rest Modal — identical to GameChat */}
      {restModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ backdropFilter: "blur(4px)", background: "rgba(15,23,42,0.45)" }}
          onClick={closeRestModal}
        >
          <div
            className="relative w-[min(32rem,92vw)] rounded-2xl border border-white/40 bg-white/90 dark:bg-slate-900/90 shadow-[0_20px_50px_rgba(15,23,42,0.45)] backdrop-blur-xl px-7 py-6"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="mb-4 flex items-center gap-2.5">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-slate-500"
                aria-hidden="true"
              >
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              </svg>
              <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">
                {t("input.restModal.title")}
              </h2>
            </div>

            {/* Mechanics description */}
            <div className="mb-4 rounded-xl border border-slate-100 bg-slate-50/80 px-4 py-3 dark:border-slate-700/60 dark:bg-slate-800/40">
              <p className="mb-2 text-sm text-slate-500 dark:text-slate-400">
                {t("input.restModal.mechanic")}
              </p>
              <ul className="space-y-1">
                <li className="flex items-center gap-2 text-sm text-slate-400 dark:text-slate-500">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-300 dark:bg-slate-600 shrink-0" />
                  {t("input.restModal.tier1")}
                </li>
                <li className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                  {t("input.restModal.tier2")}
                </li>
                <li className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                  {t("input.restModal.tier3")}
                </li>
              </ul>
            </div>

            {/* Choose label */}
            <p className="mb-3 text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500">
              {t("input.restModal.chooseLabel")}
            </p>

            {/* Preset duration buttons */}
            <div className="mb-4 grid grid-cols-4 gap-3">
              {([1, 2, 4, 8] as const).map((h) => {
                const tier =
                  h < 4
                    ? "none"
                    : h < 8
                      ? "fatigue"
                      : "full";
                const colorClass =
                  tier === "none"
                    ? "border-slate-200 bg-white/70 text-slate-400 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-500"
                    : tier === "fatigue"
                      ? "border-amber-200 bg-amber-50/80 text-amber-800 hover:border-amber-300 hover:bg-amber-100 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-300"
                      : "border-emerald-200 bg-emerald-50/80 text-emerald-800 hover:border-emerald-300 hover:bg-emerald-100 dark:border-emerald-700/60 dark:bg-emerald-900/20 dark:text-emerald-300";
                return (
                  <button
                    key={h}
                    type="button"
                    className={`rounded-xl border px-0 py-3 text-base font-medium shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${colorClass} ${
                      restSelectedHours === h && !restShowCustomInput
                        ? "ring-2 ring-amber-300 dark:ring-amber-500"
                        : ""
                    }`}
                    onClick={() => {
                      setRestSelectedHours(h);
                      setRestShowCustomInput(false);
                      setRestCustomHours("");
                    }}
                  >
                    {h}h
                  </button>
                );
              })}
            </div>

            {/* Custom hours */}
            {restShowCustomInput ? (
              <div className="mb-4">
                <input
                  type="number"
                  min="1"
                  max="24"
                  value={restCustomHours}
                  onChange={(e) => {
                    setRestCustomHours(e.target.value);
                    setRestSelectedHours(null);
                  }}
                  placeholder={t("input.restModal.customPlaceholder")}
                  className="flex-1 rounded-xl border border-slate-200 bg-white/70 px-4 py-3 text-base text-slate-800 shadow-sm focus:border-amber-300 focus:outline-none dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200"
                  autoFocus
                />
              </div>
            ) : (
              <button
                type="button"
                className="mb-4 w-full rounded-xl border border-slate-200 bg-white/60 py-3 text-sm text-slate-500 shadow-sm transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white/80 hover:shadow-md dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-400"
                onClick={() => {
                  setRestShowCustomInput(true);
                  setRestSelectedHours(null);
                }}
              >
                {t("input.restModal.customHours")}
              </button>
            )}

            <button
              type="button"
              className="mb-3 w-full rounded-xl border border-amber-300 bg-amber-100 py-3 text-sm font-medium text-amber-900 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md disabled:opacity-40 disabled:pointer-events-none"
              onClick={handleRestConfirm}
              disabled={isRestConfirmDisabled}
            >
              {t("input.restModal.confirm")}
            </button>

            <button
              type="button"
              className="w-full rounded-xl border border-slate-200 bg-transparent py-3 text-sm text-slate-400 transition-all hover:bg-slate-100/60 dark:border-slate-700 dark:text-slate-500 dark:hover:bg-slate-800/40"
              onClick={closeRestModal}
            >
              {t("input.restModal.cancel")}
            </button>
          </div>
        </div>
      )}

      {/* Multiplayer Skill Selection Modal (two-phase commit) */}
      <SkillSelectionModal
        isOpen={!!skillSelectionRequest}
        pendingTurn={
          skillSelectionRequest
            ? ({ status: "skill_selection" } as any)
            : null
        }
        availableSkills={availableSkills}
        selectedSkill={selectedSkill}
        setSelectedSkill={setSelectedSkill}
        onConfirm={async () => {
          if (!selectedSkill.trim() || !currentPlayerId) return;
          try {
            const res = await authFetch(
              `/api/multiplayer/rooms/${roomId}/scene-rooms/${sceneRoomId}/skill-selection`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  playerId: currentPlayerId,
                  selectedSkill: selectedSkill.trim(),
                }),
              }
            );
            const data = await res.json();
            if (!data.success) {
              console.error("[SkillSelection] Error:", data.error);
            }
          } catch (err) {
            console.error("[SkillSelection] Failed:", err);
          }
          setSkillSelectionRequest(null);
          setSelectedSkill("");
          setIsWaiting(true);
        }}
        onCancel={() => {
          // Can't cancel — skill selection is required. Reset skill pick only.
          setSelectedSkill("");
        }}
        language={language}
      />
    </div>
  );
}
