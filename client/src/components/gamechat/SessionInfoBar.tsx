/**
 * SessionInfoBar - Displays character name and save button
 */

import type React from "react";
import { useTranslation } from "react-i18next";

interface SessionInfoBarProps {
  characterName: string;
}

export const SessionInfoBar: React.FC<SessionInfoBarProps> = ({
  characterName,
}) => {
  const { t } = useTranslation("game");
  return (
    <div className="session-info-bar">
      <div className="character-info backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-3 py-1.5 h-9 flex items-center">
        <span className="character-label">{t("session.playingAs")}</span>
        <span className="character-value">{characterName}</span>
      </div>
    </div>
  );
};
