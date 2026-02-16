import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import Homes from "./Homes";
import { ModManager } from "../components/ModManager";
import { CheckpointSelectorModal } from "../components/modals/CheckpointSelectorModal";
import { LanguageToggle } from "../components/layout/LanguageToggle";
import { useGameSession } from "../hooks/useGameSession";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { authFetch } from "../utils/authFetch";

export const HomePage: React.FC = () => {
  const { t } = useTranslation(['checkpoint', 'common', 'game']);
  const navigate = useNavigate();
  const gameSession = useGameSession();
  const { language, handleLanguageChange } = useAppSettings();

  const [showCheckpointSelector, setShowCheckpointSelector] = useState(false);
  const [showModManager, setShowModManager] = useState(false);
  const [checkpoints, setCheckpoints] = useState<any[]>([]);
  const [loadingCheckpoints, setLoadingCheckpoints] = useState(false);
  const [loadingCheckpoint, setLoadingCheckpoint] = useState(false);
  const [loadFeedback, setLoadFeedback] = useState<{
    open: boolean;
    title: string;
    message: string;
    isError: boolean;
  }>({
    open: false,
    title: "",
    message: "",
    isError: false,
  });

  const sleep = (ms: number) =>
    new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });

  // Handle continue game - show checkpoint selector
  const handleContinueGame = async () => {
    setShowCheckpointSelector(true);
    setLoadingCheckpoints(true);

    try {
      const maxRetries = 3;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const response = await authFetch(
            `/api/checkpoints/list?sessionId=all&limit=50`
          );

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const data = await response.json();
          if (!data.success) {
            throw new Error(data.error || t("common:error.generic"));
          }

          setCheckpoints(data.checkpoints || []);
          lastError = null;
          break;
        } catch (error) {
          lastError =
            error instanceof Error ? error : new Error(String(error));
          console.warn(
            `[HomePage] load checkpoints attempt ${attempt}/${maxRetries} failed:`,
            lastError.message
          );

          if (attempt < maxRetries) {
            await sleep(400 * attempt);
          }
        }
      }

      if (lastError) {
        alert(`${t("checkpoint:errors.loadFailed")}: ${lastError.message}`);
      }
    } catch (error) {
      console.error("Error loading checkpoints:", error);
      alert(t('common:error.network'));
    } finally {
      setLoadingCheckpoints(false);
    }
  };

  // Handle checkpoint deletion
  const handleDeleteCheckpoint = async (
    checkpointId: string,
    checkpointName: string,
    e: React.MouseEvent
  ) => {
    e.stopPropagation();

    const confirmed = window.confirm(
      t('checkpoint:confirmDeleteNamed', { name: checkpointName || t('checkpoint:unnamed') })
    );

    if (!confirmed) {
      return;
    }

    try {
      const response = await authFetch(`/api/checkpoints/${checkpointId}`, {
        method: "DELETE",
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // Refresh checkpoint list
        await handleContinueGame();
      } else {
        alert(
          t('checkpoint:errors.deleteFailed') + ": " + (data.error || t('common:error.generic'))
        );
      }
    } catch (error) {
      console.error("Error deleting checkpoint:", error);
      alert(t('common:error.network'));
    }
  };

  // Handle batch checkpoint deletion
  const handleBatchDeleteCheckpoints = async (checkpointIds: string[]) => {
    try {
      const response = await authFetch("/api/checkpoints/batch-delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ checkpointIds }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        alert(data.message || t('checkpoint:success.batchDeleted', { count: data.deletedCount }));
        // Refresh checkpoint list
        await handleContinueGame();
      } else {
        alert(t('checkpoint:errors.deleteFailed') + ": " + (data.error || t('common:error.generic')));
      }
    } catch (error) {
      console.error("Error batch deleting checkpoints:", error);
      alert(t('common:error.network'));
    }
  };

  // Handle checkpoint selection and load
  const handleLoadCheckpoint = async (checkpointId: string) => {
    setLoadingCheckpoint(true);
    const result = await gameSession.loadCheckpoint(checkpointId, language);
    setLoadingCheckpoint(false);

    if (result.success) {
      setShowCheckpointSelector(false);
      setLoadFeedback({
        open: true,
        title: t("checkpoint:success.loaded"),
        message: result.notice || t("checkpoint:success.loaded"),
        isError: false,
      });
      return;
    }

    setLoadFeedback({
      open: true,
      title: t("checkpoint:errors.loadFailed"),
      message: result.error || t("common:error.generic"),
      isError: true,
    });
  };

  return (
    <>
      <Homes
        onCreate={() => navigate("/character/create")}
        onStartGame={() => navigate("/mod/select")}
        onContinueGame={handleContinueGame}
        onManageMods={() => setShowModManager(true)}
      />

      {showModManager && (
        <ModManager onClose={() => setShowModManager(false)} />
      )}

      <CheckpointSelectorModal
        open={showCheckpointSelector}
        onClose={() => setShowCheckpointSelector(false)}
        checkpoints={checkpoints}
        loadingCheckpoints={loadingCheckpoints}
        loadingCheckpoint={loadingCheckpoint}
        onLoad={handleLoadCheckpoint}
        onDelete={handleDeleteCheckpoint}
        onBatchDelete={handleBatchDeleteCheckpoints}
      />

      {loadFeedback.open && (
        <div className="checkpoint-feedback-overlay">
          <div className="checkpoint-feedback-modal">
            <h3 className="checkpoint-feedback-title">{loadFeedback.title}</h3>
            <p
              className={`checkpoint-feedback-message ${loadFeedback.isError ? "error" : ""}`}
            >
              {loadFeedback.message}
            </p>
            <div className="checkpoint-feedback-actions">
              <button
                className="checkpoint-feedback-btn"
                onClick={() => {
                  const shouldNavigate = !loadFeedback.isError;
                  setLoadFeedback((prev) => ({ ...prev, open: false }));
                  if (shouldNavigate) {
                    navigate("/game");
                  }
                }}
              >
                {t("common:button.ok")}
              </button>
            </div>
          </div>
        </div>
      )}

      <LanguageToggle
        language={language}
        onLanguageChange={handleLanguageChange}
      />

      <style>{`
        .checkpoint-feedback-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1200;
          padding: 20px;
        }
        @supports (backdrop-filter: blur(4px)) {
          .checkpoint-feedback-overlay {
            background: rgba(0, 0, 0, 0.3);
          }
        }
        .checkpoint-feedback-modal {
          background: rgba(255, 255, 255, 0.8);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.5);
          border-radius: 1.5rem;
          max-width: 520px;
          width: 100%;
          padding: 24px;
          box-shadow: 0 30px 80px rgba(15, 23, 42, 0.25);
        }
        @supports (backdrop-filter: blur(16px)) {
          .checkpoint-feedback-modal {
            background: rgba(255, 255, 255, 0.55);
          }
        }
        .checkpoint-feedback-title {
          margin: 0 0 10px;
          font-size: 1.2rem;
          color: var(--title, #3d2f1f);
        }
        .checkpoint-feedback-message {
          margin: 0;
          color: #444;
          line-height: 1.5;
          white-space: pre-wrap;
        }
        .checkpoint-feedback-message.error {
          color: #b42318;
        }
        .checkpoint-feedback-actions {
          display: flex;
          justify-content: flex-end;
          margin-top: 16px;
        }
        .checkpoint-feedback-btn {
          background: #6b5a45;
          color: #fff;
          border: 1px solid #6b5a45;
          border-radius: 6px;
          padding: 8px 14px;
          cursor: pointer;
          font-weight: 600;
          transition: all 0.2s ease-in-out;
        }
        .checkpoint-feedback-btn:hover {
          filter: brightness(1.05);
        }
      `}</style>
    </>
  );
};
