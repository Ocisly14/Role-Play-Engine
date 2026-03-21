/**
 * Hook for managing game messages state and loading
 */

import { useEffect, useRef, useState } from "react";
import type { Message } from "../types/gamechat";
import { authFetch } from "../utils/authFetch";

export interface UseGameMessagesParams {
  sessionId: string;
  apiBaseUrl: string;
  initialMessages?: Message[];
}

export interface UseGameMessagesResult {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  streamingTurnId: string | null;
  setStreamingTurnId: React.Dispatch<React.SetStateAction<string | null>>;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  processedTurnIdsRef: React.MutableRefObject<Set<string>>;
  loadConversationHistory: () => Promise<void>;
}

export function useGameMessages({
  sessionId,
  apiBaseUrl,
  initialMessages,
}: UseGameMessagesParams): UseGameMessagesResult {
  const [messages, setMessages] = useState<Message[]>(initialMessages || []);
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const processedTurnIdsRef = useRef<Set<string>>(new Set());

  const loadConversationHistory = async () => {
    try {
      const response = await authFetch(
        `${apiBaseUrl}/sessions/${sessionId}/conversation`
      );
      const data = await response.json();

      if (data.success && data.conversation) {
        setMessages(data.conversation);
        // Mark all existing turnNumbers as processed
        const existingTurnNumbers = new Set(
          data.conversation.map((msg: Message) => msg.turnNumber)
        );
        processedTurnIdsRef.current = new Set(
          Array.from(existingTurnNumbers).map((n) => `turn-${n}`)
        );
      } else {
        setMessages([]);
        processedTurnIdsRef.current.clear();
      }
    } catch (err) {
      console.error("Failed to load conversation history:", err);
      setMessages([]);
      processedTurnIdsRef.current.clear();
    }
  };

  // Load conversation history on mount or when sessionId changes
  useEffect(() => {
    setStreamingTurnId(null);
    // If initialMessages are provided, use them; otherwise load from API
    if (initialMessages && initialMessages.length > 0) {
      setMessages(initialMessages);
      // Mark all existing turnNumbers as processed
      const existingTurnNumbers = new Set(
        initialMessages.map((msg) => msg.turnNumber)
      );
      processedTurnIdsRef.current = new Set(
        Array.from(existingTurnNumbers).map((n) => `turn-${n}`)
      );
    } else if (sessionId) {
      loadConversationHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Update messages when initialMessages prop changes.
  useEffect(() => {
    if (initialMessages && initialMessages.length > 0) {
      setMessages(initialMessages);
      // Mark all existing turnNumbers as processed
      const existingTurnNumbers = new Set(
        initialMessages.map((msg) => msg.turnNumber)
      );
      processedTurnIdsRef.current = new Set(
        Array.from(existingTurnNumbers).map((n) => `turn-${n}`)
      );
    } else if (!initialMessages && sessionId) {
      // If initialMessages is cleared, reload from API
      loadConversationHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessages]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return {
    messages,
    setMessages,
    streamingTurnId,
    setStreamingTurnId,
    messagesEndRef,
    processedTurnIdsRef,
    loadConversationHistory,
  };
}
