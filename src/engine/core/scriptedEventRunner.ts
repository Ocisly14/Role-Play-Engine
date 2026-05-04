import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { DynamicNPCProfile, DynamicScene } from "../../state/types.js";
import type {
  ActionMatch,
  CharacterPredicate,
  Effect,
  Predicate,
  ScenePredicate,
  ScriptedEvent,
  ScriptedEventState,
  ScriptedEventStatus,
  TrackerState,
} from "../scriptedEvents/types.js";
import type { CharacterAction, GameTime, StateChange } from "./types.js";

/**
 * ScriptedEventRunner — see plan §C-runtime.
 *
 * Owns only the event definitions Map (loaded from module data; not persisted).
 * All runtime state lives in DGSM (`state.scriptedEventStates`); reads/writes
 * route through `dgsm.getScriptedEventState` / `setScriptedEventState`.
 */

const MAX_CASCADE = 8;
const TERMINAL_STATUSES: ReadonlySet<ScriptedEventStatus> =
  new Set<ScriptedEventStatus>(["completed", "failed", "disabled"]);

export interface EvaluatorContext {
  dgsm: DynamicGameStateManager;
  gameDay: number;
  tickTime: GameTime;
  currentTick: number;
  committedActionsThisTick: readonly CharacterAction[];
  getEventState: (eventId: string) => ScriptedEventState | undefined;
}

export interface RunInput {
  dgsm: DynamicGameStateManager;
  currentTick: number;
  tickTime: GameTime;
  committedActionsThisTick: readonly CharacterAction[];
}

export class ScriptedEventRunner {
  private events: Map<string, ScriptedEvent>;

  constructor(events: ScriptedEvent[]) {
    this.events = new Map(events.map((e) => [e.id, e]));
  }

  run(input: RunInput): StateChange[] {
    const out: StateChange[] = [];

    // Lazy-init: ensure every event has a DGSM record.
    for (const [eventId, event] of this.events) {
      if (input.dgsm.getScriptedEventState(eventId) === undefined) {
        input.dgsm.setScriptedEventState(eventId, this.initEventState(event));
      }
    }

    // Update trackers from this tick's committed actions.
    this.updateTrackers(
      input.dgsm,
      input.committedActionsThisTick,
      input.currentTick
    );

    // Cascade loop.
    let hop = 0;
    let changed = true;
    while (hop < MAX_CASCADE && changed) {
      changed = false;
      for (const eventId of this.events.keys()) {
        if (this.evaluateAndTransition(eventId, input, out)) {
          changed = true;
        }
      }
      hop += 1;
    }
    if (hop >= MAX_CASCADE && changed) {
      console.warn(
        `[ScriptedEventRunner] cascade cap (${MAX_CASCADE}) reached`
      );
    }

    return out;
  }

  // ─────────────────── helpers ───────────────────

  private initEventState(event: ScriptedEvent): ScriptedEventState {
    const trackerStates: Record<string, TrackerState> = {};
    for (const tracker of event.trackers ?? []) {
      if (tracker.kind === "actionCount") {
        trackerStates[tracker.id] = { kind: "actionCount", count: 0 };
      } else {
        trackerStates[tracker.id] = {
          kind: "lastFulfillment",
          lastFulfilledTick: null,
        };
      }
    }
    return {
      id: event.id,
      status: event.initialStatus ?? "active",
      scheduledCompleteTick: null,
      trackerStates,
    };
  }

  private updateTrackers(
    dgsm: DynamicGameStateManager,
    committedActions: readonly CharacterAction[],
    currentTick: number
  ): void {
    for (const [eventId, event] of this.events) {
      const state = dgsm.getScriptedEventState(eventId);
      if (!state) continue;
      if (TERMINAL_STATUSES.has(state.status)) continue;
      if (!event.trackers || event.trackers.length === 0) continue;

      let mutated = false;
      for (const tracker of event.trackers) {
        const matching = committedActions.filter((a) =>
          this.matchesAction(a, tracker.match)
        );
        if (matching.length === 0) continue;
        const ts = state.trackerStates[tracker.id];
        if (!ts) continue;
        if (ts.kind === "actionCount" && tracker.kind === "actionCount") {
          ts.count += matching.length;
          mutated = true;
        } else if (
          ts.kind === "lastFulfillment" &&
          tracker.kind === "lastFulfillment"
        ) {
          ts.lastFulfilledTick = currentTick;
          mutated = true;
        }
      }
      if (mutated) {
        dgsm.setScriptedEventState(eventId, state);
      }
    }
  }

