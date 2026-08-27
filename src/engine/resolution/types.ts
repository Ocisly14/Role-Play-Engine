// src/engine/resolution/types.ts
//
// Contracts of the unified World Action Engine resolution phase (plan D7 /
// Phase 7). The Engine receives one verifiable, replayable
// EngineResolutionContext per triggered tick — always the FULL world
// authoritative snapshot, never a pre-trimmed "relevant" subset — plus all
// new commands and all active actions, and returns one TickResolution.

import type { CharacterPosition } from "../../state/topologyTypes.js";
import type {
  ActionCommand,
  EngineAction,
  TickResolution,
} from "../actions/types.js";
import type {
  CharacterCondition,
  FeatureEvent,
  GameTime,
  SceneCondition,
} from "../core/types.js";

// ==================== Snapshots ====================

export interface ItemSnapshot {
  id: string;
  name: string;
  description?: string;
  type?: string;
  /** "scene:<sceneId>" or a character id — same grammar as DGSM item moves. */
  holder: string;
  damaged?: boolean;
  properties?: Record<string, unknown>;
}

export interface SceneSnapshot {
  id: string;
  name: string;
  description: string;
  parentLocationId: string;
  indoor?: boolean;
  conditions: SceneCondition[];
  itemIds: string[];
  connections: Array<{
    targetId: string;
    description?: string;
    hidden?: boolean;
    blockedReason?: string;
  }>;
  environment: {
    temperature: number;
    illumination: number;
    oxygen: number;
    noise: number;
    airborneHazards: string[];
  };
  presentCharacterIds: string[];
}

export interface CharacterSnapshot {
  id: string;
  name: string;
  occupation?: string;
  appearance?: string;
  alive: boolean;
  attributes: Record<string, number>;
  skills: Record<string, number>;
  hp: number;
  maxHp: number;
  san: number;
  maxSan: number;
  fatigue: number;
  maxFatigue: number;
  position: CharacterPosition | null;
  /** Resolved location id ("" when position is unknown). */
  locationId: string;
  conditions: CharacterCondition[];
  inventoryItemIds: string[];
}

// ==================== Context ====================

export type ResolutionTriggerReason =
  | "new_action"
  | "duration_reached"
  | "replacement"
  | "interrupted";

export interface ResolutionTrigger {
  actionIds: string[];
  reason: ResolutionTriggerReason;
}

export interface WorldInvariant {
  id: string;
  description: string;
}

/** Objective event that already took effect this tick before the resolution
 *  phase (scripted/world events, interruption signals). */
export interface ObjectiveWorldEvent {
  kind: "interruption" | "world_event";
  actionId?: string;
  description: string;
  event?: FeatureEvent;
}

/** Trusted deterministic result computed before the session (beyond the
 *  skill rolls already carried on the commands themselves). */
export interface DeterministicResult {
  label: string;
  data: Record<string, unknown>;
}

export interface EngineResolutionContext {
  trigger: {
    triggers: ResolutionTrigger[];
    /** Union of all triggering action ids. */
    actionIds: string[];
  };

  tick: {
    tickId: string;
    tickStartTime: GameTime;
    durationMinutes: number;
  };

  rules: {
    resolutionGuide: "src/engine/rules/world-action-resolution.md";
    outputSchemaVersion: number;
    worldInvariants: WorldInvariant[];
  };

  state: {
    scenes: SceneSnapshot[];
    items: ItemSnapshot[];
    characters: CharacterSnapshot[];
  };

  actions: {
    newCommands: ActionCommand[];
    activeActions: EngineAction[];
  };

  events: {
    objectiveWorldEvents: ObjectiveWorldEvent[];
    deterministicResults: DeterministicResult[];
  };
}

// ==================== Engine output ====================

export interface WorldActionEngineResult {
  resolution: TickResolution;
  /** Validation problems that survived the corrective retry; the offending
   *  deltas were dropped and the named actions failed. */
  droppedViolations: string[];
  /** Structured trace of the session's code-tool calls. */
  codeToolInvocations: import("../tools/codeTool.js").CodeToolInvocation[];
  /** Engine judgements per actionId (persisted onto action runtime). */
  judgements: Record<string, import("../actions/types.js").ActionJudgement>;
  /** Movement-leg runtime annotations per actionId. */
  movementInits: Record<string, { destinationId: string }>;
}
