// src/engine/resolution/worldDeltaValidator.ts
//
// Code-side contract enforcement for the World Action Engine's output
// (plan Phase 7 / rules "Output rules"). Two entry points:
//
//   validateRawResolution — returns every violation found, addressed, so the
//     Engine can resubmit a corrected resolution.
//   finalizeResolution — converts a fully validated raw output into a typed
//     TickResolution; ids and nextWakeAt are code-assigned.
//
// The validator never re-judges semantics; it enforces structure, real
// references, invariants, transition legality, timing ownership and
// roll-consistency (via the deterministic adjudicator).

import { MAX_SPOT_LENGTH } from "../../state/characterSpot.js";
import { addMinutes } from "../../state/gameClock.js";
import { needsExplicitItemId } from "../../state/itemId.js";
import { actionIdForCommand } from "../actions/actionStore.js";
import type {
  ActionCommand,
  ActionTransition,
  CharacterChange,
  EngineAction,
  EngineActionStatus,
  ItemChange,
  Occurrence,
  PerceptionClarity,
  SceneChange,
  SourcedWorldDelta,
  TickResolution,
  WorldDelta,
} from "../actions/types.js";
import { PERCEPTION_CLARITIES } from "../actions/types.js";
import { SKILL_CATALOG, catalogSkillName } from "../rules/skillCatalog.js";
import { parseJsonResponse } from "../shared/jsonParse.js";
import type { SanityOutcome, SanityRollOptions } from "./sanityResolver.js";
import { resolveSanityDeclarations } from "./sanityResolver.js";
import type { EngineResolutionContext, ResolutionError } from "./types.js";
import {
  CHARACTER_OPS,
  CHECK_LEVELS,
  ITEM_OPS,
  SANITY_LOSS_FORMULAS,
  SCENE_OPS,
  opKinds,
} from "./worldDeltaSchema.js";
import type {
  RawActionEnd,
  RawActionStart,
  RawOccurrence,
  RawSourcedDelta,
  RawTickResolution,
} from "./worldDeltaSchema.js";

// ==================== Shape guards ====================
//
// The validator is a TOTAL function over whatever the model sent. Only half
// the submission is schema-enforced: `submit_actions` is strict, so on
// Anthropic `starting` and `ending` arrive as declared — but `submit_effects`
// is not (Anthropic cannot compile its operation grammar), OpenAI cannot
// express either half's nested optional fields in strict mode, and DeepSeek
// honours `strict` only on `submit_actions` (its adapter rewrites that half
// into DeepSeek's narrower subset) and only when the beta channel accepts the
// request. Every read below that would throw on the wrong
// shape goes through these, and the wrong shape becomes an addressed error
// the Engine can correct — never a TypeError that takes the whole tick down.

/** A JSON object and nothing else — not null, not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field that must be a list, read safely: anything else reads as empty.
 *  The caller reports the shape; this only keeps the read from throwing. */
function listOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** The action ids a row cites, as strings — the address of every error
 *  about it, so it has to be readable whatever the row's shape. */
function citedActionIds(occ: unknown): string[] {
  return listOf<unknown>(isRecord(occ) ? occ.actionIds : undefined).filter(
    (id): id is string => typeof id === "string"
  );
}

const CHECK_LEVEL_SET: ReadonlySet<string> = new Set(CHECK_LEVELS);
const SANITY_LOSS_SET: ReadonlySet<unknown> = new Set(SANITY_LOSS_FORMULAS);
/** Every domain a defender may resist with — the catalog minus `Languages`,
 *  which has no single value and is never rolled in defense. */
const OPPOSABLE_SKILL_NAMES = SKILL_CATALOG.map((s) => s.name).filter(
  (name) => name !== "Languages"
);

/**
 * The ways out of the place the actor is standing in, each marked open or
 * closed — code's answer, put beside the command that might need it.
 *
 * Passability is never the model's call: the movement runtime walks the
 * stated route and interrupts it with a `blocked:` reason the moment a closed
 * edge is actually reached. But with the Blocked Connections table in front
 * of it and nothing saying what the table was FOR, the model cross-referenced
 * routes against it by place name — read "lodge_drive ↔ porch is closed" as
 * "the porch is closed", and ended a walk from the greatroom to the porch as
 * weather-blocked when that door was open. Listing the actor's own exits with
 * their state removes the lookup, and with it the misreading.
 */
export function exitsFromHere(
  context: Pick<EngineResolutionContext, "state">,
  actorId: string
):
  | Array<{
      connectionId: string;
      to: string;
      open: boolean;
      reason?: string;
    }>
  | undefined {
  const here = context.state.characters.find(
    (c) => c.id === actorId
  )?.locationId;
  if (!here) return undefined;
  const place = context.state.places.find((p) => p.id === here);
  if (!place) return undefined;
  const blocked = new Map<string, string>();
  for (const e of context.state.blockedEdges) {
    blocked.set(`${e.from}|${e.to}`, e.reason);
    blocked.set(`${e.to}|${e.from}`, e.reason);
  }
  return place.connections
    .filter((c) => !c.hidden)
    .map((c) => {
      const reason = c.blockedReason ?? blocked.get(`${here}|${c.targetId}`);
      return reason
        ? {
            connectionId: c.connectionId,
            to: c.targetId,
            open: false,
            reason,
          }
        : { connectionId: c.connectionId, to: c.targetId, open: true };
    });
}

/** One exit as `exitsFromHere` lists it. */
export type Exit = NonNullable<ReturnType<typeof exitsFromHere>>[number];

// ==================== Shared lookup tables ====================

export interface KnownAction {
  status: EngineActionStatus;
  command: ActionCommand;
  progressMinutes: number;
  resolvedDurationTicks?: number;
  check?: EngineAction["check"];
}

interface Lookup {
  characterIds: Set<string>;
  aliveCharacterIds: Set<string>;
  /** Characters with real sanity capacity, by id. A being with `maxSan: 0`
   *  (a Mythos entity, say) cannot be shocked, and the resolver reads the
   *  tick-start `san` from here rather than taking a second pass over state. */
  sanById: Map<string, { san: number; maxSan: number }>;
  /** Every scene (interior and top-level node scenes alike). */
  sceneIds: Set<string>;
  /** EVERY place in the world — scene or road — from
   *  `state.placeKinds`, the full-world lookup. Never the skeleton graph
   *  (which drops interior scenes) and never the trimmed Tier-2 snapshots:
   *  prompt layering must not narrow what counts as a real reference. */
  placeIds: Set<string>;
  /** placeIds plus wherever a character actually stands (defensive: a
   *  position outside the graph is still a real location). */
  locationIds: Set<string>;
  /** Every authored connection id (`connection.*`), from `state.connectionIds`. */
  connectionIds: Set<string>;
  /** The actor's own exits, open or closed — the SAME list the prompt puts
   *  beside their command as `exitsFromHere`, so a grant is checked against
   *  what the model was shown. Undefined when the actor's place is not in
   *  the involved set. */
  exitsFor: (actorId: string) => Exit[] | undefined;
  /** connectionId → the two places it joins, from every involved place's
   *  connections and the world-wide blocked list. Used to tell when two
   *  different ids name the same passage (a two-way exit is two ids). */
  edgeByConnectionId: Map<string, { from: string; to: string }>;
  vehicleIds: Set<string>;
  vehicleInteriors: Map<string, string>;
  characterSceneIds: Map<string, string | undefined>;
  /** Involved (Tier 2) places' prose — for the stale-citation check. */
  placeDescriptions: Map<string, string>;
  /** FULL-world item→holder map (context.state.itemHolders). */
  itemHolders: Map<string, string>;
  /** All actions addressable this resolution (queued from commands + active).
   *  Active entries carry progress, duration and the bar set at start — all
   *  code-owned facts the entry rules read. */
  actionById: Map<string, KnownAction>;
  /** Actions the Engine is obliged to answer: the ones that have not begun,
   *  and the ones that are due or forced to stop. A triggered action that is
   *  merely still running is not here — silence means "keeps running". */
  requiredActionIds: Set<string>;
  /** Active actions that this trigger actually ends. */
  endingActionIds: Set<string>;
}

/**
 * Which moment each triggered action is in, and which of them the Engine is
 * actually obliged to answer.
 *
 * Shared by the prompt (which prints it as the trigger worklist) and the
 * validator (which enforces coverage against it) so the two cannot drift —
 * the Engine being told one thing and judged by another is what this whole
 * split exists to stop.
 *
 * `starting` and `ending` identify the two moments that require answers. A
 * start is answered in `starting`; an end is answered either in `ending` or,
 * for pure talk, by a speech occurrence alone. An action that is merely still
 * running takes no entry at all: silence already means "keeps running".
 */
export interface ResolutionWorklist {
  /** Queued: has not begun. Must appear in `starting`. */
  starting: string[];
  /** It is due or forced to stop. Must be answered by an `ending` entry,
   *  except that a pure-speech action is answered by its speech occurrence
   *  alone. The duration was set once when the action began. */
  ending: string[];
  /** Triggered but still running. Informational only — the Engine owes these
   *  nothing. Listed so every id in the trigger is accounted for. */
  stillRunning: string[];
  /** The actor has issued a new command over this one. It is in `ending`
   *  too: it stops at THIS minute, whatever its duration said, and the Engine
   *  accounts for what was done up to now — never for how it would have
   *  ended. Measured before this list existed: the old action sat under
   *  `stillRunning`, nothing ever ended it, and both ran to completion side
   *  by side — a notebook handed over twice, a couple leaving through a door
   *  one of them had already slammed. */
  replaced: string[];
  /** Ending actions whose command carries an `utterance`. If the whole of
   *  what happened is that the words were said, the answer is a `speech`
   *  occurrence and no `ending` entry; if hands did something too, that part
   *  is a second row and the entry carries the outcome. */
  endingWithUtterance: string[];
  /** Starting actions whose command carries an `utterance`. The words are
   *  NOT said yet: code clocks a spoken line at one minute, so the id comes
   *  back under `endingWithUtterance` next tick, and only then does a speech
   *  row cite it. Listed so the Engine is told, beside the utterance it can
   *  read in New Commands, that the line is still in the actor's mouth —
   *  measured: 26 speech rows in one run cited an id the Engine had itself
   *  just placed under `starting`. */
  startingWithUtterance: string[];
  /** Starting actions whose actor declared NO skill. There is nothing to
   *  check, so `check` is refused on these — and the Engine should not have to
   *  go find `declaredSkillId` in another section to work that out. Every
   *  remaining rejection in one measured run was this lookup going wrong, and
   *  always on the same kind of action: a described deception with no skill
   *  behind it, where a bar feels obviously right and is not allowed. */
  startingWithoutSkill: string[];
}

