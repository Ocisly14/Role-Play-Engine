/**
 * SkillSelectionModal - Modal for selecting skills when backend requires it
 */

import React from "react";
import { getSkillNameZh } from "../../lib/skillNames";
import type { Skill } from "../../types/gamechat";
import type { TurnStatus } from "../../hooks/useTurnPolling";

interface SkillSelectionModalProps {
  isOpen: boolean;
  pendingTurn: TurnStatus | null;
  availableSkills: Skill[];
  selectedSkill: string;
  setSelectedSkill: (skill: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  language: "en" | "zh";
}

export const SkillSelectionModal = React.memo<SkillSelectionModalProps>(({
  isOpen,
  pendingTurn,
  availableSkills,
  selectedSkill,
  setSelectedSkill,
  onConfirm,
  onCancel,
  language,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[radial-gradient(circle_at_top,rgba(148,163,184,0.28),rgba(15,23,42,0.62))] px-3 backdrop-blur-md">
      <div className="relative w-full max-w-xl max-h-[74vh] overflow-hidden rounded-[24px] border border-white/45 bg-white/30 shadow-[0_18px_60px_rgba(15,23,42,0.42)] backdrop-blur-2xl flex flex-col">
        <div className="pointer-events-none absolute -top-20 left-[-12%] h-56 w-56 rounded-full bg-amber-200/40 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 right-[-10%] h-64 w-64 rounded-full bg-sky-200/35 blur-3xl" />

        {/* Modal Header */}
        <div className="relative border-b border-white/35 bg-white/20 px-4 py-3 sm:px-5 sm:py-4 text-slate-900">
          <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/70 bg-white/55 text-base shadow-sm">
              ⚔️
            </span>
            <span>Skill Check Required</span>
          </h2>
          <p className="text-slate-700 text-xs sm:text-sm mt-1">
            Your action requires a skill check.
          </p>
        </div>

        {/* Modal Body */}
        <div className="relative flex-1 overflow-y-auto p-3 sm:p-4">
          {/* Action Description */}
          {pendingTurn && (
            <div className="mb-4 rounded-2xl border border-white/60 bg-white/45 px-3 py-2.5 shadow-[0_8px_28px_rgba(15,23,42,0.12)]">
              <p className="text-xs uppercase tracking-wide text-slate-500 mb-1">
                Your Action
              </p>
              <p className="font-medium text-slate-900 leading-relaxed">
                {pendingTurn.characterInput}
              </p>
            </div>
          )}

          {/* Selected Skill Display */}
          {selectedSkill && (
            <div className="mb-4 rounded-2xl border border-amber-300/65 bg-amber-100/45 px-3 py-2.5 shadow-[0_10px_28px_rgba(146,64,14,0.18)]">
              <p className="text-xs uppercase tracking-wide text-amber-800/80 mb-1">
                Selected Skill
              </p>
              <div className="flex items-center justify-between">
                <span className="text-base sm:text-lg font-semibold text-amber-950">
                  {language === "zh"
                    ? (availableSkills.find((s) => s.name === selectedSkill)
                        ?.displayNameZh ?? getSkillNameZh(selectedSkill))
                    : selectedSkill}
                </span>
                <span className="text-amber-800 font-mono">
                  {availableSkills.find((s) => s.name === selectedSkill)
                    ?.value ?? 0}
                  %
                </span>
              </div>
            </div>
          )}

          {/* Skills Grid */}
          {availableSkills.length > 0 ? (
            <div>
              <p className="text-sm font-medium text-slate-700 mb-3">
                Choose one skill for this check:
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-1">
                {availableSkills.map((skill) => (
                  <button
                    key={skill.name}
                    type="button"
                    onClick={() => setSelectedSkill(skill.name)}
                    className={`text-left p-2.5 rounded-xl border transition-all duration-200 ${
                      selectedSkill === skill.name
                        ? "border-amber-300/90 bg-amber-100/65 shadow-[0_10px_25px_rgba(180,83,9,0.22)] scale-[1.01]"
                        : "border-white/65 bg-white/45 hover:border-white/90 hover:bg-white/60 hover:-translate-y-0.5 hover:shadow-[0_8px_18px_rgba(15,23,42,0.14)]"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`font-medium ${
                          selectedSkill === skill.name
                            ? "text-amber-900"
                            : "text-slate-700"
                        }`}
                      >
                        {language === "zh"
                          ? (skill.displayNameZh ?? getSkillNameZh(skill.name))
                          : skill.name}
                      </span>
                      <span
                        className={`font-mono text-sm ${
                          selectedSkill === skill.name
                            ? "text-amber-700"
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
          ) : (
            <div className="text-center py-8">
              <div className="w-8 h-8 border-2 border-slate-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <p className="text-slate-600">Loading skills...</p>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="border-t border-white/35 bg-white/20 px-3 py-3 sm:px-4 flex items-center justify-end gap-2.5">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-slate-700 bg-white/55 border border-white/75 rounded-xl hover:bg-white/70 transition-all hover:-translate-y-0.5"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!selectedSkill}
            className="px-6 py-2 bg-gradient-to-r from-amber-500/95 to-orange-500/95 text-white font-medium rounded-xl hover:from-amber-500 hover:to-orange-500 transition-all hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_12px_26px_rgba(194,65,12,0.34)] disabled:shadow-none"
          >
            Confirm Selection
          </button>
        </div>
      </div>
    </div>
  );
});

SkillSelectionModal.displayName = "SkillSelectionModal";