  private matchesAction(a: CharacterAction, m: ActionMatch): boolean {
    if (m.definitionId !== undefined && a.definitionId !== m.definitionId) {
      return false;
    }
    if (m.byNpcId !== undefined && a.characterId !== m.byNpcId) {
      return false;
    }
    if (m.atSceneId !== undefined && a.sceneId !== m.atSceneId) {
      return false;
    }
    if (
      m.withTargetId !== undefined &&
      !a.targetCharacterIds.includes(m.withTargetId)
    ) {
      return false;
    }
    return true;
  }

  private makeEvaluatorContext(input: RunInput): EvaluatorContext {
    return {
      dgsm: input.dgsm,
      gameDay: input.tickTime.day,
      tickTime: input.tickTime,
      currentTick: input.currentTick,
      committedActionsThisTick: input.committedActionsThisTick,
      getEventState: (id) => input.dgsm.getScriptedEventState(id),
    };
  }

  private evaluateAndTransition(
    eventId: string,
    input: RunInput,
    out: StateChange[]
  ): boolean {
    const event = this.events.get(eventId);
    if (!event) return false;
    const state = input.dgsm.getScriptedEventState(eventId);
    if (!state) return false;
    if (TERMINAL_STATUSES.has(state.status)) return false;

    const ctx = this.makeEvaluatorContext(input);

    // failWhen has priority; can interrupt pending events.
    if (event.failWhen && this.evaluatePredicate(event.failWhen, ctx, state)) {
      state.status = "failed";
      state.scheduledCompleteTick = null;
      out.push(...this.expandEffects(event.onFail ?? [], event, ctx));
      this.applyTransitionEffects(event.onFail ?? [], ctx, out, 0);
      input.dgsm.setScriptedEventState(eventId, state);
      return true;
    }

    if (state.status === "active") {
      if (this.evaluatePredicate(event.fireWhen, ctx, state)) {
        const totalWait =
          (event.fireDelayTicks ?? 0) + (event.durationTicks ?? 0);
        if (totalWait > 0) {
          state.status = "pending";
          state.scheduledCompleteTick = input.currentTick + totalWait;
        } else {
          state.status = "completed";
          state.scheduledCompleteTick = null;
          out.push(...this.expandEffects(event.onComplete, event, ctx));
          this.applyTransitionEffects(event.onComplete, ctx, out, 0);
        }
        input.dgsm.setScriptedEventState(eventId, state);
        return true;
      }
      return false;
    }

    if (state.status === "pending") {
      if (
        state.scheduledCompleteTick !== null &&
        input.currentTick >= state.scheduledCompleteTick
      ) {
        state.status = "completed";
        state.scheduledCompleteTick = null;
        out.push(...this.expandEffects(event.onComplete, event, ctx));
        this.applyTransitionEffects(event.onComplete, ctx, out, 0);
        input.dgsm.setScriptedEventState(eventId, state);
        return true;
      }
      return false;
    }

    return false;
  }

  /**
   * Recursively apply `event.transition` effects. Each transition force-sets
   * the target event's status (skipping its own fireWhen / delay / duration)
   * and queues the target's onComplete/onFail effects to `out`. Recursion is
   * capped by MAX_CASCADE to defend against transition loops.
   */
  private applyTransitionEffects(
    effects: readonly Effect[],
    ctx: EvaluatorContext,
    out: StateChange[],
    depth: number
  ): void {
    if (depth >= MAX_CASCADE) {
      console.warn(
        `[ScriptedEventRunner] applyTransitionEffects depth cap (${MAX_CASCADE}) reached`
      );
      return;
    }
    for (const effect of effects) {
      if (effect.kind !== "event.transition") continue;
      const target = ctx.dgsm.getScriptedEventState(effect.otherEventId);
      if (!target) continue;
      const targetEvent = this.events.get(effect.otherEventId);
      if (!targetEvent) continue;

      target.status = effect.to;
      target.scheduledCompleteTick = null;

      if (effect.to === "completed") {
        out.push(
          ...this.expandEffects(targetEvent.onComplete, targetEvent, ctx)
        );
        this.applyTransitionEffects(
          targetEvent.onComplete,
          ctx,
          out,
          depth + 1
        );
      } else if (effect.to === "failed") {
        const onFail = targetEvent.onFail ?? [];
        out.push(...this.expandEffects(onFail, targetEvent, ctx));
        this.applyTransitionEffects(onFail, ctx, out, depth + 1);
      }

      ctx.dgsm.setScriptedEventState(effect.otherEventId, target);
    }
  }