export function resolutionWorklist(
  context: EngineResolutionContext
): ResolutionWorklist {
  const worklist: ResolutionWorklist = {
    starting: [],
    ending: [],
    stillRunning: [],
    endingWithUtterance: [],
    startingWithUtterance: [],
    startingWithoutSkill: [],
    replaced: [],
  };
  const queued = new Set(
    context.actions.newCommands.map((c) => actionIdForCommand(c.commandId))
  );
  const replaced = new Set(
    context.trigger.triggers
      .filter((t) => t.reason === "replacement")
      .flatMap((t) => t.actionIds)
  );
  const explicitlyEnding = new Set(
    context.trigger.triggers
      .filter((t) =>
        ["duration_reached", "replacement", "interrupted"].includes(t.reason)
      )
      .flatMap((t) => t.actionIds)
  );
  const commandById = new Map(
    context.actions.newCommands.map((c) => [actionIdForCommand(c.commandId), c])
  );
  for (const id of context.trigger.actionIds) {
    if (queued.has(id)) {
      worklist.starting.push(id);
      if (commandById.get(id)?.declaredSkillId === undefined) {
        worklist.startingWithoutSkill.push(id);
      }
      if (commandById.get(id)?.utterance?.trim()) {
        worklist.startingWithUtterance.push(id);
      }
      continue;
    }
    const action = context.actions.activeActions.find((a) => a.id === id);
    if (!action) continue;
    const durationTicks = action.resolvedDurationTicks;
    const due =
      durationTicks !== undefined &&
      action.progressMinutes >= durationTicks * context.tick.durationMinutes;
    if (due || explicitlyEnding.has(id)) {
      worklist.ending.push(id);
      // Cut short by its own actor: an entry is owed now, and the clock
      // (not the Engine) will record it as interrupted, since its time was
      // not spent.
      if (replaced.has(id)) worklist.replaced.push(id);
    } else worklist.stillRunning.push(id);
  }
  for (const id of worklist.ending) {
    const action = context.actions.activeActions.find((a) => a.id === id);
    if (action?.command.utterance?.trim())
      worklist.endingWithUtterance.push(id);
  }
  return worklist;
}

export function buildLookup(context: EngineResolutionContext): Lookup {
  const worklist = resolutionWorklist(context);
  const characterIds = new Set(context.state.characters.map((c) => c.id));
  const aliveCharacterIds = new Set(
    context.state.characters.filter((c) => c.alive).map((c) => c.id)
  );
  const sanById = new Map<string, { san: number; maxSan: number }>();
  for (const c of context.state.characters) {
    if (Number.isFinite(c.san) && Number.isFinite(c.maxSan) && c.maxSan > 0) {
      sanById.set(c.id, { san: c.san, maxSan: c.maxSan });
    }
  }
  const placeKinds = Object.entries(context.state.placeKinds);
  const sceneIds = new Set(
    placeKinds.filter(([, kind]) => kind === "scene").map(([id]) => id)
  );
  const placeIds = new Set(placeKinds.map(([id]) => id));
  const connectionIds = new Set(context.state.connectionIds);
  const vehicleIds = new Set((context.state.vehicles ?? []).map((v) => v.id));
  const vehicleInteriors = new Map(
    (context.state.vehicles ?? []).map((v) => [v.id, v.interiorSceneId])
  );
  const characterSceneIds = new Map(
    context.state.characters.map((c) => {
      const position = c.position as { sceneId?: string } | null;
      return [c.id, position?.sceneId];
    })
  );
  const placeDescriptions = new Map(
    context.state.places.map((p) => [p.id, p.description ?? ""])
  );
  const locationIds = new Set<string>(placeIds);
  for (const c of context.state.characters) {
    if (c.locationId) locationIds.add(c.locationId);
    const position = c.position as
      | { sceneId?: string; roadId?: string }
      | undefined;
    for (const id of [position?.sceneId, position?.roadId]) {
      if (id) locationIds.add(id);
    }
  }
  const itemHolders = new Map<string, string>(
    Object.entries(context.state.itemHolders)
  );
  const exitsCache = new Map<string, Exit[] | undefined>();
  const exitsFor = (actorId: string): Exit[] | undefined => {
    if (!exitsCache.has(actorId)) {
      exitsCache.set(actorId, exitsFromHere(context, actorId));
    }
    return exitsCache.get(actorId);
  };
  const edgeByConnectionId = new Map<string, { from: string; to: string }>();
  for (const place of context.state.places) {
    for (const c of place.connections ?? []) {
      edgeByConnectionId.set(c.connectionId, {
        from: place.id,
        to: c.targetId,
      });
    }
  }
  for (const e of context.state.blockedEdges) {
    if (!edgeByConnectionId.has(e.connectionId)) {
      edgeByConnectionId.set(e.connectionId, { from: e.from, to: e.to });
    }
  }

  const actionById = new Map<string, KnownAction>();
  for (const action of context.actions.activeActions) {
    actionById.set(action.id, {
      status: action.status,
      command: action.command,
      progressMinutes: action.progressMinutes,
      ...(action.resolvedDurationTicks !== undefined
        ? { resolvedDurationTicks: action.resolvedDurationTicks }
        : {}),
      ...(action.check !== undefined ? { check: action.check } : {}),
    });
  }
  for (const command of context.actions.newCommands) {
    const id = actionIdForCommand(command.commandId);
    if (!actionById.has(id)) {
      actionById.set(id, { status: "queued", command, progressMinutes: 0 });
    }
  }

  return {
    characterIds,
    aliveCharacterIds,
    sanById,
    sceneIds,
    placeIds,
    locationIds,
    connectionIds,
    exitsFor,
    edgeByConnectionId,
    vehicleIds,
    vehicleInteriors,
    characterSceneIds,
    placeDescriptions,
    itemHolders,
    actionById,
    requiredActionIds: new Set([...worklist.starting, ...worklist.ending]),
    endingActionIds: new Set(worklist.ending),
  };
}

// ==================== Transition legality ====================

/** An action that has ended is out of the Engine's reach for good. */
const TERMINAL_STATUSES: ReadonlySet<EngineActionStatus> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

// ==================== Per-piece validation ====================

/**
 * Rules that survive the split.
 *
 * Everything the old single-shape `actions[]` needed a rule for — "a starting
 * action has no result", "the bar cannot change mid-flight", "an ending needs
 * an occurrence" — is now carried by the types themselves: those fields do not
 * exist on the wrong moment, so they cannot be sent at all. What is left here
 * is the handful of constraints a JSON Schema cannot express, and each one
 * names the world fact it checks against.
 */

/** Whichever list it arrived in, an action has to be one this tick can
 *  address, and not one already over. */
function resolvableAction(
  actionId: string,
  lookup: Lookup
): { known: KnownAction } | { error: string } {
  const known = lookup.actionById.get(actionId);
  if (!known) {
    // Name the addressable ids: a bare "unknown actionId" gives the
    // correction round nothing to correct toward, so every round re-sends
    // the same id.
    return {
      error: `unknown actionId — address one of: ${[...lookup.actionById.keys()].join(", ")}, or leave this entry out of the resubmission`,
    };
  }
  if (TERMINAL_STATUSES.has(known.status)) {
    return {
      error: `action already ${known.status} — it cannot be resolved again`,
    };
  }
  return { known };
}

function validateStart(entry: RawActionStart, lookup: Lookup): string[] {
  const resolvable = resolvableAction(entry.actionId, lookup);
  if ("error" in resolvable) return [resolvable.error];
  const { known } = resolvable;
  const errs: string[] = [];

  if (known.status !== "queued") {
    errs.push(
      `this action is already running — it belongs in "ending" if its time is spent, and needs no entry at all if it does not`
    );
  }
  if (entry.check !== undefined) {
    if (
      !isRecord(entry.check) ||
      !CHECK_LEVEL_SET.has(entry.check.requiredLevel as string)
    ) {
      errs.push(
        `check must be {"requiredLevel": one of ${CHECK_LEVELS.join(", ")}}`
      );
    } else if (known.command.declaredSkillId === undefined) {
      errs.push(
        `the actor declared no skill, so there is nothing to check — omit "check"`
      );
    }
  }
  if (entry.opposedBy !== undefined) {
    if (!Array.isArray(entry.opposedBy)) {
      errs.push("opposedBy must be an array of {characterId, skillId}");
    } else {
      for (const [i, defender] of entry.opposedBy.entries()) {
        if (!isRecord(defender) || typeof defender.characterId !== "string") {
          errs.push(`opposedBy[${i}] must be {characterId, skillId}`);
          continue;
        }
        if (!lookup.characterIds.has(defender.characterId)) {
          errs.push(
            `opposedBy character "${defender.characterId}" does not exist`
          );
        }
        errs.push(...validateDefenseSkill(defender.skillId, i));
      }
      // An empty array is how a resolution spells "nobody resists", and the
      // correction round itself asks for `[]` rather than omission on every
      // other list. Reading it as an assertion of opposition cost a whole
      // full-world round for a submission that said nothing wrong; the
      // adjudicator has always read it as unopposed (skillAdjudicator.ts).
      if (entry.opposedBy.length > 0 && !entry.check) {
        errs.push(
          "opposedBy needs a check — name the bar the opposition is against"
        );
      }
    }
  }
  // The route goes straight to the movement runtime, which walks the
  // character leg by leg. Every waypoint must name a real place; adjacency
  // between consecutive waypoints is enforced at movement init, which fails
  // the action with a route-shaped reason the actor can learn from.
  if (entry.movement !== undefined && !isRecord(entry.movement)) {
    errs.push(
      'movement must be an object {"route": [place ids], "vehicleId"?, "passBlockedConnectionId"?}'
    );
  } else if (entry.movement !== undefined) {
    const route = entry.movement.route;
    if (!Array.isArray(route) || route.length === 0) {
      errs.push(
        "movement requires a non-empty route array (the waypoints the actor stated, grounded to place ids)"
      );
    } else {
      for (const waypoint of route) {
        if (typeof waypoint !== "string" || !waypoint.trim()) {
          errs.push("movement.route entries must be place id strings");
        } else if (!lookup.locationIds.has(waypoint)) {
          errs.push(
            `movement.route waypoint "${waypoint}" is not a place in this world`
          );
        }
      }
    }
    if (
      entry.movement.vehicleId !== undefined &&
      !lookup.vehicleIds.has(entry.movement.vehicleId)
    ) {
      errs.push(
        `movement.vehicleId "${entry.movement.vehicleId}" is not a vehicle in this world`
      );
    }
    if (entry.movement.passBlockedConnectionId !== undefined) {
      errs.push(
        ...validatePassGrant(
          entry.movement.passBlockedConnectionId,
          Array.isArray(route) ? route : [],
          known.command.actorId,
          lookup
        )
      );
      if (entry.check !== undefined) {
        errs.push(
          "movement.passBlockedConnectionId cannot accompany a check: a passage cannot be crossed before that unresolved check is rolled"
        );
      }
    }
  }
  // Duration is conditionally required: a non-travel action must say how
  // long it takes; a travel action must NOT be clocked by hand — code derives
  // its time from the route, and the rules and the schema both say to omit
  // the field. Accepting it anyway (the runtime overrides it) taught the
  // model the sentence was optional. A spoken line is clocked by code too
  // (one minute, see finalizeResolution), so an utterance-bearing action may
  // omit it.
  if (entry.movement !== undefined) {
    if (entry.resolvedDurationTicks !== undefined) {
      errs.push(
        "a movement action must omit resolvedDurationTicks — travel time is derived from the route and the mode of travel; drop the field"
      );
    }
  } else {
    if (
      entry.resolvedDurationTicks === undefined &&
      !known.command.utterance?.trim()
    ) {
      errs.push(
        "a non-travel action needs resolvedDurationTicks; only movement actions derive their clock from the route"
      );
    }
    errs.push(...validateDuration(entry.resolvedDurationTicks));
  }
  return errs;
}

