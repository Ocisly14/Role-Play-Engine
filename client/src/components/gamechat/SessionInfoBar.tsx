/**
 * SessionInfoBar - Displays character name and save button
 */

import React from "react";

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
  return (
    <div className="session-info-bar">
      <div className="character-info backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-3 py-1.5 h-9 flex items-center">
        <span className="character-label">Playing as:</span>
        <span className="character-value">{characterName}</span>
      </div>
      <div className="save-checkpoint-section">
        <button
          className="save-checkpoint-btn backdrop-blur-md bg-white/50 border border-slate-200 shadow-md rounded-xl px-3 py-1.5 text-sm hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 transition-all h-9"
          onClick={onSaveCheckpoint}
          disabled={isSaving}
          title="Save current game progress"
        >
          {isSaving ? "💾 Saving..." : "💾 Save"}
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
