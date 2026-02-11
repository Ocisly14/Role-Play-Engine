/**
 * MessageItem - Renders a single message in the chat
 */

import React from "react";
import ReactMarkdown from "react-markdown";
import { DiceAnimation, type DiceRollInfo } from "../DiceAnimation";

interface MessageItemProps {
  role: "character" | "keeper";
  content: string;
  timestamp: string;
  characterName: string;
  diceRolls?: Array<string | DiceRollInfo>;
  imageUrl?: string;
  imageCaption?: string;
  gameDay?: number | null;
  gameTime?: string | null;
  onAnimationComplete?: () => void;
}

export const MessageItem = React.memo<MessageItemProps>(({
  role,
  content,
  timestamp,
  characterName,
  diceRolls,
  imageUrl,
  imageCaption,
  gameDay,
  gameTime,
  onAnimationComplete,
}) => {
  return (
    <div className={`chat-message ${role}`}>
      <div className="message-meta">
        <span className="sender-name">
          {role === "character" ? `📝 ${characterName}` : "🎭 Keeper"}
        </span>
        <span className="message-timestamp">
          {gameTime && gameTime !== null && gameTime !== undefined && gameTime !== ""
            ? `Day ${gameDay ?? 1}, ${gameTime}`
            : new Date(timestamp).toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
              })}
        </span>
      </div>
      {diceRolls && diceRolls.length > 0 && (
        <DiceAnimation
          diceRolls={diceRolls}
          onAnimationComplete={onAnimationComplete}
        />
      )}
      {imageUrl && (
        <div className="scene-image-wrapper">
          <img
            className="scene-image"
            src={imageUrl}
            alt={imageCaption || "Scene image"}
          />
          {imageCaption && (
            <div className="scene-image-caption">{imageCaption}</div>
          )}
        </div>
      )}
      {content && (
        <div
          className={`message-text backdrop-blur-sm border border-slate-200 shadow-md rounded-lg px-[18px] py-[14px] ${
            role === "character"
              ? "bg-[rgba(232,220,196,0.5)]"
              : "bg-white/50"
          }`}
        >
          <ReactMarkdown className="markdown-content">
            {content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
});

MessageItem.displayName = "MessageItem";
