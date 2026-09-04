import type {
  CharacterCondition,
  FeatureEvent,
  SceneCondition,
} from "../core/types.js";
import type { WeatherType } from "../subsystem/weather.js";

// ─── Top-level Event ────────────────────────────────────────────
export interface ScriptedEvent {
  id: string;
  label: string; // human-readable, debug/log only
  initialStatus?: "active" | "disabled"; // default "active"
  /** A recurring event re-arms instead of completing terminally: on
   *  completion it returns to "active" with its trackers reset, and is
   *  barred from re-firing within the same tick (see
   *  `recurringCooldownTicks`). failWhen on a recurring event also
   *  re-arms (runs onFail, back to "active", no cooldown stamp) instead
   *  of failing terminally. Pair with a `timeOfDay` predicate for daily
   *  schedules (the stage-set economy's restock). */
  recurring?: boolean;
  /** Recurring events only: minimum ticks between completions. Lets a
   *  fireWhen WINDOW (timeOfDay gte/lte) fire once per day instead of
   *  every minute of the window. Default: same-tick guard only. */
  recurringCooldownTicks?: number;

  // Timing — DSL distinguishes "delay before event manifests" vs "duration the
  // event takes". Runtime collapses both into one `pending` phase whose
  // scheduledCompleteTick = currentTick + (fireDelayTicks ?? 0) + (durationTicks ?? 0).
  // Module authors that need to query "is X visibly happening now?" decompose into
  // two events linked by cascade — the engine doesn't track separate phases.
  fireDelayTicks?: number; // default 0
  durationTicks?: number; // default 0

  trackers?: Tracker[]; // optional; only needed if predicates reference trackers
  fireWhen: Predicate; // when true → transition to "pending" (or directly "completed" if delay+duration = 0)
  failWhen?: Predicate; // optional; when true → transition to "failed" (priority over completion)
  onComplete: Effect[];
  onFail?: Effect[];
}

// ─── Trackers (cross-tick state) ────────────────────────────────
// All time semantics are continuous (tick-based). No day-boundary special case;
// "daily" / "missed N days" predicates are derived from tick deltas in the
// trackerSinceFulfillment predicate.
export type Tracker =
  | { id: string; kind: "actionCount"; match: ActionMatch }
  | { id: string; kind: "lastFulfillment"; match: ActionMatch };

export interface ActionMatch {
  definitionId?: string; // omit = any action kind
  byNpcId?: string; // omit = any NPC
  atSceneId?: string; // omit = any scene
  withTargetId?: string; // omit = any/no target
}

// ─── Predicate (tick-level boolean) ─────────────────────────────
export type Predicate =
  // ── Tracker queries ────────────────────────────────────
  | {
      op: "trackerCount";
      trackerId: string;
      cmp: "gte" | "lte" | "eq";
      value: number;
    }
  // ticks since the matching action last committed; for "daily" use cmp:lte,value:1440;
  // for "missed N days" use cmp:gte,value:N*1440. If lastFulfilledTick == null
  // (never fulfilled), treats elapsed as +Infinity.
  | {
      op: "trackerSinceFulfillment";
      trackerId: string;
      cmp: "gte" | "lte" | "eq";
      value: number;
    }
  | { op: "trackerNeverFulfilled"; trackerId: string }
  // ── This-tick events ───────────────────────────────────
  | { op: "actionCommittedThisTick"; match: ActionMatch }
  // ── World state ────────────────────────────────────────
  | { op: "characterAt"; characterId: string; sceneId: string }
  | { op: "characterAlive"; characterId: string; expectedAlive: boolean }
  | { op: "characterHasItem"; characterId: string; itemName: string }
  | { op: "sceneHasConditionFromFeature"; sceneId: string; featureId: string }
  | { op: "gameDate"; cmp: "gte" | "lte" | "eq"; value: string }
  // Time-of-day, compared as "HH:MM" (lexicographic == chronological).
  // With one-minute ticks, `eq` fires exactly once per day — the natural
  // trigger for a recurring daily event.
  | { op: "timeOfDay"; cmp: "gte" | "lte" | "eq"; value: string }
  // Any living NPC standing in the scene. The stage-set economy's witness
  // guard: wrap in `not` so a refill only happens while nobody watches.
  | { op: "sceneOccupied"; sceneId: string }
  // Current weather in a region (reads the weather subsystem's state
  // directly — featureId-based scene conditions cannot tell rain from fog).
  | {
      op: "regionWeather";
      regionId: string;
      /** Match any of these types. */
      types: string[];
      /** Minimum intensity (1-5), default 1. */
      minIntensity?: number;
    }
  // ── Cross-event (D) ────────────────────────────────────
  | {
      op: "eventStatus";
      otherEventId: string;
      isStatus: ScriptedEventStatus;
    }
  // ── Composition (C) ────────────────────────────────────
  | { op: "and"; children: Predicate[] }
  | { op: "or"; children: Predicate[] }
  | { op: "not"; child: Predicate };

