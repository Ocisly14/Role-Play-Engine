import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import Homes from "./Homes";
import { ModManager } from "../components/ModManager";
import { CheckpointSelectorModal } from "../components/modals/CheckpointSelectorModal";
import { LanguageToggle } from "../components/layout/LanguageToggle";
import { useGameSession } from "../hooks/useGameSession";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { authFetch } from "../utils/authFetch";

export const HomePage: React.FC = () => {
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
          "Failed to load checkpoint list: " + (data.error || "Unknown error")
        );
      }
    } catch (error) {
      console.error("Error loading checkpoints:", error);
      alert("Network error, unable to load checkpoint list");
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
      `Are you sure you want to delete checkpoint "${checkpointName || "Unnamed Checkpoint"}"?\n\nThis action cannot be undone.`
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
          "Failed to delete checkpoint: " + (data.error || "Unknown error")
        );
      }
    } catch (error) {
      console.error("Error deleting checkpoint:", error);
      alert("Network error, unable to delete checkpoint");
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
        alert(data.message || `Successfully deleted ${data.deletedCount} checkpoint(s)`);
        // Refresh checkpoint list
        await handleContinueGame();
      } else {
        alert("Failed to delete checkpoints: " + (data.error || "Unknown error"));
      }
    } catch (error) {
      console.error("Error batch deleting checkpoints:", error);
      alert("Network error, unable to delete checkpoints");
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
