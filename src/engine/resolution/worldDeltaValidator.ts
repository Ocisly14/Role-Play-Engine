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

import { addMinutes } from "../../state/gameClock.js";
import { actionIdForCommand } from "../actions/actionStore.js";
import type {
  ActionCommand,
  ActionTransition,
  EngineAction,
  CharacterChange,
  EngineActionStatus,
  ItemChange,
  Occurrence,
  SceneChange,
  SourcedWorldDelta,
  TickResolution,
  WorldDelta,
} from "../actions/types.js";
import type { CodeToolInvocation } from "../tools/codeTool.js";
import type { EngineResolutionContext, ResolutionError } from "./types.js";
import type {
  RawActionResolution,
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
  sceneIds: Set<string>;
  locationIds: Set<string>;
  itemHolders: Map<string, string>;
  /** All actions addressable this resolution (queued from commands + active).
   *  Active entries carry progress, duration and the bar set at start — all
   *  code-owned facts the entry rules read. */
  actionById: Map<string, KnownAction>;
  /** Actions that MUST receive exactly one transition. */
  requiredActionIds: Set<string>;
}

export function buildLookup(context: EngineResolutionContext): Lookup {
  const characterIds = new Set(context.state.characters.map((c) => c.id));
  const aliveCharacterIds = new Set(
    context.state.characters.filter((c) => c.alive).map((c) => c.id)
  );
  const sceneIds = new Set(context.state.scenes.map((s) => s.id));
  const locationIds = new Set<string>(sceneIds);
  for (const c of context.state.characters) {
    if (c.locationId) locationIds.add(c.locationId);
  }
  const itemHolders = new Map<string, string>();
  for (const item of context.state.items) itemHolders.set(item.id, item.holder);

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
    sceneIds,
    locationIds,
    itemHolders,
    actionById,
    requiredActionIds: new Set(context.trigger.actionIds),
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

function validateActionEntry(
  entry: RawActionResolution,
  lookup: Lookup,
  _invocations: CodeToolInvocation[]
): string[] {
  const errs: string[] = [];
  const known = lookup.actionById.get(entry.actionId);
  if (!known) {
    return [`unknown actionId`];
  }
  if (TERMINAL_STATUSES.has(known.status)) {
    return [`action already ${known.status} — it cannot be resolved again`];
  }

  const starting = known.status === "queued";

  if (starting) {
    if (
      typeof entry.resolvedDurationTicks !== "number" ||
      !Number.isInteger(entry.resolvedDurationTicks) ||
      entry.resolvedDurationTicks < 1
    ) {
      errs.push(
        `an action that is starting requires integer resolvedDurationTicks >= 1 (the actor's proposal is advisory)`
      );
    }
    if (!entry.timingReason?.trim()) {
      errs.push(`an action that is starting requires a timingReason`);
    }
    if (entry.result) {
      errs.push(
        `an action that is starting has no result yet — set the duration and the bar now; the outcome comes when its time is spent`
      );
    }
  } else {
    if (entry.check) {
      errs.push(
        `the bar was set when this action started and cannot be changed mid-flight`
      );
    }
    if (entry.opposedBy) {
      errs.push(
        `opposition is named when the action starts, not while it runs`
      );
    }
    if (
      entry.resolvedDurationTicks !== undefined &&
      !entry.timingReason?.trim()
    ) {
      errs.push(`revising resolvedDurationTicks requires a timingReason`);
    }
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
    errs.push(`opposedBy needs a check — name the bar the opposition is against`);
  }

  if (entry.result) {
    if (!entry.result.reason?.trim()) {
      errs.push(`a result requires a reason`);
    }
    // With a check, code already decided success from the roll against the
    // bar; restating it is how the two can disagree.
    const hadCheck = known.check !== undefined;
    if (hadCheck && entry.result.outcome !== undefined) {
      errs.push(
        `this action was checked — code decides success from the roll against your bar; drop result.outcome`
      );
    }
    if (!hadCheck && !entry.result.outcome) {
      errs.push(
        `an action with no check needs result.outcome — there is no roll to derive it from`
      );
    }
  }

  return errs;
}

const CHARACTER_OP_KINDS = new Set([
  "hp",
  "san",
  "fatigue",
  "position",
  "addCondition",
  "removeCondition",
  "relationship",
]);
const SCENE_OP_KINDS = new Set([
  "addCondition",
  "removeCondition",
  "connectionBlock",
  "environmentContribute",
  "environmentHazard",
]);
const ITEM_OP_KINDS = new Set([
  "create",
  "move",
  "modify",
  "damage",
  "destroy",
]);

function validateCommonDelta(
  delta: RawSourcedDelta,
  lookup: Lookup
): string[] {
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
    return lookup.sceneIds.has(holder.slice("scene:".length));
  }
  return lookup.characterIds.has(holder);
}

