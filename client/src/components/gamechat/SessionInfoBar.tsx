/**
 * SessionInfoBar - Displays character name and save button
 */

import type React from "react";
import { useTranslation } from "react-i18next";

interface SessionInfoBarProps {
  characterName: string;
  isSaving: boolean;
  saveMessage: string | null;
  onSaveCheckpoint: () => void;
}

export const SessionInfoBar: React.FC<SessionInfoBarProps> = ({
  characterName,
  isSaving,
  saveMessage,
  onSaveCheckpoint,
}) => {
  const { t } = useTranslation("game");
  return (
    <div className="session-info-bar">
      <div className="character-info backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-3 py-1.5 h-9 flex items-center">
        <span className="character-label">{t("session.playingAs")}</span>
        <span className="character-value">{characterName}</span>
      </div>
      <div className="save-checkpoint-section">
        <button
          className="save-checkpoint-btn backdrop-blur-md bg-white/50 border border-slate-200 shadow-md rounded-xl px-3 py-1.5 text-sm hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 transition-all h-9"
          onClick={onSaveCheckpoint}
          disabled={isSaving}
          title={t("session.saveTitle")}
        >
          <span className="save-btn-icon">💾</span>
          <span className="save-btn-text">
            {isSaving ? t("session.saving") : t("session.save")}
          </span>
        </button>
        {saveMessage && (
          <span
            className="save-message"
            style={{
              marginLeft: "10px",
              fontSize: "0.85rem",
              color: saveMessage.startsWith("✓") ? "#155724" : "#721c24",
            }}
          >
            {saveMessage}
          </span>
        )}
      </div>
    </div>
  );
};
