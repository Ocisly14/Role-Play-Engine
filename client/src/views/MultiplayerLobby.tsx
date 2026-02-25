import type React from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authFetch } from "../utils/authFetch";

export const MultiplayerLobby: React.FC = () => {
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
      if (!data.success) throw new Error(data.error ?? "Failed to create room");
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
      setError("Please enter a 5-digit room code");
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
      if (!data.success) throw new Error(data.error ?? "Failed to join room");
      navigate(`/multiplayer/room/${data.roomId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-yellow-400 mb-2">
            Multiplayer
          </h1>
          <p className="text-gray-400 text-sm">
            Create a room or join with a 5-digit code
          </p>
        </div>

        {error && (
          <div className="bg-red-900/60 border border-red-600 rounded-lg p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {/* Create Room */}
        <div className="bg-gray-800 rounded-xl p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-100">Create Room</h2>
          <p className="text-gray-400 text-sm">
            Start a new session as host. A 5-digit code will be generated for
            others to join.
          </p>
          <button
            type="button"
            onClick={handleCreateRoom}
            disabled={creating}
            className="w-full bg-yellow-500 hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed text-black font-semibold py-3 rounded-lg transition-colors"
          >
            {creating ? "Creating…" : "Create Room"}
          </button>
        </div>

        {/* Join Room */}
        <div className="bg-gray-800 rounded-xl p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-100">Join Room</h2>
          <form onSubmit={handleJoinRoom} className="space-y-3">
            <input
              type="text"
              inputMode="numeric"
              maxLength={5}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, ""))}
              placeholder="Enter 5-digit code"
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-3 text-center text-xl tracking-widest focus:outline-none focus:border-yellow-500"
            />
            <button
              type="submit"
              disabled={joining || joinCode.trim().length !== 5}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition-colors"
            >
              {joining ? "Joining…" : "Join Room"}
            </button>
          </form>
        </div>

        <button
          type="button"
          onClick={() => navigate("/")}
          className="w-full text-gray-500 hover:text-gray-300 text-sm transition-colors"
        >
          ← Back to Home
        </button>
      </div>
    </div>
  );
};
