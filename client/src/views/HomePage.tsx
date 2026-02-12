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
  const { t } = useTranslation(['checkpoint', 'common']);
  const navigate = useNavigate();
  const gameSession = useGameSession();
  const { language, handleLanguageChange } = useAppSettings();

  const [showCheckpointSelector, setShowCheckpointSelector] = useState(false);
  const [showModManager, setShowModManager] = useState(false);
  const [checkpoints, setCheckpoints] = useState<any[]>([]);
  const [loadingCheckpoints, setLoadingCheckpoints] = useState(false);

  // Handle continue game - show checkpoint selector
  const handleContinueGame = async () => {
    setShowCheckpointSelector(true);
    setLoadingCheckpoints(true);

    try {
      const response = await authFetch(
        `/api/checkpoints/list?sessionId=all&limit=50`
      );
      const data = await response.json();

      if (data.success) {
        setCheckpoints(data.checkpoints || []);
      } else {
        alert(
          t('checkpoint:errors.loadFailed') + ": " + (data.error || t('common:error.generic'))
        );
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
    await gameSession.loadCheckpoint(checkpointId, language);
    setShowCheckpointSelector(false);
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
        onLoad={handleLoadCheckpoint}
        onDelete={handleDeleteCheckpoint}
        onBatchDelete={handleBatchDeleteCheckpoints}
      />

      <LanguageToggle
        language={language}
        onLanguageChange={handleLanguageChange}
      />
    </>
  );
};