/**
 * The defense skill in an `opposedBy` entry, against the same 17-domain
 * catalog the Engine's own prompt renders.
 *
 * Unchecked, a name outside the catalog was not a loud failure but a silent
 * one: the defender roll fails to resolve, `resolveCheck` returns not-ok, and
 * the orchestrator's `if (outcome.ok)` writes nothing — so BOTH sides' dice
 * are discarded, the action runs its full duration, and the Engine judges its
 * ending with no roll in front of it and no error explaining why.
 * `Languages` is in the catalog but is refused here for the same reason: a
 * defender is never asked to defend in a tongue, so the roller passes no
 * language and the domain never resolves to a value.
 */
function validateDefenseSkill(skillId: unknown, index: number): string[] {
  const at = `opposedBy[${index}].skillId`;
  if (typeof skillId !== "string" || !skillId.trim()) {
    return [`${at} is required — the domain this defender resists with`];
  }
  const canonical = catalogSkillName(skillId);
  if (canonical === undefined) {
    return [
      `${at} "${skillId}" is not one of the ability domains — use one of: ${OPPOSABLE_SKILL_NAMES.join(", ")}`,
    ];
  }
  if (canonical === "Languages") {
    return [
      `${at}: an opposed check is never resisted with Languages — a defender is not asked to defend in a tongue. Name the domain they actually resist with, or drop this defender`,
    ];
  }
  return [];
}

/**
 * A one-shot grant to cross a blocked passage is checked against the list the
 * model was shown: the actor's own `exitsFromHere`. It used to be checked
 * against every connection id in the world, so a grant for a far-off, open
 * or off-route passage passed here and was silently ignored by the movement
 * runtime — the walker was interrupted again with the same reason, and
 * nobody learned the id was wrong.
 */
function validatePassGrant(
  passId: unknown,
  route: unknown[],
  actorId: string,
  lookup: Lookup
): string[] {
  if (typeof passId !== "string" || !passId) {
    return [
      "movement.passBlockedConnectionId must be an exact connection id from exitsFromHere",
    ];
  }
  const exits = lookup.exitsFor(actorId);
  if (exits === undefined) {
    // The actor's place is not in the involved set, so there is no exit list
    // to hold the grant against: fall back to "names something real".
    return lookup.connectionIds.has(passId)
      ? []
      : [
          `movement.passBlockedConnectionId "${passId}" names no connection in this world`,
        ];
  }
  const exit = exits.find((e) => e.connectionId === passId);
  if (!exit) {
    const closed = exits.filter((e) => !e.open).map((e) => e.connectionId);
    return [
      `movement.passBlockedConnectionId "${passId}" is not an exit of where ${actorId} stands — a grant names one of THEIR blocked exits from exitsFromHere${
        closed.length > 0
          ? `: ${closed.join(", ")}`
          : ", and none of them is blocked, so no grant applies"
      }`,
    ];
  }
  if (exit.open) {
    return [
      `movement.passBlockedConnectionId "${passId}" leads to "${exit.to}" and that passage is open — a grant is only for a blocked passage; drop it`,
    ];
  }
  if (route.length > 0 && route[0] !== exit.to) {
    return [
      `movement.passBlockedConnectionId "${passId}" leads to "${exit.to}", but the route's first step is "${String(route[0])}" — the grant applies only to the passage the route actually takes out of here`,
    ];
  }
  return [];
}

/** The occurrences that cite an action — its trace. Null rows (a model
 *  artefact on the non-strict path) are skipped. */
export function occurrencesCiting(
  actionId: string,
  occurrences: ReadonlyArray<RawOccurrence | null | undefined> | undefined
): RawOccurrence[] {
  return (occurrences ?? []).filter(
    (o): o is RawOccurrence =>
      isRecord(o) && citedActionIds(o).includes(actionId)
  );
}

/** True when the row is a spoken line being delivered. Read as a boolean and
 *  nothing else: `"true"` is not a flag, and a missing flag is `false` only
 *  because the row then has to carry `content`, which is the safer failure. */
export function isSpeechRow(o: RawOccurrence | null | undefined): boolean {
  return o?.speech === true;
}

const CLARITY_SET: ReadonlySet<string> = new Set(PERCEPTION_CLARITIES);

function isClarity(v: unknown): v is PerceptionClarity {
  return typeof v === "string" && CLARITY_SET.has(v);
}

/** The row's perceivers as `characterId → clarity`, over well-formed entries
 *  only; malformed ones are reported by `validateOccurrence` and skipped
 *  here. On a duplicate id the first entry wins — the validator refuses the
 *  row anyway. */
function perceiverClarities(
  o: RawOccurrence | null | undefined
): Map<string, PerceptionClarity> {
  const out = new Map<string, PerceptionClarity>();
  if (!Array.isArray(o?.perceivers)) return out;
  for (const p of o.perceivers) {
    if (
      p != null &&
      typeof p.characterId === "string" &&
      p.characterId.length > 0 &&
      isClarity(p.clarity) &&
      !out.has(p.characterId)
    ) {
      out.set(p.characterId, p.clarity);
    }
  }
  return out;
}

function validateEnd(
  entry: RawActionEnd,
  lookup: Lookup,
  /** The whole submission's occurrences: the trace of this ending lives
   *  there now. */
  occurrences: ReadonlyArray<RawOccurrence | null | undefined> = []
): string[] {
  const resolvable = resolvableAction(entry.actionId, lookup);
  if ("error" in resolvable) return [resolvable.error];
  const { known } = resolvable;
  const errs: string[] = [];

  if (known.status === "queued") {
    // The ONLY error worth reporting: this entry is in the wrong list, so
    // every field on it is beside the point. Reported alongside the field
    // checks below, it contradicted them — "this ending should not exist" in
    // the same breath as "your ending is missing its outcome" — and the model
    // obeyed both, putting the action in `starting` AND completing the ending
    // it had just been told to withdraw. That is a duplicate, which is where
    // it came from, and the tick died three rounds later going round it. Same
    // reasoning as the addressing failure above: a misfiled entry gets one
    // instruction, not a field-by-field review of a form it should not be on.
    return [
      `this action has not started yet — put it in "starting" with a duration and a bar, and send it ONLY there; its outcome comes on a later tick, when its time is spent`,
    ];
  }
  if (!lookup.endingActionIds.has(entry.actionId)) {
    return [
      `this action does not end this tick — drop this ending entry; the trigger's \`stillRunning\` list says it continues without an entry`,
    ];
  }
  const trace = occurrencesCiting(entry.actionId, occurrences);
  if (trace.length === 0) {
    // The guarantee the nested `occurrence` slot used to give, now a check.
    // Without a trace the actor perceives nothing, concludes nothing
    // happened, and re-issues the same action next minute — the loop the
    // old required field existed to prevent.
    errs.push(
      `no occurrence cites this ending — the actor perceives nothing, concludes nothing happened, and re-issues the same action next minute. Add a speech:false entry to "occurrences" with this actionId in its "actionIds"`
    );
    // Nothing else is worth saying about an ending nobody can see: the
    // outcome check below would only pile a second correction on the first.
    return errs;
  }
  if (trace.every(isSpeechRow)) {
    // The trace of an ENDING is what happened, and a speech row carries only
    // the words. Pure talk is answered by its speech row alone and has no
    // ending entry; an action that also did something physical owes a
    // speech:false row for the physical part. Either way this entry, as
    // sent, is wrong — and the two legal moves are named, because the last
    // time this was refused without them the model had no move left and the
    // tick died three rounds later.
    errs.push(
      `only a speech row cites this ending. If the whole of it was words said, drop this "ending" entry — the speech row alone answers pure talk. If something physical also happened, keep it and add a speech:false occurrence citing this actionId that states what happened`
    );
    return errs;
  }
  if (typeof entry.outcome !== "string" || !entry.outcome.trim()) {
    errs.push(
      "an ending requires an outcome — one objective paragraph of what came of it, which the actor is told"
    );
  }
  return errs;
}

