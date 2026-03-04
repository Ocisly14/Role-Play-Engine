import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { FrameImage } from "../components/FrameImage";
import { authFetch } from "../utils/authFetch";

interface CheckpointSummary {
  checkpointId: string;
  name: string;
  createdAt: string;
  gameDay: number | null;
  timeOfDay: string | null;
  playerCount: number;
  activeScenes: string[];
}

export const MultiplayerLobby: React.FC = () => {
  const { t } = useTranslation("home");
  const navigate = useNavigate();

  const [creating, setCreating] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create room modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [loadingCheckpoints, setLoadingCheckpoints] = useState(false);

  const handleOpenCreateModal = async () => {
    setError(null);
    setShowCreateModal(true);
    setLoadingCheckpoints(true);
    try {
      const res = await authFetch("/api/multiplayer/checkpoints/mine");
      const data = await res.json();
      if (data.success) {
        setCheckpoints(data.checkpoints ?? []);
      }
    } catch {
      // Non-critical
    } finally {
      setLoadingCheckpoints(false);
    }
  };

  const handleNewGame = async () => {
    setShowCreateModal(false);
    setError(null);
    setCreating(true);
    try {
      const res = await authFetch("/api/multiplayer/rooms/create", {
        method: "POST",
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? t("multiplayer.createFailed"));
      navigate(`/multiplayer/room/${data.roomId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleCreateFromCheckpoint = async (checkpointId: string) => {
    setShowCreateModal(false);
    setError(null);
    setCreating(true);
    try {
      const res = await authFetch("/api/multiplayer/rooms/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkpointId }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? t("multiplayer.createFailed"));
      navigate(`/multiplayer/room/${data.roomId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (joinCode.trim().length !== 5) {
      setError(t("multiplayer.codeInvalid"));
      return;
    }
    setError(null);
    setJoining(true);
    try {
      const res = await authFetch("/api/multiplayer/rooms/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomCode: joinCode.trim() }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? t("multiplayer.joinFailed"));
      navigate(`/multiplayer/room/${data.roomId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="home">
      <div className="home-frame">
        <FrameImage />
        <div className="fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] max-w-[480px] max-h-[90vh] w-full overflow-y-auto rounded-3xl supports-[backdrop-filter]:backdrop-blur-lg border border-white/50 bg-white/80 shadow-[0_30px_80px_rgba(15,23,42,0.25)] supports-[backdrop-filter]:bg-white/55 flex flex-col">
          <div className="p-12 space-y-8">
            {/* Header */}
            <div className="text-center">
              <h1 className="text-3xl font-bold mb-2" style={{ color: "var(--title)" }}>
                {t("multiplayer.title")}
              </h1>
              <p className="text-sm" style={{ color: "#666" }}>
                {t("multiplayer.createRoomDesc")}
              </p>
            </div>

            {/* Error banner */}
            {error && (
              <div className="backdrop-blur-sm bg-red-50/60 border border-red-200 rounded-xl p-3 text-sm" style={{ color: "#b91c1c" }}>
                {error}
              </div>
            )}

            {/* Create Room */}
            <div className="backdrop-blur-sm bg-white/50 border border-slate-200 rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-semibold m-0" style={{ color: "var(--title)" }}>
                {t("multiplayer.createRoom")}
              </h2>
              <p className="text-sm m-0" style={{ color: "#666" }}>
                {t("multiplayer.createRoomDesc")}
              </p>
              <button
                type="button"
                onClick={handleOpenCreateModal}
                disabled={creating}
                className="primary"
                style={{ width: "100%", opacity: creating ? 0.5 : 1 }}
              >
                {creating ? t("multiplayer.creating") : t("multiplayer.createRoom")}
              </button>
            </div>

            {/* Join Room */}
            <div className="backdrop-blur-sm bg-white/50 border border-slate-200 rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-semibold m-0" style={{ color: "var(--title)" }}>
                {t("multiplayer.joinRoom")}
              </h2>
              <form onSubmit={handleJoinRoom} className="space-y-3">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={5}
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, ""))}
                  placeholder={t("multiplayer.codePlaceholder")}
                  className="backdrop-blur-sm bg-white/60 border border-slate-200 rounded-xl"
                  style={{
                    width: "100%",
                    padding: "12px 16px",
                    textAlign: "center",
                    fontSize: "1.25rem",
                    letterSpacing: "0.2em",
                    color: "var(--title)",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
                <button
                  type="submit"
                  disabled={joining || joinCode.trim().length !== 5}
                  className="primary"
                  style={{ width: "100%", opacity: (joining || joinCode.trim().length !== 5) ? 0.5 : 1 }}
                >
                  {joining ? t("multiplayer.joining") : t("multiplayer.joinRoom")}
                </button>
              </form>
            </div>

            {/* Back button */}
            <button
              type="button"
              onClick={() => navigate("/")}
              className="secondary"
              style={{ width: "100%" }}
            >
              {t("multiplayer.backToHome")}
            </button>
          </div>
        </div>
      </div>

      {/* Create Room Modal: New Game / Continue from Checkpoint */}
      {showCreateModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            onClick={() => setShowCreateModal(false)}
          />
          <div className="relative z-10 w-full max-w-[420px] mx-4 rounded-3xl supports-[backdrop-filter]:backdrop-blur-lg border border-white/50 bg-white/80 shadow-[0_30px_80px_rgba(15,23,42,0.25)] supports-[backdrop-filter]:bg-white/55 overflow-hidden">
            <div className="p-8 space-y-4">
              <h2 className="text-xl font-bold m-0" style={{ color: "var(--title)" }}>
                {t("multiplayer.newOrContinue")}
              </h2>

              {/* New Game */}
              <button
                type="button"
                onClick={handleNewGame}
                disabled={creating}
                className="primary"
                style={{ width: "100%", opacity: creating ? 0.5 : 1 }}
              >
                {t("multiplayer.newGame")}
              </button>

              {/* Continue from checkpoint */}
              <div className="backdrop-blur-sm bg-white/50 border border-slate-200 rounded-xl p-4 space-y-2">
                <h3 className="text-sm font-semibold m-0" style={{ color: "var(--title)" }}>
                  {t("multiplayer.continueGame")}
                </h3>
                {loadingCheckpoints ? (
                  <p className="text-xs m-0" style={{ color: "#666" }}>...</p>
                ) : checkpoints.length === 0 ? (
                  <p className="text-xs m-0" style={{ color: "#666" }}>
                    {t("multiplayer.noCheckpoints")}
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {checkpoints.map((cp) => (
                      <button
                        key={cp.checkpointId}
                        type="button"
                        onClick={() => handleCreateFromCheckpoint(cp.checkpointId)}
                        disabled={creating}
                        className="w-full text-left backdrop-blur-sm bg-white/60 border border-slate-200 rounded-lg px-3 py-2 hover:bg-white/80 transition-all"
                        style={{ opacity: creating ? 0.5 : 1 }}
                      >
                        <p className="text-sm font-medium m-0" style={{ color: "var(--title)" }}>
                          {cp.name}
                        </p>
                        <p className="text-xs m-0" style={{ color: "#666" }}>
                          {cp.gameDay != null && t("multiplayer.checkpointDay", { day: cp.gameDay })}
                          {cp.timeOfDay && ` ${cp.timeOfDay}`}
                          {" · "}
                          {cp.playerCount} {t("multiplayer.players")}
                          {" · "}
                          {new Date(cp.createdAt).toLocaleDateString()}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Cancel */}
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="secondary"
                style={{ width: "100%" }}
              >
                {t("multiplayer.cancelReady")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
