import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "../utils/authFetch";

export interface RoomMember {
  id: string;
  userId: string;
  role: string;
  characterId: string | null;
  seatOrder: number;
  confirmStatus: string;
  joinedAt: string;
}

export interface RoomOverview {
  roomId: string;
  roomCode: string;
  status: string;
  hostUserId: string;
  moduleName: string | null;
  createdAt: string;
  members: RoomMember[];
  isHost: boolean;
}

const POLL_INTERVAL_MS = 3000;

export function useMultiplayerRoom(roomId: string | null) {
  const [room, setRoom] = useState<RoomOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRoom = useCallback(async () => {
    if (!roomId) return;
    try {
      const res = await authFetch(`/api/multiplayer/rooms/${roomId}/overview`);
      const data = await res.json();
      if (data.success) {
        setRoom(data.room as RoomOverview);
        setError(null);
      } else {
        setError(data.error ?? "Failed to load room");
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;

    setLoading(true);
    fetchRoom().finally(() => setLoading(false));

    intervalRef.current = setInterval(fetchRoom, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [roomId, fetchRoom]);

  return { room, loading, error, refetch: fetchRoom };
}
