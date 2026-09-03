// src/engine/resolution/worldDeltaValidator.ts
//
// Code-side contract enforcement for the World Action Engine's output
// (plan Phase 7 / rules "Output rules"). Two entry points:
//
//   validateRawResolution — returns every violation found (fed back to the
//     model for ONE corrective retry).
//   finalizeResolution — converts the (possibly still imperfect) raw output
//     into a typed TickResolution: invalid deltas/occurrences are dropped
//     with recorded violations, actions whose transition is missing or
//     illegal are marked failed, ids and nextWakeAt are code-assigned.
//
// The validator never re-judges semantics; it enforces structure, real
// references, invariants, transition legality, timing ownership and
// roll-consistency (via the deterministic adjudicator).

import { MAX_SPOT_LENGTH } from "../../state/characterSpot.js";
import { addMinutes } from "../../state/gameClock.js";
import { actionIdForCommand } from "../actions/actionStore.js";
import type {
  ActionCommand,
  ActionTransition,
  CharacterChange,
  EngineAction,
  EngineActionStatus,
  ItemChange,
  Occurrence,
  SceneChange,
  SourcedWorldDelta,
  TickResolution,
  WorldDelta,
} from "../actions/types.js";
import { parseJsonResponse } from "../shared/jsonParse.js";
import {
  isGuaranteedZeroLoss,
  validSanityLossFormula,
} from "../tools/diceTools.js";
import type { SanityOutcome, SanityRollOptions } from "./sanityResolver.js";
import { resolveSanityDeclarations } from "./sanityResolver.js";
import type { EngineResolutionContext, ResolutionError } from "./types.js";
import {
  CHARACTER_OPS,
  ITEM_OPS,
  SCENE_OPS,
  opKinds,
} from "./worldDeltaSchema.js";
import type {
  RawActionEnd,
  RawActionStart,
  RawOccurrence,
  RawResolutionRepair,
  RawSourcedDelta,
  RawTickResolution,
} from "./worldDeltaSchema.js";

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
   *  and the ones whose time is spent. A triggered action that is merely
   *  still running is not here — silence already means "keeps running". */
  requiredActionIds: Set<string>;
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
 * Only `starting` and `ending` are obligations, and they are the only two
 * lists a submission has. An action that is merely still running takes no
 * entry at all: "keeps running" is already what silence means, so an entry
 * for it would be a sentence carrying no information.
 */