  /**
   * Expand each Effect into concrete StateChange[]. Filtered effects iterate
   * NPCs / scenes and emit one StateChange per match. `event.transition` is
   * NOT expanded here — it's handled by `applyTransitionEffects`.
   */
  private expandEffects(
    effects: readonly Effect[],
    event: ScriptedEvent,
    ctx: EvaluatorContext
  ): StateChange[] {
    const out: StateChange[] = [];
    const sourceFeatureId = `scripted:${event.id}`;
    const reason = event.label;
    const allNpcs = ctx.dgsm.getState().npcCharacters;

    for (const effect of effects) {
      switch (effect.kind) {
        case "character.san":
        case "character.hp":
        case "character.fatigue": {
          const field =
            effect.kind === "character.san"
              ? "san"
              : effect.kind === "character.hp"
                ? "hp"
                : "fatigue";
          for (const npc of allNpcs) {
            if (
              this.evaluateCharacterPredicate(effect.targetFilter, npc, ctx)
            ) {
              if (field === "san") {
                out.push({
                  kind: "character.san",
                  characterId: npc.id,
                  delta: effect.delta,
                  sourceFeatureId,
                  reason,
                });
              } else if (field === "hp") {
                out.push({
                  kind: "character.hp",
                  characterId: npc.id,
                  delta: effect.delta,
                  sourceFeatureId,
                  reason,
                });
              } else {
                out.push({
                  kind: "character.fatigue",
                  characterId: npc.id,
                  delta: effect.delta,
                  sourceFeatureId,
                  reason,
                });
              }
            }
          }
          break;
        }
        case "character.addCondition": {
          for (const npc of allNpcs) {
            if (
              this.evaluateCharacterPredicate(effect.targetFilter, npc, ctx)
            ) {
              out.push({
                kind: "character.addCondition",
                characterId: npc.id,
                condition: effect.condition,
              });
            }
          }
          break;
        }
        case "character.removeCondition": {
          for (const npc of allNpcs) {
            if (
              this.evaluateCharacterPredicate(effect.targetFilter, npc, ctx)
            ) {
              out.push({
                kind: "character.removeCondition",
                characterId: npc.id,
                conditionId: effect.conditionId,
              });
            }
          }
          break;
        }
        case "scene.addCondition": {
          const sceneIds = ctx.dgsm.getAllSceneIds();
          for (const sceneId of sceneIds) {
            const scene = ctx.dgsm.getScene(sceneId);
            if (!scene) continue;
            if (this.evaluateScenePredicate(effect.sceneFilter, scene, ctx)) {
              const condWithSource = {
                ...effect.condition,
                featureId: effect.condition.featureId ?? sourceFeatureId,
              };
              out.push({
                kind: "scene.addCondition",
                sceneId,
                condition: condWithSource,
              });
            }
          }
          break;
        }
        case "scene.removeCondition": {
          const sceneIds = ctx.dgsm.getAllSceneIds();
          for (const sceneId of sceneIds) {
            const scene = ctx.dgsm.getScene(sceneId);
            if (!scene) continue;
            if (this.evaluateScenePredicate(effect.sceneFilter, scene, ctx)) {
              out.push({
                kind: "scene.removeCondition",
                sceneId,
                predicate: effect.predicate,
              });
            }
          }
          break;
        }
        case "connection.setBlock": {
          out.push({
            kind: "connection.setBlock",
            connectionId: effect.connectionId,
            blocked: effect.blocked,
            sourceFeatureId,
            reason: effect.reason,
          });
          break;
        }
        case "event.emit": {
          out.push({ kind: "event.emit", event: effect.event });
          break;
        }
        case "event.transition": {
          // Handled by applyTransitionEffects, not expanded into StateChange[].
          break;
        }
      }
    }

    return out;
  }

  // ─────────────────── predicate evaluators ───────────────────

