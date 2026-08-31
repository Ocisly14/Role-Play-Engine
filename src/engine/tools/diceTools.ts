// src/engine/tools/diceTools.ts
//
// Trusted randomness for the unified Engine: opponent/defender skill rolls
// for opposed checks, and damage dice. The actor's own roll is NEVER made
// here — it already exists as the command's immutable SkillRollRecord
// (rolled at intake) and must not be re-rolled. Both tools accept explicit
// roll values so a replay can pin recorded outcomes.

import {
  resolveSkillValue,
  rollSkill,
  successLevelFor,
} from "../actions/skillRollService.js";
import type { SkillRollRecord } from "../actions/types.js";
import {
  applyPenalties,
  getCharacterConditionPenalties,
  getScenePenalties,
  rollD100,
} from "../shared/index.js";
import type { CodeToolContext, EngineCodeTool } from "./codeTool.js";

/** Clamp helper shared by numeric aggregation paths. Exported as a plain
 *  function — clamping is arithmetic, not a tool invocation. */
export function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ==================== Opposed / defender roll ====================

export interface OpposedRollInput {
  characterId: string;
  /** Defense skill the ENGINE chose for this defender (the Engine judges
   *  which defense applies; this tool only executes the roll). */
  skillId: string;
  /** Replay only: pin the d100 result instead of rolling. */
  fixedRoll?: number;
}

export type OpposedRollOutput =
  | { ok: true; record: SkillRollRecord }
  | { ok: false; reason: "unknown_skill" };

export const opposedRollTool: EngineCodeTool<
  OpposedRollInput,
  OpposedRollOutput
> = {
  name: "opposedRoll",
  description:
    "Roll a defender's skill (real value from character state, scene/condition penalties applied) for an opposed check. Never re-rolls the actor.",
  execute(input: OpposedRollInput, ctx: CodeToolContext): OpposedRollOutput {
    const profileSkills =
      ctx.dgsm.getNpcProfile(input.characterId)?.skills ?? {};
    const resolved = resolveSkillValue(input.skillId, profileSkills);
    if (!resolved) return { ok: false, reason: "unknown_skill" };

    // Same penalty stack the legacy skill-check path applied: scene
    // conditions at the defender's location plus their own conditions.
    const position = ctx.dgsm.getCharacterPosition(input.characterId);
    const locationId = position ? ctx.dgsm.resolveLocationId(position) : "";
    const scenePenalties = locationId
      ? getScenePenalties(locationId, ctx.dgsm)
      : new Map<string, number>();
    const charPenalties = getCharacterConditionPenalties(
      input.characterId,
      ctx.dgsm
    );
    const adjusted = applyPenalties(
      applyPenalties(
        { [resolved.canonicalSkillId]: resolved.value },
        scenePenalties
      ),
      charPenalties
    );
    const value = adjusted[resolved.canonicalSkillId] ?? resolved.value;

    return {
      ok: true,
      record: rollSkill(resolved.canonicalSkillId, value, input.fixedRoll),
    };
  },
};

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

const FORMULA_RE = /^\s*(?:(\d+)[dD](\d+)\s*(?:([+-])\s*(\d+))?|([+-]?\d+))\s*$/;
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
