// src/engine/resolution/types.ts
//
// Contracts of the unified World Action Engine resolution phase (plan D7 /
// Phase 7, two-tier context since M3). The Engine receives one verifiable,
// replayable EngineResolutionContext per triggered tick: Tier 1 is the whole
// world as a graph (every place and every connection, no prose), Tier 2 is
// the full snapshot of only the places this tick's actions touch. Characters
// stay complete, and the validation lookup (`state.itemHolders` plus the
// graph) is built from the FULL state, so what the prompt trims never
// narrows what the validator accepts.

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
  /** "scene:<placeId>" or a character id — same grammar as DGSM item moves. */
  holder: string;
  /** The Engine is all-knowing: hidden items appear here (that is what makes
   *  revealing them possible), flagged so it knows characters cannot see them. */
  hidden?: boolean;
  damaged?: boolean;
  properties?: Record<string, unknown>;
}

export type PlaceKind = "scene" | "road";

/** Tier 1: the world SKELETON — macro locations plus geography (top-level
 *  node scenes and roads), no interior scenes. An edge whose authored
 *  endpoint is an interior scene is lifted to that scene's parent (the
 *  connectionId stays the authored one), and edges between two scenes of the
 *  same parent are omitted. Static by construction: blocked state travels
 *  separately (volatile), so this section stays byte-identical across ticks
 *  for prompt caching. */
export interface WorldGraph {
  /** `description` is the outline's macro prose. */
  macroLocations: Array<{ id: string; name: string; description?: string }>;
  /** Geography nodes only: top-level scenes (kind "scene") and roads.
   *  `description` is the authored v2 prose — it already cites its `[exit.*]`
   *  references, so the skeleton renders in the same
   *  description-plus-references shape as every place file. */
  places: Array<{
    id: string;
    kind: PlaceKind;
    name: string;
    description?: string;
    parentLocationId?: string;
  }>;
  edges: Array<{
    /** The authored connection id (`exit.*`) — the handle connectionBlock /
     *  connectionHidden operations take. */
    connectionId: string;
    /** Skeleton node: the declaring place, lifted to its macro location when
     *  the declaring place is an interior scene. */
    from: string;
    to: string;
    /** Full-length walk time; set on road endpoint edges. */
    travelTimeMinutes?: number;
    hidden?: boolean;
  }>;
}

/** A currently impassable edge, addressed by the authored ids (volatile —
 *  rendered outside the cached graph so blocking a road does not invalidate
 *  the stable prompt half). */
export interface BlockedEdge {
  connectionId: string;
  from: string;
  to: string;
  reason: string;
}

/** Tier 2: the full snapshot of one INVOLVED place — a scene or road an
 *  action touches this tick. */
export interface PlaceSnapshot {
  id: string;
  kind: PlaceKind;
  name: string;
  description: string;
  parentLocationId?: string;
  indoor?: boolean;
  conditions: SceneCondition[];
  itemIds: string[];
  connections: Array<{
    connectionId: string;
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
  /**
   * Free text: where they are WITHIN `locationId` — "at the workbench, back
   * to the door". Narrative only. No reachability is computed from it and
   * nobody is stopped by it; you weigh it like everything else. Absent =
   * nothing worth saying.
   */
  spot?: string;
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
    /** Tier 1 — the world skeleton: macro locations + geography. Static. */
    graph: WorldGraph;
    /** Currently blocked edges, world-wide. Volatile companion to `graph`. */
    blockedEdges: BlockedEdge[];
    /** Tier 2 — full snapshots of the involved places only. */
    places: PlaceSnapshot[];
    /** Items at the involved places plus the involved actors' inventories. */
    items: ItemSnapshot[];
    /** FULL-world item-id → holder map. Validation reads this (never the
     *  trimmed `items` list), so an item at an uninvolved place is still a
     *  real reference. Not rendered into the prompt. */
    itemHolders: Record<string, string>;
    /** FULL-world place-id → kind map. Validation reads this (never the
     *  skeleton graph, which carries no interior scenes). Not rendered. */
    placeKinds: Record<string, PlaceKind>;
    /** Every authored connection id in the world. Validation lookup for
     *  connectionBlock/connectionHidden targets. Not rendered. */
    connectionIds: string[];
    /** ALL characters, untrimmed. */
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
      /** Movement-leg runtime annotations per actionId. */
      movementInits: Record<string, { destinationId: string }>;
      /** The bar the Engine set for an action as it starts, per actionId. */
      checkInits: Record<
        string,
        {
          requiredLevel: "regular" | "hard" | "extreme";
          basis: string;
          opposedBy?: Array<{ characterId: string; skillId: string }>;
        }
      >;
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
