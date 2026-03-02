/**
 * Long-polling hook for multiplayer round results.
 *
 * Mirrors useTurnPolling.ts but targets the multiplayer round-result endpoint.
 * Acts as a fallback when WebSocket is unavailable — deduplication with WS is
 * handled by the caller via processedRoundsRef.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "../utils/authFetch";

export interface RoundResult {
  status: "completed" | "waiting" | "processing" | "timeout" | "scene_changed" | "error";
  roundTurnId?: string;
  keeperNarrative?: string | null;
  gameDay?: number | null;
  gameTime?: string | null;
  turnNumber?: number;
  diceRolls?: any[];
  completedAt?: string | null;
  submittedCount?: number;
  totalCount?: number;
  error?: string;
}

export interface UseMultiplayerRoundPollingResult {
  roundResult: RoundResult | null;
  isPolling: boolean;
  startPolling: (roundNumber: number) => void;
  stopPolling: () => void;
}

const RETRY_DELAY_MS = 3_000;

export function useMultiplayerRoundPolling(
  roomId: string,
  sceneRoomId: string | null
): UseMultiplayerRoundPollingResult {
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const stopPolling = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsPolling(false);
  }, []);

  const startPolling = useCallback(
    (roundNumber: number) => {
      // Clear any existing polling
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      setRoundResult(null);
      setIsPolling(true);

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const poll = async () => {
        if (!sceneRoomId) {
          setIsPolling(false);
          return;
        }

        try {
          const url =
            `/api/multiplayer/rooms/${roomId}/scene-rooms/${sceneRoomId}/round-result` +
            `?roundNumber=${roundNumber}&wait=true`;

          const response = await authFetch(url, {
            signal: abortController.signal,
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const data: RoundResult & { success?: boolean } = await response.json();

          if (!data.success) {
            throw new Error(data.error || "Failed to fetch round result");
          }

          setRoundResult(data);

          if (
            data.status === "completed" ||
            data.status === "error" ||
            data.status === "scene_changed"
          ) {
            // Terminal — stop polling
            setIsPolling(false);
            abortControllerRef.current = null;
          } else if (data.status === "timeout") {
            // Server timed out its long-poll — re-poll immediately
            poll();
          } else {
            // "waiting" or "processing" — server already held the connection;
            // re-poll immediately (the server will hold again)
            poll();
          }
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            setIsPolling(false);
            abortControllerRef.current = null;
            return;
          }

          console.error("[useMultiplayerRoundPolling] Error:", err);
          // Network error — retry after a delay
          setTimeout(() => {
            if (abortControllerRef.current === abortController) {
              poll();
            }
          }, RETRY_DELAY_MS);
        }
      };

      poll();
    },
    [roomId, sceneRoomId]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  return { roundResult, isPolling, startPolling, stopPolling };
}
