// src/engine/actions/adjudication/types.ts
//
// Contracts of the check stage. The World Action Engine names the difficulty
// (and any opposition) when an action STARTS, before a roll exists; trusted
// code rolls against that bar when the action's time is spent. Nothing
// semantic lives here.

import type { SkillRollRecord, SkillSuccessLevel } from "../types.js";

export type RequiredLevel = "regular" | "hard" | "extreme";

/** Executes a defender roll deterministically (the opposed-roll code tool).
 *  Injected so tests can pin dice. */
export type RollDefenderFn = (
  characterId: string,
  skillId: string
) => { ok: true; record: SkillRollRecord } | { ok: false; reason: string };
