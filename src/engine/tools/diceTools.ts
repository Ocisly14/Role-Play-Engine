// src/engine/tools/diceTools.ts
//
// Trusted randomness for the unified Engine: opponent/defender skill rolls
// for opposed checks, and damage dice. The actor's own roll is NEVER made
// here — it already exists as the command's immutable SkillRollRecord
// (rolled at intake) and must not be re-rolled. Both tools accept explicit
// roll values so a replay can pin recorded outcomes.

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
      "Roll a damage formula (e.g. 1d6+1) plus an optional CoC damage-bonus string; returns total and individual dice.",
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

// rollD100 / successLevelFor are re-exported for the Engine's direct use in
// deterministic aggregation (they are pure functions, not tool invocations).
export { rollD100, successLevelFor };