/** The bound the schema used to carry as `minimum: 1`. Strict mode has no
 *  numeric keywords, so the description says it and this enforces it. */
function validateDuration(ticks: unknown): string[] {
  if (ticks === undefined) return [];
  if (!Number.isInteger(ticks) || (ticks as number) < 1) {
    return [
      `resolvedDurationTicks must be a whole number of minutes, at least 1 — got ${JSON.stringify(ticks)}`,
    ];
  }
  return [];
}

// Same rows the model is shown: the accepted kinds and the advertised field
// lists come from one table in the schema, so "unknown operation kind" can
// never mean "we told it about a kind we then refused".
const CHARACTER_OP_KINDS = opKinds(CHARACTER_OPS);
const SCENE_OP_KINDS = opKinds(SCENE_OPS);
const ITEM_OP_KINDS = opKinds(ITEM_OPS);

function validateCommonDelta(delta: RawSourcedDelta, lookup: Lookup): string[] {
  const errs: string[] = [];
  if (!lookup.actionById.has(delta.sourceActionId)) {
    errs.push(`sourceActionId "${delta.sourceActionId}" is unknown`);
  }
  if (!delta.operation || typeof delta.operation.kind !== "string") {
    errs.push("operation.kind is required");
  }
  return errs;
}

function validHolder(holder: string, lookup: Lookup): boolean {
  if (holder.startsWith("scene:")) {
    // All three place kinds hold items — a glove on a road is a real holder.
    return lookup.placeIds.has(holder.slice("scene:".length));
  }
  return lookup.characterIds.has(holder);
}

export function validateCharacterChange(
  delta: RawSourcedDelta & { characterId?: string },
  lookup: Lookup
): string[] {
  const errs = validateCommonDelta(delta, lookup);
  if (!delta.characterId || !lookup.characterIds.has(delta.characterId)) {
    errs.push(`characterId "${delta.characterId}" does not exist`);
    return errs;
  }
  const op = delta.operation;
  if (!op?.kind || !CHARACTER_OP_KINDS.has(op.kind)) {
    errs.push(`unknown character operation kind "${op?.kind}"`);
    return errs;
  }
  switch (op.kind) {
    case "hp":
    case "fatigue": {
      const d = op.delta;
      if (typeof d !== "number" || !Number.isFinite(d) || Math.abs(d) > 500) {
        errs.push(`${op.kind}.delta must be a finite number (|d| <= 500)`);
      }
      if (typeof op.reason !== "string" || !op.reason.trim()) {
        errs.push(`${op.kind} requires a reason`);
      }
      break;
    }
    case "position": {
      // Scene only. A road position carries a fraction along the road that
      // only the movement runtime sets; the Engine once stood a character on
      // a road with no fraction, and the next route planned from there came
      // out NaN and took the whole tick down.
      const p = op.position as
        | {
            type?: string;
            sceneId?: string;
          }
        | undefined;
      if (!p || typeof p !== "object") {
        errs.push(
          `position.position must be an object {type:"scene", sceneId}`
        );
      } else if (p.type === "road") {
        errs.push(
          "position cannot put a character on a road — a road is walked, never assigned; give the action a movement.route instead"
        );
      } else if (p.type !== "scene") {
        errs.push(
          `position.type must be "scene" — got ${JSON.stringify(p.type)}`
        );
      } else if (typeof p.sceneId !== "string" || !p.sceneId) {
        errs.push(`position of type "scene" requires sceneId`);
      } else if (!lookup.sceneIds.has(p.sceneId)) {
        errs.push(
          `position sceneId "${p.sceneId}" is not a place you were shown`
        );
      }
      break;
    }
    case "spot": {
      // Free text by design. Whether "behind the counter" is a sensible place
      // to be is a judgement in full context, which is what the Engine is;
      // the only thing code can judge is whether the string is one a prompt
      // line can carry. No emptiness check — `""` IS the clear.
      const spot = op.spot;
      if (typeof spot !== "string") {
        errs.push(`spot requires a spot string ("" clears it)`);
      } else if (spot.length > MAX_SPOT_LENGTH) {
        errs.push(
          `spot must be at most ${MAX_SPOT_LENGTH} characters — got ${spot.length}; it is a phrase, not a description`
        );
      }
      break;
    }
    case "setAppearance": {
      // Whole-prose replacement, like a scene's setDescription. Emptiness is
      // the one thing code can judge: a blank face is never the intent.
      if (typeof op.appearance !== "string" || !op.appearance.trim()) {
        errs.push(
          `setAppearance requires a non-empty appearance string — the character's whole appearance prose, rewritten`
        );
      }
      break;
    }
    case "addCondition": {
      const c = op.condition as
        | { description?: string; id?: string }
        | undefined;
      if (!c || typeof c !== "object") {
        errs.push(
          `addCondition.condition must be an object {id, description} — got ${typeof c === "string" ? `the string ${JSON.stringify(c)}` : typeof c}`
        );
      } else if (!c.id || !c.description) {
        errs.push(
          `addCondition.condition is missing ${[!c.id && "id", !c.description && "description"].filter(Boolean).join(" and ")}`
        );
      }
      break;
    }
    case "removeCondition":
      if (typeof op.conditionId !== "string" || !op.conditionId) {
        errs.push("removeCondition requires conditionId");
      }
      break;
  }
  return errs;
}

export function validateSceneChange(
  delta: RawSourcedDelta & { sceneId?: string },
  lookup: Lookup
): string[] {
  const errs = validateCommonDelta(delta, lookup);
  // Scene operations apply to every place kind — roads carry
  // conditions, descriptions and connections exactly like interior scenes.
  if (!delta.sceneId || !lookup.placeIds.has(delta.sceneId)) {
    errs.push(`sceneId "${delta.sceneId}" does not exist`);
    return errs;
  }
  const op = delta.operation;
  if (!op?.kind || !SCENE_OP_KINDS.has(op.kind)) {
    errs.push(`unknown scene operation kind "${op?.kind}"`);
    return errs;
  }
  const checkConnectionId = (kind: string): void => {
    if (typeof op.connectionId !== "string" || !op.connectionId) {
      errs.push(`${kind} requires connectionId`);
    } else if (!lookup.connectionIds.has(op.connectionId)) {
      errs.push(
        `${kind}.connectionId "${op.connectionId}" names nothing real — cite an exit id (\`connection.*\`) from the graph edges or a place snapshot's connections`
      );
    }
  };
  switch (op.kind) {
    case "addCondition": {
      const c = op.condition as { description?: string } | undefined;
      if (!c?.description) {
        errs.push("addCondition requires condition.description");
      }
      break;
    }
    case "removeCondition": {
      const p = op.predicate as { id?: string; featureId?: string } | undefined;
      const hasId = typeof p?.id === "string" && p.id.length > 0;
      const hasFeatureId =
        typeof p?.featureId === "string" && p.featureId.length > 0;
      if (!hasId && !hasFeatureId) {
        errs.push(
          "removeCondition requires predicate.id and/or predicate.featureId"
        );
      }
      break;
    }
    case "setDescription":
      if (typeof op.description !== "string" || !op.description.trim()) {
        errs.push("setDescription requires a non-empty description");
      }
      break;
    case "connectionBlock":
      checkConnectionId("connectionBlock");
      if (typeof op.blocked !== "boolean") {
        errs.push("connectionBlock requires blocked boolean");
      }
      if (typeof op.reason !== "string" || !op.reason.trim()) {
        errs.push("connectionBlock requires a reason");
      }
      break;
    case "connectionDiscovered": {
      checkConnectionId("connectionDiscovered");
      const ids = op.characterIds;
      if (!Array.isArray(ids) || ids.length === 0) {
        errs.push(
          "connectionDiscovered requires characterIds — everyone who could see it happen, and at least one of them"
        );
        break;
      }
      for (const id of ids) {
        if (typeof id !== "string" || !lookup.characterIds.has(id)) {
          errs.push(
            `connectionDiscovered.characterIds contains "${String(id)}", which names no character`
          );
        }
      }
      break;
    }
    case "connectionHidden":
      checkConnectionId("connectionHidden");
      if (typeof op.hidden !== "boolean") {
        errs.push("connectionHidden requires hidden boolean");
      }
      break;
    case "environmentContribute":
      if (
        !["temperature", "illumination", "oxygen", "noise"].includes(
          op.quantity as string
        )
      ) {
        errs.push("environmentContribute has invalid quantity");
      }
      if (typeof op.value !== "number" || !Number.isFinite(op.value)) {
        errs.push("environmentContribute requires numeric value");
      }
      break;
    case "environmentHazard": {
      // It used to accept anything, including an operation that hazards
      // nothing — which applies cleanly and changes the world not at all, so
      // the actor perceives no consequence and tries again.
      const lists = (["add", "remove"] as const).filter(
        (k) => op[k] !== undefined
      );
      if (lists.length === 0) {
        errs.push(`environmentHazard needs "add" or "remove" (or both)`);
      }
      for (const key of lists) {
        const list = op[key];
        if (
          !Array.isArray(list) ||
          list.some((h) => typeof h !== "string" || !h.trim())
        ) {
          errs.push(
            `environmentHazard.${key} must be an array of hazard names`
          );
        }
      }
      break;
    }
  }
  return errs;
}

