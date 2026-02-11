/**
 * InputArea - Handles message input with skill selection
 */

import React from "react";
import { getSkillNameZh } from "../../lib/skillNames";
import type { Skill } from "../../types/gamechat";

interface InputAreaProps {
  inputValue: string;
  setInputValue: (value: string) => void;
  selectedSkill: string;
  setSelectedSkill: (skill: string) => void;
  isSkillAuto: boolean;
  setIsSkillAuto: (auto: boolean) => void;
  suggestedSkills: Skill[];
  isSuggesting: boolean;
  isSkillPickerOpen: boolean;
  setIsSkillPickerOpen: (open: boolean) => void;
  availableSkills: Skill[];
  isSending: boolean;
  isPolling: boolean;
  isGameEnded: boolean;
  isInputCollapsed: boolean;
  isSceneChanging: boolean;
  language: "en" | "zh";
  handleInputAreaMouseEnter: () => void;
  handleInputAreaMouseLeave: () => void;
  handleSendMessage: () => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

export const InputArea = React.memo<InputAreaProps>(({
  inputValue,
  setInputValue,
  selectedSkill,
  setSelectedSkill,
  isSkillAuto,
  setIsSkillAuto,
  suggestedSkills,
  isSuggesting,
  isSkillPickerOpen,
  setIsSkillPickerOpen,
  availableSkills,
  isSending,
  isPolling,
  isGameEnded,
  isInputCollapsed,
  isSceneChanging,
  language,
  handleInputAreaMouseEnter,
  handleInputAreaMouseLeave,
  handleSendMessage,
  handleKeyDown,
}) => {
  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-30 pointer-events-none px-2 sm:px-0"
      style={{
        filter: isSceneChanging ? "blur(8px)" : "none",
        transition: "filter 0.5s ease-in-out",
      }}
    >
      <div
        onMouseEnter={handleInputAreaMouseEnter}
        onMouseLeave={handleInputAreaMouseLeave}
        className={`mx-auto w-full px-4 sm:px-0 pointer-events-auto rounded-3xl border border-white/30 dark:border-white/20 backdrop-blur-md shadow-[0_5px_13px_rgba(15,23,42,0.55)] ease-in-out ${
          isInputCollapsed && !inputValue.trim()
            ? "max-w-[160px] max-h-6 overflow-hidden mb-3 [transition:max-height_0.5s_ease-in-out,max-width_1s_ease-in-out_0.5s]"
            : "max-w-xl max-h-[80vh] mb-2 [transition:max-width_1s_ease-in-out,max-height_0.5s_ease-in-out]"
        }`}
      >
        <div
          className={`flex flex-col transition-opacity duration-300 ${
            isInputCollapsed && !inputValue.trim()
              ? "space-y-0 opacity-0 pointer-events-none invisible"
              : "space-y-1 opacity-100 visible"
          }`}
          aria-hidden={isInputCollapsed && !inputValue.trim()}
        >
          {/* Input Form */}
          <div className="px-2 pb-2 pt-2">
            <div className="relative">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-6 bottom-[-40px] h-24 rounded-full bg-slate-500/10 blur-3xl dark:bg-slate-900/60"
              />
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendMessage();
                }}
                className="relative z-10 overflow-hidden rounded-2xl border border-white/50 shadow-[0_6px_15px_rgba(15,23,42,0.25)] transition-all duration-300 ease-in-out bg-white/80 dark:bg-slate-950/60 supports-[backdrop-filter]:bg-white/55 supports-[backdrop-filter]:backdrop-blur-2xl dark:supports-[backdrop-filter]:bg-slate-900/40"
              >
                {(suggestedSkills.length > 0 || selectedSkill || isSkillAuto) && (
                  <div className="px-3 pt-2">
                    <div className="flex items-center">
                      <span className="text-[10px] uppercase tracking-wide text-slate-500">
                        Suggested Skills{isSuggesting ? "..." : ""}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {selectedSkill && (
                        <button
                          type="button"
                          className="flex items-center gap-1 rounded-full border border-amber-300 bg-amber-200 px-2 py-0.5 text-[11px] text-amber-900 shadow-[0_10px_20px_rgba(124,45,18,0.25)] transition-all -translate-y-0.5"
                          onClick={() => {
                            setSelectedSkill("");
                            setIsSkillAuto(false);
                          }}
                          disabled={isSending || isPolling || isGameEnded}
                        >
                          {(() => {
                            const selectedDisplay =
                              suggestedSkills.find(
                                (item) => item.name === selectedSkill
                              )?.displayName ??
                              (language === "zh"
                                ? (availableSkills.find(
                                    (item) => item.name === selectedSkill
                                  )?.displayNameZh ??
                                  getSkillNameZh(selectedSkill))
                                : selectedSkill);
                            return selectedDisplay;
                          })()}
                          {(() => {
                            const selectedValue =
                              availableSkills.find(
                                (item) => item.name === selectedSkill
                              )?.value ??
                              suggestedSkills.find(
                                (item) => item.name === selectedSkill
                              )?.value ??
                              null;
                            return Number.isFinite(selectedValue as number)
                              ? ` ${selectedValue}%`
                              : "";
                          })()}
                        </button>
                      )}
                      {suggestedSkills
                        .filter((skill) => skill.name !== selectedSkill)
                        .map((skill) => (
                          <button
                            key={skill.name}
                            type="button"
                            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] shadow-sm transition-all ${
                              selectedSkill === skill.name
                                ? "border-amber-300 bg-amber-200 text-amber-900 -translate-y-0.5 shadow-[0_10px_20px_rgba(124,45,18,0.25)]"
                                : "border-slate-200 bg-white/70 text-slate-700 hover:-translate-y-0.5 hover:shadow-md"
                            }`}
                            onClick={() => {
                              setSelectedSkill(
                                selectedSkill === skill.name ? "" : skill.name
                              );
                              setIsSkillAuto(false);
                            }}
                            disabled={isSending || isPolling || isGameEnded}
                          >
                            {skill.displayName ?? skill.name}
                            {Number.isFinite(skill.value)
                              ? ` ${skill.value}%`
                              : ""}
                          </button>
                        ))}
                      <div className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          className={`flex h-6 items-center rounded-full border px-2 text-[10px] uppercase tracking-wide shadow-sm transition-all ${
                            isSkillAuto
                              ? "border-amber-300 bg-amber-200 text-amber-900 shadow-[0_8px_16px_rgba(124,45,18,0.2)]"
                              : "border-slate-200 bg-white/70 text-slate-600 hover:-translate-y-0.5 hover:bg-white hover:shadow-md"
                          }`}
                          onClick={() => {
                            setIsSkillAuto((prev) => {
                              const next = !prev;
                              if (next) {
                                setSelectedSkill("");
                                setIsSkillPickerOpen(false);
                              }
                              return next;
                            });
                          }}
                          disabled={isSending || isPolling || isGameEnded}
                          aria-label="Auto select skill"
                        >
                          auto
                        </button>
                        <button
                          type="button"
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white/70 text-[11px] text-slate-600 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-white hover:shadow-md [&_svg]:shrink-0"
                          onClick={() =>
                            setIsSkillPickerOpen((prev) => !prev)
                          }
                          disabled={
                            isSending ||
                            isPolling ||
                            isGameEnded ||
                            availableSkills.length === 0
                          }
                          aria-label="Choose skill"
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            aria-hidden="true"
                          >
                            <circle cx="6" cy="12" r="2" />
                            <circle cx="12" cy="12" r="2" />
                            <circle cx="18" cy="12" r="2" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {isSkillPickerOpen && availableSkills.length > 0 && (
                  <div className="mx-3 mt-2 max-h-40 overflow-auto rounded-xl border border-slate-200 bg-white/80 p-2 text-[11px] text-slate-700 shadow-sm">
                    <div className="flex flex-wrap gap-1.5">
                      {availableSkills.map((skill) => (
                        <button
                          key={skill.name}
                          type="button"
                          className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] shadow-sm transition-all ${
                            selectedSkill === skill.name
                              ? "border-amber-300 bg-amber-200 text-amber-900 shadow-[0_8px_16px_rgba(124,45,18,0.2)]"
                              : "border-slate-200 bg-white/70 text-slate-700 hover:-translate-y-0.5 hover:shadow-md"
                          }`}
                          onClick={() => {
                            setSelectedSkill(
                              selectedSkill === skill.name ? "" : skill.name
                            );
                            setIsSkillAuto(false);
                            setIsSkillPickerOpen(false);
                          }}
                          disabled={isSending || isPolling || isGameEnded}
                        >
                          {language === "zh"
                            ? (skill.displayNameZh ??
                              getSkillNameZh(skill.name))
                            : skill.name}
                          {Number.isFinite(skill.value)
                            ? ` ${skill.value}%`
                            : ""}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <textarea
                  className="select-none md:text-sm max-h-12 px-4 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 w-full flex items-center h-16 min-h-10 resize-none rounded-md bg-transparent border-0 py-1 pl-2 pr-0.5 mt-2 shadow-none focus-visible:ring-0"
                  autoComplete="off"
                  name="message"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    isGameEnded
                      ? "The story has ended."
                      : "Type your message here..."
                  }
                  disabled={isSending || isPolling || isGameEnded}
                />
                <div className="flex items-center p-1.5 pt-0">
                  <button
                    type="submit"
                    className="inline-flex items-center justify-center whitespace-nowrap font-medium transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 backdrop-blur-md bg-white/50 border border-slate-200 text-slate-900 shadow-md hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 rounded-xl px-3 text-xs ml-auto gap-0.5 h-[30px]"
                    disabled={
                      !inputValue.trim() ||
                      isSending ||
                      isPolling ||
                      isGameEnded
                    }
                  >
                    {isGameEnded
                      ? "Game Ended"
                      : isSending || isPolling
                        ? "Processing..."
                        : "Send Message"}
                    {!isGameEnded && !isSending && !isPolling && (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="lucide lucide-send size-3.5"
                      >
                        <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
                        <path d="m21.854 2.147-10.94 10.939" />
                      </svg>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

InputArea.displayName = "InputArea";
