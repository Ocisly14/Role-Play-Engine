// src/engine/actions/commandValidator.ts
//
// Structural + scope validation for raw `act` Tool args. Runs inside the
// trust boundary before an ActionCommand is built. Rejections carry a
// structured reason the agent can read as factual feedback on its next
// decision. No semantic classification happens here: whether the action is
// feasible, whether the skill fits, whether the target resists — all of that
// is the Engine's job in full context.

import type { PerceivableDirectory } from "../../state/perceivableDirectory.js";
import {
  ACTION_ENTITY_KINDS,
  type ActToolArgs,
  type ActionObjectRef,
  OBJECT_REF_ROLES,
} from "./types.js";

/** Bounds for the actor-proposed duration. 1 tick = 1 in-world minute; the
 *  cap only rejects absurd submissions — the Engine owns real durations. */
export const MIN_PROPOSED_DURATION_TICKS = 1;
export const MAX_PROPOSED_DURATION_TICKS = 480;

export type CommandRejectionCode =
  | "invalid_description"
  | "invalid_object_refs"
  | "unknown_ref"
  | "invalid_duration"
  | "invalid_skill"
  | "invalid_utterance";

/** What the world contains, for the two id spaces that are global and stable.
 *  Only existence: reachability is not a boundary question. */
export interface WorldRefs {
  /** A real character id, or an alias any actor could have been given. The
   *  alias space is stable, so this needs no notion of "this tick". */
  resolveCharacter(handle: string): string | undefined;
  hasItem(id: string): boolean;
  /** Scene, junction or road — the citation grammar has one `scene` kind for
   *  "a place". */
  hasPlace(id: string): boolean;
}

export type ValidateActArgsResult =
  | { ok: true; args: ActToolArgs }
  | { ok: false; code: CommandRejectionCode; reason: string };

const KIND_SET = new Set<string>(ACTION_ENTITY_KINDS);
const ROLE_SET = new Set<string>(OBJECT_REF_ROLES);

/**
 * Validate untrusted `act` args: shape, enums, duration bounds, and every
 * objectRef naming something real. Returns a normalized copy on success
 * (trimmed strings, integral duration).
 *
 * Character refs arrive as opaque handles and leave as real ids — this is the
 * one place the two id spaces meet. Nothing here asks whether the thing is
 * still within reach: every id space is stable, so that is a question about
 * the world, and the Engine answers it as something the actor finds out.
 */
