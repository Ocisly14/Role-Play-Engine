import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { GameChat } from "../components/GameChat";
import { GameSidebar } from "../components/GameSidebar";
import { useGameSession } from "../hooks/useGameSession";
import { useAppSettings } from "../contexts/AppSettingsContext";

export const GamePage: React.FC = () => {
  const { t } = useTranslation("game");
  const navigate = useNavigate();
  const gameSession = useGameSession();
  const { language } = useAppSettings();

  // Redirect to home if no active session
  useEffect(() => {
    if (!gameSession.sessionId && !gameSession.isRestoringSession) {
      navigate("/");
    }
  }, [gameSession.sessionId, gameSession.isRestoringSession, navigate]);

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
      <div className="game-header backdrop-blur-sm border border-slate-200 shadow-md rounded-lg">
        <h1>
          {gameSession.currentModuleName
            ? t("session.titleWithModule", {
                module: gameSession.currentModuleName,
              })
            : t("session.title")}
        </h1>
        <button
          onClick={() => navigate("/")}
          className="back-button backdrop-blur-md bg-white/50 border border-slate-200 shadow-md rounded-xl px-5 py-2.5 hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 transition-all"
        >
          ← {t("session.backToHome")}
        </button>
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
        <GameSidebar
          sessionId={gameSession.sessionId}
          apiBaseUrl="/api"
          refreshTrigger={gameSession.sidebarRefreshTrigger}
        />
      </div>
    </div>
  );
};
