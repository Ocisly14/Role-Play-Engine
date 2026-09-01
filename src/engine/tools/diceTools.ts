// src/engine/tools/diceTools.ts
//
// Trusted randomness for the unified Engine: damage dice and involuntary
// sanity checks. The actor's declared-skill roll is NEVER made here — it
// already exists as the command's immutable SkillRollRecord (rolled at
// intake) and must not be re-rolled. Both tools accept explicit roll values
// so a replay can pin recorded outcomes.

import { successLevelFor } from "../actions/skillRollService.js";
import { rollD100 } from "../shared/index.js";
import type { EngineCodeTool } from "./codeTool.js";

/** Clamp helper shared by numeric aggregation paths. Exported as a plain
 *  function — clamping is arithmetic, not a tool invocation. */
export function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ==================== Damage dice ====================

export interface DamageRollInput {
  /** Dice formula: "NdM", "NdM+K", "NdM-K", or a flat integer "K". */
  formula: string;
  /** Optional CoC damage-bonus string ("+1d4", "-1", "0", …). */
  damageBonus?: string;
  /** Replay only: pin every die (formula dice first, then bonus dice). */
  fixedRolls?: number[];
}

export type DamageRollOutput =
  | {
      ok: true;
      total: number;
      rolls: number[];
      formulaTotal: number;
      bonusTotal: number;
    }
  | { ok: false; reason: "invalid_formula" };

const FORMULA_RE =
  /^\s*(?:(\d+)[dD](\d+)\s*(?:([+-])\s*(\d+))?|([+-]?\d+))\s*$/;
const BONUS_RE = /^([+-]?)(?:(\d+)[dD](\d+)|(\d+))$/;

export const damageRollTool: EngineCodeTool<DamageRollInput, DamageRollOutput> =
  {
    name: "damageRoll",
    description:
      "Roll a damage formula (e.g. 1d6+1) plus an optional CoC damage-bonus string; returns total and individual dice. Send EVERY roll this tick needs as separate calls in the SAME turn — one call per turn spends the session's whole budget before the resolution is written.",
    execute(input: DamageRollInput): DamageRollOutput {
      const match = FORMULA_RE.exec(input.formula ?? "");
      if (!match) return { ok: false, reason: "invalid_formula" };

      const fixed = input.fixedRolls ? [...input.fixedRolls] : undefined;
      const rolls: number[] = [];
      const die = (sides: number): number => {
        const value = fixed?.shift() ?? Math.floor(Math.random() * sides) + 1;
        rolls.push(value);
        return value;
      };

      let formulaTotal: number;
      if (match[5] !== undefined) {
        formulaTotal = Number.parseInt(match[5], 10);
      } else {
        const count = Number.parseInt(match[1], 10);
        const sides = Number.parseInt(match[2], 10);
        if (count < 1 || count > 100 || sides < 1) {
          return { ok: false, reason: "invalid_formula" };
        }
        let sum = 0;
        for (let i = 0; i < count; i++) sum += die(sides);
        if (match[3] !== undefined) {
          const mod = Number.parseInt(match[4], 10);
          sum += match[3] === "-" ? -mod : mod;
        }
        formulaTotal = sum;
      }

      let bonusTotal = 0;
      if (input.damageBonus !== undefined && input.damageBonus !== "0") {
        const bonus = BONUS_RE.exec(input.damageBonus.trim());
        if (!bonus) return { ok: false, reason: "invalid_formula" };
        const sign = bonus[1] === "-" ? -1 : 1;
        if (bonus[4] !== undefined) {
          bonusTotal = sign * Number.parseInt(bonus[4], 10);
        } else {
          const count = Number.parseInt(bonus[2], 10);
          const sides = Number.parseInt(bonus[3], 10);
          let sum = 0;
          for (let i = 0; i < count; i++) sum += die(sides);
          bonusTotal = sign * sum;
        }
      }

      return {
        ok: true,
        total: formulaTotal + bonusTotal,
        rolls,
        formulaTotal,
        bonusTotal,
      };
    },
  };

// ==================== Sanity checks ====================

