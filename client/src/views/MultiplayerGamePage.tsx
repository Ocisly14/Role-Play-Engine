/**
 * MultiplayerGamePage — Main multiplayer game view.
 *
 * Mirrors GamePage structure with:
 *   - Shared chat (all players in same scene room see each other's messages)
 *   - Per-player sidebar (each player's own character data)
 *   - Skip button for multiplayer turns
 *   - WebSocket for real-time round results
 */

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { GameSidebar } from "../components/GameSidebar";
import { SidebarToggleButton } from "../components/layout/SidebarToggleButton";
import { InputArea } from "../components/gamechat/InputArea";
import { MessageList } from "../components/gamechat/MessageList";
import { SessionInfoBar } from "../components/gamechat/SessionInfoBar";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useInputCollapse } from "../hooks/useInputCollapse";
import { useMobileSidebar } from "../hooks/useMobileSidebar";
import { useMultiplayerWebSocket } from "../hooks/useMultiplayerWebSocket";
import { useSkillSelection } from "../hooks/useSkillSelection";
import type { Message, PendingDiceRolls } from "../types/gamechat";
import { authFetch } from "../utils/authFetch";

interface GameStateInfo {
  sessionId: string;
  sceneRooms: Array<{
    sceneRoomId: string;
    scenarioName: string | null;
    roundNumber: number;
    memberPlayerIds: string[];
    isBattle: boolean;
  }>;
  moduleName: string;
  gameDay: number;
  timeOfDay: string;
  gameEnding: any;
}

interface RoomOverview {
  roomId: string;
  moduleName: string | null;
  members: Array<{
    userId: string;
    characterId: string | null;
    role: string;
    currentSceneRoomId?: string;
  }>;
}

