// StateResolution currently lives at src/engine/types.ts (marked @deprecated there).
// Cleaning up resolver output types is out of scope for this refactor; we use
// the type as-is for now.
import type { CharacterPosition } from "../../state/topologyTypes.js";
import type { StateResolution } from "../types.js";

export type FeatureStateScope = "scene" | "region" | "character" | "global";

/**
 * One leg of a movement route — junction-to-junction segments produced by
 * pathfinding. Used by the CodeEngine movement subsystem (and re-exported from
 * `planning/types.ts` for any straggling caller still on the legacy
 * PlanNode.executionMeta.movement shape).
 */
export interface MovementStep {
  kind: "to_junction" | "along_road" | "to_scene";
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

/** Kind of entity referenced via [Name] citation in actionText.
 *  Drives downstream routing: stateContextBuilder, scriptedEventRunner.matchTarget,
 *  impactPropagation level-1 propagation all filter by kind === "character". */
export type EntityKind = "character" | "item" | "scene";

/** A resolved citation from `actionText`: directory lookup result.
 *  Produced by GameInterpreter; carried on InterpretedStep / ActionStep / CharacterAction. */
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

export interface ActionInput {
  characterId: string;
  actionText: string;
  sceneId: string;
  overlayFields?: Record<string, unknown>;
  // targetCharacterIds removed — agent no longer emits this; interpreter derives referencedEntities
}

export interface ActionHandle {
  readonly id: string;
  readonly characterId: string;
  readonly submittedAt: GameTime;
}

export type ActionStatus =
  | "queued"
  | "active"
  | "completed"
  | "interrupted"
  | "cancelled";

export interface ActionStep {
  id: string;
  handle: ActionHandle;
  stepGroupId: string;
  stepIndex: number;

  characterId: string;
  /** Citations from actionText resolved by interpreter — typed (id + kind).
   *  Replaces legacy `targetCharacterIds: string[]` (Phase H). */
  referencedEntities: ReferencedEntity[];
  actionText: string;
  definitionId: string;
  executionSceneId: string;
  overlayFields?: Record<string, unknown>;

  /**
   * Dispatch discriminator copied from the matched `ActionDefinition.engine`
   * during interpretation. `"code"` steps are dispatched to a
   * `CodeEngineSubsystem`; `"llm"` steps run through the resolver path.
   * Optional for back-compat with steps constructed before the dual-engine
   * cutover (e.g. via tests); the orchestrator treats `undefined` as `"llm"`.
   */
  engine?: "code" | "llm";
  /**
   * Identifies which `CodeEngineSubsystem` handles this step when
   * `engine === "code"`. Copied from `ActionDefinition.codeSubsystem`.
   */
  codeSubsystem?: string;

  submittedAt: GameTime;

  activatedAt?: GameTime;
  plannedDuration?: number;
  plannedOutcome?: StateResolution;
  completionTime?: GameTime;

  status: ActionStatus;
}

export interface CancelResult {
  applied: boolean;
  remainingChainCancelled: number;
}

export interface SceneCondition {
  featureId?: string;
  data?: Record<string, unknown>;
  mechanicalEffect?: {
    skillPenalty?: Record<string, number>;
    blockConnections?: boolean;
  };
  description: string;
}

export type ConditionPredicate = { featureId: string };

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
 * Output of the resolver pipeline for a single action step. Consumed by
 * Phase 4 commit (applier processes stateChanges) and by EventBus emission
 * (narrative surfaces). Moved here from worldFeature.ts in Phase I.
 */
export interface PlannedOutcome {
  stateChanges: StateChange[];
  elapsedMinutes: number;
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
      kind: "scene.damageItem";
      sceneId: string;
      itemId: string;
      damagedBy: string; // "fire" | "moisture" | "weapon" | ...
      reason: string;
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
  // ── Resolver-emitted variants (flattened from resolver schemaTypes) ──
  | {
      kind: "item.modify";
      itemId: string;
      name?: string;
      description?: string;
    }
  | {
      kind: "item.create";
      name: string;
      location: string;
      properties?: Record<string, unknown>;
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
      /** Resolver-emitted event memory. Applier no-op; consumed by
       *  NpcActionController.routeResolverMemories. */
      kind: "memory.event";
      characterId: string;
      content: string;
    }
  | {
      /** Resolver-emitted witness memory. Applier no-op; consumed by
       *  NpcActionController.routeResolverMemories. */
      kind: "memory.witness";
      characterId: string;
      content: string;
    }
  | {
      kind: "relationship.change";
      fromId: string;
      toId: string;
      delta?: number;
      note?: string;
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
  activatedAt: GameTime;
  completedAt: GameTime;
  outcome?: StateResolution;
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
  /** Steps that became `active` this tick (queued → active). Surfaced so the
   *  controller can write "begin" event memory at activatedAt, paired with
   *  the existing "result" memory from `commits` at completedAt. */
  activations: ActionStep[];
  commits: CharacterAction[];
  cancellations: CharacterAction[];
  featureEvents: FeatureEvent[];
  stateChanges: StateChange[];
  damageReports: DamageReport[];
}
