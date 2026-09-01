import type { CharacterPosition } from "../../state/topologyTypes.js";

export type FeatureStateScope = "scene" | "region" | "character" | "global";

/**
 * One leg of a movement route — node-to-node segments produced by
 * pathfinding. Used by the CodeEngine movement subsystem (and re-exported from
 * `planning/types.ts` for any straggling caller still on the legacy
 * PlanNode.executionMeta.movement shape).
 */
export interface MovementStep {
  kind: "along_road" | "to_scene";
  from: CharacterPosition;
  to: CharacterPosition;
  durationMinutes: number;
  roadId?: string;
  blockCheck?: {
    fromId: string;
    toId: string;
  };
}

export type GameDateTime = string;
export type GameTime = GameDateTime;

export type Unsubscribe = () => void;

/** Kind of entity referenced by an action. Downstream routing
 *  (scriptedEventRunner.matchTarget, impactPropagation level-1) filters by
 *  kind === "character". `connection` names an authored exit (`connection.*`). */
export type EntityKind = "character" | "item" | "scene" | "connection";

/** A typed entity reference (id + kind) carried on CharacterAction. */
export interface ReferencedEntity {
  id: string;
  kind: EntityKind;
}

/**
 * Structured character-level condition. Symmetric with SceneCondition.
 * Replaces the old `status.conditions: string[]` representation.
 */
export interface CharacterCondition {
  id: string; // unique per character; targeted by character.removeCondition
  featureId?: string; // owner feature (for observability / cleanup by featureId)
  description: string; // human/LLM-readable
  data?: Record<string, unknown>; // feature-private metadata
  mechanicalEffect?: {
    skillPenalty?: Record<string, number>;
    /** Adds to every skill check (wildcard "*"). Summed across conditions. */
    globalSkillPenalty?: number;
    attackPenalty?: number;
  };
  expiresAt?: GameTime; // optional auto-expiry (not enforced by Applier — features check)
}

export interface SceneCondition {
  /** Stable condition id (v2 modules always author one; subsystems may omit). */
  id?: string;
  featureId?: string;
  data?: Record<string, unknown>;
  mechanicalEffect?: {
    skillPenalty?: Record<string, number>;
    blockConnections?: boolean;
  };
  description: string;
}

/** Addresses scene conditions for removal. At least one of `id` / `featureId`
 *  must be present (semantic requirement; both are optional at the type level). */
export type ConditionPredicate = { id?: string; featureId?: string };

export interface FeatureEvent {
  type: string;
  /**
   * Intrinsic perceptibility / impact level (0-5). Drives
   * impactPropagation.findAffectedCharacters: 1=targeted, 2=same scene,
   * 3=macro location, 4=neighborhood, 5=global. Set by the emitter; matches
   * spec §E-renderer-layer's "events carry intrinsic impact" model.
   */
  impact: 0 | 1 | 2 | 3 | 4 | 5;
  /**
   * One-line human-readable description used by NpcActionController to render
   * the event into the agent's `reviseTriggers` prompt section. Set by the
   * emitter so each event type is self-describing without controller-side
   * format tables.
   */
  description: string;
  characterId?: string;
  sceneId?: string;
  data?: Record<string, unknown>;
}

/**
 * Per-location aggregated environmental reading, computed each tick by the
 * Applier from `environment.contribute` / `environment.cap` / `environment.hazard`
 * StateChanges. Features (fire, weather, lighting, sanity, etc.) read this via
 * FeatureReadContext.getEnvironmentReading(locationId) instead of cross-querying
 * each other's scoped state.
 */
export interface EnvironmentReading {
  temperature: number;
  illumination: number;
  oxygen: number;
  noise: number;
  airborneHazards: string[];
}

export const DEFAULT_ENVIRONMENT_READING: EnvironmentReading = Object.freeze({
  temperature: 20,
  illumination: 3,
  oxygen: 1,
  noise: 0,
  airborneHazards: Object.freeze([]) as unknown as string[],
}) as EnvironmentReading;

/**
 * Legacy outcome shape kept for the derived CharacterAction migration view
 * (TickReport.commits). Dies when downstream consumers finish moving to
 * transitions + occurrences.
 */
export interface PlannedOutcome {
  stateChanges: StateChange[];
  elapsedMinutes: number;
  /** Why the action ended the way it did, in the engine's words. Read by
   *  SimulationEventEmitter into the persisted event's `outcome` field, which
   *  was `""` on every row until this was carried: a run could be replayed
   *  from the log and still not say why anything failed. */
  narrative?: string;
}

