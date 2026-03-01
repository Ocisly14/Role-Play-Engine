/**
 * MultiplayerGamePage — mirrors GamePage exactly.
 *
 * Structure:
 *   game-container
 *   ├── game-header (module name, back button)
 *   └── game-main-layout
 *       ├── MultiplayerGameChat (shared chat)
 *       └── GameSidebar (per-player, apiBaseUrl="/api/multiplayer/rooms/:roomId")
 */

import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { MultiplayerGameChat } from "../components/MultiplayerGameChat";
import { GameSidebar } from "../components/GameSidebar";
import { SidebarToggleButton } from "../components/layout/SidebarToggleButton";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useMobileSidebar } from "../hooks/useMobileSidebar";
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

  // Core state — fetched on mount
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sceneRoomId, setSceneRoomId] = useState<string | null>(null);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [characterName, setCharacterName] = useState("Investigator");
  const [moduleName, setModuleName] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Sidebar refresh trigger (same pattern as GamePage via useGameSession)
  const [sidebarRefreshTrigger, setSidebarRefreshTrigger] = useState(0);
  const triggerSidebarRefresh = useCallback(() => {
    setSidebarRefreshTrigger((n) => n + 1);
  }, []);

  // Initialize: fetch game state + room overview
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
      } catch (err) {
        console.error("[MultiplayerGame] Init error:", err);
        setLoadError((err as Error).message);
      } finally {
        setIsLoading(false);
      }
    };

    init();
  }, [roomId]);

  // ESC key handler for closing drawer (mirrors GamePage)
  useEffect(() => {
    if (!isMobile) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isSidebarOpen) {
        closeSidebar();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isMobile, isSidebarOpen, closeSidebar]);

  // Loading state
  if (isLoading) {
    return (
      <div style={{ padding: "20px", textAlign: "center" }}>
        <p>{tHome("multiplayer.gameInitializing")}</p>
      </div>
    );
  }

  // Error state
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

  // No valid session after init
  if (!sessionId || !sceneRoomId || !characterId || !roomId) {
    return (
      <div style={{ padding: "20px", textAlign: "center" }}>
        <p>{t("session.loadingSession")}</p>
      </div>
    );
  }

  return (
    <div className="game-container">
      <div className="game-header backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg">
        {/* Mobile: back button on left */}
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
          <div style={{ width: "52px" }} aria-hidden="true"></div>
        )}

        {/* Title - center */}
        <h1>
          {moduleName
            ? t("session.titleWithModule", { module: moduleName })
            : t("session.title")}
        </h1>

        {/* Right corner controls */}
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

      <div className="game-main-layout">
        <MultiplayerGameChat
          roomId={roomId}
          sessionId={sessionId}
          sceneRoomId={sceneRoomId}
          characterId={characterId}
          characterName={characterName}
          onNarrativeComplete={triggerSidebarRefresh}
          language={language as "en" | "zh"}
        />

        {/* Backdrop overlay - only on mobile when drawer is open */}
        {isMobile && isSidebarOpen && (
          <div className="sidebar-backdrop" onClick={closeSidebar} />
        )}

        <GameSidebar
          sessionId={sessionId}
          apiBaseUrl={`/api/multiplayer/rooms/${roomId}`}
          refreshTrigger={sidebarRefreshTrigger}
          isMobile={isMobile}
          isOpen={isSidebarOpen}
          onClose={closeSidebar}
        />
      </div>
    </div>
  );
};
