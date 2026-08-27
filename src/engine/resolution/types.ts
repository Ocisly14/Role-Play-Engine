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

// ==================== Errors ====================

/**
 * One thing the Engine got wrong, addressed at the element that must change.
 *
 * The address is what makes repair incremental: the Engine is told "fix
 * characterChanges[2]" rather than "this submission is bad, write the whole
 * thing again". Re-emitting a whole resolution wastes the parts that were
 * already correct and invites the model to break them.
 */
export interface ResolutionError {
  target:
    | { kind: "action"; actionId: string }
    | { kind: "characterChange"; index: number }
    | { kind: "sceneChange"; index: number }
    | { kind: "itemChange"; index: number }
    | { kind: "occurrence"; index: number }
    /** Wrong about the submission as a whole — a triggering action with no
     *  transition, an ended action with no occurrence citing it. */
    | { kind: "resolution" };
  /** What is wrong, stated as fact, and what would make it right. */
  message: string;
}

/** How a ResolutionError is addressed in the repair call. */
export function formatErrorTarget(target: ResolutionError["target"]): string {
  switch (target.kind) {
    case "action":
      return `action:${target.actionId}`;
    case "resolution":
      return "resolution";
    default:
      return `${target.kind}:${target.index}`;
  }
}

// ==================== Engine output ====================

/**
 * Either the Engine produced a resolution that satisfies every contract, or
 * it produced nothing at all.
 *
 * There is no partial application. A resolution that still violates the
 * contract after repair is an ENGINE fault, not an event in the world:
 * dropping the invalid parts and keeping the rest writes a half-true world
 * and hides the fault. The tick applies nothing instead, the actions keep the
 * state they had, and the failure stays loud.
 */
export type WorldActionEngineResult =
  | {
      ok: true;
      resolution: TickResolution;
      /** Engine judgements per actionId (persisted onto action runtime). */
      judgements: Record<string, import("../actions/types.js").ActionJudgement>;
      /** Movement-leg runtime annotations per actionId. */
      movementInits: Record<string, { destinationId: string }>;
      /** Structured trace of the session's code-tool calls. */
      codeToolInvocations: import("../tools/codeTool.js").CodeToolInvocation[];
    }
  | {
      ok: false;
      /** Why the session produced nothing usable. */
      failure: string;
      /** Whatever was still wrong when the repair budget ran out; empty when
       *  the session failed before any submission (model error). */
      errors: ResolutionError[];
      codeToolInvocations: import("../tools/codeTool.js").CodeToolInvocation[];
    };
