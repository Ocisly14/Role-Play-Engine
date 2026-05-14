import { useTranslation } from "react-i18next";
import { getSkillNameZh } from "../lib/skillNames.js";

/**
 * Hook to translate skill names based on current language
 * Integrates existing skillNames.ts system with i18next
 */
export function useSkillTranslation() {
  const { i18n } = useTranslation();

  /**
   * Translate a skill name from English to the current language
   * @param skillNameEn - English skill name
   * @returns Translated skill name (or original if translation not available)
   */
  const translateSkill = (skillNameEn: string): string => {
    return i18n.language === "zh" ? getSkillNameZh(skillNameEn) : skillNameEn;
  };

  /**
   * Translate multiple skill names
   * @param skillNamesEn - Array of English skill names
   * @returns Array of translated skill names
   */
  const translateSkills = (skillNamesEn: string[]): string[] => {
    return skillNamesEn.map(translateSkill);
  };

  return {
    translateSkill,
    translateSkills,
    language: i18n.language,
    isEnglish: i18n.language === "en",
    isChinese: i18n.language === "zh",
  };
}
