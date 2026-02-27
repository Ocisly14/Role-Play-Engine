import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { FrameImage } from "../components/FrameImage";
import { authFetch } from "../utils/authFetch";

export const MultiplayerLobby: React.FC = () => {
  const { t } = useTranslation("home");
  const navigate = useNavigate();

  const [creating, setCreating] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreateRoom = async () => {
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
                onClick={handleCreateRoom}
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
    </div>
  );
};
