/**
 * Shared utility functions for agents
 */

import type { BaseMessage } from "@langchain/core/messages";

/**
 * Convert various content types to string
 */
export const contentToString = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
};

/**
 * Extract the latest human message from message history
 */
export const latestHumanMessage = (messages: BaseMessage[]): string => {
  const reversed = [...messages].reverse();
  const human = reversed.find(
    (message: BaseMessage) =>
      // LangChain BaseMessage exposes _getType(); fall back to .type for compatibility
      (message as any)._getType?.() === "human" ||
      (message as any).type === "human"
  );
  return human ? contentToString(human.content) : "";
};