export function validateActArgs(
  raw: unknown,
  directory: PerceivableDirectory,
  world: WorldRefs
): ValidateActArgsResult {
  if (typeof raw !== "object" || raw === null) {
    return reject("invalid_description", "act args must be an object");
  }
  const args = raw as Record<string, unknown>;

  const description =
    typeof args.description === "string" ? args.description.trim() : "";
  if (description === "") {
    return reject(
      "invalid_description",
      "`description` is required and must be a non-empty string"
    );
  }

  if (!Array.isArray(args.objectRefs)) {
    return reject(
      "invalid_object_refs",
      "`objectRefs` is required and must be an array (use [] when no entity is involved)"
    );
  }
  const refs: ActionObjectRef[] = [];
  for (const [i, entry] of args.objectRefs.entries()) {
    const ref = validateRef(entry, i, directory, world);
    if (!ref.ok) return ref;
    refs.push(ref.ref);
  }

  const rawDuration = args.proposedDurationTicks;
  const duration =
    typeof rawDuration === "number" && Number.isInteger(rawDuration)
      ? rawDuration
      : Number.NaN;
  if (
    Number.isNaN(duration) ||
    duration < MIN_PROPOSED_DURATION_TICKS ||
    duration > MAX_PROPOSED_DURATION_TICKS
  ) {
    return reject(
      "invalid_duration",
      `\`proposedDurationTicks\` must be an integer between ${MIN_PROPOSED_DURATION_TICKS} and ${MAX_PROPOSED_DURATION_TICKS} (got: ${JSON.stringify(rawDuration)})`
    );
  }

  if (args.skillId !== undefined && typeof args.skillId !== "string") {
    return reject("invalid_skill", "`skillId` must be a string when present");
  }
  const skillId =
    typeof args.skillId === "string" && args.skillId.trim() !== ""
      ? args.skillId.trim()
      : undefined;

  if (args.language !== undefined && typeof args.language !== "string") {
    return reject("invalid_skill", "`language` must be a string when present");
  }
  const language =
    typeof args.language === "string" && args.language.trim() !== ""
      ? args.language.trim()
      : undefined;
  if (language !== undefined && skillId === undefined) {
    return reject(
      "invalid_skill",
      '`language` only means something with `skillId: "Languages"` — drop it, or declare the skill'
    );
  }

  if (args.utterance !== undefined && typeof args.utterance !== "string") {
    return reject(
      "invalid_utterance",
      "`utterance` must be a string when present"
    );
  }
  const utterance =
    typeof args.utterance === "string" && args.utterance !== ""
      ? args.utterance
      : undefined;

  return {
    ok: true,
    args: {
      description,
      objectRefs: refs,
      proposedDurationTicks: duration,
      ...(skillId !== undefined ? { skillId } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(utterance !== undefined ? { utterance } : {}),
    },
  };
}

type ValidateRefResult =
  | { ok: true; ref: ActionObjectRef }
  | { ok: false; code: CommandRejectionCode; reason: string };

function validateRef(
  entry: unknown,
  index: number,
  directory: PerceivableDirectory,
  world: WorldRefs
): ValidateRefResult {
  if (typeof entry !== "object" || entry === null) {
    return reject(
      "invalid_object_refs",
      `objectRefs[${index}] must be an object {kind, id, role?}`
    );
  }
  const ref = entry as Record<string, unknown>;
  const kind = typeof ref.kind === "string" ? ref.kind : "";
  if (!KIND_SET.has(kind)) {
    return reject(
      "invalid_object_refs",
      `objectRefs[${index}].kind must be one of ${ACTION_ENTITY_KINDS.join("|")} (got: ${JSON.stringify(ref.kind)})`
    );
  }
  const id = typeof ref.id === "string" ? ref.id.trim() : "";
  if (id === "") {
    return reject(
      "invalid_object_refs",
      `objectRefs[${index}].id must be a non-empty string`
    );
  }
  if (ref.role !== undefined) {
    if (typeof ref.role !== "string" || !ROLE_SET.has(ref.role)) {
      return reject(
        "invalid_object_refs",
        `objectRefs[${index}].role must be one of ${OBJECT_REF_ROLES.join("|")} (got: ${JSON.stringify(ref.role)})`
      );
    }
  }

  // Characters are cited by opaque handle; this is where the handle becomes a
  // real id. Everything downstream — the command, the Engine, the world —
  // sees only real ids, and the actor never saw one.
  let resolvedId = id;
  if (kind === "character") {
    // An alias is stable per (viewer, target), so it can be resolved whenever
    // it is cited — including out of the actor's own perception history, ten
    // minutes after the person walked away. Whether they are still HERE is a
    // question about the world, and the Engine answers it in the fiction.
    const real = world.resolveCharacter(id);
    if (real === undefined) {
      return reject(
        "unknown_ref",
        `objectRefs[${index}] cites character "${id}", which is nobody in this world — cite the tag exactly as it appears in brackets in what you perceive`
      );
    }
    resolvedId = real;
  } else {
    // Items and places keep their real ids, which are global and stable, so
    // there is nothing here to expire. Whether the thing is still WITHIN REACH
    // is a question about the world, and the world is the Engine's to read —
    // it can answer "she reaches for the display and finds the gap where the
    // daisies were", which is an occurrence the actor learns from. Rejecting
    // instead taught her nothing and cost a retry.
    //
    // What is still refused is an id that names nothing at all: an invented or
    // mistyped reference the Engine could only guess at.
    const exists = kind === "item" ? world.hasItem(id) : world.hasPlace(id);
    if (!exists) {
      return reject(
        "unknown_ref",
        `objectRefs[${index}] cites ${kind} "${id}", which is not a ${kind} in this world — cite the id exactly as it appears in brackets in what you perceive`
      );
    }
  }

  return {
    ok: true,
    ref: {
      kind: kind as ActionObjectRef["kind"],
      id: resolvedId,
      ...(ref.role !== undefined
        ? { role: ref.role as ActionObjectRef["role"] }
        : {}),
    },
  };
}

function reject(
  code: CommandRejectionCode,
  reason: string
): { ok: false; code: CommandRejectionCode; reason: string } {
  return { ok: false, code, reason };
}
