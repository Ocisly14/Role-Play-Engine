/**
 * GameChat - Main game chat component
 *
 * This component integrates all custom hooks and presentational components
 * for the game chat interface.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useTurnPolling, type TurnStatus } from "../hooks/useTurnPolling";
import { useInputCollapse } from "../hooks/useInputCollapse";
import { useSceneTransition } from "../hooks/useSceneTransition";
import { useAutoSave } from "../hooks/useAutoSave";
import { useDiceAnimation } from "../hooks/useDiceAnimation";
import { useGameMessages } from "../hooks/useGameMessages";
import { useSkillSelection } from "../hooks/useSkillSelection";
import { useWebSocket } from "../hooks/useWebSocket";
import { authFetch } from "../utils/authFetch";
import type {
  Message,
  GameEndingInfo,
  GameState,
  GameChatProps,
} from "../types/gamechat";
import { buildDiceRollInfos } from "./gamechat/utils";
import { SessionInfoBar } from "./gamechat/SessionInfoBar";
import { MessageList } from "./gamechat/MessageList";
import { InputArea } from "./gamechat/InputArea";
import { SkillSelectionModal } from "./gamechat/SkillSelectionModal";

export function GameChat({
  sessionId,
  apiBaseUrl = "/api",
  characterName = "Investigator",
  moduleIntroduction,
  initialMessages,
  onNarrativeComplete,
  language = "en",
}: GameChatProps) {
  const { t } = useTranslation('game');

  // Local component state
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isGameEnded, setIsGameEnded] = useState(false);
  const [currentGameState, setCurrentGameState] = useState<{
    gameDay?: number;
    timeOfDay?: string;
  } | null>(null);
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
  } =
    useSceneTransition();

  const { updateLastSavedTurnNumber, triggerAutoSave } = useAutoSave({
    apiBaseUrl,
    sessionId,
    messagesRef,
  });

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
    updateLastSavedTurnNumber,
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
  }, [apiBaseUrl, sessionId, selectedSkill, normalizeSkills, setAvailableSkills, setSelectedSkill]);

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
      const allDiceRolls = buildDiceRollInfos(
        mainActionResults,
        characterName
      );

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

  // Event handlers
  const handleSendMessage = useCallback(async () => {
    if (!inputValue.trim() || isSending || isGameEnded) return;

    const messageText = inputValue.trim();
    const trimmedSkill = selectedSkill.trim();
    const hasSelectedSkill = trimmedSkill.length > 0;
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

  const handleSaveCheckpoint = useCallback(async () => {
    if (isSaving) return;

    setIsSaving(true);
    setSaveMessage(null);

    try {
      const response = await authFetch(`${apiBaseUrl}/checkpoints/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || "Failed to save checkpoint");
      }

      setSaveMessage("✓ Checkpoint saved successfully");
      updateLastSavedTurnNumber(messagesRef.current);

      setTimeout(() => {
        setSaveMessage(null);
      }, 3000);
    } catch (err) {
      console.error("Failed to save checkpoint:", err);
      setSaveMessage(
        "Failed to save: " +
          (err instanceof Error ? err.message : "Unknown error")
      );
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, apiBaseUrl, updateLastSavedTurnNumber, messagesRef]);

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

      <SessionInfoBar
        characterName={characterName}
        isSaving={isSaving}
        saveMessage={saveMessage}
        onSaveCheckpoint={handleSaveCheckpoint}
      />

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
        isInputCollapsed={isInputCollapsed}
        isSceneChanging={isSceneChanging}
        language={language}
        handleInputAreaMouseEnter={handleInputAreaMouseEnter}
        handleInputAreaMouseLeave={handleInputAreaMouseLeave}
        handleSendMessage={handleSendMessage}
        handleKeyDown={handleKeyDown}
      />
    </div>
  );
}