  private evaluatePredicate(
    pred: Predicate,
    ctx: EvaluatorContext,
    thisEventState: ScriptedEventState
  ): boolean {
    switch (pred.op) {
      case "trackerCount": {
        const ts = thisEventState.trackerStates[pred.trackerId];
        if (!ts || ts.kind !== "actionCount") return false;
        return cmp(ts.count, pred.cmp, pred.value);
      }
      case "trackerSinceFulfillment": {
        const ts = thisEventState.trackerStates[pred.trackerId];
        if (!ts || ts.kind !== "lastFulfillment") return false;
        if (ts.lastFulfilledTick === null) {
          // Treat elapsed as +Infinity.
          if (pred.cmp === "gte") return true;
          if (pred.cmp === "lte") return false;
          return false; // eq with Infinity is never true
        }
        const elapsed = ctx.currentTick - ts.lastFulfilledTick;
        return cmp(elapsed, pred.cmp, pred.value);
      }
      case "trackerNeverFulfilled": {
        const ts = thisEventState.trackerStates[pred.trackerId];
        if (!ts || ts.kind !== "lastFulfillment") return false;
        return ts.lastFulfilledTick === null;
      }
      case "actionCommittedThisTick": {
        return ctx.committedActionsThisTick.some((a) =>
          this.matchesAction(a, pred.match)
        );
      }
      case "characterAt": {
        const pos = ctx.dgsm.getCharacterPosition(pred.characterId);
        if (!pos) return false;
        return pos.type === "scene" && pos.sceneId === pred.sceneId;
      }
      case "characterAlive": {
        const profile = ctx.dgsm.getNpcProfile(pred.characterId);
        if (!profile) return !pred.expectedAlive;
        const alive = ctx.dgsm.isNpcAlive(pred.characterId);
        return alive === pred.expectedAlive;
      }
      case "characterHasItem": {
        const profile = ctx.dgsm.getNpcProfile(pred.characterId);
        if (!profile) return false;
        const inv = profile.inventory ?? [];
        const target = pred.itemName.toLowerCase().trim();
        return inv.some((it) => it.name?.toLowerCase().trim() === target);
      }
      case "sceneHasConditionFromFeature": {
        const scene = ctx.dgsm.getScene(pred.sceneId);
        if (!scene) return false;
        return (scene.conditions ?? []).some(
          (c) => (c as { featureId?: string }).featureId === pred.featureId
        );
      }
      case "gameDay": {
        return cmp(ctx.gameDay, pred.cmp, pred.value);
      }
      case "eventStatus": {
        const target = ctx.getEventState(pred.otherEventId);
        if (!target) return false;
        return target.status === pred.isStatus;
      }
      case "and":
        return pred.children.every((c) =>
          this.evaluatePredicate(c, ctx, thisEventState)
        );
      case "or":
        return pred.children.some((c) =>
          this.evaluatePredicate(c, ctx, thisEventState)
        );
      case "not":
        return !this.evaluatePredicate(pred.child, ctx, thisEventState);
    }
  }

  private evaluateCharacterPredicate(
    pred: CharacterPredicate,
    character: DynamicNPCProfile,
    ctx: EvaluatorContext
  ): boolean {
    switch (pred.op) {
      case "atScene": {
        const pos = ctx.dgsm.getCharacterPosition(character.id);
        if (!pos) return false;
        return pos.type === "scene" && pos.sceneId === pred.sceneId;
      }
      case "alive": {
        const alive = ctx.dgsm.isNpcAlive(character.id);
        return alive === pred.expectedAlive;
      }
      case "hasItem": {
        const inv = character.inventory ?? [];
        const target = pred.itemName.toLowerCase().trim();
        return inv.some((it) => it.name?.toLowerCase().trim() === target);
      }
      case "is":
        return character.id === pred.characterId;
      case "and":
        return pred.children.every((c) =>
          this.evaluateCharacterPredicate(c, character, ctx)
        );
      case "or":
        return pred.children.some((c) =>
          this.evaluateCharacterPredicate(c, character, ctx)
        );
      case "not":
        return !this.evaluateCharacterPredicate(pred.child, character, ctx);
    }
  }

  private evaluateScenePredicate(
    pred: ScenePredicate,
    scene: DynamicScene,
    ctx: EvaluatorContext
  ): boolean {
    switch (pred.op) {
      case "is":
        return scene.id === pred.sceneId;
      case "inRegion":
        return scene.parentLocationId === pred.regionId;
      case "hasConditionFromFeature":
        return (scene.conditions ?? []).some(
          (c) => (c as { featureId?: string }).featureId === pred.featureId
        );
      case "and":
        return pred.children.every((c) =>
          this.evaluateScenePredicate(c, scene, ctx)
        );
      case "or":
        return pred.children.some((c) =>
          this.evaluateScenePredicate(c, scene, ctx)
        );
      case "not":
        return !this.evaluateScenePredicate(pred.child, scene, ctx);
    }
  }
}

function cmp(a: number, op: "gte" | "lte" | "eq", b: number): boolean {
  if (op === "gte") return a >= b;
  if (op === "lte") return a <= b;
  return a === b;
}
