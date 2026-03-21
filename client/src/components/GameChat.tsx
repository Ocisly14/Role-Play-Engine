/**
 * GameChat - Main game chat component
 *
 * This component integrates all custom hooks and presentational components
 * for the game chat interface.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDiceAnimation } from "../hooks/useDiceAnimation";
import { useGameMessages } from "../hooks/useGameMessages";
import { useInputCollapse } from "../hooks/useInputCollapse";
import { useSceneTransition } from "../hooks/useSceneTransition";
import { useSkillSelection } from "../hooks/useSkillSelection";
import { type TurnStatus, useTurnPolling } from "../hooks/useTurnPolling";
import { useWebSocket } from "../hooks/useWebSocket";
import type { GameChatProps, GameEndingInfo, Message } from "../types/gamechat";
import { authFetch } from "../utils/authFetch";
import { InputArea } from "./gamechat/InputArea";
import { MessageList } from "./gamechat/MessageList";
import { SessionInfoBar } from "./gamechat/SessionInfoBar";
import { SkillSelectionModal } from "./gamechat/SkillSelectionModal";
import { buildDiceRollInfos } from "./gamechat/utils";

export function GameChat({
  sessionId,
  apiBaseUrl = "/api",
  characterName = "Investigator",
  moduleIntroduction,
  initialMessages,
  onNarrativeComplete,
  language = "en",
}: GameChatProps) {
  const { t } = useTranslation("game");

  // Local component state
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
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
  const [restSelectedHours, setRestSelectedHours] = useState<number | null>(
    null
  );
  const [restCustomHours, setRestCustomHours] = useState("");
  const [restShowCustomInput, setRestShowCustomInput] = useState(false);
  const [isSkillSelectionModalOpen, setIsSkillSelectionModalOpen] =
    useState(false);
  const [pendingTurnForSkillSelection, setPendingTurnForSkillSelection] =
    useState<TurnStatus | null>(null);

  // Refs
  const processedSkillSelectionTurnsRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef<Message[]>([]);
  const onNarrativeCompleteRef = useRef(onNarrativeComplete);
  const fetchGameEndingRef = useRef<(() => Promise<void>) | null>(null);
  const streamingBufferRef = useRef<Map<string, string>>(new Map());
  const streamingBlockedRef = useRef<Set<string>>(new Set());

  // Hooks
  const { turn, isPolling, error, startPolling, stopPolling } =
    useTurnPolling(apiBaseUrl);

  const {
    isInputCollapsed,
    handleInputAreaMouseEnter,
    handleInputAreaMouseLeave,
  } = useInputCollapse({ inputValue });

  const {
    isSceneChanging,
    sceneChangingTextKey,
    startSceneChanging,
    clearSceneChanging,
  } = useSceneTransition();

  const {
    messages,
    setMessages,
    streamingTurnId,
    setStreamingTurnId,
    messagesEndRef,
    processedTurnIdsRef,
  } = useGameMessages({
    sessionId,
    apiBaseUrl,
    initialMessages,
  });

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

  // WebSocket connection
  useWebSocket({
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
  });

  // Update refs
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    onNarrativeCompleteRef.current = onNarrativeComplete;
  }, [onNarrativeComplete]);

  // Fetch game ending/state
  const fetchGameEnding = useCallback(async () => {
    if (!sessionId) return;

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
          !skills.find((skill) => skill.name === selectedSkill)
        ) {
          setSelectedSkill("");
        }
      }
    } catch (err) {
      console.error("[GameChat] Failed to fetch game state:", err);
    }
  }, [
    apiBaseUrl,
    sessionId,
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

  // Handle skill selection requirement
  useEffect(() => {
    if (turn && turn.status === "requires_skill_selection") {
      setIsSending(false);
      stopPolling();

      const turnId = turn.turnId || `turn-${turn.turnNumber}`;
      const alreadyProcessed =
        processedSkillSelectionTurnsRef.current.has(turnId);

      if (!alreadyProcessed && !isSkillSelectionModalOpen) {
        processedSkillSelectionTurnsRef.current.add(turnId);
        setIsSkillSelectionModalOpen(true);
        setPendingTurnForSkillSelection(turn);

        if (availableSkills.length === 0 && fetchGameEndingRef.current) {
          fetchGameEndingRef.current();
        }
      }
    }
  }, [turn, stopPolling, availableSkills.length, isSkillSelectionModalOpen]);

  // Handle turn completion
  useEffect(() => {
    if (turn && turn.status === "completed") {
      const turnKey = turn.turnId || `turn-${turn.turnNumber}`;
      const turnNumberKey = `turn-${turn.turnNumber}`;
      if (
        processedTurnIdsRef.current.has(turnKey) ||
        processedTurnIdsRef.current.has(turnNumberKey) ||
        (turn.turnId && processedTurnIdsRef.current.has(turn.turnId))
      ) {
        setIsSending(false);
        clearSceneChanging();
        return;
      }

      processedTurnIdsRef.current.add(turnKey);
      processedTurnIdsRef.current.add(turnNumberKey);
      if (turn.turnId) {
        processedTurnIdsRef.current.add(turn.turnId);
      }

      // Only show dice rolls from the main action (first actionResult)
      // NPC response dice rolls are not displayed to avoid clutter
      const mainActionResults = turn.actionResults?.slice(0, 1) || [];
      const allDiceRolls = buildDiceRollInfos(mainActionResults, characterName);

      const existingStreamingMessage = turn.turnId
        ? messagesRef.current.find(
            (msg) => msg.turnId === turn.turnId && msg.role === "keeper"
          )
        : null;

      if (existingStreamingMessage) {
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.turnId !== turn.turnId) return msg;
            return {
              ...msg,
              content: turn.keeperNarrative || msg.content,
              timestamp: turn.completedAt || turn.startedAt,
              turnNumber: turn.turnNumber,
              isStreaming: false,
              diceRolls: allDiceRolls.length > 0 ? allDiceRolls : msg.diceRolls,
              gameDay: turn.gameDay ?? msg.gameDay ?? null,
              gameTime: turn.gameTime ?? msg.gameTime ?? null,
            };
          })
        );

        if (turn.turnId) {
          setStreamingTurnId((current) =>
            current === turn.turnId ? null : current
          );
        }

        if (onNarrativeComplete) {
          onNarrativeComplete();
        }

        setIsSending(false);
        if (fetchGameEndingRef.current) {
          fetchGameEndingRef.current();
        }
        return;
      }

      if (allDiceRolls.length > 0 && turn.keeperNarrative) {
        setPendingDiceRolls({
          turnNumber: turn.turnNumber,
          turnId: turn.turnId,
          diceRolls: allDiceRolls,
          narrative: turn.keeperNarrative,
          timestamp: turn.completedAt || turn.startedAt,
          gameDay: turn.gameDay ?? null,
          gameTime: turn.gameTime ?? null,
        });
        setShowingDiceAnimation(true);
        setDiceAnimationCompleted(false);
      } else {
        setMessages((prev) => {
          const existingKeeperMessage = prev.find(
            (msg) =>
              msg.role === "keeper" &&
              ((turn.turnId && msg.turnId === turn.turnId) ||
                msg.turnNumber === turn.turnNumber)
          );
          if (existingKeeperMessage) return prev;

          if (turn.keeperNarrative) {
            const keeperMessage: Message = {
              role: "keeper" as const,
              content: turn.keeperNarrative,
              timestamp: turn.completedAt || turn.startedAt,
              turnNumber: turn.turnNumber,
              turnId: turn.turnId,
              gameDay: turn.gameDay ?? null,
              gameTime: turn.gameTime ?? null,
            };
            return [...prev, keeperMessage];
          }
          return prev;
        });

        if (onNarrativeComplete) {
          onNarrativeComplete();
        }
      }

      setIsSending(false);
      clearSceneChanging();
      if (fetchGameEndingRef.current) {
        fetchGameEndingRef.current();
      }
    } else if (turn && turn.status === "error") {
      setIsSending(false);
      clearSceneChanging();
    }
  }, [
    turn,
    onNarrativeComplete,
    clearSceneChanging,
    characterName,
    processedTurnIdsRef,
    messagesRef,
    setMessages,
    setStreamingTurnId,
    setPendingDiceRolls,
    setShowingDiceAnimation,
    setDiceAnimationCompleted,
  ]);

  // Handle game ending
  useEffect(() => {
    if (!isGameEnded) return;
    stopPolling();
    setIsSending(false);
  }, [isGameEnded, stopPolling]);

  useEffect(() => {
    if (currentGameState?.isBattle && isSkillAuto) {
      setIsSkillAuto(false);
    }
  }, [currentGameState?.isBattle, isSkillAuto, setIsSkillAuto]);

  // 检测战斗结束：isBattle true → false，在最后一条 narrative 之后插入 combat_end banner
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
  const canSendInCombat =
    !isCombatSkillRequired || selectedSkill.trim().length > 0;

  // Event handlers
  const handleSendMessage = useCallback(async () => {
    if (!inputValue.trim() || isSending || isGameEnded) return;

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
      const response = await authFetch(`${apiBaseUrl}/turns`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: messageText,
          selectedSkill: skillToSend,
          skillSelectionMode,
          language,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || "Failed to send message");
      }

      setSelectedSkill("");
      startPolling(data.turnId);
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
    isGameEnded,
    selectedSkill,
    isCombatSkillRequired,
    isSkillAuto,
    messages,
    currentGameState,
    apiBaseUrl,
    language,
    setMessages,
    setSelectedSkill,
    startPolling,
    setIsSkillPickerOpen,
  ]);

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

  const handleRest = useCallback(
    async (restHours: number) => {
      if (isResting || isSending || isGameEnded) return;
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

        const response = await authFetch(`${apiBaseUrl}/turns`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: restMessageText,
            selectedSkill: null,
            skillSelectionMode: "manual",
            language,
          }),
        });
        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || "Failed to send rest action");
        }

        setSelectedSkill("");
        startPolling(data.turnId);
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
      }
    },
    [
      isResting,
      isSending,
      isGameEnded,
      apiBaseUrl,
      language,
      messages,
      currentGameState,
      setMessages,
      setIsSending,
      setSelectedSkill,
      startPolling,
      setIsSkillPickerOpen,
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
  }, [
    restShowCustomInput,
    restCustomHours,
    restSelectedHours,
    closeRestModal,
    handleRest,
  ]);

  const isRestConfirmDisabled = restShowCustomInput
    ? !restCustomHours ||
      Number(restCustomHours) < 1 ||
      Number(restCustomHours) > 24
    : restSelectedHours === null;

  const handleSkillSelectionConfirm = useCallback(async () => {
    if (!pendingTurnForSkillSelection || !selectedSkill) return;

    const messageText = pendingTurnForSkillSelection.characterInput;
    const skillToSend = selectedSkill.trim();

    setIsSkillSelectionModalOpen(false);
    setPendingTurnForSkillSelection(null);
    setSelectedSkill("");
    setIsSending(true);

    try {
      const response = await authFetch(`${apiBaseUrl}/turns`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: messageText,
          selectedSkill: skillToSend,
          skillSelectionMode: "manual",
          language,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || "Failed to send message");
      }

      startPolling(data.turnId);
    } catch (err) {
      console.error("Failed to submit with skill selection:", err);
      setIsSending(false);
      setIsSkillSelectionModalOpen(true);
      alert(
        "Failed to submit action: " +
          (err instanceof Error ? err.message : "Unknown error")
      );
    }
  }, [
    pendingTurnForSkillSelection,
    selectedSkill,
    apiBaseUrl,
    language,
    startPolling,
    setSelectedSkill,
  ]);

  const handleSkillSelectionCancel = useCallback(() => {
    setIsSkillSelectionModalOpen(false);
    setPendingTurnForSkillSelection(null);
    setSelectedSkill("");
    setIsSending(false);
  }, [setSelectedSkill]);

  return (
    <div className="game-chat-container backdrop-blur-sm border border-slate-200 shadow-md rounded-lg">
      <SkillSelectionModal
        isOpen={isSkillSelectionModalOpen}
        pendingTurn={pendingTurnForSkillSelection}
        availableSkills={availableSkills}
        selectedSkill={selectedSkill}
        setSelectedSkill={setSelectedSkill}
        onConfirm={handleSkillSelectionConfirm}
        onCancel={handleSkillSelectionCancel}
        language={language}
      />

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

      <SessionInfoBar characterName={characterName} />

      <MessageList
        messages={messages}
        characterName={characterName}
        showingDiceAnimation={showingDiceAnimation}
        pendingDiceRolls={pendingDiceRolls}
        diceAnimationCompleted={diceAnimationCompleted}
        handleDiceAnimationComplete={handleDiceAnimationComplete}
        isSending={isSending}
        isPolling={isPolling}
        streamingTurnId={streamingTurnId}
        error={error}
        messagesEndRef={messagesEndRef}
        isSceneChanging={isSceneChanging}
        isInputCollapsed={isInputCollapsed}
      />

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
        isPolling={isPolling}
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
      />

      {/* Rest Modal - centered over the entire GameChat interface */}
      {restModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{
            backdropFilter: "blur(4px)",
            background: "rgba(15,23,42,0.45)",
          }}
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
                const tier = h < 4 ? "none" : h < 8 ? "fatigue" : "full";
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

            {/* Cancel */}
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
    </div>
  );
}
