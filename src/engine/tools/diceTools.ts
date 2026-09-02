// src/engine/tools/diceTools.ts
//
// Trusted randomness for the unified Engine. `damageRoll` is the one code
// tool the resolution session can call; it accepts explicit roll values so a
// replay can pin recorded outcomes.
//
// The actor's declared-skill roll is NEVER made here — it already exists as
// the command's immutable SkillRollRecord (rolled at intake) and must not be
// re-rolled. Sanity is not a tool either: it is declared on an occurrence and
// settled by `resolution/sanityResolver.ts`, which reuses the formula helpers
// exported below.

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
  | { ok: false; reason: "invalid_formula" | "nothing_to_roll" };

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
      // A constant with no die in it is not a roll. Seen live as a stall:
      // `damageRoll("0")` to occupy a forced first turn, answered with a
      // cheerful `total: 0` that taught nothing. Refuse it with the reason
      // the model should read next turn.
      if (match[5] !== undefined && Number.parseInt(match[5], 10) === 0) {
        return { ok: false, reason: "nothing_to_roll" };
      }

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

// ==================== Sanity loss formulas ====================
//
// No `sanityCheck` tool lives here any more. It was a stateless, non-idempotent
// roll the model started mid-session: every repeat returned a fresh d100 and
// `ok: true`, so nothing in the payload ever said "this exposure is settled".
// Measured over 30 full-injection ticks, five of them burned the entire
// session budget re-rolling the SAME (actionId, characterId) and never
// submitted, dropping the whole tick. Sanity is now DECLARED on the occurrence
// that caused it and rolled in code, which makes the loop structurally
// impossible — one submission, one roll.
//
// These helpers survive because the declaration still carries a dice formula.

/** A loss formula the world will accept: "1", "1d4", "2d6+1". */
export function validSanityLossFormula(formula: string): boolean {
  const match = FORMULA_RE.exec(formula ?? "");
  if (!match) return false;
  if (match[5] !== undefined) {
    return Number.parseInt(match[5], 10) >= 0;
  }
  const count = Number.parseInt(match[1], 10);
  const sides = Number.parseInt(match[2], 10);
  return count >= 1 && count <= 100 && sides >= 1;
}

/** True for a formula that cannot ever cost a point — a flat integer <= 0.
 *  Dice formulas are never guaranteed-zero (`rollSanityLoss` floors at 0, but
 *  `1d4` can still land above it), so only the flat case counts.
 *
 *  Since a PASSED check now costs nothing, a guaranteed-zero failure loss is a
 *  check that cannot cost anything at all — which is a check that should not
 *  happen. The validator refuses it. */
export function isGuaranteedZeroLoss(formula: string): boolean {
  const match = FORMULA_RE.exec(formula ?? "");
  if (!match || match[5] === undefined) return false;
  return Number.parseInt(match[5], 10) <= 0;
}

/** Roll a loss formula. `rng` returns a uniform [0,1) and is injectable so a
 *  whole resolution's dice — the d100 and every loss die — can be pinned from
 *  one source in tests and replays. */
export function rollSanityLoss(
  formula: string,
  rng: () => number = Math.random
): { total: number; rolls: number[] } {
  const match = FORMULA_RE.exec(formula);
  // The caller validates the formula before rolling it. Keep this guard so the
  // rolling helper remains total if that invariant ever changes.
  if (!match) return { total: 0, rolls: [] };
  if (match[5] !== undefined) {
    return { total: Number.parseInt(match[5], 10), rolls: [] };
  }

  const count = Number.parseInt(match[1], 10);
  const sides = Number.parseInt(match[2], 10);
  const rolls: number[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const value = Math.floor(rng() * sides) + 1;
    rolls.push(value);
    total += value;
  }
  if (match[3] !== undefined) {
    const modifier = Number.parseInt(match[4], 10);
    total += match[3] === "-" ? -modifier : modifier;
  }
  return { total: Math.max(0, total), rolls };
}

// rollD100 / successLevelFor are re-exported for the Engine's direct use in
// deterministic aggregation (they are pure functions, not tool invocations).
export { rollD100, successLevelFor };
