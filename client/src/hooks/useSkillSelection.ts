/**
 * Hook for managing skill selection and suggestion
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { authFetch } from "../utils/authFetch";
import { getSkillNameZh } from "../lib/skillNames";
import type { Skill } from "../types/gamechat";

export interface UseSkillSelectionParams {
  apiBaseUrl: string;
  inputValue: string;
  isGameEnded: boolean;
  language: "en" | "zh";
}

export interface UseSkillSelectionResult {
  availableSkills: Skill[];
  setAvailableSkills: React.Dispatch<React.SetStateAction<Skill[]>>;
  selectedSkill: string;
  setSelectedSkill: React.Dispatch<React.SetStateAction<string>>;
  isSkillAuto: boolean;
  setIsSkillAuto: React.Dispatch<React.SetStateAction<boolean>>;
  suggestedSkills: Skill[];
  setSuggestedSkills: React.Dispatch<React.SetStateAction<Skill[]>>;
  isSuggesting: boolean;
  isSkillPickerOpen: boolean;
  setIsSkillPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  normalizeSkills: (skills: Record<string, unknown> | undefined | null) => Skill[];
}

export function useSkillSelection({
  apiBaseUrl,
  inputValue,
  isGameEnded,
  language,
}: UseSkillSelectionParams): UseSkillSelectionResult {
  const [availableSkills, setAvailableSkills] = useState<Skill[]>([]);
  const [selectedSkill, setSelectedSkill] = useState("");
  const [isSkillAuto, setIsSkillAuto] = useState(false);
  const [suggestedSkills, setSuggestedSkills] = useState<Skill[]>([]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isSkillPickerOpen, setIsSkillPickerOpen] = useState(false);
  const suggestRequestIdRef = useRef(0);

  const normalizeSkills = useCallback(
    (skills: Record<string, unknown> | undefined | null) => {
      if (!skills || typeof skills !== "object") return [];
      return Object.entries(skills)
        .map(([name, raw]) => {
          if (typeof raw === "number") return { name, value: raw };
          if (
            raw &&
            typeof raw === "object" &&
            "value" in raw &&
            typeof (raw as { value: unknown }).value === "number"
          ) {
            return { name, value: (raw as { value: number }).value };
          }
          return null;
        })
        .filter((entry): entry is { name: string; value: number } =>
          Boolean(entry)
        )
        .map((entry) => ({
          ...entry,
          displayNameZh: getSkillNameZh(entry.name),
        }))
        .sort((a, b) => {
          if (b.value !== a.value) return b.value - a.value;
          return a.name.localeCompare(b.name);
        });
    },
    []
  );

  // Skill suggestion effect
  useEffect(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || trimmed.length < 2 || isGameEnded) {
      setSuggestedSkills([]);
      setIsSuggesting(false);
      return;
    }

    const requestId = ++suggestRequestIdRef.current;
    const controller = new AbortController();

    const timeoutId = window.setTimeout(async () => {
      setIsSuggesting(true);
      try {
        const response = await authFetch(`${apiBaseUrl}/skills/suggest`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: trimmed,
            max: 3,
            language,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error("Failed to fetch skill suggestions");
        }

        const data = await response.json();
        if (requestId !== suggestRequestIdRef.current) return;

        const suggestions = Array.isArray(data?.suggestions)
          ? data.suggestions
          : [];
        const nextLanguage = language;
        setSuggestedSkills(
          suggestions
            .filter(
              (skill: { name?: string; value?: number }) =>
                typeof skill?.name === "string"
            )
            .map(
              (skill: {
                name: string;
                value?: number;
                displayName?: string;
              }) => ({
                name: skill.name,
                value: typeof skill.value === "number" ? skill.value : 0,
                displayName:
                  typeof skill.displayName === "string"
                    ? skill.displayName
                    : nextLanguage === "zh"
                      ? getSkillNameZh(skill.name)
                      : skill.name,
              })
            )
        );
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        console.warn("[useSkillSelection] Failed to fetch skill suggestions:", err);
        if (requestId === suggestRequestIdRef.current) {
          setSuggestedSkills([]);
        }
      } finally {
        if (requestId === suggestRequestIdRef.current) {
          setIsSuggesting(false);
        }
      }
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [apiBaseUrl, inputValue, isGameEnded, language]);

  return {
    availableSkills,
    setAvailableSkills,
    selectedSkill,
    setSelectedSkill,
    isSkillAuto,
    setIsSkillAuto,
    suggestedSkills,
    setSuggestedSkills,
    isSuggesting,
    isSkillPickerOpen,
    setIsSkillPickerOpen,
    normalizeSkills,
  };
}