export function validateItemChange(
  delta: RawSourcedDelta & { itemId?: string },
  lookup: Lookup,
  movedItemIds: Set<string>,
  createdItemIds: Set<string> = new Set()
): string[] {
  const errs = validateCommonDelta(delta, lookup);
  const op = delta.operation;
  if (!op?.kind || !ITEM_OP_KINDS.has(op.kind)) {
    errs.push(`unknown item operation kind "${op?.kind}"`);
    return errs;
  }
  if (op.kind === "create") {
    if (typeof op.name !== "string" || !op.name.trim()) {
      errs.push("create requires a name");
    } else if (op.id === undefined && needsExplicitItemId(op.name)) {
      // Code derives an id from the Latin letters and digits in the name.
      // A name with none — the norm in this world — derives nothing, and the
      // minting falls back to `item_`, `item__2`, `item__3`: unique, and
      // telling nothing apart in the prose where `[id]` is the only handle a
      // character has on the thing.
      errs.push(
        `create "${op.name}" needs an explicit id: no id can be derived from a name with no Latin letters or digits. Supply a short unused ascii id, e.g. "item_bronze_key"`
      );
    }
    if (typeof op.location !== "string" || !validHolder(op.location, lookup)) {
      errs.push(
        `create.location "${op.location}" must be "scene:<realPlaceId>" or a real character id`
      );
    }
    if (op.id !== undefined) {
      const id = op.id;
      if (typeof id !== "string" || !id) {
        errs.push("create.id must be a non-empty string when present");
      } else if (id.length > 64) {
        errs.push(`create.id must be at most 64 characters — got ${id.length}`);
      } else if (/[[\]\s]/.test(id)) {
        errs.push("create.id must not contain brackets or whitespace");
      } else if (lookup.itemHolders.has(id)) {
        errs.push(
          `create.id "${id}" is already taken by an existing item — pick an unused id or omit it`
        );
      } else if (createdItemIds.has(id)) {
        errs.push(`create.id "${id}" is created more than once this tick`);
      } else {
        createdItemIds.add(id);
      }
    }
    return errs;
  }
  if (!delta.itemId || !lookup.itemHolders.has(delta.itemId)) {
    errs.push(`itemId "${delta.itemId}" does not exist`);
    return errs;
  }
  switch (op.kind) {
    case "move": {
      const currentHolder = lookup.itemHolders.get(delta.itemId);
      if (typeof op.from !== "string" || op.from !== currentHolder) {
        errs.push(
          `move.from "${op.from}" does not match the item's actual holder "${currentHolder}"`
        );
      }
      if (typeof op.to !== "string" || !validHolder(op.to, lookup)) {
        errs.push(
          `move.to "${op.to}" is not a valid holder — write "scene:<placeId>" for a place (a vehicle interior scene included) or a bare characterId for a person`
        );
      } else if (op.to === op.from) {
        // Applies cleanly and changes nothing: the state model has no
        // item-level spot, so "moved within the same scene" is not a move at
        // all. The actor perceives no consequence and tries it again.
        errs.push(
          `move.from and move.to are both "${op.to}" — there is no item-level position within a holder, so this changes nothing. Say where it came to rest in the occurrence, and rewrite the place's description only if the new resting place is a lasting, materially relevant part of it`
        );
      }
      if (movedItemIds.has(delta.itemId)) {
        errs.push(
          `item "${delta.itemId}" is moved/destroyed more than once this tick (unique-ownership conflict — resolve one atomic winner)`
        );
      }
      movedItemIds.add(delta.itemId);
      break;
    }
    case "destroy":
      if (movedItemIds.has(delta.itemId)) {
        errs.push(
          `item "${delta.itemId}" is moved/destroyed more than once this tick`
        );
      }
      movedItemIds.add(delta.itemId);
      break;
    case "set": {
      const hasDescription =
        typeof op.description === "string" && op.description.trim().length > 0;
      const hasAppend =
        typeof op.appendDescription === "string" &&
        op.appendDescription.trim().length > 0;
      const hasHidden = typeof op.hidden === "boolean";
      const hasLight =
        typeof op.isLightSource === "boolean" ||
        typeof op.lightLevel === "number";
      if (!hasDescription && !hasAppend && !hasHidden && !hasLight) {
        errs.push(
          "set needs at least one of description, appendDescription, hidden, isLightSource, lightLevel"
        );
      }
      // Replacing and appending in the same breath does not say which text
      // wins, and the two orders give different results.
      if (hasDescription && hasAppend) {
        errs.push(
          "set cannot carry both description and appendDescription — replace or append, not both"
        );
      }
      break;
    }
  }
  return errs;
}

const PERSPECTIVE_PATTERNS = [
  /\bI\s+(see|hear|feel|notice|recognize)\b/i,
  /令我/,
  /我(看见|听见|认出|感到)/,
];

/** Shortest and longest a declared consequence may last, in in-world minutes.
 *  The expiry sweep is the ONLY thing that removes one of these conditions,
 *  and it is injected into two prompts every tick it is alive — so an
 *  unbounded duration is both a permanent prompt cost and a handicap the
 *  Engine can never revoke. One in-world day is long enough for "shaken for
 *  the rest of the day" and short enough to heal itself. */
export const MIN_CONSEQUENCE_MINUTES = 5;
export const MAX_CONSEQUENCE_MINUTES = 1440;

/**
 * Structural validation of an occurrence's declared sanity checks. Nothing
 * here judges whether the exposure DESERVES a check — that is the rule
 * document's job, in full context. These are shape and reference rules only,
 * the same bargain the action trust boundary strikes.
 */
export const MAX_SANITY_CHECKS = 8;

export function validateSanityChecks(
  occ: RawOccurrence,
  lookup: Lookup
): string[] {
  if (occ.sanityChecks === undefined) return [];
  if (!Array.isArray(occ.sanityChecks)) {
    return [
      "sanityChecks must be an array of {characterId, failureLoss, consequence?}",
    ];
  }
  const declarations = occ.sanityChecks;
  if (declarations.length === 0) return [];

  const errs: string[] = [];
  // Was `maxItems: 8` on the schema; strict mode has no array-length
  // keywords, so the description says it and this enforces it.
  if (declarations.length > MAX_SANITY_CHECKS) {
    errs.push(
      `sanityChecks: at most ${MAX_SANITY_CHECKS} per occurrence — got ${declarations.length}`
    );
  }
  // Every produced delta needs a real `sourceActionId`, and the schema sets no
  // `minItems` on actionIds — an empty array is wire-legal, and would leave
  // the resolver with nothing to attribute the SAN loss to.
  if ((occ.actionIds ?? []).length === 0) {
    errs.push(
      "sanityChecks: an occurrence that declares a sanity check must name at least one actionId"
    );
  }
  const perceivers = perceiverClarities(occ);
  const seen = new Set<string>();

  for (const [i, decl] of declarations.entries()) {
    const at = `sanityChecks[${i}]`;
    const id = decl?.characterId;
    if (typeof id !== "string" || id.length === 0) {
      errs.push(`${at}: characterId is required`);
    } else if (!lookup.characterIds.has(id)) {
      errs.push(`${at}: character "${id}" does not exist`);
    } else {
      if (!lookup.aliveCharacterIds.has(id)) {
        errs.push(`${at}: character "${id}" is not alive`);
      }
      if (!lookup.sanById.has(id)) {
        errs.push(
          `${at}: character "${id}" has no sanity capacity and cannot be checked`
        );
      }
      // Exposure is perception: the same evidence that decided who perceived
      // this occurrence decides who can be shocked by it. A map lookup, not a
      // judgement — except that a trace carries no source to be shocked by.
      const clarity = perceivers.get(id);
      if (clarity === undefined) {
        errs.push(
          `${at}: character "${id}" is not among this occurrence's perceivers — only someone who perceived it can be shocked by it`
        );
      } else if (clarity === "trace") {
        errs.push(
          `${at}: character "${id}" perceives this occurrence only as a trace — a sound or movement with no source cannot be a horror exposure. Raise their clarity if they actually saw or heard the thing, or drop the check`
        );
      }
      if (seen.has(id)) {
        errs.push(
          `${at}: character "${id}" is already checked in this occurrence — one roll per character per exposure`
        );
      }
      seen.add(id);
    }

    // The closed ladder from the guidance, not "any dice formula": the
    // validator used to accept `2d6+1` and `1d100` against a document that
    // offers four rungs, and the model took the offer.
    if (!SANITY_LOSS_SET.has(decl?.failureLoss)) {
      errs.push(
        `${at}: failureLoss "${String(decl?.failureLoss)}" must be exactly one of ${SANITY_LOSS_FORMULAS.join(", ")} — the lowest rung that fits`
      );
    }

    const consequence = decl?.consequence;
    if (consequence === undefined) continue;
    if (typeof consequence !== "object" || consequence === null) {
      errs.push(`${at}: consequence must be an object when provided`);
      continue;
    }
    if (
      typeof consequence.description !== "string" ||
      !consequence.description.trim()
    ) {
      errs.push(
        `${at}: consequence.description is required and must describe objective observable or independently verifiable signs, not inner activity`
      );
    }
    const minutes = consequence.durationMinutes;
    // Not hygiene — crash prevention. `finalizeResolution` runs after this and
    // hands the number to `addMinutes`, which THROWS on a non-integer, and a
    // throw there takes the whole tick down. A malformed submission must be a
    // correctable error, never a crash.
    if (
      !Number.isInteger(minutes) ||
      minutes < MIN_CONSEQUENCE_MINUTES ||
      minutes > MAX_CONSEQUENCE_MINUTES
    ) {
      errs.push(
        `${at}: consequence.durationMinutes must be a whole number of minutes between ${MIN_CONSEQUENCE_MINUTES} and ${MAX_CONSEQUENCE_MINUTES}, got ${String(minutes)}`
      );
    }
  }
  return errs;
}

