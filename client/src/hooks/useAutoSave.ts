/**
 * Hook for managing auto-save functionality
 */

import { useCallback, useEffect, useRef } from "react";
import {
  getLatestCompletedTurnNumber,
  getLatestTurnNumber,
} from "../components/gamechat/utils";
import type { Message } from "../types/gamechat";
import { authFetch } from "../utils/authFetch";

export interface UseAutoSaveParams {
  apiBaseUrl: string;
  sessionId: string | null;
  messagesRef: React.RefObject<Message[]>;
}

export interface UseAutoSaveResult {
  updateLastSavedTurnNumber: (nextMessages: Message[]) => void;
  hasNewTurnSinceLastSave: () => boolean;
  triggerAutoSave: (reason: string, keepalive?: boolean) => void;
}

export function useAutoSave({
  apiBaseUrl,
  sessionId,
  messagesRef,
}: UseAutoSaveParams): UseAutoSaveResult {
  const autoSaveTriggeredRef = useRef(false);
  const lastSavedTurnNumberRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(sessionId);
  const autoSaveEffectRunsRef = useRef(0);

  // Update sessionIdRef when sessionId changes
  useEffect(() => {
    sessionIdRef.current = sessionId || null;
    autoSaveTriggeredRef.current = false;
    lastSavedTurnNumberRef.current = null;
  }, [sessionId]);

  const updateLastSavedTurnNumber = useCallback((nextMessages: Message[]) => {
    const latestCompleted = getLatestCompletedTurnNumber(nextMessages);
    const latestAny = getLatestTurnNumber(nextMessages);
    lastSavedTurnNumberRef.current = latestCompleted ?? latestAny ?? null;
  }, []);

  const hasNewTurnSinceLastSave = useCallback(() => {
    const latestTurnNumber = getLatestTurnNumber(messagesRef.current || []);
    const lastSavedTurnNumber = lastSavedTurnNumberRef.current;
    if (latestTurnNumber === null || lastSavedTurnNumber === null) return false;
    return latestTurnNumber > lastSavedTurnNumber;
  }, [messagesRef]);

  const triggerAutoSave = useCallback(
    (reason: string, keepalive = false) => {
      if (autoSaveTriggeredRef.current) return;
      if (reason === "exit" && !hasNewTurnSinceLastSave()) return;
      const activeSessionId = sessionIdRef.current;
      if (!activeSessionId) return;

      autoSaveTriggeredRef.current = true;

      authFetch(`${apiBaseUrl}/checkpoints/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkpointType: "auto", reason }),
        keepalive,
      }).catch((err) => {
        console.warn("[useAutoSave] Auto-save failed:", err);
      });
    },
    [apiBaseUrl, hasNewTurnSinceLastSave]
  );

  // Set up beforeunload handler for exit auto-save
  useEffect(() => {
    const handleBeforeUnload = () => {
      triggerAutoSave("exit", true);
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      autoSaveEffectRunsRef.current += 1;
      if (import.meta.env?.DEV && autoSaveEffectRunsRef.current === 1) {
        return;
      }
      triggerAutoSave("exit", true);
    };
  }, [triggerAutoSave]);

  return {
    updateLastSavedTurnNumber,
    hasNewTurnSinceLastSave,
    triggerAutoSave,
  };
}