export function validateCharacterChange(
  index: number,
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
        errs.push(
          `${op.kind}.delta must be a finite number (|d| <= 500)`
        );
      }
      if (typeof op.reason !== "string" || !op.reason.trim()) {
        errs.push(`${op.kind} requires a reason`);
      }
      break;
    }
    case "position": {
      const p = op.position as
        | {
            type?: string;
            sceneId?: string;
            junctionId?: string;
            roadId?: string;
          }
        | undefined;
      if (!p || typeof p !== "object" || typeof p.type !== "string") {
        errs.push(`position.position must be a CharacterPosition`);
      } else if (p.type === "scene" && !lookup.sceneIds.has(p.sceneId ?? "")) {
        errs.push(`position sceneId "${p.sceneId}" does not exist`);
      }
      break;
    }
    case "addCondition": {
      const c = op.condition as
        | { description?: string; id?: string }
        | undefined;
      if (!c?.description || !c?.id) {
        errs.push(
          `addCondition requires condition {id, description}`
        );
      }
      break;
    }
    case "removeCondition":
      if (typeof op.conditionId !== "string" || !op.conditionId) {
        errs.push(`removeCondition requires conditionId`);
      }
      break;
    case "relationship":
      if (
        typeof op.toCharacterId !== "string" ||
        !lookup.characterIds.has(op.toCharacterId)
      ) {
        errs.push(
          `relationship.toCharacterId "${op.toCharacterId}" does not exist`
        );
      }
      break;
  }
  return errs;
}

export function validateSceneChange(
  index: number,
  delta: RawSourcedDelta & { sceneId?: string },
  lookup: Lookup
): string[] {
  const errs = validateCommonDelta(delta, lookup);
  if (!delta.sceneId || !lookup.sceneIds.has(delta.sceneId)) {
    errs.push(`sceneId "${delta.sceneId}" does not exist`);
    return errs;
  }
  const op = delta.operation;
  if (!op?.kind || !SCENE_OP_KINDS.has(op.kind)) {
    errs.push(`unknown scene operation kind "${op?.kind}"`);
    return errs;
  }
  switch (op.kind) {
    case "addCondition": {
      const c = op.condition as { description?: string } | undefined;
      if (!c?.description) {
        errs.push(`addCondition requires condition.description`);
      }
      break;
    }
    case "removeCondition": {
      const p = op.predicate as { featureId?: string } | undefined;
      if (!p?.featureId) {
        errs.push(`removeCondition requires predicate.featureId`);
      }
      break;
    }
    case "connectionBlock":
      if (typeof op.connectionId !== "string" || !op.connectionId) {
        errs.push(`connectionBlock requires connectionId`);
      }
      if (typeof op.blocked !== "boolean") {
        errs.push(`connectionBlock requires blocked boolean`);
      }
      if (typeof op.reason !== "string" || !op.reason.trim()) {
        errs.push(`connectionBlock requires a reason`);
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
    case "environmentHazard":
      break;
  }
  return errs;
}

export function validateItemChange(
  index: number,
  delta: RawSourcedDelta & { itemId?: string },
  lookup: Lookup,
  movedItemIds: Set<string>
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
        `create.location "${op.location}" must be "scene:<realSceneId>" or a real character id`
      );
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
        errs.push(`move.to "${op.to}" is not a valid holder`);
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
    case "modify":
      if (typeof op.description !== "string" || !op.description.trim()) {
        errs.push(`modify requires a description`);
      }
      break;
    case "damage":
      if (typeof op.damagedBy !== "string" || !op.damagedBy.trim()) {
        errs.push(`damage requires damagedBy`);
      }
      if (typeof op.reason !== "string" || !op.reason.trim()) {
        errs.push(`damage requires a reason`);
      }
      break;
  }
  return errs;
}

const PERSPECTIVE_PATTERNS = [
  /\bI\s+(see|hear|feel|notice|recognize)\b/i,
  /令我/,
  /我(看见|听见|认出|感到)/,
];

