/**
 * MessageList - Renders the list of messages with loading states
 */

import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { MessageItem } from "./MessageItem";
import type { Message, PendingDiceRolls } from "../../types/gamechat";

interface MessageListProps {
  messages: Message[];
  characterName: string;
  showingDiceAnimation: boolean;
  pendingDiceRolls: PendingDiceRolls | null;
  diceAnimationCompleted: boolean;
  handleDiceAnimationComplete: () => void;
  isSending: boolean;
  isPolling: boolean;
  streamingTurnId: string | null;
  error: string | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  isSceneChanging: boolean;
  isInputCollapsed: boolean;
}

export const MessageList = React.memo<MessageListProps>(({
  messages,
  characterName,
  showingDiceAnimation,
  pendingDiceRolls,
  diceAnimationCompleted,
  handleDiceAnimationComplete,
  isSending,
  isPolling,
  streamingTurnId,
  error,
  messagesEndRef,
  isSceneChanging,
  isInputCollapsed,
}) => {
  const { t } = useTranslation('game');
  // Auto-scroll when input area expands
  useEffect(() => {
    if (!isInputCollapsed) {
      // Delay slightly to ensure padding has updated
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 100);
    }
  }, [isInputCollapsed, messagesEndRef]);

  return (
    <div
      className="messages-scroll-area"
      style={{
        filter: isSceneChanging ? "blur(8px)" : "none",
        transition: "filter 0.5s ease-in-out, padding-bottom 0.5s ease-in-out",
        pointerEvents: isSceneChanging ? "none" : "auto",
        paddingBottom: isInputCollapsed ? "80px" : "500px",
      }}
    >
      {messages.length === 0 && (
        <div className="empty-chat-prompt">
          <p>🎲 {t('messages.welcome')}</p>
          <p>
            {t('messages.welcomePrompt')}
          </p>
        </div>
      )}

      {messages.map((msg, index) => (
        <MessageItem
          key={index}
          role={msg.role}
          content={msg.content}
          timestamp={msg.timestamp}
          characterName={characterName}
          diceRolls={msg.diceRolls}
          imageUrl={msg.imageUrl}
          imageCaption={msg.imageCaption}
          gameDay={msg.gameDay}
          gameTime={msg.gameTime}
          onAnimationComplete={undefined}
        />
      ))}

      {showingDiceAnimation && pendingDiceRolls && (
        <MessageItem
          role="keeper"
          content={diceAnimationCompleted && pendingDiceRolls.narrative ? pendingDiceRolls.narrative : ""}
          timestamp={pendingDiceRolls.timestamp}
          characterName={characterName}
          diceRolls={pendingDiceRolls.diceRolls}
          gameDay={pendingDiceRolls.gameDay}
          gameTime={pendingDiceRolls.gameTime}
          onAnimationComplete={handleDiceAnimationComplete}
        />
      )}

      {(isSending || isPolling) && !streamingTurnId && (
        <div className="chat-message keeper loading">
          <div className="message-meta">
            <span className="sender-name">🎭 {t('messages.keeper')}</span>
          </div>
          <div className="message-text backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-[18px] py-[14px]">
            <span className="typing-indicator">
              <span>•</span>
              <span>•</span>
              <span>•</span>
            </span>
            {isPolling
              ? ` ${t('messages.contemplating')}`
              : ` ${t('messages.processingAction')}`}
          </div>
        </div>
      )}

      {error && (
        <div className="error-message">
          <strong>⚠️ {t('messages.errorPrefix')}</strong> {error}
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
});

MessageList.displayName = "MessageList";
