/**
 * MessageItem - Renders a single message in the chat
 */

import React from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { DiceAnimation, type DiceRollInfo } from "../DiceAnimation";

interface MessageItemProps {
  role: "character" | "keeper" | "banner";
  content: string;
  timestamp: string;
  characterName: string;
  diceRolls?: Array<string | DiceRollInfo>;
  imageUrl?: string;
  imageCaption?: string;
  gameDay?: number | null;
  gameTime?: string | null;
  onAnimationComplete?: () => void;
  bannerType?: "combat_start" | "combat_end";
}

export const MessageItem = React.memo<MessageItemProps>(
  ({
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
    bannerType,
  }) => {
    const { t } = useTranslation("game");

    if (role === "banner") {
      const isCombatStart = bannerType === "combat_start";
      const label = isCombatStart ? t("combat.start") : t("combat.end");
      const color = isCombatStart ? "#c0392b" : "#2c3e50";
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            margin: "16px 0",
            padding: "0 8px",
          }}
        >
          <div style={{ flex: 1, height: "2px", background: color, opacity: 0.4 }} />
          <span
            style={{
              color,
              fontSize: "24px",
              fontWeight: 600,
              letterSpacing: "0.1em",
              whiteSpace: "nowrap",
              opacity: 0.85,
            }}
          >
            {label}
          </span>
          <div style={{ flex: 1, height: "2px", background: color, opacity: 0.4 }} />
        </div>
      );
    }

    return (
      <div className={`chat-message ${role}`}>
        <div className="message-meta">
          <span className="sender-name">
            {role === "character"
              ? `📝 ${characterName}`
              : `🎭 ${t("messages.keeper")}`}
          </span>
          <span className="message-timestamp">
            {gameTime &&
            gameTime !== null &&
            gameTime !== undefined &&
            gameTime !== ""
              ? `${t("messages.day")} ${gameDay ?? 1}, ${gameTime}`
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
              alt={imageCaption || t("messages.sceneImage")}
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
  }
);

MessageItem.displayName = "MessageItem";