export interface ResolutionWorklist {
  /** Queued: has not begun. Must appear in `starting`. */
  starting: string[];
  /** Its time is spent. Must appear in `ending`. The duration was set once,
   *  when the action began; there is no way to ask for more time here, or the
   *  Engine could postpone committing to an outcome indefinitely. */
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
  /** In-flight actions that carried no check, so nothing rolled. If one of
   *  these ends, the Engine supplies `outcome`. */
  endingNeedsOutcome: string[];
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
    endingNeedsOutcome: [],
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
  const commandById = new Map(
    context.actions.newCommands.map((c) => [actionIdForCommand(c.commandId), c])
  );
  for (const id of context.trigger.actionIds) {
    if (queued.has(id)) {
      worklist.starting.push(id);
      if (commandById.get(id)?.declaredSkillId === undefined) {
        worklist.startingWithoutSkill.push(id);
      }
      continue;
    }
    const action = context.actions.activeActions.find((a) => a.id === id);
    if (!action) continue;
    const durationTicks = action.resolvedDurationTicks;
    const due =
      durationTicks !== undefined &&
      action.progressMinutes >= durationTicks * context.tick.durationMinutes;
    if (due) worklist.ending.push(id);
    else if (replaced.has(id)) {
      // Cut short by its own actor: an entry is owed now, and the clock
      // (not the Engine) will record it as interrupted, since its time was
      // not spent.
      worklist.ending.push(id);
      worklist.replaced.push(id);
    } else worklist.stillRunning.push(id);
    // Listed for every in-flight action, not just the due ones, because a
    // still-running action may still be cut short here.
    if (action.check === undefined) worklist.endingNeedsOutcome.push(id);
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
    vehicleIds,
    vehicleInteriors,
    characterSceneIds,
    placeDescriptions,
    itemHolders,
    actionById,
    requiredActionIds: new Set([...worklist.starting, ...worklist.ending]),
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
    // Name the addressable ids: a bare "unknown actionId" gives the repair
    // round nothing to correct toward, so every round re-sends the same id.
    return {
      error: `unknown actionId — address one of: ${[...lookup.actionById.keys()].join(", ")}, or withdraw this entry with {"actionId": "<the id you sent>", "remove": true}`,
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
  if (entry.check && known.command.declaredSkillId === undefined) {
    errs.push(
      `the actor declared no skill, so there is nothing to check — omit "check"`
    );
  }
  for (const defender of entry.opposedBy ?? []) {
    if (!lookup.characterIds.has(defender.characterId)) {
      errs.push(`opposedBy character "${defender.characterId}" does not exist`);
    }
  }
  if (entry.opposedBy && !entry.check) {
    errs.push(
      `opposedBy needs a check — name the bar the opposition is against`
    );
  }
  // The route goes straight to the movement runtime, which walks the
  // character leg by leg. Every waypoint must name a real place; adjacency
  // between consecutive waypoints is enforced at movement init, which fails
  // the action with a route-shaped reason the actor can learn from.
  if (entry.movement !== undefined) {
    const route = entry.movement.route;
    if (!Array.isArray(route) || route.length === 0) {
      errs.push(
        `movement requires a non-empty route array (the waypoints the actor stated, grounded to place ids)`
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
  }
  // Duration is conditionally required: a non-travel action must say how
  // long it takes; a travel action must NOT be clocked by hand — code derives
  // its time from the route. `timingReason` is not required: nothing at
  // runtime reads it, and demanding it bought a repair round (a full re-send)
  // every time the model left it off, for a sentence only the harness prints.
  if (
    entry.movement === undefined &&
    entry.resolvedDurationTicks === undefined
  ) {
    errs.push(
      "a non-travel action needs resolvedDurationTicks; only movement actions derive their clock from the route"
    );
  }
  errs.push(...validateDuration(entry.resolvedDurationTicks));
  return errs;
}

/**
 * An ending the Engine has judged to be nothing but talk: every fact it wrote
 * is speech. Talk is not an attempt — it neither succeeds nor fails, it is
 * simply heard — so these endings carry no `outcome`, the same way a checked
 * ending carries none because code already decided it.
 *
 * The test reads what the Engine WROTE rather than asking it a separate
 * question: fact types are already its judgement about what happened, so a
 * second field saying "this was conversation" could only ever contradict them.
 */
function isSpeechOnly(occurrences: RawOccurrence[]): boolean {
  const facts = occurrences.flatMap((o) =>
    Array.isArray(o?.facts) ? o.facts : []
  );
  if (facts.length === 0) return false;
  return facts.every((f) => f?.type === "speech");
}

/** The occurrences that cite an action — its trace. Null rows (withdrawn in
 *  a repair) are skipped. */
export function occurrencesCiting(
  actionId: string,
  occurrences: ReadonlyArray<RawOccurrence | null | undefined> | undefined
): RawOccurrence[] {
  return (occurrences ?? []).filter(
    (o): o is RawOccurrence =>
      o != null && (o.actionIds ?? []).includes(actionId)
  );
}

function validateEnd(
  entry: RawActionEnd,
  lookup: Lookup,
  /** The whole submission's occurrences: the trace of this ending lives
   *  there now, and whether it is nothing but talk is read off it. */
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
  if (!entry.reason?.trim()) {
    errs.push(`an ending requires a reason`);
  }
  // With a check, code already decided success from the roll against the bar;
  // restating it is how the two can disagree.
  // `null` is the model saying "none" — the same answer as leaving the field
  // out, and it was being refused as if a verdict had been written.
  const hadCheck = known.check !== undefined;
  const trace = occurrencesCiting(entry.actionId, occurrences);
  if (trace.length === 0) {
    // The guarantee the nested `occurrence` slot used to give, now a check.
    // Without a trace the actor perceives nothing, concludes nothing
    // happened, and re-issues the same action next minute — the loop the
    // old required field existed to prevent.
    errs.push(
      `no occurrence cites this ending — the actor perceives nothing, concludes nothing happened, and re-issues the same action next minute. Add an entry to "occurrences" with this actionId in its "actionIds"`
    );
  }
  const spokenOnly = isSpeechOnly(trace);
  if (hadCheck && entry.outcome != null) {
    errs.push(
      `this action was checked — code decides success from the roll against your bar; drop "outcome"`
    );
  }
  if (!hadCheck && spokenOnly && entry.outcome != null) {
    errs.push(
      `every fact here is speech, so nothing was staked and nothing can have failed — drop "outcome". The words reach whoever could hear them; that is the whole result`
    );
  }
  if (!hadCheck && !spokenOnly && !entry.outcome) {
    errs.push(
      `this action carried no check, so nothing rolled — "outcome" is required (the trigger section lists it under endingNeedsOutcome), unless every fact you write is speech`
    );
  }
  if (entry.replacedBy !== undefined) {
    // Informational, but it must point at the real successor: the one new
    // command whose `replacesActionId` is this action. Anything else is the
    // model misreading the trigger, and naming the right id costs nothing.
    const successor = [...lookup.actionById.entries()].find(
      ([, a]) => a.command.replacesActionId === entry.actionId
    );
    if (!successor) {
      errs.push(
        `"replacedBy" is only for an id the trigger lists under \`replaced\` — this action was not cut short by a new command; drop the field`
      );
    } else if (successor[0] !== entry.replacedBy) {
      errs.push(
        `"replacedBy" names "${entry.replacedBy}", but the command that replaced this action is "${successor[0]}"`
      );
    }
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
  if (!delta.causalBasis?.trim()) {
    errs.push(`causalBasis is required`);
  }
  if (!delta.operation || typeof delta.operation.kind !== "string") {
    errs.push(`operation.kind is required`);
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
    case "san":
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
          `position cannot put a character on a road — a road is walked, never assigned; give the action a movement.route instead`
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
        errs.push(`removeCondition requires conditionId`);
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
        errs.push(`addCondition requires condition.description`);
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
        errs.push(`connectionBlock requires blocked boolean`);
      }
      if (typeof op.reason !== "string" || !op.reason.trim()) {
        errs.push(`connectionBlock requires a reason`);
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
        errs.push(`environmentContribute has invalid quantity`);
      }
      if (typeof op.value !== "number" || !Number.isFinite(op.value)) {
        errs.push(`environmentContribute requires numeric value`);
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
      errs.push(`create requires a name`);
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
          `set needs at least one of description, appendDescription, hidden, isLightSource, lightLevel`
        );
      }
      // Replacing and appending in the same breath does not say which text
      // wins, and the two orders give different results.
      if (hasDescription && hasAppend) {
        errs.push(
          `set cannot carry both description and appendDescription — replace or append, not both`
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
  const declarations = occ.sanityChecks ?? [];
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
  const perceivers = new Set(occ.perceiverCharacterIds ?? []);
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
      // this occurrence decides who can be shocked by it. A set membership
      // test, not a judgement.
      if (!perceivers.has(id)) {
        errs.push(
          `${at}: character "${id}" is not among this occurrence's perceiverCharacterIds — only someone who perceived it can be shocked by it`
        );
      }
      if (seen.has(id)) {
        errs.push(
          `${at}: character "${id}" is already checked in this occurrence — one roll per character per exposure`
        );
      }
      seen.add(id);
    }

    if (!validSanityLossFormula(decl?.failureLoss)) {
      errs.push(
        `${at}: failureLoss "${decl?.failureLoss}" is not a dice formula`
      );
    } else if (isGuaranteedZeroLoss(decl.failureLoss)) {
      errs.push(
        `${at}: failureLoss "${decl.failureLoss}" cannot cost anything, and a passed check already costs nothing — a check that cannot cost anything is one that should not happen. Resolve the action without it.`
      );
    }

    const consequence = decl?.consequence;
    if (consequence === undefined) continue;
    if (typeof consequence !== "object" || consequence === null) {
      errs.push(`${at}: consequence must be an object when provided`);
      continue;
    }
    if (!consequence.description?.trim()) {
      errs.push(
        `${at}: consequence.description is required and must describe objective observable or independently verifiable signs, not inner activity`
      );
    }
    const minutes = consequence.durationMinutes;
    // Not hygiene — crash prevention. `finalizeResolution` runs after this and
    // hands the number to `addMinutes`, which THROWS on a non-integer, and a
    // throw there takes the whole tick down. A malformed submission must be a
    // repairable error, never a crash.
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
  /** Item ids minted by this submission's own `create` operations: an
   *  occurrence may cite the thing the same tick brings into being. */
  createdItemIds: Set<string> = new Set()
): string[] {
  const errs: string[] = [];
  if (!Array.isArray(occ.actionIds) || occ.actionIds.length === 0) {
    errs.push(
      "actionIds is required — name the action(s) this is the trace of"
    );
  }
  for (const id of occ.actionIds ?? []) {
    if (!lookup.actionById.has(id)) {
      errs.push(`actionIds: "${id}" is unknown`);
    }
  }
  if (occ.locationId && !lookup.locationIds.has(occ.locationId)) {
    errs.push(`locationId "${occ.locationId}" does not exist`);
  }
  if (!occ.facts || occ.facts.length === 0) {
    errs.push(`at least one fact is required`);
  }
  for (const [fi, fact] of (occ.facts ?? []).entries()) {
    if (fact.type === "utterance") {
      // Told that code carries the spoken line in for it, the model reached
      // for a POINTER at the line instead — a fact whose entire content was
      // "action_e2de4d90_utterance", handed on to four characters as the
      // thing they heard. The line is added after validation and is not the
      // Engine's to write, to name, or to refer to.
      errs.push(
        `facts[${fi}]: "utterance" is not a type you write — code adds the spoken line itself. Describe what the words were NOT (how it was said, what the hands did, who turned to look), and never write a fact standing in for the line`
      );
    }
    if (!fact.content?.trim()) {
      errs.push(`facts[${fi}]: content is required`);
    } else if (PERSPECTIVE_PATTERNS.some((re) => re.test(fact.content))) {
      errs.push(
        `facts[${fi}]: character-perspective wording detected — facts must be objective and third-person`
      );
    }
    for (const id of fact.refIds ?? []) {
      if (resolveRefKind(id, lookup, createdItemIds) === undefined) {
        errs.push(`facts[${fi}]: ref "${id}" does not exist`);
      }
    }
  }
  if (occ.actorId !== undefined && !lookup.characterIds.has(occ.actorId)) {
    errs.push(`actorId "${occ.actorId}" does not exist`);
  }
  for (const [field, ids] of [
    ["targetIds", occ.targetIds],
    ["affectedIds", occ.affectedIds],
  ] as const) {
    for (const id of ids ?? []) {
      if (!lookup.characterIds.has(id)) {
        errs.push(`${field}: "${id}" does not exist`);
      }
    }
  }
  for (const id of occ.perceiverCharacterIds ?? []) {
    if (!lookup.characterIds.has(id)) {
      errs.push(`perceiver "${id}" does not exist`);
    }
  }
  for (const [si, signal] of (occ.signals ?? []).entries()) {
    for (const fi of signal.factIndexes ?? []) {
      if (!Number.isInteger(fi) || fi < 0 || fi >= (occ.facts?.length ?? 0)) {
        errs.push(`signals[${si}]: factIndex ${fi} out of range`);
      }
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
  // That address is what lets the Engine repair one element instead of
  // rewriting the whole resolution.
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
    for (const entry of entries) {
      const target: ResolutionError["target"] = {
        kind: "action",
        actionId: entry.actionId,
      };
      if (seen.has(entry.actionId)) {
        at(target, [
          `appears more than once — an action is either starting or ending, not both (found again in "${moment}"). Send it ONCE in the list it belongs in: a repaired action replaces every copy of its id. Do NOT withdraw it — this action must be answered this tick`,
        ]);
        continue;
      }
      seen.add(entry.actionId);
      at(
        target,
        moment === "ending"
          ? validateEnd(entry as RawActionEnd, lookup, raw.occurrences)
          : validate(entry as never, lookup)
      );
    }
    if (moment === "starting") {
      // The wheels will not turn for someone standing beside the vehicle:
      // a drive is only settled when the driver is IN the interior scene —
      // already, or moved there by a position change in this same
      // submission. Mechanical (position vs scene id), so it can live here
      // rather than in the rules prose alone.
      for (const entry of entries as RawActionStart[]) {
        const vehicleId = entry.movement?.vehicleId;
        if (vehicleId === undefined) continue;
        const interior = lookup.vehicleInteriors.get(vehicleId);
        if (interior === undefined) continue; // unknown vehicle already reported
        const actorId = lookup.actionById.get(entry.actionId)?.command.actorId;
        if (actorId === undefined) continue;
        const alreadyInside =
          lookup.characterSceneIds.get(actorId) === interior;
        const boardedThisSubmission = (raw.characterChanges ?? []).some(
          (change) =>
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
    }
  }
  for (const required of lookup.requiredActionIds) {
    if (!seen.has(required)) {
      at({ kind: "resolution" }, [
        `triggering action "${required}" was not answered — it is either starting or ending this tick, and needs an entry in that list`,
      ]);
    }
  }

  const movedItemIds = new Set<string>();
  // Ids minted by this submission's `create` operations: occurrences may cite
  // them, so item changes are validated (and the set filled) first.
  const createdItemIds = new Set<string>();
  (raw.characterChanges ?? []).forEach((d, i) => {
    if (d === null) return;
    at(
      { kind: "characterChange", index: i },
      validateCharacterChange(d, lookup)
    );
  });
  (raw.sceneChanges ?? []).forEach((d, i) => {
    if (d === null) return;
    at({ kind: "sceneChange", index: i }, validateSceneChange(d, lookup));
  });
  (raw.itemChanges ?? []).forEach((d, i) => {
    if (d === null) return;
    at(
      { kind: "itemChange", index: i },
      validateItemChange(d, lookup, movedItemIds, createdItemIds)
    );
  });
  // Prose-coherence: an item CITED by its holder place's description cannot
  // leave (move/destroy) without the same submission rewriting that prose —
  // a stale citation breaks every later render of the place. Mechanical:
  // string containment vs the Tier-2 snapshot; places outside the involved
  // set are skipped (their prose is not at hand to check).
  (raw.itemChanges ?? []).forEach((d, i) => {
    if (d === null) return;
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
        sc !== null &&
        (sc as { sceneId?: string }).sceneId === placeId &&
        (sc.operation as { kind?: string })?.kind === "setDescription"
    );
    if (!rewritten) {
      at({ kind: "itemChange", index: i }, [
        `"${d.itemId}" is cited in the description of "${placeId}" — ${op.kind === "move" ? "moving" : "destroying"} it leaves that prose pointing at nothing and breaks every later render there. Add a sceneChanges setDescription for "${placeId}" in this submission (keep still-true citations, drop this one).`,
      ]);
    }
  });
  (raw.occurrences ?? []).forEach((o, i) => {
    if (o === null) return;
    at(
      { kind: "occurrence", index: i },
      validateOccurrence(o, lookup, createdItemIds)
    );
  });

  // One shock per character per tick, across the WHOLE submission.
  // `validateSanityChecks` sees a single occurrence and cannot catch the same
  // person being checked in two of them. This is the structural replacement
  // for the deleted session ledger, and it is what makes the old loop
  // impossible: not "the tool refuses" but "the submission is rejected at an
  // address, and the repair is one targeted edit".
  const shocked = new Set<string>();
  const noteShocks = (
    occ: Pick<RawOccurrence, "sanityChecks"> | null | undefined,
    target: ResolutionError["target"]
  ): void => {
    for (const decl of occ?.sanityChecks ?? []) {
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
  (raw.occurrences ?? []).forEach((o, i) => {
    noteShocks(o, { kind: "occurrence", index: i });
  });

  return errors;
}

/**
 * Merge a repair over the previous submission. Only the addressed elements
 * change; everything else stands exactly as it was, which is the whole point
 * — a model asked to re-send a correct delta will sometimes "improve" it.
 *
 * Withdrawn elements become holes rather than being spliced out, so an index
 * quoted in one round still addresses the same element in the next.
 */
/**
 * Make a model-shaped resolution safe to read.
 *
 * Every list here is declared as an array in the schema, but the repair tool
 * next door takes index-keyed OBJECTS for the same fields, and the model
 * mixes them up. A `{"0": {...}}` where an array belongs used to reach
 * `.filter` and take the whole tick down with a TypeError — a malformed
 * submission must be a repairable error, never a crash. Object form means
 * exactly what the array form means, so read it and move on.
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
    // The whole list, serialized. The engine tools are `strict` now, and a
    // provider that honours it (Anthropic, OpenAI) cannot produce this shape.
    // DeepSeek has no strict mode, so the tolerance stays for that path.
    //
    // Two shapes were measured before strict went on. The list as its own
    // JSON text — `"[{...}]"` — and the list wrapped in an object under its
    // own name, or a name the model made up: `"{\"starting\": [...]}"`,
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

/**
 * The withdrawals in this repair that {@link applyRepair} will refuse, because
 * the action must be answered this tick. Separate from the merge so the caller
 * can SAY so in the next round's feedback: a refusal the model is not told
 * about is a correction it will make again.
 */
export function refusedWithdrawals(
  repair: RawResolutionRepair,
  protectedActionIds: ReadonlySet<string>
): string[] {
  const out = new Set<string>();
  for (const moment of ["starting", "ending"] as const) {
    for (const item of normalizeList<{ actionId?: string; remove?: boolean }>(
      repair[moment],
      `repair.${moment}`
    )) {
      if (
        item?.remove === true &&
        typeof item.actionId === "string" &&
        protectedActionIds.has(item.actionId)
      ) {
        out.add(item.actionId);
      }
    }
  }
  return [...out];
}

export function applyRepair(
  raw: RawTickResolution,
  repair: RawResolutionRepair,
  /** Actions the trigger requires an answer for. A withdrawal aimed at one of
   *  these is refused rather than obeyed — see the note in the action merge. */
  protectedActionIds: ReadonlySet<string> = new Set()
): RawTickResolution {
  // One shape for everything: an array whose items carry their own address.
  const patchList = <T>(
    list: Array<T | null> | undefined,
    patches: unknown
  ): Array<T | null> => {
    const out = [...(list ?? [])];
    // In the retired shape the KEY was the address, so keep it when reading
    // one: dropping it would turn a replacement into an append.
    const items: Array<Record<string, unknown>> =
      patches && typeof patches === "object" && !Array.isArray(patches)
        ? Object.entries(patches as Record<string, unknown>).map(
            ([key, value]) =>
              value === null
                ? { index: Number(key), remove: true }
                : { index: Number(key), ...(value as Record<string, unknown>) }
          )
        : normalizeList<Record<string, unknown>>(patches);
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const { index, remove, ...value } = raw as {
        index?: number;
        remove?: boolean;
      } & Record<string, unknown>;
      const addressed =
        typeof index === "number" &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < out.length;
      if (addressed) {
        out[index as number] = remove === true ? null : (value as T);
      } else if (remove !== true) {
        out.push(value as T);
      }
    }
    return out;
  };

  // Actions are addressed by id, not by index — and the list an action sits
  // in is itself the decision, so a repair that moves one between moments has
  // to drop it from the other. Otherwise "this belongs in ending" would
  // leave the wrong entry behind and the next round would reject both.
  //
  // Two rules make the id the whole address. A replacement collapses EVERY
  // copy of that id into the one sent: a submission that answered the same
  // action twice used to be unrepairable, because replacing hit the first
  // copy and the second went on being the duplicate the error complained
  // about — three rounds of correct-looking repairs in one measured tick, and
  // the resolution dropped anyway. And `remove: true` withdraws the id from
  // both lists, which is the only way to take back an answer to something the
  // trigger never asked about.
  const base = normalizeRawResolution(raw);
  const repaired = {
    starting: [...(base.starting ?? [])],
    ending: [...(base.ending ?? [])],
  };
  const touched = new Set<string>();
  const withdrawn = new Set<string>();
  /** actionId → the entry that survives, and the list it belongs in. */
  const kept = new Map<
    string,
    { moment: "starting" | "ending"; entry: unknown }
  >();
  for (const moment of ["starting", "ending"] as const) {
    for (const item of normalizeList<{ actionId: string; remove?: boolean }>(
      repair[moment],
      `repair.${moment}`
    )) {
      if (typeof item?.actionId !== "string") continue;
      touched.add(item.actionId);
      if (item.remove === true) {
        // Withdrawal is for an entry that should never have been sent — an
        // answer to something the trigger is not resolving. A TRIGGERING
        // action cannot be withdrawn: it must be answered this tick, and
        // obeying the removal only turns "you answered this twice" into "you
        // did not answer this at all". Measured: told an action appeared in
        // both lists, the model withdrew it, was told it was unanswered, put
        // it back in both, and the tick died three rounds later.
        if (protectedActionIds.has(item.actionId)) {
          // Refuse the withdrawal — but only forget that the id was touched
          // when this repair offered nothing else for it. A repair that sends
          // BOTH a replacement and a removal for one action used to leave the
          // id untouched while its replacement still waited in `kept`: the
          // copies already in the lists were kept as-is AND the replacement
          // was appended, so every round added one more copy of the very
          // action the errors were complaining about.
          if (!kept.has(item.actionId)) touched.delete(item.actionId);
          continue;
        }
        withdrawn.add(item.actionId);
        kept.delete(item.actionId);
        continue;
      }
      withdrawn.delete(item.actionId);
      const { remove: _remove, ...entry } = item;
      kept.set(item.actionId, { moment, entry });
    }
  }
  for (const moment of ["starting", "ending"] as const) {
    const list = repaired[moment] as Array<{ actionId: string }>;
    const seen = new Set<string>();
    repaired[moment] = list.flatMap((existing) => {
      const id = existing.actionId;
      if (!touched.has(id)) return [existing];
      const replacement = kept.get(id);
      // Withdrawn, moved to the other list, or a second copy of an id whose
      // replacement has already landed: all three leave nothing here.
      if (replacement?.moment !== moment || seen.has(id)) return [];
      seen.add(id);
      return [replacement.entry as typeof existing];
    }) as never;
    // An id the submission never carried in this list appends here.
    for (const [id, { moment: target, entry }] of kept) {
      if (target === moment && !seen.has(id)) {
        seen.add(id);
        (repaired[moment] as unknown[]).push(entry);
      }
    }
  }

  return {
    ...repaired,
    characterChanges: patchList(
      raw.characterChanges,
      repair.characterChanges
    ) as RawTickResolution["characterChanges"],
    sceneChanges: patchList(
      raw.sceneChanges,
      repair.sceneChanges
    ) as RawTickResolution["sceneChanges"],
    itemChanges: patchList(
      raw.itemChanges,
      repair.itemChanges
    ) as RawTickResolution["itemChanges"],
    occurrences: patchList(
      raw.occurrences,
      repair.occurrences
    ) as RawTickResolution["occurrences"],
  };
}

// ==================== Finalization ====================

export interface FinalizedResolution {
  resolution: TickResolution;
  /** Movement-leg annotations per action (Engine-owned runtime init). */
  movementInits: Record<string, { route: string[]; vehicleId?: string }>;
  /** The bar set for an action as it starts, per actionId. Written onto the
   *  action once and never revised — code rolls against it later. */
  checkInits: Record<
    string,
    {
      requiredLevel: "regular" | "hard" | "extreme";
      basis: string;
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
 * trace. Anything that could not be repaired never reaches here — the tick
 * applies nothing instead.
 *
 * What code still owns rather than trusting the model: occurrence and fact
 * ids, how much time passed, and whether an action is now finished — the
 * Engine says what happened, code says when and whether it is over.
 */
/** Where an occurrence happened when the Engine left `locationId` blank:
 *  wherever its actor stands. The Engine leaves it blank most of the time
 *  (measured: every occurrence of a 50-minute doorway conversation), and a
 *  blank location is what let the renderer put a mother at a bedside two
 *  rooms from where she stood — a participant with no place reads as "here".
 *  Only scene positions resolve; a road walker's occurrence stays unplaced. */
function occurrenceLocationFromActor(
  o: { actorId?: string; actionIds?: string[] },
  lookup: Lookup
): string | undefined {
  const actor =
    o.actorId ??
    o.actionIds
      ?.map((id) => lookup.actionById.get(id)?.command.actorId)
      .find((id): id is string => id !== undefined);
  return actor ? lookup.characterSceneIds.get(actor) : undefined;
}

/** The finalized participant rows, rebuilt from the three flat fields. */
function participantsOf(o: RawOccurrence): Occurrence["participants"] {
  return [
    ...(o.actorId ? [{ characterId: o.actorId, role: "actor" as const }] : []),
    ...(o.targetIds ?? []).map((characterId) => ({
      characterId,
      role: "target" as const,
    })),
    ...(o.affectedIds ?? []).map((characterId) => ({
      characterId,
      role: "directly_affected" as const,
    })),
  ];
}

/**
 * The spoken lines of the actions an occurrence cites, placed ahead of the
 * Engine's own facts — but only on the FIRST occurrence citing each action,
 * in list order: that row's perceivers are the people who made out the
 * words. `utterance` is the one part of a command that is already objective
 * — it is what anyone in earshot hears, character for character — so nothing
 * gets to restate it. Before this, the Engine wrote a third-person summary of
 * the line and the renderer then re-imagined that summary for each listener:
 * two rewrites, and the actor's own diction never reached anyone.
 */
function withSpokenWords(
  o: RawOccurrence,
  index: number,
  all: ReadonlyArray<RawOccurrence | null | undefined>,
  lookup: Lookup
): RawOccurrence["facts"] {
  const facts = o.facts ?? [];
  const spokenFacts: RawOccurrence["facts"] = [];
  for (const actionId of o.actionIds ?? []) {
    const first = all.findIndex(
      (other) => other != null && (other.actionIds ?? []).includes(actionId)
    );
    if (first !== index) continue;
    const command = lookup.actionById.get(actionId)?.command;
    const spoken = command?.utterance?.trim();
    if (!command || !spoken) continue;
    spokenFacts.push({
      // Typed apart from `speech` on purpose: `speech` is the Engine writing
      // ABOUT what was said, `utterance` is the words themselves, and the
      // renderer has to treat the two differently — one it retells, one it
      // may only quote.
      type: "utterance",
      content: spoken,
      refIds: [command.actorId],
    });
  }
  return [...spokenFacts, ...facts];
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
  const movementInits: Record<string, { route: string[]; vehicleId?: string }> =
    {};
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
      };
    }
    if (entry.check) {
      checkInits[entry.actionId] = {
        requiredLevel: entry.check.requiredLevel,
        basis: entry.check.basis,
        ...(entry.opposedBy ? { opposedBy: entry.opposedBy } : {}),
      };
    }
    transitions.push({
      actionId: entry.actionId,
      actorId: known.command.actorId,
      from: known.status,
      to: "active",
      progressDeltaMinutes: 0,
      ...(entry.resolvedDurationTicks !== undefined
        ? { resolvedDurationTicks: entry.resolvedDurationTicks }
        : {}),
      ...(entry.timingReason !== undefined
        ? { timingReason: entry.timingReason }
        : {}),
      ...(entry.resolvedDurationTicks !== undefined
        ? {
            nextWakeAt: addMinutes(
              context.tick.tickStartTime,
              Math.max(
                tickMinutes,
                entry.resolvedDurationTicks * tickMinutes -
                  known.progressMinutes
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
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
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

  // Every occurrence is a standalone row now; the actor's spoken line is
  // placed on the first row citing its action. Withdrawn (null) rows are
  // dropped here, so ids below count only real occurrences.
  const listed = raw.occurrences ?? [];
  const rawOccurrences: RawOccurrence[] = listed
    .map((o, i) =>
      o == null ? null : { ...o, facts: withSpokenWords(o, i, listed, lookup) }
    )
    .filter((o): o is RawOccurrence => o != null);

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
  const createdItemIds = createdItemIdsOf(raw);
  rawOccurrences.forEach((o, i) => {
    if (o == null) return;
    const occurrenceId = `occ_${context.tick.tickId}_${i}`;
    const factIds = (o.facts ?? []).map((_, fi) => `${occurrenceId}#f${fi}`);
    const locationId = o.locationId ?? occurrenceLocationFromActor(o, lookup);
    occurrences.push({
      id: occurrenceId,
      tickId: context.tick.tickId,
      sourceActionIds: o.actionIds ?? [],
      ...(locationId !== undefined ? { locationId } : {}),
      facts: (o.facts ?? []).map((f, fi) => ({
        id: factIds[fi],
        type: f.type,
        content: f.content,
        // Bare ids on the wire; the kind is code's to know. An id that
        // resolves to nothing was refused by validation, so `scene` here is
        // only a type-level fallback.
        entityRefs: (f.refIds ?? []).map((id) => ({
          kind: resolveRefKind(id, lookup, createdItemIds) ?? "scene",
          id,
        })),
      })),
      participants: participantsOf(o),
      perceiverCharacterIds: [...new Set(o.perceiverCharacterIds ?? [])],
      signals: (o.signals ?? []).map((sig) => ({
        factIds: (sig.factIndexes ?? o.facts.map((_, fi) => fi)).map(
          (fi) => factIds[fi]
        ),
        channel: sig.channel,
        ...(sig.originLocationId !== undefined
          ? { originLocationId: sig.originLocationId }
          : {}),
        ...(sig.intensity !== undefined ? { intensity: sig.intensity } : {}),
      })),
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
    causalBasis: raw.causalBasis,
    delta,
  };
}