export type StateChange =
  | { kind: "scene.addCondition"; sceneId: string; condition: SceneCondition }
  | {
      kind: "scene.removeCondition";
      sceneId: string;
      predicate: ConditionPredicate;
    }
  | {
      kind: "character.hp";
      characterId: string;
      delta: number;
      sourceFeatureId: string;
      reason: string;
    }
  | {
      kind: "character.san";
      characterId: string;
      delta: number;
      sourceFeatureId: string;
      reason: string;
    }
  | {
      kind: "character.fatigue";
      characterId: string;
      delta: number;
      sourceFeatureId: string;
      reason: string;
    }
  | {
      kind: "character.addCondition";
      characterId: string;
      condition: CharacterCondition;
    }
  | {
      kind: "character.removeCondition";
      characterId: string;
      conditionId: string;
    }
  | {
      kind: "connection.setBlock";
      connectionId: string;
      blocked: boolean;
      sourceFeatureId: string;
      reason: string;
    }
  | {
      /** These characters have found a concealed connection: each of them
       *  perceives it from now on, and nobody else does. Recorded on the
       *  passage itself (`SceneConnection.discoveredBy`), beside `hidden`.
       *  `connection.setHidden` is the other half — that one opens it for the
       *  whole world at once. */
      kind: "connection.discovered";
      connectionId: string;
      characterIds: string[];
    }
  | {
      /** Reveal/hide a connection by its authored id (`connection.*`). Routed to
       *  DGSM.setConnectionHiddenById, which mutates the owning place's
       *  SceneConnection in place. */
      kind: "connection.setHidden";
      connectionId: string;
      hidden: boolean;
    }
  | {
      /** Rewrite a place's whole prose (scene, junction or road — the same
       *  three-way fallthrough every scene.* setter uses). */
      kind: "scene.setDescription";
      sceneId: string;
      description: string;
    }
  | {
      kind: "feature.setState";
      featureId: string;
      key: string;
      state: unknown;
    }
  | { kind: "feature.removeState"; featureId: string; key: string }
  | { kind: "event.emit"; event: FeatureEvent }
  | {
      kind: "environment.contribute";
      locationId: string;
      quantity: "temperature" | "illumination" | "oxygen" | "noise";
      value: number;
      sourceFeatureId: string;
    }
  | {
      kind: "environment.cap";
      locationId: string;
      quantity: "illumination";
      value: number;
      sourceFeatureId: string;
    }
  | {
      kind: "environment.hazard";
      locationId: string;
      add?: string[];
      remove?: string[];
      sourceFeatureId: string;
    }
  | {
      /**
       * Move a character to a new topology position. Emitted by the CodeEngine
       * movement subsystem each tick as it interpolates along a route.
       * `sourceSubsystem` mirrors `sourceFeatureId` for traceability.
       */
      kind: "character.position";
      characterId: string;
      position: CharacterPosition;
      sourceSubsystem: string;
    }
  | {
      /** Move a VEHICLE. Occupants ride along for free — their position is
       *  the vehicle's interior scene and never changes while riding. */
      kind: "vehicle.position";
      vehicleId: string;
      position: CharacterPosition;
      sourceSubsystem: string;
    }
  | {
      /**
       * Where a character now is WITHIN their location, as prose. Narrative
       * only — nothing reads it but prompts. Empty string clears it, and
       * `setCharacterPosition` clears it on its own whenever the location id
       * actually changes.
       */
      kind: "character.spot";
      characterId: string;
      spot: string;
    }
  // ── Resolver-emitted variants (flattened from resolver schemaTypes) ──
  | {
      /** Everything about an item that can change while it exists. Its
       *  description is its state; the two lighting fields are the only part
       *  a deterministic subsystem reads rather than a model (sun.ts). */
      kind: "item.set";
      itemId: string;
      description?: string;
      /** Appended as one sentence instead of replacing. How damage lands. */
      appendDescription?: string;
      /** Conceal from / reveal to characters. `false` is the reveal. */
      hidden?: boolean;
      isLightSource?: boolean;
      lightLevel?: number;
      /** Set when a subsystem emitted this rather than the resolver. */
      sourceFeatureId?: string;
    }
  | {
      kind: "item.create";
      name: string;
      location: string;
      description?: string;
      /** Stable id to use verbatim when free (DGSM falls back to a generated
       *  one on conflict, with a warning). */
      id?: string;
    }
  | {
      kind: "item.move";
      itemId: string;
      from: string;
      to: string;
    }
  | {
      kind: "item.destroy";
      itemId: string;
    }
  | {
      /** Subsystem-emitted event memory. Applier no-op; consumed by
       *  NpcActionController.routeStateChangeMemories. */
      kind: "memory.event";
      characterId: string;
      content: string;
    }
  | {
      /** Subsystem-emitted witness memory. Applier no-op; consumed by
       *  NpcActionController.routeStateChangeMemories. */
      kind: "memory.witness";
      characterId: string;
      content: string;
    };

export interface CharacterAction {
  characterId: string;
  handleId: string;
  stepGroupId: string;
  stepIndex: number;
  definitionId: string;
  actionText: string;
  sceneId: string;
  /** Citations from actionText resolved by interpreter — typed (id + kind).
   *  Phase H rename of `targetCharacterIds: string[]`. */
  referencedEntities: ReferencedEntity[];
  /** Perceptibility level inherited from the originating ActionStep. Drives
   *  impactPropagation when the controller processes the TickReport. */
  impact: 0 | 1 | 2 | 3 | 4 | 5;
  activatedAt: GameTime;
  completedAt: GameTime;
  outcome?: PlannedOutcome;
}

export interface DamageReport {
  characterId: string;
  field: "hp" | "san" | "fatigue";
  contributors: Array<{ featureId: string; delta: number; reason: string }>;
  finalValueAfter: number;
  died: boolean;
}

// Phase E: encounter detection is removed. Per-NPC perception (including the
// "two NPCs in the same scene" case the legacy encounter scanner detected)
// becomes the renderer's job in the post-Phase-E perception layer.

export interface TickReport {
  gameDateTime: GameDateTime;
  /** Action lifecycle changes this tick (plan Phase 8). The authoritative
   *  record; `commits`/`cancellations` below are derived views kept for the
   *  migration window (event emitter, renderer) until Phase 9 consumers
   *  switch to transitions + occurrences. */
  transitions: import("../actions/types.js").ActionTransition[];
  /** Objective occurrences with perceiver character ids (plan D6). */
  occurrences: import("../actions/types.js").Occurrence[];
  /** Derived from transitions with to="completed". */
  commits: CharacterAction[];
  /** Derived from transitions with to="interrupted"/"cancelled"/"failed". */
  cancellations: CharacterAction[];
  featureEvents: FeatureEvent[];
  stateChanges: StateChange[];
  damageReports: DamageReport[];
}