export function validateOccurrence(
  index: number,
  occ: RawOccurrence,
  lookup: Lookup
): string[] {
  const errs: string[] = [];
  for (const id of occ.sourceActionIds ?? []) {
    if (!lookup.actionById.has(id)) {
      errs.push(`sourceActionId "${id}" is unknown`);
    }
  }
  if (occ.locationId && !lookup.locationIds.has(occ.locationId)) {
    errs.push(`locationId "${occ.locationId}" does not exist`);
  }
  if (!occ.facts || occ.facts.length === 0) {
    errs.push(`at least one fact is required`);
  }
  for (const [fi, fact] of (occ.facts ?? []).entries()) {
    if (!fact.content?.trim()) {
      errs.push(`facts[${fi}]: content is required`);
    } else if (PERSPECTIVE_PATTERNS.some((re) => re.test(fact.content))) {
      errs.push(
        `facts[${fi}]: character-perspective wording detected — facts must be objective and third-person`
      );
    }
    for (const ref of fact.entityRefs ?? []) {
      const pool =
        ref.kind === "character"
          ? lookup.characterIds
          : ref.kind === "scene"
            ? lookup.locationIds
            : lookup.itemHolders;
      const exists =
        ref.kind === "item"
          ? (pool as Map<string, string>).has(ref.id)
          : (pool as Set<string>).has(ref.id);
      if (!exists) {
        errs.push(
          `facts[${fi}]: entityRef ${ref.kind} "${ref.id}" does not exist`
        );
      }
    }
  }
  for (const p of occ.participants ?? []) {
    if (!lookup.characterIds.has(p.characterId)) {
      errs.push(`participant "${p.characterId}" does not exist`);
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
  return errs;
}

// ==================== Whole-resolution validation ====================

export function validateRawResolution(
  raw: RawTickResolution,
  context: EngineResolutionContext,
  invocations: CodeToolInvocation[]
): ResolutionError[] {
  const lookup = buildLookup(context);
  const errors: ResolutionError[] = [];

  // The per-piece validators return plain messages; the address comes from
  // here, which is the only place that knows WHICH element is being checked.
  // That address is what lets the Engine repair one element instead of
  // rewriting the whole resolution.
  const at = (
    target: ResolutionError["target"],
    messages: string[]
  ): void => {
    for (const message of messages) errors.push({ target, message });
  };

  const seen = new Set<string>();
  for (const entry of raw.actions ?? []) {
    const target: ResolutionError["target"] = {
      kind: "action",
      actionId: entry.actionId,
    };
    if (seen.has(entry.actionId)) {
      at(target, [
        `duplicate transition for "${entry.actionId}" — each action gets at most one per resolution`,
      ]);
      continue;
    }
    seen.add(entry.actionId);
    at(target, validateActionEntry(entry, lookup, invocations));
  }
  for (const required of lookup.requiredActionIds) {
    if (!seen.has(required)) {
      at({ kind: "resolution" }, [
        `triggering action "${required}" received no transition — every action that triggered this resolution needs exactly one`,
      ]);
    }
  }

  const movedItemIds = new Set<string>();
  (raw.characterChanges ?? []).forEach((d, i) => {
    if (d === null) return;
    at({ kind: "characterChange", index: i }, validateCharacterChange(i, d, lookup));
  });
  (raw.sceneChanges ?? []).forEach((d, i) => {
    if (d === null) return;
    at({ kind: "sceneChange", index: i }, validateSceneChange(i, d, lookup));
  });
  (raw.itemChanges ?? []).forEach((d, i) => {
    if (d === null) return;
    at(
      { kind: "itemChange", index: i },
      validateItemChange(i, d, lookup, movedItemIds)
    );
  });
  (raw.occurrences ?? []).forEach((o, i) => {
    if (o === null) return;
    at({ kind: "occurrence", index: i }, validateOccurrence(i, o, lookup));
  });

  for (const message of missingTerminalOccurrences(raw)) {
    errors.push({ target: { kind: "resolution" }, message });
  }

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
export function applyRepair(
  raw: RawTickResolution,
  repair: RawResolutionRepair
): RawTickResolution {
  const patchList = <T>(
    list: Array<T | null> | undefined,
    patch: Record<string, T | null> | undefined,
    additions: T[] | undefined
  ): Array<T | null> => {
    const out = [...(list ?? [])];
    for (const [key, value] of Object.entries(patch ?? {})) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= out.length) continue;
      out[index] = value;
    }
    out.push(...(additions ?? []));
    return out;
  };

  const actions = [...(raw.actions ?? [])];
  for (const replacement of repair.actions ?? []) {
    const index = actions.findIndex((a) => a.actionId === replacement.actionId);
    if (index >= 0) actions[index] = replacement;
    else actions.push(replacement);
  }

  return {
    actions,
    characterChanges: patchList(
      raw.characterChanges,
      repair.characterChanges,
      repair.addCharacterChanges
    ) as RawTickResolution["characterChanges"],
    sceneChanges: patchList(
      raw.sceneChanges,
      repair.sceneChanges,
      repair.addSceneChanges
    ) as RawTickResolution["sceneChanges"],
    itemChanges: patchList(
      raw.itemChanges,
      repair.itemChanges,
      repair.addItemChanges
    ) as RawTickResolution["itemChanges"],
    occurrences: patchList(
      raw.occurrences,
      repair.occurrences,
      repair.addOccurrences
    ) as RawTickResolution["occurrences"],
  };
}

/**
 * An action that ended must leave an objective trace, even when it changed no
 * world state.
 *
 * Failure is the case that matters. A failed move changes nothing the actor
 * can see — their position is identical, so next tick's perception is
 * identical, so they decide the same thing again. Observed live: a detective
 * re-issued "run to the car park" for seven straight ticks because nothing
 * ever told him there was no route. The old movement subsystem closed that
 * loop by writing the character a memory; memory is the character's own now,
 * so the trace has to arrive as perception instead — an occurrence whose
 * perceivers include the actor.
 */
function missingTerminalOccurrences(raw: RawTickResolution): string[] {
  const cited = new Set<string>();
  for (const occ of raw.occurrences ?? []) {
    for (const id of occ.sourceActionIds ?? []) cited.add(id);
  }
  return (raw.actions ?? [])
    .filter((entry) => entry.result && !cited.has(entry.actionId))
    .map(
      (entry) =>
        `occurrences: action "${entry.actionId}" produced a result with no occurrence citing it — every action that ends leaves an objective trace, and without one the actor perceives no change and simply re-issues the same action. Emit at least an action_result fact listing the actor among perceiverCharacterIds.`
    );
}

// ==================== Finalization ====================

export interface FinalizedResolution {
  resolution: TickResolution;
  /** Movement-leg annotations per action (Engine-owned runtime init). */
  movementInits: Record<string, { destinationId: string }>;
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
export function finalizeResolution(
  raw: RawTickResolution,
  context: EngineResolutionContext
): FinalizedResolution {
  const lookup = buildLookup(context);
  const transitions: ActionTransition[] = [];
  const movementInits: Record<string, { destinationId: string }> = {};
  const checkInits: FinalizedResolution["checkInits"] = {};
  const tickMinutes = context.tick.durationMinutes;

  for (const entry of raw.actions ?? []) {
    const known = lookup.actionById.get(entry.actionId);
    if (!known) continue; // unreachable post-validation; keeps types honest
    if (entry.movement?.destinationId) {
      movementInits[entry.actionId] = {
        destinationId: entry.movement.destinationId,
      };
    }
    if (entry.check) {
      checkInits[entry.actionId] = {
        requiredLevel: entry.check.requiredLevel,
        basis: entry.check.basis,
        ...(entry.opposedBy ? { opposedBy: entry.opposedBy } : {}),
      };
    }

    // Progress was already advanced from the clock this tick; the Engine has
    // no say in it. What is left to decide is whether the action is over —
    // and that follows from whether it produced a result and whether its time
    // was actually spent.
    const durationTicks =
      entry.resolvedDurationTicks ?? known.resolvedDurationTicks;
    const spent =
      durationTicks !== undefined &&
      known.progressMinutes >= durationTicks * tickMinutes;
    const to: EngineActionStatus = entry.result
      ? spent
        ? "completed"
        : "interrupted"
      : "active";
    const nextWakeAt =
      to === "active" && durationTicks !== undefined
        ? addMinutes(
            context.tick.tickStartTime,
            Math.max(
              tickMinutes,
              durationTicks * tickMinutes - known.progressMinutes
            )
          )
        : undefined;

    transitions.push({
      actionId: entry.actionId,
      actorId: known.command.actorId,
      from: known.status,
      to,
      progressDeltaMinutes: 0,
      ...(entry.resolvedDurationTicks !== undefined
        ? { resolvedDurationTicks: entry.resolvedDurationTicks }
        : {}),
      ...(entry.timingReason !== undefined
        ? { timingReason: entry.timingReason }
        : {}),
      ...(nextWakeAt !== undefined ? { nextWakeAt } : {}),
      ...(entry.result?.reason !== undefined
        ? { reason: entry.result.reason }
        : {}),
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

  const occurrences: Occurrence[] = [];
  (raw.occurrences ?? []).forEach((o, i) => {
    if (o == null) return;
    const occurrenceId = `occ_${context.tick.tickId}_${i}`;
    const factIds = (o.facts ?? []).map((_, fi) => `${occurrenceId}#f${fi}`);
    occurrences.push({
      id: occurrenceId,
      tickId: context.tick.tickId,
      sourceActionIds: o.sourceActionIds ?? [],
      ...(o.locationId !== undefined ? { locationId: o.locationId } : {}),
      facts: (o.facts ?? []).map((f, fi) => ({
        id: factIds[fi],
        type: f.type,
        content: f.content,
        entityRefs: f.entityRefs ?? [],
      })),
      participants: o.participants ?? [],
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
