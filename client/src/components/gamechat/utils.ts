/**
 * Utility functions for GameChat component
 */

import type { Message } from "../../types/gamechat";
import type { DiceRollInfo } from "../DiceAnimation";

/**
 * Normalize a name to lowercase and trim whitespace
 */
export function normalizeName(name?: string | null): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

/**
 * Check if a dice roll is an opposed roll
 */
export function isOpposedRoll(roll?: string | null): boolean {
  if (!roll) return false;
  return /\b1d100_opposed\[\d+\]\s*:/i.test(roll);
}

/**
 * Extract actor name from roll prefix. Format: "Actor Name: 1d100[0]: ..."
 */
function extractRollCharacter(roll?: string | null): string | null {
  if (!roll) return null;
  const diceAt = roll.search(/\b(?:1d100_opposed|\d+d\d+)\[\d+\]\s*:/i);
  if (diceAt <= 0) return null;
  const candidate = roll
    .slice(0, diceAt)
    .replace(/[:\s]+$/g, "")
    .trim();
  return candidate.length > 0 ? candidate : null;
}

/**
 * Build DiceRollInfo[] from action results (for turn history display)
 * Displays all dice rolls from the provided action results without filtering
 * Splits multi-dice rolls (e.g., with penalty/bonus) into separate entries for animation
 */
export function buildDiceRollInfos(
  actionResults: Array<{ character: string; diceRolls?: string[] }>,
  playerName?: string
): DiceRollInfo[] {
  const infos: DiceRollInfo[] = [];
  for (const result of actionResults || []) {
    for (const roll of result.diceRolls || []) {
      const character = extractRollCharacter(roll) || result.character;

      // Check if this roll contains multiple dice (penalty/bonus format)
      // Format: "Dr. Smith: 1d100[0]: 45, 1d100[1]: 82(penalty),(Spot Hidden 60% use highest 82 = failure)"
      const diceMatches = [
        ...roll.matchAll(/(\d+d\d+\[\d+\]:\s*\d+(?:\(penalty\)|\(bonus\))?)/gi),
      ];

      if (diceMatches.length > 1) {
        const checkDetail = extractCheckDetail(roll);
        // Multi-dice roll - create separate DiceRollInfo for each die
        for (const match of diceMatches) {
          const diceStr = match[1]; // e.g., "1d100[0]: 45" or "1d100[1]: 82(penalty)"
          const singleDiceRoll = `${character}: ${diceStr}`;
          infos.push({
            character,
            roll: singleDiceRoll,
            skill: undefined,
            success: undefined,
            penalty: diceStr.includes("(penalty)")
              ? "penalty"
              : diceStr.includes("(bonus)")
                ? "bonus"
                : undefined,
            checkDetail,
          });
        }
      } else {
        // Single dice roll - use original logic
        const info: DiceRollInfo = {
          character,
          roll,
        };
        const checkDetail = extractCheckDetail(roll);
        if (checkDetail) {
          info.checkDetail = checkDetail;
        }
        const parenMatches = [...roll.matchAll(/\(([^)]+)\)/g)];
        const content =
          parenMatches.length > 0
            ? parenMatches[parenMatches.length - 1][1]
            : null;
        if (content) {
          const successMatch = content.match(
            /\s*=\s*(success|failure|critical|fumble)\s*$/i
          );
          if (successMatch)
            info.success =
              successMatch[1].toLowerCase() as DiceRollInfo["success"];

          // Penalty/Bonus detection - check entire roll string, not just last parentheses
          // New format: "1d100[1]: 82(penalty)" or "1d100[1]: 34(bonus)"
          // Old format: "(Spot Hidden 60% penalty die = failure)"
          const newFormatPenaltyMatch = roll.match(/\(penalty\)/i);
          const newFormatBonusMatch = roll.match(/\(bonus\)/i);
          const oldFormatPenaltyMatch = content.match(
            /(?:penalty\s+die|bonus\s+die|-\s*\d+\s*%?|\(\s*-\s*\d+\s*\))/i
          );

          if (newFormatPenaltyMatch) {
            info.penalty = "penalty";
          } else if (newFormatBonusMatch) {
            info.penalty = "bonus";
          } else if (oldFormatPenaltyMatch) {
            info.penalty = oldFormatPenaltyMatch[0].trim();
          }

          const beforeEquals = content
            .replace(/\s*=\s*(success|failure|critical|fumble)\s*$/i, "")
            .trim();
          const explicitPercentSkill = beforeEquals.match(/(.+?\d+%)/);
          const skillPart = explicitPercentSkill
            ? explicitPercentSkill[1].trim()
            : beforeEquals
                .replace(
                  /(?:penalty\s+die|bonus\s+die|-\s*\d+\s*%?|\(\s*-\s*\d+\s*\)|use\s+(?:highest|lowest)\s+\d+).*/gi,
                  ""
                )
                .trim();
          if (
            skillPart &&
            (/\d+%\s*$/.test(skillPart) || skillPart.length < 40)
          )
            info.skill = skillPart;
        }
        infos.push(info);
      }
    }
  }
  return infos;
}

function extractCheckDetail(roll: string): string | undefined {
  if (!roll) return undefined;
  const matches = [...roll.matchAll(/\(([^)]+)\)/g)];
  if (matches.length === 0) return undefined;
  const content = matches[matches.length - 1][1]?.trim();
  if (!content || !content.includes("=")) return undefined;
  return content;
}

/**
 * Filter dice rolls for a specific player
 */
export function filterDiceRollsForPlayer(
  diceRolls: Array<string | DiceRollInfo> | undefined,
  playerName?: string
): Array<string | DiceRollInfo> | undefined {
  if (!diceRolls || diceRolls.length === 0) return diceRolls;
  const playerNameNormalized = normalizeName(playerName);
  if (!playerNameNormalized) return diceRolls;
  return diceRolls.filter((roll) => {
    if (typeof roll === "string") {
      return true;
    }
    if (isOpposedRoll(roll.roll)) {
      return true;
    }
    const rollNameNormalized = normalizeName(roll.character);
    return !!rollNameNormalized && rollNameNormalized === playerNameNormalized;
  });
}

/**
 * Get the latest turn number from messages array
 */
export function getLatestTurnNumber(messages: Message[]): number | null {
  if (!messages || messages.length === 0) return null;
  let max = Number.NEGATIVE_INFINITY;
  for (const msg of messages) {
    const num =
      typeof msg.turnNumber === "number" ? msg.turnNumber : Number.NaN;
    if (Number.isFinite(num) && num > max) {
      max = num;
    }
  }
  return Number.isFinite(max) ? max : null;
}

/**
 * Get the latest completed turn number (keeper messages only)
 */
export function getLatestCompletedTurnNumber(
  messages: Message[]
): number | null {
  if (!messages || messages.length === 0) return null;
  let max = Number.NEGATIVE_INFINITY;
  for (const msg of messages) {
    if (msg.role !== "keeper") continue;
    const num =
      typeof msg.turnNumber === "number" ? msg.turnNumber : Number.NaN;
    if (Number.isFinite(num) && num > max) {
      max = num;
    }
  }
  return Number.isFinite(max) ? max : null;
}