export interface SanityCheckInput {
  /** Action whose consequence exposed the character; retained in the audit output. */
  actionId: string;
  characterId: string;
  /** SAN loss formula when d100 <= current SAN. */
  successLoss: string;
  /** SAN loss formula when d100 > current SAN. */
  failureLoss: string;
  /** Replay/test only; omitted from the model-facing schema. */
  fixedRoll?: number;
  /** Replay/test only; omitted from the model-facing schema. */
  fixedLossRolls?: number[];
}

export type SanityCheckOutput =
  | {
      ok: true;
      actionId: string;
      characterId: string;
      currentSan: number;
      roll: number;
      passed: boolean;
      lossFormula: string;
      lossRolls: number[];
      loss: number;
    }
  | {
      ok: false;
      reason:
        | "unknown_character"
        | "sanity_not_applicable"
        | "invalid_loss_formula"
        | "invalid_fixed_roll";
    };

function validSanityLossFormula(formula: string): boolean {
  const match = FORMULA_RE.exec(formula ?? "");
  if (!match) return false;
  if (match[5] !== undefined) {
    return Number.parseInt(match[5], 10) >= 0;
  }
  const count = Number.parseInt(match[1], 10);
  const sides = Number.parseInt(match[2], 10);
  return count >= 1 && count <= 100 && sides >= 1;
}

function rollSanityLoss(
  formula: string,
  fixedRolls?: number[]
): { total: number; rolls: number[] } {
  const match = FORMULA_RE.exec(formula);
  // The caller validates both formulas before selecting one. Keep this guard
  // so the rolling helper remains total if that invariant ever changes.
  if (!match) return { total: 0, rolls: [] };
  if (match[5] !== undefined) {
    return { total: Number.parseInt(match[5], 10), rolls: [] };
  }

  const count = Number.parseInt(match[1], 10);
  const sides = Number.parseInt(match[2], 10);
  const fixed = fixedRolls ? [...fixedRolls] : [];
  const rolls: number[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const value = fixed.shift() ?? Math.floor(Math.random() * sides) + 1;
    rolls.push(value);
    total += value;
  }
  if (match[3] !== undefined) {
    const modifier = Number.parseInt(match[4], 10);
    total += match[3] === "-" ? -modifier : modifier;
  }
  return { total: Math.max(0, total), rolls };
}

export const sanityCheckTool: EngineCodeTool<
  SanityCheckInput,
  SanityCheckOutput
> = {
  name: "sanityCheck",
  description:
    "Roll d100 against a character's current SAN and roll the matching success/failure SAN-loss formula. One call per exposed character, and ALL of them in the SAME turn — one call per turn spends the session's whole budget before the resolution is written. Rare: see the sanity-check guidance for the short list of things that warrant one at all.",
  execute(input, ctx): SanityCheckOutput {
    const profile = ctx.dgsm.getNpcProfile(input.characterId);
    if (!profile) return { ok: false, reason: "unknown_character" };

    const currentSan = profile.status?.san;
    const maxSan = profile.status?.maxSan;
    if (
      typeof currentSan !== "number" ||
      !Number.isFinite(currentSan) ||
      typeof maxSan !== "number" ||
      !Number.isFinite(maxSan) ||
      maxSan <= 0
    ) {
      return { ok: false, reason: "sanity_not_applicable" };
    }
    if (
      !validSanityLossFormula(input.successLoss) ||
      !validSanityLossFormula(input.failureLoss)
    ) {
      return { ok: false, reason: "invalid_loss_formula" };
    }

    const roll = input.fixedRoll ?? rollD100();
    if (!Number.isInteger(roll) || roll < 1 || roll > 100) {
      return { ok: false, reason: "invalid_fixed_roll" };
    }
    const passed = roll <= clampValue(currentSan, 0, 99);
    const lossFormula = passed ? input.successLoss : input.failureLoss;
    const rolledLoss = rollSanityLoss(lossFormula, input.fixedLossRolls);

    return {
      ok: true,
      actionId: input.actionId,
      characterId: input.characterId,
      currentSan,
      roll,
      passed,
      lossFormula,
      lossRolls: rolledLoss.rolls,
      loss: rolledLoss.total,
    };
  },
};

// rollD100 / successLevelFor are re-exported for the Engine's direct use in
// deterministic aggregation (they are pure functions, not tool invocations).
export { rollD100, successLevelFor };
