import type { SuccessLevel } from "../../dynamicBasicAgent/npcPlanning/types.js";

export function rollD100(): number {
  return Math.floor(Math.random() * 100) + 1;
}

export function isFumble(roll: number, skillValue: number): boolean {
  return skillValue < 50 ? roll >= 96 : roll === 100;
}

export function getSuccessLevel(
  roll: number,
  skillValue: number
): SuccessLevel {
  if (roll === 1) return "critical";
  if (isFumble(roll, skillValue)) return "fumble";
  if (roll <= Math.floor(skillValue / 5)) return "hard";
  if (roll <= Math.floor(skillValue / 2)) return "hard";
  if (roll <= skillValue) return "regular";
  return "fail";
}

export function getSuccessLevelWithDifficulty(
  roll: number,
  skillValue: number,
  difficulty: "regular" | "hard" | "extreme"
): SuccessLevel {
  if (roll === 1) return "critical";
  if (isFumble(roll, skillValue)) return "fumble";
  const threshold =
    difficulty === "extreme"
      ? Math.floor(skillValue / 5)
      : difficulty === "hard"
        ? Math.floor(skillValue / 2)
        : skillValue;
  if (roll <= threshold) return "regular";
  return "fail";
}

export const SUCCESS_RANK: Record<SuccessLevel, number> = {
  critical: 3,
  hard: 2,
  regular: 1,
  fail: 0,
  fumble: -1,
};

export function luckFailureRate(luck: number): number {
  return 0.025 + (100 - luck) * 0.0005;
}

export function getDamageBonus(str: number, siz: number): string {
  const total = str + siz;
  if (total <= 64) return "-2";
  if (total <= 84) return "-1";
  if (total <= 124) return "0";
  if (total <= 164) return "+1d4";
  if (total <= 204) return "+1d6";
  return "+2d6";
}

export function rollDamageBonus(db: string): number {
  if (db === "0") return 0;
  const sign = db.startsWith("-") ? -1 : 1;
  const diceMatch = db.match(/(\d+)d(\d+)/);
  if (diceMatch) {
    const count = Number.parseInt(diceMatch[1]);
    const sides = Number.parseInt(diceMatch[2]);
    let total = 0;
    for (let i = 0; i < count; i++) {
      total += Math.floor(Math.random() * sides) + 1;
    }
    return sign * total;
  }
  const flat = Number.parseInt(db);
  return isNaN(flat) ? 0 : flat;
}
