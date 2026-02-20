/**
 * CombatResponsePanel - Panel shown when the backend requires a combat response
 * Displays NPC attack narrative and allows player to select a skill + describe their defense
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSkillTranslation } from "../../hooks/useSkillTranslation";
import type { TurnStatus } from "../../hooks/useTurnPolling";
import type { Skill } from "../../types/gamechat";

interface CombatResponsePanelProps {
  isOpen: boolean;
  pendingTurn: TurnStatus | null;
  availableSkills: Skill[];
  onConfirm: (input: string, selectedSkill: string | null) => void;
  onCancel: () => void;
  language: "en" | "zh";
}

export const CombatResponsePanel = React.memo<CombatResponsePanelProps>(
  ({ isOpen, pendingTurn, availableSkills, onConfirm, onCancel, language }) => {
    const { t } = useTranslation("game");
    const { translateSkill } = useSkillTranslation();
    const [selectedSkill, setSelectedSkill] = useState<string>("");
    const [playerInput, setPlayerInput] = useState<string>("");

    if (!isOpen) return null;

    const npcNarrative = pendingTurn?.keeperNarrative || "";

    const handleConfirm = () => {
      if (!playerInput.trim()) return;
      onConfirm(playerInput.trim(), selectedSkill || null);
    };

    const defensiveSkills = availableSkills.filter((s) =>
      [
        "Dodge",
        "Brawl",
        "Fighting (Brawl)",
        "Fighting",
        "Firearms",
        "Handgun",
        "Rifle/Shotgun",
        "Submachine Gun",
        "Heavy Weapons",
        "Melee Weapons",
        "Throw",
        "Luck",
        "Agility",
        "闪避",
        "格斗",
        "斗殴",
        "枪械",
        "手枪",
        "步枪",
        "近战武器",
      ].some((keyword) => s.name.toLowerCase().includes(keyword.toLowerCase()))
    );

    const otherSkills = availableSkills.filter(
      (s) => !defensiveSkills.includes(s)
    );

    const displaySkills =
      defensiveSkills.length > 0
        ? [...defensiveSkills, ...otherSkills]
        : availableSkills;

    return (
      <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-[radial-gradient(circle_at_bottom,rgba(185,28,28,0.25),rgba(15,23,42,0.65))] px-3 backdrop-blur-md">
        <div className="relative w-full max-w-xl max-h-[88vh] sm:max-h-[80vh] overflow-hidden rounded-t-[24px] sm:rounded-[24px] border border-red-300/40 bg-slate-900/90 shadow-[0_-8px_60px_rgba(185,28,28,0.35)] backdrop-blur-2xl flex flex-col">
          {/* Decorative glows */}
          <div className="pointer-events-none absolute -top-16 left-[-10%] h-48 w-48 rounded-full bg-red-600/20 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-20 right-[-8%] h-56 w-56 rounded-full bg-orange-600/15 blur-3xl" />

          {/* Header */}
          <div className="relative border-b border-red-400/25 bg-red-950/40 px-4 py-3 sm:px-5 sm:py-4">
            <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2 text-red-100">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-red-400/50 bg-red-900/60 text-base shadow-sm">
                ⚔️
              </span>
              <span>{language === "zh" ? "战斗回应" : "Combat Response"}</span>
            </h2>
            <p className="text-red-300/80 text-xs sm:text-sm mt-1">
              {language === "zh"
                ? "敌人发动了攻击！选择如何应对。"
                : "Enemies are attacking! Choose how to respond."}
            </p>
          </div>

          {/* Body */}
          <div className="relative flex-1 overflow-y-auto p-3 sm:p-4 space-y-4">
            {/* NPC Attack Narrative */}
            {npcNarrative && (
              <div className="rounded-2xl border border-red-400/30 bg-red-950/30 px-4 py-3 shadow-[0_4px_20px_rgba(185,28,28,0.2)]">
                <p className="text-xs uppercase tracking-wide text-red-400/70 mb-2">
                  {language === "zh" ? "敌人的行动" : "Enemy Actions"}
                </p>
                <p className="text-red-100/90 text-sm leading-relaxed whitespace-pre-wrap">
                  {npcNarrative}
                </p>
              </div>
            )}

            {/* Skill Selector */}
            <div>
              <p className="text-sm font-medium text-slate-300 mb-2">
                {language === "zh"
                  ? "选择防御技能（可选）"
                  : "Select Defense Skill (optional)"}
              </p>
              <div className="grid grid-cols-2 gap-2 max-h-44 overflow-y-auto pr-1">
                {displaySkills.map((skill) => (
                  <button
                    key={skill.name}
                    type="button"
                    onClick={() =>
                      setSelectedSkill((prev) =>
                        prev === skill.name ? "" : skill.name
                      )
                    }
                    className={`text-left p-2.5 rounded-xl border transition-all duration-200 ${
                      selectedSkill === skill.name
                        ? "border-red-400/80 bg-red-900/50 shadow-[0_6px_18px_rgba(185,28,28,0.3)] scale-[1.01]"
                        : "border-white/15 bg-white/5 hover:border-white/30 hover:bg-white/10"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`font-medium text-xs sm:text-sm ${
                          selectedSkill === skill.name
                            ? "text-red-200"
                            : "text-slate-300"
                        }`}
                      >
                        {translateSkill(skill.name)}
                      </span>
                      <span
                        className={`font-mono text-xs ${
                          selectedSkill === skill.name
                            ? "text-red-400"
                            : "text-slate-500"
                        }`}
                      >
                        {skill.value}%
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Player Input */}
            <div>
              <p className="text-sm font-medium text-slate-300 mb-2">
                {language === "zh"
                  ? "描述你的应对行动"
                  : "Describe your response action"}
              </p>
              <textarea
                value={playerInput}
                onChange={(e) => setPlayerInput(e.target.value)}
                rows={3}
                placeholder={
                  language === "zh"
                    ? "例如：我向旁边翻滚，试图闪避攻击..."
                    : "e.g., I roll to the side, attempting to dodge the attack..."
                }
                className="w-full rounded-xl border border-white/20 bg-white/5 px-3 py-2.5 text-sm text-slate-200 placeholder-slate-500 resize-none focus:outline-none focus:border-red-400/60 focus:ring-1 focus:ring-red-400/30 transition-all"
              />
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-red-400/20 bg-red-950/20 px-3 py-3 sm:px-4 flex items-center justify-end gap-2.5">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-slate-400 bg-white/5 border border-white/15 rounded-xl hover:bg-white/10 transition-all text-sm"
            >
              {language === "zh" ? "取消" : "Cancel"}
            </button>
            <button
              onClick={handleConfirm}
              disabled={!playerInput.trim()}
              className="px-6 py-2 bg-gradient-to-r from-red-700/95 to-red-600/95 text-white font-medium rounded-xl hover:from-red-700 hover:to-red-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_8px_20px_rgba(185,28,28,0.4)] disabled:shadow-none text-sm"
            >
              {language === "zh" ? "确认应对" : "Respond"}
            </button>
          </div>
        </div>
      </div>
    );
  }
);

CombatResponsePanel.displayName = "CombatResponsePanel";
