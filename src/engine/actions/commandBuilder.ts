// src/engine/actions/commandBuilder.ts
//
// Trusted Action Intake: turns untrusted `act` Tool args into a trusted,
// immutable ActionCommand. The model never authors the envelope — actorId,
// time and scene come from live DGSM state, replacesActionId from the Engine.
// A declared skill is checked for existence only (any known CoC skill; the
// actor's trained value or the base value) and rolled immediately; semantic
// applicability is judged later by the Engine with the roll in hand.

import { randomUUID } from "node:crypto";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { buildPerceivableDirectory } from "../../state/perceivableDirectory.js";
import type { CommandRejectionCode } from "./commandValidator.js";
import { validateActArgs } from "./commandValidator.js";
import { resolveSkillValue, rollSkill } from "./skillRollService.js";
import type { ActionCommand } from "./types.js";

export interface BuildCommandDeps {
  dgsm: DynamicGameStateManager;
  /** Live action to replace, queried from the Engine by the caller. The old
   *  action is NOT cancelled here — replacement is resolved next tick (D4). */
  replacesActionId?: string;
}

export type BuildCommandResult =
  | { ok: true; command: ActionCommand }
  | { ok: false; code: CommandRejectionCode; reason: string };

export function buildActionCommand(
  actorId: string,
  rawArgs: unknown,
  deps: BuildCommandDeps
): BuildCommandResult {
  const { dgsm } = deps;

  const directory = buildPerceivableDirectory(actorId, dgsm);
  const validated = validateActArgs(rawArgs, directory);
  if (!validated.ok) return validated;
  const args = validated.args;

  const position = dgsm.getCharacterPosition(actorId);
  const issuedSceneId = position ? dgsm.resolveLocationId(position) : "";

  const command: ActionCommand = {
    commandId: randomUUID(),
    actorId,
    issuedAt: dgsm.getGameDateTime(),
    issuedSceneId,
    ...(deps.replacesActionId !== undefined
      ? { replacesActionId: deps.replacesActionId }
      : {}),
    description: args.description,
    objectRefs: args.objectRefs,
    proposedDurationTicks: args.proposedDurationTicks,
    ...(args.utterance !== undefined ? { utterance: args.utterance } : {}),
  };

  if (args.skillId !== undefined) {
    const actorSkills = dgsm.getNpcProfile(actorId)?.skills ?? {};
    const resolved = resolveSkillValue(args.skillId, actorSkills);
    if (!resolved) {
      return {
        ok: false,
        code: "invalid_skill",
        reason: `"${args.skillId}" is not a skill this world knows — declare a real CoC skill name, or omit skillId`,
      };
    }
    // Roll once, immediately, from the real value. declaredSkillId and
    // skillRoll always travel together (schema invariant, plan §4.3).
    command.declaredSkillId = resolved.canonicalSkillId;
    command.skillRoll = rollSkill(resolved.canonicalSkillId, resolved.value);
  }

  return { ok: true, command };
}