export function validateOccurrence(
  occ: RawOccurrence,
  lookup: Lookup,
  /** Actions whose time is spent this tick — the only ones a speech row may
   *  cite, since the words are delivered when the action ends. */
  endingIds: ReadonlySet<string> = new Set()
): string[] {
  const errs: string[] = [];
  if (!Array.isArray(occ.actionIds) || occ.actionIds.length === 0) {
    errs.push(
      "actionIds is required — name the action(s) this is the trace of"
    );
  }
  for (const id of listOf<unknown>(occ.actionIds)) {
    if (typeof id !== "string") {
      errs.push("actionIds: every entry must be an action id string");
    } else if (!lookup.actionById.has(id)) {
      errs.push(`actionIds: "${id}" is unknown`);
    }
  }
  if (typeof occ.speech !== "boolean") {
    errs.push(
      "speech is required, true or false — true when this row delivers a spoken line for an id under `endingWithUtterance` (code adds the words), false when something happened"
    );
  }
  const speech = isSpeechRow(occ);
  if (speech) {
    const cited = citedActionIds(occ);
    if (cited.length > 1) {
      // One row, one utterance. Code places a row where the actor of its
      // FIRST cited action stands and copies every cited utterance onto it,
      // so two speakers in one row put the second one's words in the first
      // one's room.
      errs.push(
        `a speech row delivers ONE utterance, but this row cites ${cited.length} actions. Send one speech:true row per speaking action, each with its own targetIds and perceivers`
      );
    }
    for (const id of cited) {
      const known = lookup.actionById.get(id);
      if (!known) continue;
      if (!known.command.utterance?.trim()) {
        errs.push(
          `speech is true, but "${id}" carries no utterance — there are no words to deliver. Set speech false and write what happened in content`
        );
      } else if (!endingIds.has(id)) {
        errs.push(
          `speech is true, but "${id}" does not end this tick — its words are delivered next minute, when it appears under \`endingWithUtterance\`. Leave this row out of the resubmission; the starting entry is all it needs now`
        );
      }
    }
    if (!Array.isArray(occ.targetIds)) {
      errs.push(
        "a speech row requires targetIds — who the words were addressed to (an empty list means the room)"
      );
    }
  } else {
    if (typeof occ.content !== "string" || !occ.content.trim()) {
      errs.push(
        "content is required when speech is false — one objective paragraph of what happened"
      );
    }
    if (occ.targetIds !== undefined && !Array.isArray(occ.targetIds)) {
      errs.push("targetIds must be an array of character ids");
    }
  }
  if (
    typeof occ.content === "string" &&
    PERSPECTIVE_PATTERNS.some((re) => re.test(occ.content as string))
  ) {
    errs.push(
      "content: character-perspective wording detected — it must be objective and third-person"
    );
  }
  for (const id of listOf<unknown>(occ.targetIds)) {
    if (typeof id !== "string" || !lookup.characterIds.has(id)) {
      errs.push(`targetIds: "${String(id)}" does not exist`);
    }
  }
  if (!Array.isArray(occ.perceivers) || occ.perceivers.length === 0) {
    errs.push(
      "perceivers is required — who could perceive this, each with a clarity (full, limited or trace); an occurrence nobody perceives changes nothing"
    );
  }
  const listed = new Set<string>();
  for (const [i, p] of (Array.isArray(occ.perceivers)
    ? occ.perceivers
    : []
  ).entries()) {
    const at = `perceivers[${i}]`;
    const id = p?.characterId;
    if (typeof id !== "string" || id.length === 0) {
      errs.push(`${at}: characterId is required`);
    } else if (!lookup.characterIds.has(id)) {
      errs.push(`${at}: character "${id}" does not exist`);
    } else if (listed.has(id)) {
      errs.push(
        `perceivers: character "${id}" is listed twice — one entry per character, at the single clarity they actually reach`
      );
    } else {
      listed.add(id);
    }
    if (!isClarity(p?.clarity)) {
      errs.push(
        `${at}: clarity "${String(p?.clarity)}" is not one of ${PERCEPTION_CLARITIES.join(", ")}`
      );
    }
  }
  errs.push(...validateSanityChecks(occ, lookup));
  return errs;
}

type EntityKind = Occurrence["facts"][number]["entityRefs"][number]["kind"];

/** Item ids this submission mints with `create` operations — an occurrence
 *  may cite the thing the same tick brings into being. */
export function createdItemIdsOf(raw: RawTickResolution): Set<string> {
  const ids = new Set<string>();
  for (const d of raw.itemChanges ?? []) {
    const op = d?.operation as { kind?: string; id?: unknown } | undefined;
    if (op?.kind === "create" && typeof op.id === "string" && op.id) {
      ids.add(op.id);
    }
  }
  return ids;
}

/** Which kind of thing a bare id names. Id spaces do not overlap, so the
 *  first space that knows the id is the answer; `undefined` means no space
 *  does. A vehicle's exterior is item-like — an occurrence may point at the
 *  truck itself — and an item this same submission creates already counts. */
export function resolveRefKind(
  id: string,
  lookup: Lookup,
  createdItemIds: Set<string> = new Set()
): EntityKind | undefined {
  if (lookup.characterIds.has(id)) return "character";
  if (
    lookup.itemHolders.has(id) ||
    createdItemIds.has(id) ||
    lookup.vehicleIds.has(id)
  ) {
    return "item";
  }
  if (lookup.connectionIds.has(id)) return "connection";
  if (lookup.locationIds.has(id)) return "scene";
  return undefined;
}

// ==================== Whole-resolution validation ====================

export function validateRawResolution(
  raw: RawTickResolution,
  context: EngineResolutionContext
): ResolutionError[] {
  const lookup = buildLookup(context);
  const errors: ResolutionError[] = [];

  // The per-piece validators return plain messages; the address comes from
  // here, which is the only place that knows WHICH element is being checked.
  // That address is what lets the Engine correct one element and keep the
  // rest of the resolution as it was.
  const at = (target: ResolutionError["target"], messages: string[]): void => {
    for (const message of messages) errors.push({ target, message });
  };

  // One entry per triggering action, in exactly one of the three lists. The
  // list an action lands in IS the decision about what happens to it, so
  // appearing twice is a contradiction rather than a duplicate.
  const seen = new Set<string>();
  const moments: Array<
    [string, Array<{ actionId: string }>, (e: never, l: Lookup) => string[]]
  > = [
    ["starting", raw.starting ?? [], validateStart as never],
    ["ending", raw.ending ?? [], validateEnd as never],
  ];
  for (const [moment, entries, validate] of moments) {
    for (const [i, entry] of (entries as unknown[]).entries()) {
      if (
        !isRecord(entry) ||
        typeof entry.actionId !== "string" ||
        !entry.actionId.trim()
      ) {
        at({ kind: "resolution" }, [
          `${moment}[${i}] is not an entry — every element of "${moment}" is an object naming the action it answers: {"actionId": "<id>", ...}. Send it as one, or leave it out`,
        ]);
        continue;
      }
      const target: ResolutionError["target"] = {
        kind: "action",
        actionId: entry.actionId,
      };
      if (seen.has(entry.actionId)) {
        at(target, [
          `appears more than once — an action is either starting or ending, not both (found again in "${moment}"). Send it ONCE in the list it belongs in. Do NOT drop it — this action must be answered this tick`,
        ]);
        continue;
      }
      seen.add(entry.actionId);
      at(
        target,
        moment === "ending"
          ? validateEnd(
              entry as unknown as RawActionEnd,
              lookup,
              raw.occurrences
            )
          : validate(entry as never, lookup)
      );
    }
    if (moment === "starting") {
      // The wheels will not turn for someone standing beside the vehicle:
      // a drive is only settled when the driver is IN the interior scene —
      // already, or moved there by a position change in this same
      // submission. Mechanical (position vs scene id), so it can live here
      // rather than in the rules prose alone.
      for (const entry of entries as unknown[]) {
        if (!isRecord(entry) || typeof entry.actionId !== "string") continue;
        const movement = entry.movement;
        const vehicleId = isRecord(movement) ? movement.vehicleId : undefined;
        if (typeof vehicleId !== "string") continue;
        const interior = lookup.vehicleInteriors.get(vehicleId);
        if (interior === undefined) continue; // unknown vehicle already reported
        const actorId = lookup.actionById.get(entry.actionId)?.command.actorId;
        if (actorId === undefined) continue;
        const alreadyInside =
          lookup.characterSceneIds.get(actorId) === interior;
        const boardedThisSubmission = (raw.characterChanges ?? []).some(
          (change) =>
            isRecord(change) &&
            change.characterId === actorId &&
            (
              change.operation as {
                kind?: string;
                position?: { sceneId?: string };
              }
            )?.kind === "position" &&
            (change.operation as { position?: { sceneId?: string } }).position
              ?.sceneId === interior
        );
        if (!alreadyInside && !boardedThisSubmission) {
          at({ kind: "action", actionId: entry.actionId }, [
            `movement.vehicleId "${vehicleId}": the driver ${actorId} is not in its interior scene "${interior}" — add a characterChange position into "${interior}" in this submission (boarding), or drop the vehicle and walk`,
          ]);
        }
      }
      // Never both for one passage: an obstacle is either removed for
      // everyone (`connectionBlock blocked:false`) or got past by this one
      // walker (`passBlockedConnectionId`). Compared on the passage, not the
      // id — a two-way exit is two ids.
      const passageKey = (connectionId: string): string => {
        const edge = lookup.edgeByConnectionId.get(connectionId);
        return edge ? [edge.from, edge.to].sort().join("::") : connectionId;
      };
      const unblocked = new Map<string, string>();
      for (const sc of raw.sceneChanges ?? []) {
        if (!isRecord(sc)) continue;
        const op = sc.operation as
          | { kind?: string; connectionId?: unknown; blocked?: unknown }
          | undefined;
        if (
          op?.kind === "connectionBlock" &&
          op.blocked === false &&
          typeof op.connectionId === "string"
        ) {
          unblocked.set(passageKey(op.connectionId), op.connectionId);
        }
      }
      if (unblocked.size > 0) {
        for (const entry of entries as unknown[]) {
          if (!isRecord(entry) || typeof entry.actionId !== "string") continue;
          const movement = entry.movement;
          const passId = isRecord(movement)
            ? movement.passBlockedConnectionId
            : undefined;
          if (typeof passId !== "string") continue;
          const clearedAs = unblocked.get(passageKey(passId));
          if (clearedAs === undefined) continue;
          at({ kind: "action", actionId: entry.actionId }, [
            `movement.passBlockedConnectionId "${passId}" and a sceneChanges connectionBlock blocked:false on "${clearedAs}" name the same passage — never both for one passage. If the act REMOVED the obstacle, keep the unblock and drop the grant; if the obstacle STAYS and only this walker got past, keep the grant and drop the unblock`,
          ]);
        }
      }
    }
  }
  // An ending answered by talk alone has no entry: its speech row is the
  // answer. Anything else in the trigger's two lists needs an entry.
  const endingIds = new Set(resolutionWorklist(context).ending);
  const pureSpeechAnswer = (actionId: string): boolean => {
    const trace = occurrencesCiting(actionId, raw.occurrences);
    if (trace.length === 0 || !trace.every(isSpeechRow)) return false;
    const command = lookup.actionById.get(actionId)?.command;
    return Boolean(command?.utterance?.trim());
  };
  for (const required of lookup.requiredActionIds) {
    if (seen.has(required)) continue;
    if (endingIds.has(required) && pureSpeechAnswer(required)) continue;
    at({ kind: "resolution" }, [
      endingIds.has(required)
        ? `triggering action "${required}" was not answered — it ends this tick: give it an "ending" entry with an outcome plus a speech:false occurrence citing it, or, if the whole of it was words said, one occurrence with speech true citing it and no ending entry`
        : `triggering action "${required}" was not answered — it starts this tick and needs a "starting" entry`,
    ]);
  }

  const movedItemIds = new Set<string>();
  // Ids minted by this submission's `create` operations: occurrences may cite
  // them, so item changes are validated (and the set filled) first.
  const createdItemIds = new Set<string>();
  const notAChange = (idField: string): string[] => [
    `is not a change — every element is an object {"sourceActionId", "${idField}", "operation": {"kind", ...}}. Send it as one, or leave it out`,
  ];
  (raw.characterChanges ?? []).forEach((d, i) => {
    at(
      { kind: "characterChange", index: i },
      isRecord(d)
        ? validateCharacterChange(d, lookup)
        : notAChange("characterId")
    );
  });
  (raw.sceneChanges ?? []).forEach((d, i) => {
    at(
      { kind: "sceneChange", index: i },
      isRecord(d) ? validateSceneChange(d, lookup) : notAChange("sceneId")
    );
  });
  (raw.itemChanges ?? []).forEach((d, i) => {
    at(
      { kind: "itemChange", index: i },
      isRecord(d)
        ? validateItemChange(d, lookup, movedItemIds, createdItemIds)
        : notAChange("itemId")
    );
  });
  // Prose-coherence: an item CITED by its holder place's description cannot
  // leave (move/destroy) without the same submission rewriting that prose —
  // a stale citation breaks every later render of the place. Mechanical:
  // string containment vs the Tier-2 snapshot; places outside the involved
  // set are skipped (their prose is not at hand to check).
  (raw.itemChanges ?? []).forEach((d, i) => {
    if (!isRecord(d)) return;
    const op = d.operation as { kind?: string; from?: string };
    if (op?.kind !== "move" && op?.kind !== "destroy") return;
    if (!d.itemId) return;
    const holder =
      op.kind === "move" ? op.from : lookup.itemHolders.get(d.itemId);
    if (typeof holder !== "string" || !holder.startsWith("scene:")) return;
    const placeId = holder.slice("scene:".length);
    const prose = lookup.placeDescriptions.get(placeId);
    if (prose === undefined || !prose.includes(`[${d.itemId}]`)) return;
    const rewritten = (raw.sceneChanges ?? []).some(
      (sc) =>
        isRecord(sc) &&
        (sc as { sceneId?: string }).sceneId === placeId &&
        (sc.operation as { kind?: string })?.kind === "setDescription"
    );
    if (!rewritten) {
      at({ kind: "itemChange", index: i }, [
        `"${d.itemId}" is cited in the description of "${placeId}" — ${op.kind === "move" ? "moving" : "destroying"} it leaves that prose pointing at nothing and breaks every later render there. Add a sceneChanges setDescription for "${placeId}" in this submission (keep still-true citations, drop this one).`,
      ]);
    }
  });
  for (const [i, o] of (raw.occurrences ?? []).entries()) {
    if (!isRecord(o)) {
      at({ kind: "resolution" }, [
        `occurrences[${i}] is not a row — every element is an object {"actionIds", "speech", "perceivers", ...}. Send it as one, or leave it out`,
      ]);
      continue;
    }
    at(
      { kind: "occurrence", actionIds: citedActionIds(o) },
      validateOccurrence(o as unknown as RawOccurrence, lookup, endingIds)
    );
  }

  // One shock per character per tick, across the WHOLE submission.
  // `validateSanityChecks` sees a single occurrence and cannot catch the same
  // person being checked in two of them. This is the structural replacement
  // for the deleted session ledger, and it is what makes the old loop
  // impossible: not "the tool refuses" but "the submission is rejected at an
  // address, and the correction is one targeted edit".
  const shocked = new Set<string>();
  const noteShocks = (
    occ: Pick<RawOccurrence, "sanityChecks"> | null | undefined,
    target: ResolutionError["target"]
  ): void => {
    for (const decl of listOf<{ characterId?: unknown } | null | undefined>(
      occ?.sanityChecks
    )) {
      const id = decl?.characterId;
      if (typeof id !== "string" || id.length === 0) continue;
      if (shocked.has(id)) {
        at(target, [
          `sanityChecks: "${id}" is already checked elsewhere in this submission — one roll per character per tick, however many occurrences they appear in. Keep the exposure that actually shocked them and drop the other.`,
        ]);
        continue;
      }
      shocked.add(id);
    }
  };
  for (const o of raw.occurrences ?? []) {
    if (!isRecord(o)) continue;
    noteShocks(o as unknown as RawOccurrence, {
      kind: "occurrence",
      actionIds: citedActionIds(o),
    });
  }

  return errors;
}