export const MultiplayerGamePage: React.FC = () => {
  const { t } = useTranslation("game");
  const { t: tHome } = useTranslation("home");
  const navigate = useNavigate();
  const { roomId } = useParams<{ roomId: string }>();
  const { language } = useAppSettings();
  const { isMobile, isSidebarOpen, toggleSidebar, closeSidebar } =
    useMobileSidebar();

  // Core state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sceneRoomId, setSceneRoomId] = useState<string | null>(null);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [characterName, setCharacterName] = useState("Investigator");
  const [moduleName, setModuleName] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [isGameEnded, setIsGameEnded] = useState(false);
  const [sidebarRefreshTrigger, setSidebarRefreshTrigger] = useState(0);

  // Streaming / dice
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null);
  const [pendingDiceRolls, setPendingDiceRolls] =
    useState<PendingDiceRolls | null>(null);
  const [showingDiceAnimation, setShowingDiceAnimation] = useState(false);
  const [diceAnimationCompleted, setDiceAnimationCompleted] = useState(false);

  // Refs
  const messagesRef = useRef<Message[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamingBlockedRef = useRef<Set<string>>(new Set());
  const streamingBufferRef = useRef<Map<string, string>>(new Map());

  // Input collapse
  const {
    isInputCollapsed,
    handleInputAreaMouseEnter,
    handleInputAreaMouseLeave,
  } = useInputCollapse({ inputValue });

  // Skill selection
  const apiBaseUrl = `/api/multiplayer/rooms/${roomId}`;
  const {
    availableSkills,
    selectedSkill,
    setSelectedSkill,
    isSkillAuto,
    setIsSkillAuto,
    suggestedSkills,
    isSuggesting,
    isSkillPickerOpen,
    setIsSkillPickerOpen,
  } = useSkillSelection({
    apiBaseUrl,
    inputValue,
    isGameEnded,
    language: language as "en" | "zh",
  });

  // Keep messages ref in sync
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Trigger sidebar refresh callback
  const triggerSidebarRefresh = useCallback(() => {
    setSidebarRefreshTrigger((n) => n + 1);
  }, []);

  // Initialize: fetch game state + room overview + turn history
  useEffect(() => {
    if (!roomId) return;

    const init = async () => {
      try {
        setIsLoading(true);
        setLoadError(null);

        // 1. Get game state (sessionId, sceneRooms)
        const stateRes = await authFetch(
          `/api/multiplayer/rooms/${roomId}/game/state`
        );
        const stateData = await stateRes.json();
        if (!stateData.success) {
          throw new Error(stateData.error ?? "Failed to get game state");
        }
        const gs = stateData as GameStateInfo;
        setSessionId(gs.sessionId);
        setModuleName(gs.moduleName);

        if (gs.gameEnding?.isEnded) {
          setIsGameEnded(true);
        }

        // 2. Get room overview (find my character + sceneRoom)
        const overviewRes = await authFetch(
          `/api/multiplayer/rooms/${roomId}/overview`
        );
        const overviewData = await overviewRes.json();
        if (!overviewData.success) {
          throw new Error(overviewData.error ?? "Failed to get room overview");
        }
        const overview = overviewData.room as RoomOverview;

        // Find current user from localStorage
        const userJson = localStorage.getItem("user");
        const userId = userJson ? JSON.parse(userJson)?.id : null;

        const myMember = overview.members.find((m) => m.userId === userId);
        if (myMember?.characterId) {
          setCharacterId(myMember.characterId);
        }

        // Find which sceneRoom this user belongs to
        let mySceneRoomId: string | null = null;
        if (myMember?.currentSceneRoomId) {
          mySceneRoomId = myMember.currentSceneRoomId;
        } else if (gs.sceneRooms.length > 0) {
          // Find first sceneRoom containing this userId
          const myRoom = gs.sceneRooms.find((sr) =>
            sr.memberPlayerIds.includes(userId)
          );
          mySceneRoomId = myRoom?.sceneRoomId ?? gs.sceneRooms[0].sceneRoomId;
        }
        setSceneRoomId(mySceneRoomId);

        // 3. Fetch character name
        if (myMember?.characterId) {
          try {
            const charRes = await authFetch(
              `/api/characters/${myMember.characterId}`
            );
            const charData = await charRes.json();
            if (charData.success && charData.character?.name) {
              setCharacterName(charData.character.name);
            }
          } catch {
            // Non-critical, keep default
          }
        }

        // 4. Fetch turn history
        if (mySceneRoomId) {
          try {
            const turnsRes = await authFetch(
              `/api/multiplayer/rooms/${roomId}/scene-rooms/${mySceneRoomId}/turns`
            );
            const turnsData = await turnsRes.json();
            if (turnsData.success && turnsData.messages) {
              setMessages(turnsData.messages as Message[]);
            }
          } catch {
            // Non-critical
          }
        }
      } catch (err) {
        console.error("[MultiplayerGame] Init error:", err);
        setLoadError((err as Error).message);
      } finally {
        setIsLoading(false);
      }
    };

    init();
  }, [roomId]);

  // WebSocket connection
  useMultiplayerWebSocket({
    sessionId,
    sceneRoomId,
    isGameEnded,
    characterName,
    messagesRef,
    setMessages,
    setIsWaiting,
    setIsGameEnded,
    onNarrativeComplete: triggerSidebarRefresh,
    streamingBlockedRef,
    streamingBufferRef,
    setStreamingTurnId,
    setPendingDiceRolls,
    setShowingDiceAnimation,
    setDiceAnimationCompleted,
  });

  // ESC key to close sidebar drawer
  useEffect(() => {
    if (!isMobile) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isSidebarOpen) closeSidebar();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isMobile, isSidebarOpen, closeSidebar]);

  // Send message
  const handleSendMessage = useCallback(async () => {
    if (!inputValue.trim() || isSending || isWaiting || isGameEnded || !sceneRoomId || !characterId)
      return;

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

    // Optimistic add
    const userMessage: Message = {
      role: "character" as const,
      content: messageText,
      timestamp: new Date().toISOString(),
      turnNumber: nextTurnNumber,
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
      if (!data.success) throw new Error(data.error ?? "Failed to submit");

      setSelectedSkill("");
      // If "processing", round has begun; if "waiting", we wait for others
      if (data.status === "waiting") {
        setIsWaiting(true);
      }
      setIsSending(false);
    } catch (err) {
      console.error("[MultiplayerGame] Send failed:", err);
      setIsSending(false);
      // Roll back optimistic message
      setMessages((prev) =>
        prev.filter(
          (msg) =>
            !(
              msg.role === "character" &&
              msg.content === messageText &&
              msg.turnNumber === nextTurnNumber
            )
        )
      );
      alert((err as Error).message);
    }
  }, [
    inputValue,
    isSending,
    isWaiting,
    isGameEnded,
    sceneRoomId,
    characterId,
    roomId,
    selectedSkill,
    isSkillAuto,
    messages,
    language,
    setMessages,
    setSelectedSkill,
    setIsSkillPickerOpen,
  ]);

  // Skip turn
  const handleSkip = useCallback(async () => {
    if (isSending || isWaiting || isGameEnded || !sceneRoomId || !characterId)
      return;

    setIsSending(true);
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
      if (!data.success) throw new Error(data.error ?? "Failed to skip");

      if (data.status === "waiting") {
        setIsWaiting(true);
      }
      setIsSending(false);
    } catch (err) {
      console.error("[MultiplayerGame] Skip failed:", err);
      setIsSending(false);
      alert((err as Error).message);
    }
  }, [isSending, isWaiting, isGameEnded, sceneRoomId, characterId, roomId, language]);

  // Key handler
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

  // Dice animation complete
  const handleDiceAnimationComplete = useCallback(() => {
    if (!pendingDiceRolls) return;

    setDiceAnimationCompleted(true);

    // Unblock streaming for this turn
    if (pendingDiceRolls.turnId) {
      streamingBlockedRef.current.delete(pendingDiceRolls.turnId);
      const buffered = streamingBufferRef.current.get(pendingDiceRolls.turnId);
      if (buffered) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.turnId === pendingDiceRolls.turnId
              ? { ...msg, content: msg.content + buffered }
              : msg
          )
        );
        streamingBufferRef.current.delete(pendingDiceRolls.turnId);
      }
    }

    // If we have a non-streaming narrative, add it
    if (pendingDiceRolls.narrative && !pendingDiceRolls.isStreaming) {
      setMessages((prev) => {
        const existing = prev.find(
          (m) =>
            m.role === "keeper" &&
            m.turnId === pendingDiceRolls.turnId
        );
        if (existing) return prev;

        return [
          ...prev,
          {
            role: "keeper" as const,
            content: pendingDiceRolls.narrative,
            timestamp: pendingDiceRolls.timestamp,
            turnNumber: pendingDiceRolls.turnNumber,
            turnId: pendingDiceRolls.turnId,
            diceRolls: pendingDiceRolls.diceRolls,
            gameDay: pendingDiceRolls.gameDay ?? null,
            gameTime: pendingDiceRolls.gameTime ?? null,
          },
        ];
      });
    }

    setTimeout(() => {
      setShowingDiceAnimation(false);
      setPendingDiceRolls(null);
      setDiceAnimationCompleted(false);
    }, 500);
  }, [pendingDiceRolls, setMessages]);

  // Loading / error states
  if (isLoading) {
    return (
      <div style={{ padding: "20px", textAlign: "center" }}>
        <p>{tHome("multiplayer.gameInitializing")}</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={{ padding: "20px", textAlign: "center" }}>
        <p style={{ color: "#b91c1c" }}>{loadError}</p>
        <button
          type="button"
          onClick={() => navigate("/multiplayer")}
          className="secondary"
          style={{ marginTop: "12px" }}
        >
          {tHome("multiplayer.backToLobby")}
        </button>
      </div>
    );
  }

  return (
    <div className="game-container">
      {/* Header */}
      <div className="game-header backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg">
        {isMobile ? (
          <button
            onClick={() => navigate("/")}
            className="back-button backdrop-blur-md bg-white/50 border border-slate-200 shadow-md rounded-xl hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 transition-all"
            style={{ padding: "8px 12px" }}
            aria-label={t("session.backToHome")}
          >
            ←
          </button>
        ) : (
          <div style={{ width: "52px" }} aria-hidden="true" />
        )}

        <h1>
          {moduleName
            ? t("session.titleWithModule", { module: moduleName })
            : t("session.title")}
        </h1>

        {isMobile && !isSidebarOpen && (
          <SidebarToggleButton onClick={toggleSidebar} />
        )}
        {!isMobile && (
          <button
            onClick={() => navigate("/")}
            className="back-button backdrop-blur-md bg-white/50 border border-slate-200 shadow-md rounded-xl hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 transition-all"
            style={{ padding: "8px 12px" }}
            aria-label={t("session.backToHome")}
          >
            ←
          </button>
        )}
      </div>

      {/* Main layout */}
      <div className="game-main-layout">
        {/* Chat area */}
        <div className="game-chat">
          {/* Session info */}
          <SessionInfoBar
            characterName={characterName}
            onSaveCheckpoint={async () => {
              try {
                await authFetch(
                  `/api/multiplayer/rooms/${roomId}/checkpoints/save`,
                  { method: "POST" }
                );
              } catch {}
            }}
            isSaving={false}
            saveMessage={null}
          />

          {/* Messages */}
          <MessageList
            messages={messages}
            characterName={characterName}
            showingDiceAnimation={showingDiceAnimation}
            pendingDiceRolls={pendingDiceRolls}
            diceAnimationCompleted={diceAnimationCompleted}
            handleDiceAnimationComplete={handleDiceAnimationComplete}
            isSending={isSending}
            isPolling={isWaiting}
            streamingTurnId={streamingTurnId}
            error={null}
            messagesEndRef={messagesEndRef}
            isSceneChanging={false}
            isInputCollapsed={isInputCollapsed}
          />

          {/* Input area */}
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
            isCombatSkillRequired={false}
            canSendInCombat={true}
            isInputCollapsed={isInputCollapsed}
            isSceneChanging={false}
            language={language as "en" | "zh"}
            handleInputAreaMouseEnter={handleInputAreaMouseEnter}
            handleInputAreaMouseLeave={handleInputAreaMouseLeave}
            handleSendMessage={handleSendMessage}
            handleKeyDown={handleKeyDown}
            onSkip={handleSkip}
            isWaitingForOthers={isWaiting}
          />
        </div>

        {/* Sidebar backdrop (mobile) */}
        {isMobile && isSidebarOpen && (
          <div className="sidebar-backdrop" onClick={closeSidebar} />
        )}

        {/* Sidebar */}
        {sessionId && (
          <GameSidebar
            sessionId={sessionId}
            apiBaseUrl={apiBaseUrl}
            refreshTrigger={sidebarRefreshTrigger}
            isMobile={isMobile}
            isOpen={isSidebarOpen}
            onClose={closeSidebar}
          />
        )}
      </div>
    </div>
  );
};
