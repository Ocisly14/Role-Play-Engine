/**
 * Custom hook for waiting for turn completion using long polling
 *
 * This hook uses long polling to wait for turn completion instead of frequent polling.
 * The server will keep the connection open until the turn is completed.
 */

import { useEffect, useRef, useState } from "react";
import { authFetch } from "../utils/authFetch";

export interface ActionResult {
  timestamp: string | Date;
  gameTime: string;
  timeElapsedMinutes?: number;
  location: string;
  character: string;
  result: string;
  diceRolls: string[];
  timeConsumption: string;
  scenarioChanges?: string[];
}

export interface TurnStatus {
  turnId: string;
  turnNumber: number;
  characterInput: string;
  keeperNarrative: string | null;
  status:
    | "processing"
    | "completed"
    | "error"
    | "requires_skill_selection";
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  sceneId: string | null;
  sceneName: string | null;
  location: string | null;
  actionResults?: ActionResult[] | null;
  actionAnalysis?: any | null; // For requires_skill_selection status
  gameDay?: number | null;
  gameTime?: string | null;
}

export interface UseTurnPollingResult {
  turn: TurnStatus | null;
  isPolling: boolean;
  error: string | null;
  startPolling: (turnId: string) => void;
  stopPolling: () => void;
}

export function useTurnPolling(apiBaseUrl = "/api"): UseTurnPollingResult {
  const [turn, setTurn] = useState<TurnStatus | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const stopPolling = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsPolling(false);
  };

  const startPolling = async (turnId: string) => {
    // Clear any existing polling
    stopPolling();
    setError(null);
    setTurn(null);

    setIsPolling(true);

    // Create abort controller for cancellation
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const poll = async () => {
      try {
        // Use long polling: server will wait until turn is completed
        const response = await authFetch(
          `${apiBaseUrl}/turns/${turnId}?wait=true`,
          {
            signal: abortController.signal,
          }
        );

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || "Failed to fetch turn status");
        }

        // Log turn data for debugging
        console.log(`[useTurnPolling] Received turn data:`, {
          turnId: data.turn?.turnId,
          turnNumber: data.turn?.turnNumber,
          status: data.turn?.status,
          hasKeeperNarrative: !!data.turn?.keeperNarrative,
          keeperNarrativeLength: data.turn?.keeperNarrative?.length || 0,
          hasActionResults: !!data.turn?.actionResults,
          actionResultsType: typeof data.turn?.actionResults,
          actionResultsCount: Array.isArray(data.turn?.actionResults)
            ? data.turn.actionResults.length
            : "not array",
          actionResultsValue: data.turn?.actionResults,
        });

        setTurn(data.turn);

        if (data.turn.status === "error") {
          setError(data.turn.errorMessage || "Turn processing failed");
          setIsPolling(false);
          abortControllerRef.current = null;
        } else if (data.turn.status === "processing") {
          // Still processing, continue polling
          console.log(
            `[useTurnPolling] Turn still processing, continuing to poll...`
          );
          poll(); // Continue polling recursively
        } else {
          // Completed
          setIsPolling(false);
          abortControllerRef.current = null;
        }
      } catch (err) {
        // Ignore abort errors (user cancelled)
        if (err instanceof Error && err.name === "AbortError") {
          setIsPolling(false);
          abortControllerRef.current = null;
          return;
        }

        console.error("Error waiting for turn:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
        setIsPolling(false);
        abortControllerRef.current = null;
      }
    };

    poll();
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, []);

  return {
    turn,
    isPolling,
    error,
    startPolling,
    stopPolling,
  };
}
