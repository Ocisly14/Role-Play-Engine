import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { FrameImage } from "../components/FrameImage";
import { useAuth } from "../contexts/AuthContext";
import { useMultiplayerRoom } from "../hooks/useMultiplayerRoom";
import { authFetch } from "../utils/authFetch";

interface Character {
  character_id: string;
  name: string;
  occupation: string | null;
}

interface Mod {
  name: string;
}

export const MultiplayerRoomWaiting: React.FC = () => {
  const { t } = useTranslation("home");
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { room, loading, error, refetch } = useMultiplayerRoom(roomId ?? null);

  const [characters, setCharacters] = useState<Character[]>([]);
  const [mods, setMods] = useState<Mod[]>([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState("");
  const [selectedModuleName, setSelectedModuleName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fetch characters and mods on mount
  useEffect(() => {
    authFetch("/api/characters")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setCharacters(d.characters as Character[]);
      })
      .catch(() => {});

    authFetch("/api/mods/shared")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setMods(d.mods as Mod[]);
      })
      .catch(() => {});
  }, []);

  // Navigate away when game starts
  useEffect(() => {
    if (room?.status === "playing") {
      console.log("[Multiplayer] Game started, room:", room.roomId);
    }
  }, [room?.status, room?.roomId]);

  // Loading state
  if (loading && !room) {
    return (
      <div className="home">
        <div className="home-frame">
          <FrameImage />
          <div className="fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] max-w-[640px] max-h-[90vh] w-full overflow-y-auto rounded-3xl supports-[backdrop-filter]:backdrop-blur-lg border border-white/50 bg-white/80 shadow-[0_30px_80px_rgba(15,23,42,0.25)] supports-[backdrop-filter]:bg-white/55 flex flex-col">
            <div className="p-12 text-center">
              <p style={{ color: "#666" }}>{t("multiplayer.loadingRoom")}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Error / not found state
  if (error || !room) {
    return (
      <div className="home">
        <div className="home-frame">
          <FrameImage />
          <div className="fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] max-w-[640px] max-h-[90vh] w-full overflow-y-auto rounded-3xl supports-[backdrop-filter]:backdrop-blur-lg border border-white/50 bg-white/80 shadow-[0_30px_80px_rgba(15,23,42,0.25)] supports-[backdrop-filter]:bg-white/55 flex flex-col">
            <div className="p-12 text-center space-y-4">
              <div className="backdrop-blur-sm bg-red-50/60 border border-red-200 rounded-xl p-4">
                <p style={{ color: "#b91c1c" }}>{error ?? t("multiplayer.roomNotFound")}</p>
              </div>
              <button
                type="button"
                onClick={() => navigate("/multiplayer")}
                className="secondary"
                style={{ width: "100%" }}
              >
                {t("multiplayer.backToLobby")}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const myMember = room.members.find((m) => m.userId === user?.id);
  const allConfirmed = room.members.every((m) => m.confirmStatus === "confirmed");
  const canStart =
    room.isHost && allConfirmed && !!room.moduleName && room.members.length >= 1;

  const handleSelectCharacter = async (characterId: string) => {
    if (!characterId) return;
    setActionError(null);
    setBusy(true);
    try {
      const res = await authFetch(
        `/api/multiplayer/rooms/${room.roomId}/select-character`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ characterId }),
        }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? t("multiplayer.selectCharFailed"));
      await refetch();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmReady = async () => {
    setActionError(null);
    setBusy(true);
    try {
      const res = await authFetch(
        `/api/multiplayer/rooms/${room.roomId}/confirm`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? t("multiplayer.confirmFailed"));
      await refetch();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCancelReady = async () => {
    setActionError(null);
    setBusy(true);
    try {
      const res = await authFetch(
        `/api/multiplayer/rooms/${room.roomId}/unconfirm`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? t("multiplayer.cancelFailed"));
      await refetch();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSelectModule = async (moduleName: string) => {
    if (!moduleName) return;
    setActionError(null);
    setBusy(true);
    try {
      const res = await authFetch(
        `/api/multiplayer/rooms/${room.roomId}/select-module`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ moduleName }),
        }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? t("multiplayer.selectModFailed"));
      await refetch();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleStartGame = async () => {
    setActionError(null);
    setBusy(true);
    try {
      const startRes = await authFetch(
        `/api/multiplayer/rooms/${room.roomId}/start`,
        { method: "POST" }
      );
      const startData = await startRes.json();
      if (!startData.success) throw new Error(startData.error ?? t("multiplayer.startFailed"));

      const initRes = await authFetch(
        `/api/multiplayer/rooms/${room.roomId}/game/init`,
        { method: "POST" }
      );
      const initData = await initRes.json();
      if (!initData.success) throw new Error(initData.error ?? t("multiplayer.initFailed"));

      console.log("[Multiplayer] Game initialised:", initData);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="home">
      <div className="home-frame">
        <FrameImage />
        <div className="fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] max-w-[640px] max-h-[90vh] w-full overflow-y-auto rounded-3xl supports-[backdrop-filter]:backdrop-blur-lg border border-white/50 bg-white/80 shadow-[0_30px_80px_rgba(15,23,42,0.25)] supports-[backdrop-filter]:bg-white/55 flex flex-col">
          <div className="p-12 space-y-6">

            {/* Header */}
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold m-0" style={{ color: "var(--title)" }}>
                  {t("multiplayer.waitingRoom")}
                </h1>
                <p className="text-sm mt-1 m-0" style={{ color: "#666" }}>
                  {t("multiplayer.status")}:{" "}
                  <span className="capitalize" style={{ color: "var(--title)" }}>{room.status}</span>
                </p>
              </div>
              <div className="text-center">
                <p className="text-xs mb-1 m-0" style={{ color: "#666" }}>{t("multiplayer.roomCode")}</p>
                <p className="text-3xl font-mono font-bold tracking-widest m-0" style={{ color: "var(--title)" }}>
                  {room.roomCode}
                </p>
              </div>
            </div>

            {/* Module info */}
            {room.moduleName && (
              <div className="backdrop-blur-sm bg-white/50 border border-slate-200 rounded-lg px-4 py-2 text-sm">
                <span style={{ color: "#666" }}>{t("multiplayer.module")}: </span>
                <span className="font-medium" style={{ color: "var(--title)" }}>{room.moduleName}</span>
              </div>
            )}

            {/* Error banner */}
            {actionError && (
              <div className="backdrop-blur-sm bg-red-50/60 border border-red-200 rounded-xl p-3 text-sm" style={{ color: "#b91c1c" }}>
                {actionError}
              </div>
            )}

            {/* Members list */}
            <div className="backdrop-blur-sm bg-white/50 border border-slate-200 rounded-xl p-4 space-y-3">
              <h2 className="text-lg font-semibold m-0" style={{ color: "var(--title)" }}>
                {t("multiplayer.players")}
              </h2>
              {room.members.map((member) => (
                <div
                  key={member.id}
                  className="flex items-center justify-between backdrop-blur-sm bg-white/60 border border-slate-200 rounded-lg px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-mono" style={{ color: "#666" }}>
                      #{member.seatOrder}
                    </span>
                    <div>
                      <p className="text-sm font-medium m-0" style={{ color: "var(--title)" }}>
                        {member.userId === user?.id ? t("multiplayer.you") : `Player ${member.seatOrder}`}
                        {member.role === "host" && (
                          <span className="ml-2 text-xs" style={{ color: "var(--accent, #8b6914)" }}>({t("multiplayer.host")})</span>
                        )}
                      </p>
                      {member.characterId && (
                        <p className="text-xs m-0" style={{ color: "#666" }}>{t("multiplayer.characterSelected")}</p>
                      )}
                    </div>
                  </div>
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-medium backdrop-blur-sm ${
                      member.confirmStatus === "confirmed"
                        ? "bg-green-50/60 border border-green-200"
                        : "bg-amber-50/60 border border-amber-200"
                    }`}
                    style={{ color: member.confirmStatus === "confirmed" ? "#166534" : "#92400e" }}
                  >
                    {member.confirmStatus === "confirmed" ? t("multiplayer.confirmed") : t("multiplayer.pending")}
                  </span>
                </div>
              ))}
            </div>

            {/* Player controls: select character + confirm */}
            {myMember && myMember.confirmStatus !== "confirmed" && (
              <div className="backdrop-blur-sm bg-white/50 border border-slate-200 rounded-xl p-4 space-y-3">
                <h2 className="text-lg font-semibold m-0" style={{ color: "var(--title)" }}>
                  {t("multiplayer.yourCharacter")}
                </h2>
                <select
                  value={selectedCharacterId}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSelectedCharacterId(val);
                    if (val) handleSelectCharacter(val);
                  }}
                  disabled={busy}
                  className="backdrop-blur-sm bg-white/60 border border-slate-200 rounded-xl px-3 py-2 focus:outline-none"
                  style={{ width: "100%", color: "var(--title)", opacity: busy ? 0.5 : 1 }}
                >
                  <option value="">{t("multiplayer.selectCharacter")}</option>
                  {characters.map((c) => (
                    <option key={c.character_id} value={c.character_id}>
                      {c.name}
                      {c.occupation ? ` — ${c.occupation}` : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleConfirmReady}
                  disabled={busy || !myMember.characterId}
                  className="primary"
                  style={{ width: "100%", opacity: (busy || !myMember.characterId) ? 0.5 : 1 }}
                >
                  {t("multiplayer.confirmReady")}
                </button>
                {!myMember.characterId && (
                  <p className="text-xs text-center m-0" style={{ color: "#92400e" }}>
                    {t("multiplayer.selectCharacterFirst")}
                  </p>
                )}
              </div>
            )}

            {/* Ready confirmation + cancel */}
            {myMember?.confirmStatus === "confirmed" && (
              <div className="backdrop-blur-sm bg-green-50/60 border border-green-200 rounded-xl p-4 space-y-3 text-center">
                <p className="font-medium m-0" style={{ color: "#166534" }}>{t("multiplayer.youAreReady")}</p>
                <p className="text-sm m-0" style={{ color: "#666" }}>{t("multiplayer.waitingForPlayers")}</p>
                <button
                  type="button"
                  onClick={handleCancelReady}
                  disabled={busy}
                  className="secondary"
                  style={{ width: "100%", opacity: busy ? 0.5 : 1 }}
                >
                  {t("multiplayer.cancelReady")}
                </button>
              </div>
            )}

            {/* Host controls: select module + start game */}
            {room.isHost && (
              <div className="backdrop-blur-sm bg-white/50 border border-slate-200 rounded-xl p-4 space-y-3">
                <h2 className="text-lg font-semibold m-0" style={{ color: "var(--title)" }}>
                  {t("multiplayer.hostControls")}
                </h2>

                {/* Module selection */}
                <div>
                  <p className="text-sm mb-2 m-0" style={{ color: "#666" }}>{t("multiplayer.selectModule")}</p>
                  <select
                    value={selectedModuleName}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSelectedModuleName(val);
                      if (val) handleSelectModule(val);
                    }}
                    disabled={busy}
                    className="backdrop-blur-sm bg-white/60 border border-slate-200 rounded-xl px-3 py-2 focus:outline-none"
                    style={{ width: "100%", color: "var(--title)", opacity: busy ? 0.5 : 1 }}
                  >
                    <option value="">{t("multiplayer.chooseModule")}</option>
                    {mods.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Start game */}
                <button
                  type="button"
                  onClick={handleStartGame}
                  disabled={busy || !canStart}
                  className="primary"
                  style={{ width: "100%", opacity: (busy || !canStart) ? 0.5 : 1 }}
                >
                  {busy ? "..." : t("multiplayer.startGame")}
                </button>
                {!canStart && (
                  <p className="text-xs text-center m-0" style={{ color: "#666" }}>
                    {!room.moduleName
                      ? t("multiplayer.selectModuleFirst")
                      : !allConfirmed
                        ? t("multiplayer.waitingAllConfirm")
                        : ""}
                  </p>
                )}
              </div>
            )}

            {/* Leave room */}
            <button
              type="button"
              onClick={() => navigate("/multiplayer")}
              className="secondary"
              style={{ width: "100%" }}
            >
              {t("multiplayer.leaveRoom")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
