import type React from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { GameChat } from "../components/GameChat";
import { GameSidebar } from "../components/GameSidebar";
import { SidebarToggleButton } from "../components/layout/SidebarToggleButton";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useGameSession } from "../hooks/useGameSession";
import { useMobileSidebar } from "../hooks/useMobileSidebar";

export const GamePage: React.FC = () => {
  const { t } = useTranslation("game");
  const navigate = useNavigate();
  const gameSession = useGameSession();
  const { language } = useAppSettings();
  const { isMobile, isSidebarOpen, toggleSidebar, closeSidebar } =
    useMobileSidebar();

  // Redirect to home if no active session
  useEffect(() => {
    if (!gameSession.sessionId && !gameSession.isRestoringSession) {
      navigate("/");
    }
  }, [gameSession.sessionId, gameSession.isRestoringSession, navigate]);

  // ESC key handler for closing drawer
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

  // Still restoring session, show loading
  if (!gameSession.sessionId && gameSession.isRestoringSession) {
    return (
      <div style={{ padding: "20px", textAlign: "center" }}>
        <p>{t("session.restoringSession")}</p>
      </div>
    );
  }

  // If no valid session after restoration attempt
  if (!gameSession.sessionId) {
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
          {gameSession.currentModuleName
            ? t("session.titleWithModule", {
                module: gameSession.currentModuleName,
              })
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
        <GameChat
          sessionId={gameSession.sessionId}
          apiBaseUrl="/api"
          characterName={gameSession.characterName}
          moduleIntroduction={gameSession.moduleIntroduction}
          initialMessages={gameSession.conversationHistory || undefined}
          onNarrativeComplete={() => gameSession.triggerSidebarRefresh()}
          language={language}
        />

        {/* Backdrop overlay - only on mobile when drawer is open */}
        {isMobile && isSidebarOpen && (
          <div className="sidebar-backdrop" onClick={closeSidebar} />
        )}

        <GameSidebar
          sessionId={gameSession.sessionId}
          apiBaseUrl="/api"
          refreshTrigger={gameSession.sidebarRefreshTrigger}
          isMobile={isMobile}
          isOpen={isSidebarOpen}
          onClose={closeSidebar}
        />
      </div>
    </div>
  );
};
