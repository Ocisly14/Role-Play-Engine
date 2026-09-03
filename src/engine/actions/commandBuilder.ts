// src/engine/actions/commandBuilder.ts
//
// Trusted Action Intake: turns untrusted `act` Tool args into a trusted,
// immutable ActionCommand. The model never authors the envelope — actorId,
// time and scene come from live DGSM state, replacesActionId from the Engine.
// A declared skill is checked for existence only (any known CoC skill; the
// actor's trained value or the base value) and rolled immediately; semantic
// applicability is judged later by the Engine with the roll in hand.

import { randomBytes } from "node:crypto";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { aliasFor } from "../../state/perceivableDirectory.js";
import type { CommandRejectionCode } from "./commandValidator.js";
import { validateActArgs } from "./commandValidator.js";
import { canonicalDisplayName, resolveSkillValue } from "./skillRollService.js";
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

  const validated = validateActArgs(rawArgs, {
    resolveCharacter: (handle) => resolveCharacterHandle(handle, actorId, dgsm),
    hasItem: (id) => itemExists(id, dgsm),
    hasPlace: (id) => dgsm.getScene(id) !== null || dgsm.getRoad(id) !== null,
  });
  if (!validated.ok) return validated;
  const args = validated.args;

  const position = dgsm.getCharacterPosition(actorId);
  const issuedSceneId = position ? dgsm.resolveLocationId(position) : "";

  const command: ActionCommand = {
    // Short on purpose: the derived `action_<commandId>` is the id the Engine
    // must echo back verbatim, in the trigger worklist and again in every
    // repair round. A uuid spent ~20 tokens a mention and gave the model 36
    // characters to miscopy; 8 hex characters are unique enough for a
    // session's few hundred commands and readable in a log line.
    commandId: randomBytes(4).toString("hex"),
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
    const profile = dgsm.getNpcProfile(actorId);
    const actorSkills = profile?.skills ?? {};

    // Languages is settled first: it is the one domain with no single value,
    // so "which tongue" has to be answered before there is anything to
    // resolve, and its failures deserve their own reasons rather than the
    // generic "not a skill this world knows".
    if (canonicalDisplayName(args.skillId) === "Languages") {
      const languages = profile?.languages;
      const spoken = languages?.native ?? [];
      const learned = languages?.learned ?? {};
      const named = args.language?.trim();

      if (!named) {
        return {
          ok: false,
          code: "invalid_skill",
          reason:
            "Languages is a domain, not a single fluency — name the tongue in `language`, or omit `skillId` if you are using one you grew up with",
        };
      }
      const isNative = spoken.some(
        (tongue) => tongue.toLowerCase() === named.toLowerCase()
      );
      if (isNative) {
        // Not an error, so not a rejection: nobody rolls to speak their own
        // language. Drop the declaration and let the action be settled on its
        // merits. Rejecting would cost a retry to teach a rule that changes
        // nothing about what the actor was trying to do.
        return { ok: true, command };
      }
      const match = Object.entries(learned).find(
        ([tongue]) => tongue.toLowerCase() === named.toLowerCase()
      );
      if (!match) {
        const have = [
          spoken.length > 0 ? `speak ${spoken.join(", ")}` : "",
          Object.keys(learned).length > 0
            ? `have learned ${Object.keys(learned).join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join(" and ");
        return {
          ok: false,
          code: "invalid_skill",
          reason: `you have no ${named} — you ${have || "have no languages recorded"}. A tongue you never learned is not a harder attempt, it is one you cannot make.`,
        };
      }
      command.declaredSkillId = "Languages";
      command.declaredLanguage = match[0];
      return { ok: true, command };
    }

    const resolved = resolveSkillValue(args.skillId, actorSkills);
    if (!resolved) {
      return {
        ok: false,
        code: "invalid_skill",
        reason: `"${args.skillId}" is not a skill this world knows — declare a real CoC skill name, or omit skillId`,
      };
    }
    // Only the NAME is settled here. The dice wait for the action to run
    // its course: the Engine sets the bar when the action starts, before any
    // roll exists, and code rolls against that bar when the duration is
    // spent. Rolling at intake would hand the Engine the result while it is
    // still choosing the difficulty.
    command.declaredSkillId = resolved.canonicalSkillId;
  }

  return { ok: true, command };
}

/** Anywhere in the world: on the ground of any scene, junction or road, or in
 *  someone's hands. Not "here" — that is the Engine's question, and it can
 *  answer it as something the actor finds out. */
function itemExists(itemId: string, dgsm: DynamicGameStateManager): boolean {
  // A vehicle's exterior is item-like: pointable wherever it stands.
  return dgsm.hasItem(itemId) || dgsm.getVehicle?.(itemId) != null;
}

/** A handle back to a real character: their own id if the actor knows them,
 *  otherwise the stable alias this actor sees them under. Searched across
 *  every character in the world rather than only those in scope — the alias
 *  is stable, so it resolves the same wherever the person has wandered off
 *  to, and whether they are still HERE is the Engine's question. */
function resolveCharacterHandle(
  handle: string,
  actorId: string,
  dgsm: DynamicGameStateManager
): string | undefined {
  // Probed for EVERY objectRef now that the boundary derives the kind from
  // the id, so it is no longer a cold path only character citations reach.
  for (const npc of dgsm.getState().npcCharacters ?? []) {
    if (npc.id === handle) return npc.id;
    if (aliasFor(actorId, npc.id) === handle) return npc.id;
  }
  return undefined;
}
