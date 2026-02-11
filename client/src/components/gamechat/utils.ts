/**
 * Utility functions for GameChat component
 */

import type { DiceRollInfo } from "../DiceAnimation";
import type { Message } from "../../types/gamechat";

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
  return /^\s*1d100_opposed\[\d+\]\s*:/i.test(roll);
}

/**
 * Build DiceRollInfo[] from action results (for turn history display)
 */
export function buildDiceRollInfos(
  actionResults: Array<{ character: string; diceRolls?: string[] }>,
  playerName?: string
): DiceRollInfo[] {
  const infos: DiceRollInfo[] = [];
  const playerNameNormalized = normalizeName(playerName);
  for (const result of actionResults || []) {
    for (const roll of result.diceRolls || []) {
      if (playerNameNormalized) {
        const resultNameNormalized = normalizeName(result.character);
        const isPlayerRoll =
          !!resultNameNormalized &&
          resultNameNormalized === playerNameNormalized;
        if (!isPlayerRoll && !isOpposedRoll(roll)) {
          continue;
        }
      }
      const info: DiceRollInfo = { character: result.character, roll };
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
        const penaltyMatch = content.match(
          /(?:penalty\s+die|bonus\s+die|-\s*\d+\s*%?|\(\s*-\s*\d+\s*\))/i
        );
        if (penaltyMatch) info.penalty = penaltyMatch[0].trim();
        const beforeEquals = content
          .replace(/\s*=\s*(success|failure|critical|fumble)\s*$/i, "")
          .trim();
        const skillPart = beforeEquals
          .replace(
            /(?:penalty\s+die|bonus\s+die|-\s*\d+\s*%?|\(\s*-\s*\d+\s*\)).*/gi,
            ""
          )
          .trim();
        if (skillPart && (/\d+%\s*$/.test(skillPart) || skillPart.length < 40))
          info.skill = skillPart;
      }
      infos.push(info);
    }
  }
  return infos;
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
    const num = typeof msg.turnNumber === "number" ? msg.turnNumber : NaN;
    if (Number.isFinite(num) && num > max) {
      max = num;
    }
  }
  return Number.isFinite(max) ? max : null;
}

/**
 * Get the latest completed turn number (keeper messages only)
 */
export function getLatestCompletedTurnNumber(messages: Message[]): number | null {
  if (!messages || messages.length === 0) return null;
  let max = Number.NEGATIVE_INFINITY;
  for (const msg of messages) {
    if (msg.role !== "keeper") continue;
    const num = typeof msg.turnNumber === "number" ? msg.turnNumber : NaN;
    if (Number.isFinite(num) && num > max) {
      max = num;
    }
  }
  return Number.isFinite(max) ? max : null;
}