/**
 * Make a model-shaped resolution safe to read.
 *
 * Every list here is declared as an array in both schemas. A provider that
 * honours `strict` cannot send anything else, and that now covers `starting`
 * and `ending` on Anthropic and DeepSeek — but never the effect lists, and
 * never OpenAI, which cannot express either half. The retired patch tool used
 * to take index-keyed
 * OBJECTS for the same fields, so the model was measured sending
 * `{"0": {...}}` where an array belonged. That used to reach `.filter` and
 * take the whole tick down with a TypeError — a malformed submission must be
 * a correctable error, never a crash. Object form means exactly what the
 * array form means, so read it and move on.
 */
export function normalizeList<T>(value: unknown, field = "field"): T[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "object") {
    // Legacy index-keyed object. Every field is an array now, so this only
    // catches a model still writing the old patch shape.
    console.warn(
      `[WorldActionEngine] ${field} arrived as an object rather than an array — reading its values in key order`
    );
    return Object.entries(value as Record<string, T>)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, item]) => item);
  }
  if (typeof value === "string") {
    // The whole list, serialized — the failure the split was made to end.
    //
    // Without a grammar the model writes a JSON DOCUMENT for the field it is
    // filling instead of the field's value, and it happens at the start of
    // generation: measured over 66 stored Claude engine calls, `starting` (the
    // first key it writes) came back as a string in 7 of 55 submissions and
    // `ending` in 1 of 61, while the four effect lists never did it once. In
    // every one of those 7 the model had written `starting` first.
    //
    // `submit_actions` is strict now, so neither Anthropic nor DeepSeek can
    // produce this shape for these two fields any more. It stays reachable on
    // OpenAI, which drops the flag over the nested optional fields, and — for
    // the effect lists — on every provider.
    //
    // Three shapes were measured. The list as its own JSON text —
    // `"[{...}]"` — and the list wrapped in an object under its own name, or
    // a name the model made up: `"{\"starting\": [...]}"`,
    // `"{\"actions\": [...]}"`. Dropping either took a whole resolution with
    // it — the transition, the reason, an occurrence two characters were
    // meant to perceive — and left one line of warning behind.
    try {
      const parsed = parseJsonResponse<unknown>(value);
      if (Array.isArray(parsed)) {
        console.warn(
          `[WorldActionEngine] ${field} arrived as a JSON string — parsed back into an array of ${parsed.length}`
        );
        return parsed as T[];
      }
      if (parsed && typeof parsed === "object") {
        const arrays = Object.entries(parsed as Record<string, unknown>).filter(
          ([, v]) => Array.isArray(v)
        );
        const inner =
          arrays.find(([k]) => k === field) ??
          (arrays.length === 1 ? arrays[0] : undefined);
        if (inner) {
          console.warn(
            `[WorldActionEngine] ${field} arrived as a JSON string wrapping {"${inner[0]}": [...]} — unwrapped into an array of ${(inner[1] as unknown[]).length}`
          );
          return inner[1] as T[];
        }
      }
    } catch {
      // Falls through to the drop below, which says so.
    }
  }
  console.warn(
    `[WorldActionEngine] ${field} arrived as ${typeof value} and could not be read — ignored`
  );
  return [];
}

export function normalizeRawResolution(
  raw: RawTickResolution | undefined
): RawTickResolution {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    starting: normalizeList(source.starting, "starting"),
    ending: normalizeList(source.ending, "ending"),
    characterChanges: normalizeList(
      source.characterChanges,
      "characterChanges"
    ),
    sceneChanges: normalizeList(source.sceneChanges, "sceneChanges"),
    itemChanges: normalizeList(source.itemChanges, "itemChanges"),
    occurrences: normalizeList(source.occurrences, "occurrences"),
  } as RawTickResolution;
}

// ==================== Finalization ====================

export interface FinalizedResolution {
  resolution: TickResolution;
  /** Movement-leg annotations per action (Engine-owned runtime init). */
  movementInits: Record<
    string,
    {
      route: string[];
      vehicleId?: string;
      passBlockedConnectionId?: string;
    }
  >;
  /** The bar set for an action as it starts, per actionId. Written onto the
   *  action once and never revised — code rolls against it later. */
  checkInits: Record<
    string,
    {
      requiredLevel: "regular" | "hard" | "extreme";
      opposedBy?: Array<{ characterId: string; skillId: string }>;
    }
  >;
  /** What each declared sanity check actually rolled. The resulting deltas are
   *  already folded into `resolution.characterChanges`; this is the trace. */
  sanityOutcomes: SanityOutcome[];
}

/**
 * Convert a resolution that has ALREADY passed validation into its typed
 * form. It drops nothing and invents nothing: by the time this runs, every
 * transition is legal, every reference is real and every ended action has its
 * trace. Anything that could not be corrected never reaches here — the tick
 * applies nothing instead.
 *
 * What code still owns rather than trusting the model: occurrence and fact
 * ids, how much time passed, and whether an action is now finished — the
 * Engine says what happened, code says when and whether it is over.
 */
/** Where an occurrence happened: wherever the actor of the first action it
 *  cites stands. Every row cites an action (validated), so this always has
 *  an answer for a character in a scene; a road walker's row stays unplaced.
 *  It used to be an optional field the Engine left blank most of the time,
 *  and a blank location is what let the renderer put a mother at a bedside
 *  two rooms from where she stood. */
