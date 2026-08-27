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
import {
  adjudicateSkillAction,
  meetsRequiredLevel,
} from "../actions/adjudication/skillAdjudicator.js";
import type { SkillAssessmentProposal } from "../actions/adjudication/types.js";
import type {
  ActionCommand,
  ActionJudgement,
  ActionTransition,
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
import type { EngineResolutionContext } from "./types.js";
import type {
  RawActionResolution,
  RawJudgement,
  RawOccurrence,
  RawSourcedDelta,
  RawTickResolution,
} from "./worldDeltaSchema.js";

// ==================== Shared lookup tables ====================

interface Lookup {
  characterIds: Set<string>;
  aliveCharacterIds: Set<string>;
  sceneIds: Set<string>;
  locationIds: Set<string>;
  itemHolders: Map<string, string>;
  /** All actions addressable this resolution (queued from commands + active). */
  actionById: Map<
    string,
    { status: EngineActionStatus; command: ActionCommand }
  >;
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

  const actionById = new Map<
    string,
    { status: EngineActionStatus; command: ActionCommand }
  >();
  for (const action of context.actions.activeActions) {
    actionById.set(action.id, {
      status: action.status,
      command: action.command,
    });
  }
  for (const command of context.actions.newCommands) {
    const id = actionIdForCommand(command.commandId);
    if (!actionById.has(id)) actionById.set(id, { status: "queued", command });
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

const LEGAL_TRANSITIONS: Record<EngineActionStatus, Set<string>> = {
  queued: new Set(["active", "completed", "failed", "cancelled"]),
  active: new Set([
    "active",
    "completed",
    "failed",
    "interrupted",
    "cancelled",
  ]),
  completed: new Set(),
  failed: new Set(),
  interrupted: new Set(),
  cancelled: new Set(),
};

// ==================== Per-piece validation ====================

function validateActionEntry(
  entry: RawActionResolution,
  lookup: Lookup,
  invocations: CodeToolInvocation[]
): string[] {
  const errs: string[] = [];
  const known = lookup.actionById.get(entry.actionId);
  if (!known) {
    return [`actions[${entry.actionId}]: unknown actionId`];
  }
  if (!LEGAL_TRANSITIONS[known.status].has(entry.to)) {
    errs.push(
      `actions[${entry.actionId}]: illegal transition ${known.status} -> ${entry.to}`
    );
  }
  if (
    typeof entry.progressDeltaMinutes !== "number" ||
    entry.progressDeltaMinutes < 0
  ) {
    errs.push(
      `actions[${entry.actionId}]: progressDeltaMinutes must be a number >= 0`
    );
  }
  if (entry.to === "active") {
    if (
      typeof entry.nextWakeInTicks !== "number" ||
      !Number.isInteger(entry.nextWakeInTicks) ||
      entry.nextWakeInTicks < 1
    ) {
      errs.push(
        `actions[${entry.actionId}]: transition to "active" requires integer nextWakeInTicks >= 1`
      );
    }
  }
  if (known.status === "queued") {
    if (
      typeof entry.resolvedDurationTicks !== "number" ||
      !Number.isInteger(entry.resolvedDurationTicks) ||
      entry.resolvedDurationTicks < 1
    ) {
      errs.push(
        `actions[${entry.actionId}]: first resolution requires integer resolvedDurationTicks >= 1 (the actor's proposal is advisory)`
      );
    }
    if (!entry.timingReason?.trim()) {
      errs.push(
        `actions[${entry.actionId}]: first resolution requires a timingReason`
      );
    }
    if (!entry.judgement) {
      errs.push(
        `actions[${entry.actionId}]: first resolution requires a judgement`
      );
    }
  } else if (
    entry.resolvedDurationTicks !== undefined &&
    !entry.timingReason?.trim()
  ) {
    errs.push(
      `actions[${entry.actionId}]: revising resolvedDurationTicks requires a timingReason`
    );
  }

  if (entry.judgement) {
    errs.push(...validateJudgement(entry, known.command, lookup, invocations));
  }
  return errs;
}

function validateJudgement(
  entry: RawActionResolution,
  command: ActionCommand,
  lookup: Lookup,
  invocations: CodeToolInvocation[]
): string[] {
  const errs: string[] = [];
  const j = entry.judgement as RawJudgement;
  const hasRoll = command.skillRoll !== undefined;

  if (hasRoll && j.kind !== "skill_assessed") {
    return [
      `actions[${entry.actionId}]: command declared skill "${command.declaredSkillId}" — judgement must be kind "skill_assessed"`,
    ];
  }
  if (!hasRoll && j.kind === "skill_assessed") {
    return [
      `actions[${entry.actionId}]: command declared no skill — judgement must be kind "direct" (never invent rolls)`,
    ];
  }
  if (j.kind === "direct") {
    if (!j.reason?.trim())
      errs.push(`actions[${entry.actionId}]: direct judgement needs a reason`);
    return errs;
  }

  // skill_assessed — rebuild the deterministic adjudication and require the
  // model's outcome to be consistent with it.
  if (!j.applicabilityBasis?.trim()) {
    errs.push(
      `actions[${entry.actionId}]: skill judgement requires applicabilityBasis`
    );
  }
  for (const id of j.targetIds ?? []) {
    if (!lookup.characterIds.has(id)) {
      errs.push(`actions[${entry.actionId}]: targetId "${id}" does not exist`);
    }
  }

  const proposal = rawJudgementToProposal(j);
  if (typeof proposal === "string") {
    errs.push(`actions[${entry.actionId}]: ${proposal}`);
    return errs;
  }

  // Defender rolls must come from the session's opposedRoll tool calls.
  const adjudicated = adjudicateSkillAction(
    command,
    proposal,
    (characterId, skillId) => {
      const hit = invocations.find(
        (inv) =>
          inv.toolName === "opposedRoll" &&
          (inv.input as { characterId?: string; skillId?: string })
            ?.characterId === characterId &&
          (inv.input as { skillId?: string })?.skillId === skillId &&
          (inv.output as { ok?: boolean })?.ok === true
      );
      if (!hit) {
        return {
          ok: false,
          reason:
            "no opposedRoll tool call recorded for this defender — call the tool before submitting",
        };
      }
      return {
        ok: true,
        record: (hit.output as { record: never }).record,
      };
    }
  );
  if (!adjudicated.ok) {
    errs.push(`actions[${entry.actionId}]: ${adjudicated.error}`);
    return errs;
  }

  // Consistency: a failed check cannot yield success; a met check cannot be
  // narrated as failure. "continue" is only legal while the action stays
  // active.
  const deterministic = adjudicated.judgement.outcome;
  const claimed = j.outcome;
  const successish = new Set(["success", "partial"]);
  const failish = new Set(["failure", "blocked"]);
  const consistent =
    claimed === "continue"
      ? entry.to === "active"
      : deterministic === "success"
        ? successish.has(claimed)
        : failish.has(claimed);
  if (!consistent) {
    errs.push(
      `actions[${entry.actionId}]: outcome "${claimed}" contradicts the deterministic check result "${deterministic}" (roll ${command.skillRoll?.roll}/${command.skillRoll?.skillValue} ${command.skillRoll?.successLevel}${proposal.applicability === "accepted" ? ` vs required ${proposal.requiredLevel}` : ", skill rejected"})`
    );
  }
  return errs;
}

function rawJudgementToProposal(
  j: Extract<RawJudgement, { kind: "skill_assessed" }>
): SkillAssessmentProposal | string {
  if (j.applicability === "rejected") {
    return {
      applicability: "rejected",
      applicabilityBasis: j.applicabilityBasis ?? "",
      targetIds: j.targetIds ?? [],
      outcomeWithoutSkill: j.outcome === "continue" ? "continue" : j.outcome,
      outcomeReason: j.reason ?? "",
    };
  }
  if (!j.requiredLevel) {
    return "accepted skill judgement requires requiredLevel";
  }
  if (!j.requiredLevelBasis?.trim()) {
    return "accepted skill judgement requires requiredLevelBasis";
  }
  if (j.checkType === "opposed") {
    if (!j.opposedDefense || j.opposedDefense.length === 0) {
      return "opposed check requires opposedDefense entries";
    }
    return {
      applicability: "accepted",
      applicabilityBasis: j.applicabilityBasis ?? "",
      requiredLevel: j.requiredLevel,
      requiredLevelBasis: j.requiredLevelBasis,
      checkType: "opposed",
      targetIds: j.targetIds ?? [],
      opposedDefense: j.opposedDefense,
    };
  }
  return {
    applicability: "accepted",
    applicabilityBasis: j.applicabilityBasis ?? "",
    requiredLevel: j.requiredLevel,
    requiredLevelBasis: j.requiredLevelBasis,
    checkType: "single",
    targetIds: j.targetIds ?? [],
  };
}

// ==================== Delta validation ====================

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
  label: string,
  delta: RawSourcedDelta,
  lookup: Lookup
): string[] {
  const errs: string[] = [];
  if (!lookup.actionById.has(delta.sourceActionId)) {
    errs.push(`${label}: sourceActionId "${delta.sourceActionId}" is unknown`);
  }
  if (!delta.causalBasis?.trim()) {
    errs.push(`${label}: causalBasis is required`);
  }
  if (!delta.operation || typeof delta.operation.kind !== "string") {
    errs.push(`${label}: operation.kind is required`);
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
  const label = `characterChanges[${index}]`;
  const errs = validateCommonDelta(label, delta, lookup);
  if (!delta.characterId || !lookup.characterIds.has(delta.characterId)) {
    errs.push(`${label}: characterId "${delta.characterId}" does not exist`);
    return errs;
  }
  const op = delta.operation;
  if (!op?.kind || !CHARACTER_OP_KINDS.has(op.kind)) {
    errs.push(`${label}: unknown character operation kind "${op?.kind}"`);
    return errs;
  }
  switch (op.kind) {
    case "hp":
    case "san":
    case "fatigue": {
      const d = op.delta;
      if (typeof d !== "number" || !Number.isFinite(d) || Math.abs(d) > 500) {
        errs.push(
          `${label}: ${op.kind}.delta must be a finite number (|d| <= 500)`
        );
      }
      if (typeof op.reason !== "string" || !op.reason.trim()) {
        errs.push(`${label}: ${op.kind} requires a reason`);
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
        errs.push(`${label}: position.position must be a CharacterPosition`);
      } else if (p.type === "scene" && !lookup.sceneIds.has(p.sceneId ?? "")) {
        errs.push(`${label}: position sceneId "${p.sceneId}" does not exist`);
      }
      break;
    }
    case "addCondition": {
      const c = op.condition as
        | { description?: string; id?: string }
        | undefined;
      if (!c?.description || !c?.id) {
        errs.push(
          `${label}: addCondition requires condition {id, description}`
        );
      }
      break;
    }
    case "removeCondition":
      if (typeof op.conditionId !== "string" || !op.conditionId) {
        errs.push(`${label}: removeCondition requires conditionId`);
      }
      break;
    case "relationship":
      if (
        typeof op.toCharacterId !== "string" ||
        !lookup.characterIds.has(op.toCharacterId)
      ) {
        errs.push(
          `${label}: relationship.toCharacterId "${op.toCharacterId}" does not exist`
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
  const label = `sceneChanges[${index}]`;
  const errs = validateCommonDelta(label, delta, lookup);
  if (!delta.sceneId || !lookup.sceneIds.has(delta.sceneId)) {
    errs.push(`${label}: sceneId "${delta.sceneId}" does not exist`);
    return errs;
  }
  const op = delta.operation;
  if (!op?.kind || !SCENE_OP_KINDS.has(op.kind)) {
    errs.push(`${label}: unknown scene operation kind "${op?.kind}"`);
    return errs;
  }
  switch (op.kind) {
    case "addCondition": {
      const c = op.condition as { description?: string } | undefined;
      if (!c?.description) {
        errs.push(`${label}: addCondition requires condition.description`);
      }
      break;
    }
    case "removeCondition": {
      const p = op.predicate as { featureId?: string } | undefined;
      if (!p?.featureId) {
        errs.push(`${label}: removeCondition requires predicate.featureId`);
      }
      break;
    }
    case "connectionBlock":
      if (typeof op.connectionId !== "string" || !op.connectionId) {
        errs.push(`${label}: connectionBlock requires connectionId`);
      }
      if (typeof op.blocked !== "boolean") {
        errs.push(`${label}: connectionBlock requires blocked boolean`);
      }
      if (typeof op.reason !== "string" || !op.reason.trim()) {
        errs.push(`${label}: connectionBlock requires a reason`);
      }
      break;
    case "environmentContribute":
      if (
        !["temperature", "illumination", "oxygen", "noise"].includes(
          op.quantity as string
        )
      ) {
        errs.push(`${label}: environmentContribute has invalid quantity`);
      }
      if (typeof op.value !== "number" || !Number.isFinite(op.value)) {
        errs.push(`${label}: environmentContribute requires numeric value`);
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
  const label = `itemChanges[${index}]`;
  const errs = validateCommonDelta(label, delta, lookup);
  const op = delta.operation;
  if (!op?.kind || !ITEM_OP_KINDS.has(op.kind)) {
    errs.push(`${label}: unknown item operation kind "${op?.kind}"`);
    return errs;
  }
  if (op.kind === "create") {
    if (typeof op.name !== "string" || !op.name.trim()) {
      errs.push(`${label}: create requires a name`);
    }
    if (typeof op.location !== "string" || !validHolder(op.location, lookup)) {
      errs.push(
        `${label}: create.location "${op.location}" must be "scene:<realSceneId>" or a real character id`
      );
    }
    return errs;
  }
  if (!delta.itemId || !lookup.itemHolders.has(delta.itemId)) {
    errs.push(`${label}: itemId "${delta.itemId}" does not exist`);
    return errs;
  }
  switch (op.kind) {
    case "move": {
      const currentHolder = lookup.itemHolders.get(delta.itemId);
      if (typeof op.from !== "string" || op.from !== currentHolder) {
        errs.push(
          `${label}: move.from "${op.from}" does not match the item's actual holder "${currentHolder}"`
        );
      }
      if (typeof op.to !== "string" || !validHolder(op.to, lookup)) {
        errs.push(`${label}: move.to "${op.to}" is not a valid holder`);
      }
      if (movedItemIds.has(delta.itemId)) {
        errs.push(
          `${label}: item "${delta.itemId}" is moved/destroyed more than once this tick (unique-ownership conflict — resolve one atomic winner)`
        );
      }
      movedItemIds.add(delta.itemId);
      break;
    }
    case "destroy":
      if (movedItemIds.has(delta.itemId)) {
        errs.push(
          `${label}: item "${delta.itemId}" is moved/destroyed more than once this tick`
        );
      }
      movedItemIds.add(delta.itemId);
      break;
    case "modify":
      if (typeof op.description !== "string" || !op.description.trim()) {
        errs.push(`${label}: modify requires a description`);
      }
      break;
    case "damage":
      if (typeof op.damagedBy !== "string" || !op.damagedBy.trim()) {
        errs.push(`${label}: damage requires damagedBy`);
      }
      if (typeof op.reason !== "string" || !op.reason.trim()) {
        errs.push(`${label}: damage requires a reason`);
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
  const label = `occurrences[${index}]`;
  const errs: string[] = [];
  for (const id of occ.sourceActionIds ?? []) {
    if (!lookup.actionById.has(id)) {
      errs.push(`${label}: sourceActionId "${id}" is unknown`);
    }
  }
  if (occ.locationId && !lookup.locationIds.has(occ.locationId)) {
    errs.push(`${label}: locationId "${occ.locationId}" does not exist`);
  }
  if (!occ.facts || occ.facts.length === 0) {
    errs.push(`${label}: at least one fact is required`);
  }
  for (const [fi, fact] of (occ.facts ?? []).entries()) {
    if (!fact.content?.trim()) {
      errs.push(`${label}.facts[${fi}]: content is required`);
    } else if (PERSPECTIVE_PATTERNS.some((re) => re.test(fact.content))) {
      errs.push(
        `${label}.facts[${fi}]: character-perspective wording detected — facts must be objective and third-person`
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
          `${label}.facts[${fi}]: entityRef ${ref.kind} "${ref.id}" does not exist`
        );
      }
    }
  }
  for (const p of occ.participants ?? []) {
    if (!lookup.characterIds.has(p.characterId)) {
      errs.push(`${label}: participant "${p.characterId}" does not exist`);
    }
  }
  for (const id of occ.perceiverCharacterIds ?? []) {
    if (!lookup.characterIds.has(id)) {
      errs.push(`${label}: perceiver "${id}" does not exist`);
    }
  }
  for (const [si, signal] of (occ.signals ?? []).entries()) {
    for (const fi of signal.factIndexes ?? []) {
      if (!Number.isInteger(fi) || fi < 0 || fi >= (occ.facts?.length ?? 0)) {
        errs.push(`${label}.signals[${si}]: factIndex ${fi} out of range`);
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
): string[] {
  const lookup = buildLookup(context);
  const errs: string[] = [];

  const seen = new Set<string>();
  for (const entry of raw.actions ?? []) {
    if (seen.has(entry.actionId)) {
      errs.push(
        `actions[${entry.actionId}]: duplicate transition (single-transition invariant)`
      );
      continue;
    }
    seen.add(entry.actionId);
    errs.push(...validateActionEntry(entry, lookup, invocations));
  }
  for (const required of lookup.requiredActionIds) {
    if (!seen.has(required)) {
      errs.push(
        `actions: triggering action "${required}" received no transition`
      );
    }
  }

  const movedItemIds = new Set<string>();
  (raw.characterChanges ?? []).forEach((d, i) =>
    errs.push(...validateCharacterChange(i, d, lookup))
  );
  (raw.sceneChanges ?? []).forEach((d, i) =>
    errs.push(...validateSceneChange(i, d, lookup))
  );
  (raw.itemChanges ?? []).forEach((d, i) =>
    errs.push(...validateItemChange(i, d, lookup, movedItemIds))
  );
  (raw.occurrences ?? []).forEach((o, i) =>
    errs.push(...validateOccurrence(i, o, lookup))
  );

  errs.push(...missingTerminalOccurrences(raw));

  return errs;
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
  const ENDED = new Set(["completed", "failed", "interrupted", "cancelled"]);
  const cited = new Set<string>();
  for (const occ of raw.occurrences ?? []) {
    for (const id of occ.sourceActionIds ?? []) cited.add(id);
  }
  return (raw.actions ?? [])
    .filter((entry) => ENDED.has(entry.to) && !cited.has(entry.actionId))
    .map(
      (entry) =>
        `occurrences: action "${entry.actionId}" ended as "${entry.to}" with no occurrence citing it — every action that ends leaves an objective trace, and without one the actor perceives no change and simply re-issues the same action. Emit at least an action_result fact listing the actor among perceiverCharacterIds.`
    );
}

// ==================== Finalization ====================

export interface FinalizedResolution {
  resolution: TickResolution;
  droppedViolations: string[];
  /** Engine judgements per action, for persistence on `action.runtime`. */
  judgements: Record<string, ActionJudgement>;
  /** Movement-leg annotations per action (Engine-owned runtime init). */
  movementInits: Record<string, { destinationId: string }>;
}

/** Convert raw output to a typed TickResolution, dropping whatever is still
 *  invalid after the corrective retry. Missing/illegal transitions for
 *  triggering actions become synthesized `failed` transitions so no action is
 *  ever silently stuck. */
export function finalizeResolution(
  raw: RawTickResolution,
  context: EngineResolutionContext,
  invocations: CodeToolInvocation[]
): FinalizedResolution {
  const lookup = buildLookup(context);
  const dropped: string[] = [];
  const transitions: ActionTransition[] = [];
  const handled = new Set<string>();
  const judgements: Record<string, ActionJudgement> = {};
  const movementInits: Record<string, { destinationId: string }> = {};

  for (const entry of raw.actions ?? []) {
    if (handled.has(entry.actionId)) {
      dropped.push(`duplicate transition for ${entry.actionId} dropped`);
      continue;
    }
    const entryErrors = validateActionEntry(entry, lookup, invocations);
    const known = lookup.actionById.get(entry.actionId);
    if (!known) {
      dropped.push(entryErrors.join("; "));
      continue;
    }
    handled.add(entry.actionId);
    if (entryErrors.length > 0) {
      dropped.push(...entryErrors);
      transitions.push({
        actionId: entry.actionId,
        actorId: known.command.actorId,
        from: known.status,
        to: "failed",
        progressDeltaMinutes: 0,
        reason: `resolution output invalid after retry: ${entryErrors[0]}`,
      });
      continue;
    }
    const judgement = judgementFromRaw(entry, known.command);
    if (judgement) judgements[entry.actionId] = judgement;
    if (entry.movement?.destinationId) {
      movementInits[entry.actionId] = {
        destinationId: entry.movement.destinationId,
      };
    }
    transitions.push({
      actionId: entry.actionId,
      actorId: known.command.actorId,
      from: known.status,
      to: entry.to,
      progressDeltaMinutes: entry.progressDeltaMinutes,
      ...(entry.resolvedDurationTicks !== undefined
        ? { resolvedDurationTicks: entry.resolvedDurationTicks }
        : {}),
      ...(entry.timingReason !== undefined
        ? { timingReason: entry.timingReason }
        : {}),
      ...(entry.to === "active" && entry.nextWakeInTicks !== undefined
        ? {
            nextWakeAt: addMinutes(
              context.tick.tickStartTime,
              entry.nextWakeInTicks * context.tick.durationMinutes
            ),
          }
        : {}),
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    });
  }

  // Triggering actions the model never addressed: fail them explicitly.
  for (const required of lookup.requiredActionIds) {
    if (handled.has(required)) continue;
    const known = lookup.actionById.get(required);
    if (!known) continue;
    dropped.push(`triggering action "${required}" received no transition`);
    transitions.push({
      actionId: required,
      actorId: known.command.actorId,
      from: known.status,
      to: "failed",
      progressDeltaMinutes: 0,
      reason: "engine did not resolve this action",
    });
  }

  const failedActionIds = new Set(
    transitions
      .filter((t) => t.to === "failed" && t.reason)
      .map((t) => t.actionId)
  );
  const keepSource = (id: string): boolean =>
    lookup.actionById.has(id) && !failedActionIds.has(id);

  const characterChanges: SourcedWorldDelta<CharacterChange>[] = [];
  const movedItemIds = new Set<string>();
  (raw.characterChanges ?? []).forEach((d, i) => {
    const errors = validateCharacterChange(i, d, lookup);
    if (errors.length > 0 || !keepSource(d.sourceActionId)) {
      dropped.push(
        ...(errors.length > 0
          ? errors
          : [`characterChanges[${i}]: source action failed validation`])
      );
      return;
    }
    characterChanges.push(
      makeSourced(d, {
        domain: "character",
        characterId: d.characterId as string,
        operation: d.operation as never,
      }) as SourcedWorldDelta<CharacterChange>
    );
  });

  const sceneChanges: SourcedWorldDelta<SceneChange>[] = [];
  (raw.sceneChanges ?? []).forEach((d, i) => {
    const errors = validateSceneChange(i, d, lookup);
    if (errors.length > 0 || !keepSource(d.sourceActionId)) {
      dropped.push(
        ...(errors.length > 0
          ? errors
          : [`sceneChanges[${i}]: source action failed validation`])
      );
      return;
    }
    sceneChanges.push(
      makeSourced(d, {
        domain: "scene",
        sceneId: d.sceneId as string,
        operation: d.operation as never,
      }) as SourcedWorldDelta<SceneChange>
    );
  });

  const itemChanges: SourcedWorldDelta<ItemChange>[] = [];
  (raw.itemChanges ?? []).forEach((d, i) => {
    const errors = validateItemChange(i, d, lookup, movedItemIds);
    if (errors.length > 0 || !keepSource(d.sourceActionId)) {
      dropped.push(
        ...(errors.length > 0
          ? errors
          : [`itemChanges[${i}]: source action failed validation`])
      );
      return;
    }
    itemChanges.push(
      makeSourced(d, {
        domain: "item",
        ...(d.itemId !== undefined ? { itemId: d.itemId } : {}),
        operation: d.operation as never,
      }) as SourcedWorldDelta<ItemChange>
    );
  });

  const occurrences: Occurrence[] = [];
  (raw.occurrences ?? []).forEach((o, i) => {
    const errors = validateOccurrence(i, o, lookup);
    if (errors.length > 0) {
      dropped.push(...errors);
      return;
    }
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
      signals: (o.signals ?? []).map((s) => ({
        factIds: (s.factIndexes ?? o.facts.map((_, fi) => fi)).map(
          (fi) => factIds[fi]
        ),
        channel: s.channel,
        ...(s.originLocationId !== undefined
          ? { originLocationId: s.originLocationId }
          : {}),
        ...(s.intensity !== undefined ? { intensity: s.intensity } : {}),
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
    droppedViolations: dropped,
    judgements,
    movementInits,
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

/** Re-exported for engine-level judgement persistence. */
export function judgementFromRaw(
  entry: RawActionResolution,
  command: ActionCommand
): ActionJudgement | undefined {
  const j = entry.judgement;
  if (!j) return undefined;
  if (j.kind === "direct") {
    return { kind: "direct", outcome: j.outcome, reason: j.reason };
  }
  const roll = command.skillRoll;
  if (!roll) return undefined;
  if (j.applicability === "rejected") {
    return {
      kind: "skill_assessed",
      skillId: roll.skillId,
      rollId: roll.rollId,
      applicability: "rejected",
      targetIds: j.targetIds ?? [],
      outcome: j.outcome,
      reason: j.reason,
    };
  }
  return {
    kind: "skill_assessed",
    skillId: roll.skillId,
    rollId: roll.rollId,
    applicability: "accepted",
    ...(j.requiredLevel !== undefined
      ? { requiredLevel: j.requiredLevel }
      : {}),
    ...(j.checkType !== undefined ? { checkType: j.checkType } : {}),
    targetIds: j.targetIds ?? [],
    ...(j.opposedDefense !== undefined
      ? { opposedDefenseIds: j.opposedDefense.map((d) => d.characterId) }
      : {}),
    outcome: j.outcome,
    reason: j.reason,
  };
}

// meetsRequiredLevel re-exported for tests that assert consistency rules.
export { meetsRequiredLevel };
