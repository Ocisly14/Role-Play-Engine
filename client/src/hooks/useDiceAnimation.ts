/**
 * Hook for managing dice animation state and completion
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, PendingDiceRolls } from "../types/gamechat";

export interface UseDiceAnimationParams {
  onNarrativeCompleteRef: React.RefObject<(() => void) | undefined>;
  streamingBlockedRef: React.MutableRefObject<Set<string>>;
  streamingBufferRef: React.MutableRefObject<Map<string, string>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setStreamingTurnId: React.Dispatch<React.SetStateAction<string | null>>;
}

export interface UseDiceAnimationResult {
  pendingDiceRolls: PendingDiceRolls | null;
  setPendingDiceRolls: React.Dispatch<
    React.SetStateAction<PendingDiceRolls | null>
  >;
  showingDiceAnimation: boolean;
  setShowingDiceAnimation: React.Dispatch<React.SetStateAction<boolean>>;
  diceAnimationCompleted: boolean;
  setDiceAnimationCompleted: React.Dispatch<React.SetStateAction<boolean>>;
  handleDiceAnimationComplete: () => void;
}

export function useDiceAnimation({
  onNarrativeCompleteRef,
  streamingBlockedRef,
  streamingBufferRef,
  setMessages,
  setStreamingTurnId,
}: UseDiceAnimationParams): UseDiceAnimationResult {
  const [pendingDiceRolls, setPendingDiceRolls] =
    useState<PendingDiceRolls | null>(null);
  const [showingDiceAnimation, setShowingDiceAnimation] = useState(false);
  const [diceAnimationCompleted, setDiceAnimationCompleted] = useState(false);

  // Use useRef to access latest pendingDiceRolls
  const pendingDiceRollsRef = useRef(pendingDiceRolls);
  useEffect(() => {
    pendingDiceRollsRef.current = pendingDiceRolls;
  }, [pendingDiceRolls]);

  // Track if callback has been called for current dice rolls to prevent duplicate calls
  const diceAnimationCallbackCalledRef = useRef<string>("");

  const handleDiceAnimationComplete = useCallback(() => {
    console.log(`[useDiceAnimation] Dice animation completed`);
    const currentPendingDiceRolls = pendingDiceRollsRef.current;
    console.log(
      `[useDiceAnimation] Current pendingDiceRolls:`,
      currentPendingDiceRolls
    );

    if (!currentPendingDiceRolls) {
      console.warn(
        `[useDiceAnimation] handleDiceAnimationComplete called but pendingDiceRolls is null`
      );
      return;
    }

    // Create a unique key for this set of dice rolls
    const diceRollsKey = JSON.stringify({
      turnNumber: currentPendingDiceRolls.turnNumber,
      diceRolls: currentPendingDiceRolls.diceRolls,
      timestamp: currentPendingDiceRolls.timestamp,
    });

    // Prevent duplicate calls for the same dice roll set
    if (diceAnimationCallbackCalledRef.current === diceRollsKey) {
      console.log(
        `[useDiceAnimation] Callback already called for this dice roll set, skipping...`
      );
      return;
    }

    // Mark this set as processed
    diceAnimationCallbackCalledRef.current = diceRollsKey;

    // Mark animation as completed - this will trigger narrative display
    console.log(
      `[useDiceAnimation] Setting diceAnimationCompleted to true, narrative length: ${currentPendingDiceRolls.narrative?.length || 0}`
    );
    setDiceAnimationCompleted(true);

    // Trigger sidebar refresh using ref to avoid dependency issues
    if (onNarrativeCompleteRef.current) {
      onNarrativeCompleteRef.current();
    }
  }, [onNarrativeCompleteRef, setDiceAnimationCompleted]); // No dependencies - uses refs to access latest values

  // Add completed dice animation message to messages array
  useEffect(() => {
    if (diceAnimationCompleted && pendingDiceRolls) {
      console.log(
        `[useDiceAnimation] Adding completed dice animation to messages`
      );

      if (pendingDiceRolls.isStreaming) {
        const turnId = pendingDiceRolls.turnId;

        if (turnId) {
          streamingBlockedRef.current.delete(turnId);
        }
        const buffered = turnId
          ? streamingBufferRef.current.get(turnId) || ""
          : "";
        if (turnId && buffered) {
          streamingBufferRef.current.delete(turnId);
        }

        if (turnId) {
          setMessages((prev) => {
            const hasKeeperMessage = prev.some((msg) => msg.turnId === turnId && msg.role === "keeper");
            const next = hasKeeperMessage
              ? prev.map((msg) =>
                  msg.turnId === turnId && msg.role === "keeper"
                    ? {
                        ...msg,
                        content: msg.content + buffered,
                        isStreaming: true,
                        diceRolls: msg.diceRolls ?? pendingDiceRolls.diceRolls,
                        gameDay:
                          pendingDiceRolls.gameDay ?? msg.gameDay ?? null,
                        gameTime:
                          pendingDiceRolls.gameTime ?? msg.gameTime ?? null,
                      }
                    : msg
                )
              : [
                  ...prev,
                  {
                    role: "keeper" as const,
                    content: buffered,
                    timestamp: pendingDiceRolls.timestamp,
                    turnNumber: pendingDiceRolls.turnNumber,
                    turnId: pendingDiceRolls.turnId,
                    isStreaming: true,
                    diceRolls: pendingDiceRolls.diceRolls,
                    gameDay: pendingDiceRolls.gameDay ?? null,
                    gameTime: pendingDiceRolls.gameTime ?? null,
                  },
                ];
            return next;
          });
        }

        setShowingDiceAnimation(false);
        setPendingDiceRolls(null);
        setDiceAnimationCompleted(false);
        return;
      }

      setMessages((prev) => {
        // Check if this message already exists
        const existingMessage = prev.find(
          (msg) =>
            msg.turnNumber === pendingDiceRolls.turnNumber &&
            msg.role === "keeper"
        );
        if (existingMessage) {
          console.log(
            `[useDiceAnimation] Message for turn ${pendingDiceRolls.turnNumber} already exists, skipping...`
          );
          return prev;
        }

        // Add the keeper message with dice rolls
        const keeperMessage: Message = {
          role: "keeper",
          content: pendingDiceRolls.narrative,
          timestamp: pendingDiceRolls.timestamp,
          turnNumber: pendingDiceRolls.turnNumber,
          turnId: pendingDiceRolls.turnId,
          diceRolls: pendingDiceRolls.diceRolls,
          gameDay: pendingDiceRolls.gameDay ?? null,
          gameTime: pendingDiceRolls.gameTime ?? null,
        };
        return [...prev, keeperMessage];
      });

      // Clear the pending dice rolls to hide the temporary animation message
      setShowingDiceAnimation(false);
      setPendingDiceRolls(null);
      setDiceAnimationCompleted(false);
    }
  }, [
    diceAnimationCompleted,
    pendingDiceRolls,
    streamingBlockedRef,
    streamingBufferRef,
    setMessages,
    setPendingDiceRolls,
    setShowingDiceAnimation,
    setDiceAnimationCompleted,
  ]);

  return {
    pendingDiceRolls,
    setPendingDiceRolls,
    showingDiceAnimation,
    setShowingDiceAnimation,
    diceAnimationCompleted,
    setDiceAnimationCompleted,
    handleDiceAnimationComplete,
  };
}