function occurrenceActor(o: RawOccurrence, lookup: Lookup): string | undefined {
  return (o.actionIds ?? [])
    .map((id) => lookup.actionById.get(id)?.command.actorId)
    .find((id): id is string => id !== undefined);
}

/** The people a row was aimed at: what the Engine wrote, or — when it wrote
 *  nothing — whoever the cited commands named as target or recipient. */
function occurrenceTargets(o: RawOccurrence, lookup: Lookup): string[] {
  if (Array.isArray(o.targetIds)) return [...new Set(o.targetIds)];
  const out = new Set<string>();
  for (const id of o.actionIds ?? []) {
    for (const ref of lookup.actionById.get(id)?.command.objectRefs ?? []) {
      if (ref.kind !== "character") continue;
      if (ref.role === "target" || ref.role === "recipient") out.add(ref.id);
    }
  }
  return [...out];
}

/**
 * The finalized facts of a row. On a speech row the spoken line of each cited
 * command comes first, verbatim — `utterance` is the one part of a command
 * that is already objective, what anyone in earshot hears character for
 * character, so nothing gets to restate it. Before this, the Engine wrote a
 * third-person summary of the line and the renderer then re-imagined that
 * summary for each listener: two rewrites, and the actor's own diction never
 * reached anyone. The Engine's paragraph, when there is one, follows as a
 * `speech` fact (how it was said) or an `action_result` fact (what happened).
 */
function factsOf(
  o: RawOccurrence,
  lookup: Lookup
): Array<{ type: string; content: string; actorId?: string }> {
  const facts: Array<{ type: string; content: string; actorId?: string }> = [];
  if (isSpeechRow(o)) {
    for (const actionId of o.actionIds ?? []) {
      const command = lookup.actionById.get(actionId)?.command;
      const spoken = command?.utterance?.trim();
      if (!command || !spoken) continue;
      facts.push({
        type: "utterance",
        content: spoken,
        actorId: command.actorId,
      });
    }
  }
  const content = o.content?.trim();
  if (content) {
    facts.push({
      type: isSpeechRow(o) ? "speech" : "action_result",
      content,
    });
  }
  return facts;
}

export function finalizeResolution(
  raw: RawTickResolution,
  context: EngineResolutionContext,
  /** Injectable dice, so a replay or a test can pin every sanity roll this
   *  resolution makes from one source. */
  sanityOpts?: SanityRollOptions
): FinalizedResolution {
  const lookup = buildLookup(context);
  const transitions: ActionTransition[] = [];
  const movementInits: Record<
    string,
    {
      route: string[];
      vehicleId?: string;
      passBlockedConnectionId?: string;
    }
  > = {};
  const checkInits: FinalizedResolution["checkInits"] = {};
  const tickMinutes = context.tick.durationMinutes;

  // Which list an entry arrived in already says what happens to it, so the
  // status no longer has to be inferred from whether a `result` was present.
  // What is still derived: whether an ending completed or was cut short, which
  // follows from the clock, not from anything the Engine said.
  for (const entry of raw.starting ?? []) {
    const known = lookup.actionById.get(entry.actionId);
    if (!known) continue; // unreachable post-validation; keeps types honest
    if (entry.movement?.route?.length) {
      movementInits[entry.actionId] = {
        route: [...entry.movement.route],
        ...(entry.movement.vehicleId !== undefined
          ? { vehicleId: entry.movement.vehicleId }
          : {}),
        ...(entry.movement.passBlockedConnectionId !== undefined
          ? {
              passBlockedConnectionId: entry.movement.passBlockedConnectionId,
            }
          : {}),
      };
    }
    if (entry.check) {
      checkInits[entry.actionId] = {
        requiredLevel: entry.check.requiredLevel,
        ...(entry.opposedBy ? { opposedBy: entry.opposedBy } : {}),
      };
    }
    // A spoken line takes one minute, whatever the Engine wrote: the words
    // are delivered when the action ends, and a line that "takes" three
    // minutes is three minutes in which the listener hears nothing and the
    // Engine keeps trying to deliver it early. Movement keeps its
    // route-derived clock (the orchestrator overrides it); the words land on
    // arrival.
    const spoken =
      !entry.movement?.route?.length &&
      Boolean(known.command.utterance?.trim());
    const durationTicks = spoken ? 1 : entry.resolvedDurationTicks;
    transitions.push({
      actionId: entry.actionId,
      actorId: known.command.actorId,
      from: known.status,
      to: "active",
      progressDeltaMinutes: 0,
      ...(durationTicks !== undefined
        ? { resolvedDurationTicks: durationTicks }
        : {}),
      ...(spoken ? { timingReason: "a spoken line takes one minute" } : {}),
      ...(durationTicks !== undefined
        ? {
            nextWakeAt: addMinutes(
              context.tick.tickStartTime,
              Math.max(
                tickMinutes,
                durationTicks * tickMinutes - known.progressMinutes
              )
            ),
          }
        : {}),
    });
  }

  for (const entry of raw.ending ?? []) {
    const known = lookup.actionById.get(entry.actionId);
    if (!known) continue;
    const durationTicks = known.resolvedDurationTicks;
    // Completed only if its time was actually spent; otherwise the world
    // reached it first and it was cut short.
    const spent =
      durationTicks !== undefined &&
      known.progressMinutes >= durationTicks * tickMinutes;
    transitions.push({
      actionId: entry.actionId,
      actorId: known.command.actorId,
      from: known.status,
      to: spent ? "completed" : "interrupted",
      progressDeltaMinutes: 0,
      // The one thing an ending says. It travels as the transition's reason:
      // the renderer's "Result:" line and the event log both read it there.
      ...(typeof entry.outcome === "string" ? { reason: entry.outcome } : {}),
    });
  }
  // A pure-speech action has no ending entry: its speech row ended it. The
  // clock still has to close the action, so the transition is written here,
  // with no reason — what came of it is the words, which every perceiver of
  // the row (the actor included, when listed) receives as the row itself.
  const answered = new Set((raw.ending ?? []).map((e) => e.actionId));
  for (const id of resolutionWorklist(context).ending) {
    if (answered.has(id)) continue;
    const spoken = occurrencesCiting(id, raw.occurrences).some(isSpeechRow);
    if (!spoken) continue;
    const known = lookup.actionById.get(id);
    if (!known) continue;
    const durationTicks = known.resolvedDurationTicks;
    const spent =
      durationTicks !== undefined &&
      known.progressMinutes >= durationTicks * tickMinutes;
    transitions.push({
      actionId: id,
      actorId: known.command.actorId,
      from: known.status,
      to: spent ? "completed" : "interrupted",
      progressDeltaMinutes: 0,
    });
  }

  const characterChanges = (raw.characterChanges ?? [])
    .filter((d): d is NonNullable<typeof d> => d != null)
    .map(
      (d) =>
        makeSourced(d, {
          domain: "character",
          characterId: d.characterId,
          operation: d.operation as never,
        }) as SourcedWorldDelta<CharacterChange>
    );

  const sceneChanges = (raw.sceneChanges ?? [])
    .filter((d): d is NonNullable<typeof d> => d != null)
    .map(
      (d) =>
        makeSourced(d, {
          domain: "scene",
          sceneId: d.sceneId,
          operation: d.operation as never,
        }) as SourcedWorldDelta<SceneChange>
    );

  const itemChanges = (raw.itemChanges ?? [])
    .filter((d): d is NonNullable<typeof d> => d != null)
    .map(
      (d) =>
        makeSourced(d, {
          domain: "item",
          ...(d.itemId !== undefined ? { itemId: d.itemId } : {}),
          operation: d.operation as never,
        }) as SourcedWorldDelta<ItemChange>
    );

  // Withdrawn (null) rows are dropped here, so ids below count only real
  // occurrences. Every row cites an action (validated), so the actor, the
  // place and — failing an explicit list — the targets all come from the
  // command; the spoken line, on a speech row, comes from it too.
  const rawOccurrences: RawOccurrence[] = (raw.occurrences ?? []).filter(
    (o): o is RawOccurrence => o != null
  );

  // Finalization runs exactly once per session and only on a clean
  // submission, which is what guarantees one roll per declaration.
  const sanity = resolveSanityDeclarations(
    rawOccurrences,
    lookup,
    context.tick,
    sanityOpts
  );
  characterChanges.push(...sanity.deltas);

  const occurrences: Occurrence[] = [];
  rawOccurrences.forEach((o, i) => {
    const occurrenceId = `occ_${context.tick.tickId}_${i}`;
    const actorId = occurrenceActor(o, lookup);
    const locationId = actorId
      ? lookup.characterSceneIds.get(actorId)
      : undefined;
    occurrences.push({
      id: occurrenceId,
      tickId: context.tick.tickId,
      sourceActionIds: o.actionIds ?? [],
      ...(locationId !== undefined ? { locationId } : {}),
      facts: factsOf(o, lookup).map((f, fi) => ({
        id: `${occurrenceId}#f${fi}`,
        type: f.type,
        content: f.content,
        // The line points at whoever said it; the paragraph points at
        // nothing — its names are in the prose.
        entityRefs:
          f.actorId !== undefined
            ? [{ kind: "character" as const, id: f.actorId }]
            : [],
      })),
      participants: [
        ...(actorId ? [{ characterId: actorId, role: "actor" as const }] : []),
        ...occurrenceTargets(o, lookup)
          .filter((id) => id !== actorId)
          .map((characterId) => ({ characterId, role: "target" as const })),
      ],
      perceivers: (o.perceivers ?? []).map((p) => ({
        characterId: p.characterId,
        clarity: p.clarity,
      })),
      signals: [],
    });
  });

  return {
    resolution: {
      transitions,
      characterChanges,
      sceneChanges,
      itemChanges,
      occurrences,
    },
    movementInits,
    checkInits,
    sanityOutcomes: sanity.outcomes,
  };
}

function makeSourced<T extends WorldDelta>(
  raw: RawSourcedDelta,
  delta: T
): SourcedWorldDelta<T> {
  return {
    source: { kind: "action", actionId: raw.sourceActionId },
    delta,
  };
}
