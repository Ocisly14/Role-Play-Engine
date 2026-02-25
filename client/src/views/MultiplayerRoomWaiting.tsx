import type React from "react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { room, loading, error } = useMultiplayerRoom(roomId ?? null);

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
      // Phase 2 will add the actual game route; for now just log
      console.log("[Multiplayer] Game started, room:", room.roomId);
    }
  }, [room?.status, room?.roomId]);

  if (loading && !room) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <p className="text-gray-400">Loading room…</p>
      </div>
    );
  }

  if (error || !room) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
        <div className="text-center space-y-4">
          <p className="text-red-400">{error ?? "Room not found"}</p>
          <button
            type="button"
            onClick={() => navigate("/multiplayer")}
            className="text-gray-400 hover:text-white text-sm"
          >
            ← Back to Lobby
          </button>
        </div>
      </div>
    );
  }

  const myMember = room.members.find((m) => m.userId === user?.id);
  const allConfirmed = room.members.every((m) => m.confirmStatus === "confirmed");
  const canStart =
    room.isHost && allConfirmed && !!room.moduleName && room.members.length >= 1;

  const handleSelectCharacter = async () => {
    if (!selectedCharacterId) return;
    setActionError(null);
    setBusy(true);
    try {
      const res = await authFetch(
        `/api/multiplayer/rooms/${room.roomId}/select-character`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ characterId: selectedCharacterId }),
        }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? "Failed to select character");
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
      if (!data.success) throw new Error(data.error ?? "Failed to confirm");
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSelectModule = async () => {
    if (!selectedModuleName) return;
    setActionError(null);
    setBusy(true);
    try {
      const res = await authFetch(
        `/api/multiplayer/rooms/${room.roomId}/select-module`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ moduleName: selectedModuleName }),
        }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? "Failed to select module");
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
      // Step 1: set room status to "playing"
      const startRes = await authFetch(
        `/api/multiplayer/rooms/${room.roomId}/start`,
        { method: "POST" }
      );
      const startData = await startRes.json();
      if (!startData.success) throw new Error(startData.error ?? "Failed to start game");

      // Step 2 (host only): initialise the game state — loads module + characters
      const initRes = await authFetch(
        `/api/multiplayer/rooms/${room.roomId}/game/init`,
        { method: "POST" }
      );
      const initData = await initRes.json();
      if (!initData.success) throw new Error(initData.error ?? "Failed to initialise game");

      console.log("[Multiplayer] Game initialised:", initData);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const statusBadge = (status: string) =>
    status === "confirmed"
      ? "bg-green-700 text-green-200"
      : "bg-yellow-800 text-yellow-200";

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      <div className="max-w-2xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-yellow-400">Waiting Room</h1>
            <p className="text-gray-400 text-sm">
              Status:{" "}
              <span className="text-white capitalize">{room.status}</span>
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500 mb-1">Room Code</p>
            <p className="text-3xl font-mono font-bold tracking-widest text-yellow-300">
              {room.roomCode}
            </p>
          </div>
        </div>

        {/* Module info */}
        {room.moduleName && (
          <div className="bg-gray-800 rounded-lg px-4 py-2 text-sm">
            <span className="text-gray-400">Module: </span>
            <span className="text-white font-medium">{room.moduleName}</span>
          </div>
        )}

        {/* Error banner */}
        {actionError && (
          <div className="bg-red-900/60 border border-red-600 rounded-lg p-3 text-sm text-red-200">
            {actionError}
          </div>
        )}

        {/* Members list */}
        <div className="bg-gray-800 rounded-xl p-4 space-y-3">
          <h2 className="text-lg font-semibold text-gray-100">Players</h2>
          {room.members.map((member) => (
            <div
              key={member.id}
              className="flex items-center justify-between bg-gray-700 rounded-lg px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <span className="text-gray-300 text-sm font-mono">
                  #{member.seatOrder}
                </span>
                <div>
                  <p className="text-white text-sm font-medium">
                    {member.userId === user?.id ? "You" : `Player ${member.seatOrder}`}
                    {member.role === "host" && (
                      <span className="ml-2 text-yellow-400 text-xs">(Host)</span>
                    )}
                  </p>
                  {member.characterId && (
                    <p className="text-gray-400 text-xs">Character selected</p>
                  )}
                </div>
              </div>
              <span
                className={`text-xs px-2 py-1 rounded-full font-medium ${statusBadge(member.confirmStatus)}`}
              >
                {member.confirmStatus}
              </span>
            </div>
          ))}
        </div>

        {/* Player controls: select character + confirm */}
        {myMember && myMember.confirmStatus !== "confirmed" && (
          <div className="bg-gray-800 rounded-xl p-4 space-y-3">
            <h2 className="text-lg font-semibold text-gray-100">Your Character</h2>
            <div className="flex gap-2">
              <select
                value={selectedCharacterId}
                onChange={(e) => setSelectedCharacterId(e.target.value)}
                className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-yellow-500"
              >
                <option value="">Select a character…</option>
                {characters.map((c) => (
                  <option key={c.character_id} value={c.character_id}>
                    {c.name}
                    {c.occupation ? ` — ${c.occupation}` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleSelectCharacter}
                disabled={busy || !selectedCharacterId}
                className="bg-gray-600 hover:bg-gray-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                Select
              </button>
            </div>
            <button
              type="button"
              onClick={handleConfirmReady}
              disabled={busy || !myMember.characterId}
              className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition-colors"
            >
              Confirm Ready
            </button>
            {!myMember.characterId && (
              <p className="text-yellow-600 text-xs text-center">
                Select and save a character before confirming
              </p>
            )}
          </div>
        )}

        {myMember?.confirmStatus === "confirmed" && (
          <div className="bg-green-900/40 border border-green-700 rounded-xl p-4 text-center">
            <p className="text-green-300 font-medium">You are ready!</p>
            <p className="text-gray-400 text-sm mt-1">Waiting for other players…</p>
          </div>
        )}

        {/* Host controls: select module + start game */}
        {room.isHost && (
          <div className="bg-gray-800 rounded-xl p-4 space-y-3">
            <h2 className="text-lg font-semibold text-gray-100">Host Controls</h2>

            {/* Module selection */}
            <div>
              <p className="text-gray-400 text-sm mb-2">Select Module</p>
              <div className="flex gap-2">
                <select
                  value={selectedModuleName}
                  onChange={(e) => setSelectedModuleName(e.target.value)}
                  className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-yellow-500"
                >
                  <option value="">Choose a module…</option>
                  {mods.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleSelectModule}
                  disabled={busy || !selectedModuleName}
                  className="bg-gray-600 hover:bg-gray-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  Set
                </button>
              </div>
            </div>

            {/* Start game */}
            <button
              type="button"
              onClick={handleStartGame}
              disabled={busy || !canStart}
              className="w-full bg-yellow-500 hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed text-black font-semibold py-3 rounded-lg transition-colors"
            >
              {busy ? "…" : "Start Game"}
            </button>
            {!canStart && (
              <p className="text-gray-500 text-xs text-center">
                {!room.moduleName
                  ? "Select a module first"
                  : !allConfirmed
                    ? "Waiting for all players to confirm"
                    : ""}
              </p>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => navigate("/multiplayer")}
          className="w-full text-gray-500 hover:text-gray-300 text-sm transition-colors"
        >
          ← Leave Room
        </button>
      </div>
    </div>
  );
};