// ─── CharacterPredicate (filter a single NPC) ───────────────────
// Used in Effect.targetFilter. Subject-bound (operates on a specific character).
export type CharacterPredicate =
  | { op: "atScene"; sceneId: string }
  | { op: "alive"; expectedAlive: boolean }
  | { op: "hasItem"; itemName: string }
  | { op: "is"; characterId: string }
  | { op: "and"; children: CharacterPredicate[] }
  | { op: "or"; children: CharacterPredicate[] }
  | { op: "not"; child: CharacterPredicate };

// ─── ScenePredicate (filter a single scene) ─────────────────────
// Used in Effect.sceneFilter. Subject-bound like CharacterPredicate.
export type ScenePredicate =
  | { op: "is"; sceneId: string }
  | { op: "inRegion"; regionId: string }
  | { op: "hasConditionFromFeature"; featureId: string }
  | { op: "and"; children: ScenePredicate[] }
  | { op: "or"; children: ScenePredicate[] }
  | { op: "not"; child: ScenePredicate };

// ─── Effects (Runner expands → StateChange[]) ───────────────────
export type Effect =
  // Filtered by CharacterPredicate
  | { kind: "character.san"; targetFilter: CharacterPredicate; delta: number }
  | { kind: "character.hp"; targetFilter: CharacterPredicate; delta: number }
  | {
      kind: "character.fatigue";
      targetFilter: CharacterPredicate;
      delta: number;
    }
  | {
      kind: "character.addCondition";
      targetFilter: CharacterPredicate;
      condition: CharacterCondition;
    }
  | {
      kind: "character.removeCondition";
      targetFilter: CharacterPredicate;
      conditionId: string;
    }
  // Filtered by ScenePredicate
  | {
      kind: "scene.addCondition";
      sceneFilter: ScenePredicate;
      condition: SceneCondition;
    }
  | {
      kind: "scene.removeCondition";
      sceneFilter: ScenePredicate;
      predicate: { featureId: string };
    }
  // Direct (no filter)
  | {
      /** Put a weather region into a given state, as a natural transition
       *  would leave it: the weather engine re-judges `[Weather]` conditions
       *  and diffs the passages it previously closed, so easing a storm does
       *  not wait on the next 120-minute transition check.
       *  `regionId` is the one the module's weatherPresets named. */
      kind: "weather.set";
      regionId: string;
      weatherType: WeatherType;
      intensity: number;
    }
  | {
      kind: "connection.setBlock";
      connectionId: string;
      blocked: boolean;
      reason: string;
      /** Optional source attribution for logs/diagnostics. Connection blocks
       *  are a single last-writer-wins flag, so this is not ownership and
       *  does not restrict which later effect may clear the passage. */
      featureId?: string;
    }
  | {
      kind: "connection.setHidden";
      connectionId: string;
      hidden: boolean;
    }
  | {
      kind: "item.create";
      /** Scene/road id the item appears in. */
      location: string;
      name: string;
      description?: string;
      /** Stable id to use verbatim when free (DGSM falls back to a
       *  generated one on conflict, with a warning). Required when
       *  `skipIfExists` is set. */
      id?: string;
      /** Restock semantics: create only if no item with this `id` is
       *  currently AT `location` (location-scoped — a crate someone
       *  carried away does not block the refill). */
      skipIfExists?: boolean;
    }
  | {
      kind: "item.move";
      itemId: string;
      /** Holder strings — "scene:<placeId>" for a place, a BARE character
       *  id for a person (no "npc:" prefix; that would silently create a
       *  phantom inventory). */
      from: string;
      to: string;
    }
  | { kind: "event.emit"; event: FeatureEvent }
  // Cross-event (D)
  | {
      kind: "event.transition";
      otherEventId: string;
      to: "active" | "completed" | "failed" | "disabled";
    };

// ─── Runtime state (lives in DGSM) ──────────────────────────────
// All state below is stored as a record in DGSM (`state.scriptedEventStates`,
// keyed by event id) — NOT in the ScriptedEventRunner instance. Persistence
// rides on DGSM's existing JSON round-trip; no separate serialize/rehydrate
// path on the Runner.

export type ScriptedEventStatus =
  | "active" // being evaluated; waiting for fireWhen
  | "pending" // fireWhen met; scheduled to complete at scheduledCompleteTick
  | "completed" // terminal: success (onComplete fired)
  | "failed" // terminal: failure (onFail fired)
  | "disabled"; // not evaluated; can be re-activated via event.transition

export interface ScriptedEventState {
  id: string;
  status: ScriptedEventStatus;
  scheduledCompleteTick: number | null; // set when status = "pending"; null otherwise
  trackerStates: Record<string, TrackerState>; // keyed by Tracker.id
  /** Recurring events only: the tick of the last completion. Guards a
   *  re-armed event from firing again inside the same tick's cascade. */
  lastCompletedTick?: number | null;
}

export type TrackerState =
  | { kind: "actionCount"; count: number }
  | { kind: "lastFulfillment"; lastFulfilledTick: number | null }; // null = never fulfilled
