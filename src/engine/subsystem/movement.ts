// src/engine/subsystem/movement.ts
//
// Per-step movement processor. Phase I migration of MovementSubsystem from
// src/engine/codeEngine/movement.ts. Logic preserved verbatim; only the
// interface signature changes (CodeEngineSubsystem → ActionSubsystem,
// CodeEngineStepResult → SubsystemStepResult, getCodeEngineDgsm →
// getActionSubsystemDgsm).

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterPosition } from "../../state/topologyTypes.js";
import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { ActionStep, MovementStep, StateChange } from "../core/types.js";
import {
  buildMovementRouteIgnoringBlocks,
  nearestRoadPosition,
  resolveTargetPosition,
} from "../shared/pathfinding.js";
import { getActionSubsystemDgsm } from "./actionContext.js";
import type { ActionSubsystem, SubsystemStepResult } from "./types.js";

/**
 * Per-character state held by the movement subsystem while a route is in
 * flight. Mirrors the legacy `MovementExecutionState` shape from
 * `planning/types.ts:120-127` but lives inside the subsystem rather than on
 * `PlanNode.executionMeta.movement` (which is being deleted alongside
 * tickProcessor.ts in Task E7).
 */
interface MovementRouteState {
  routeSnapshot: MovementStep[];
  currentStepIndex: number;
  minutesIntoStep: number;
  lastReachablePosition: CharacterPosition;
  targetPosition: CharacterPosition;
}

// Module-level route map replaces the class instance field `this.routes`.
// Keyed by step.id so re-activation of the same step (rare but possible
// during persistence round-trips) can be differentiated from concurrent
// independent moves.
const routes = new Map<string, MovementRouteState>();

const SUBSYSTEM_ID = "movement";

/** Result of planning a route without executing it. Extracted from
 *  `onActivate` so the Engine's pathfinding/movement-cost code tools reuse
 *  the exact mechanics the subsystem runs on (plan Phase 5: no copies). */
export type PlannedRoute =
  | {
      ok: true;
      steps: MovementStep[];
      totalMinutes: number;
      targetPosition: CharacterPosition;
    }
  | { ok: false; reason: "missing_destination" | "no_current_position" | "no_path" };

/**
 * Resolve a destination id and plan the movement route from `currentPosition`,
 * applying the same policies `onActivate` uses: same-building shortcut,
 * road-end snapping for bare road destinations, block-ignoring route build
 * (blocks are enforced during execution, step by step).
 */
export function planMovementRoute(
  dgsm: DynamicGameStateManager,
  characterId: string,
  destination: string | undefined
): PlannedRoute {
  if (!destination) return { ok: false, reason: "missing_destination" };

  const currentPosition = dgsm.getCharacterPosition(characterId);
  if (!currentPosition) return { ok: false, reason: "no_current_position" };

  // Same-building shortcut: scene → scene within the same parent location.
  const state = dgsm.getState();
  if (currentPosition.type === "scene") {
    const currentScene = state.scenes.get(currentPosition.sceneId);
    const targetScene = state.scenes.get(destination);
    if (
      currentScene &&
      targetScene &&
      currentScene.parentLocationId === targetScene.parentLocationId &&
      currentScene.parentLocationId !== "OUTDOOR" &&
      currentPosition.sceneId !== destination
    ) {
      const targetPos: CharacterPosition = {
        type: "scene",
        sceneId: destination,
      };
      return {
        ok: true,
        steps: [
          {
            kind: "to_scene",
            from: currentPosition,
            to: targetPos,
            durationMinutes: 1,
            blockCheck: {
              fromId: currentPosition.sceneId,
              toId: destination,
            },
          },
        ],
        totalMinutes: 1,
        targetPosition: targetPos,
      };
    }
  }

  const topology = dgsm.getTopology();
  let targetPosition = resolveTargetPosition(destination, topology, dgsm);
  if (!targetPosition) return { ok: false, reason: "no_path" };
  // A road destination with no explicit "@position" ("去那条街" / an outline
  // whose entry is a road) means "get onto that road" — snap to the end
  // nearest to the mover instead of the default midpoint.
  if (targetPosition.type === "road" && !destination.includes("@")) {
    targetPosition = {
      ...targetPosition,
      position: nearestRoadPosition(
        currentPosition,
        targetPosition.roadId,
        topology,
        dgsm
      ),
    };
  }

  const route = buildMovementRouteIgnoringBlocks(
    currentPosition,
    targetPosition,
    topology,
    dgsm
  );
  if (!route) return { ok: false, reason: "no_path" };

  return {
    ok: true,
    steps: route.steps,
    totalMinutes: route.totalMinutes,
    targetPosition,
  };
}

export const movementSubsystem: ActionSubsystem = {
  id: SUBSYSTEM_ID,
  kind: "action",
  description: "Step-by-step movement along a planned route via topology.",
  effectSummary:
    "Advances character position along a precomputed route, one topology hop per several ticks.",
  affectedKinds: ["character.position"],
  priority: 250,

  onActivate(step: ActionStep, ctx: FeatureReadContext): SubsystemStepResult {
    const dgsm = getActionSubsystemDgsm(ctx);
    // FeatureReadContext intentionally hides DGSM from features. Movement is
    // an action subsystem (not a feature) and needs full read+write
    // access for pathfinding (which calls into the topology + scene maps the
    // ctx doesn't expose). The orchestrator threads a DGSM-bearing context
    // through `makeActionSubsystemContext` (see tickOrchestrator wiring).
    if (!dgsm) {
      return failure(
        "movement subsystem requires a DGSM-bearing context; orchestrator must call makeActionSubsystemContext"
      );
    }

    const destination = readDestination(step);
    const planned = planMovementRoute(dgsm, step.characterId, destination);
    if (!planned.ok) {
      if (planned.reason === "no_current_position") {
        return failure("no current position");
      }
      // Feedback matters as much as the failure: without a memory the
      // character never learns the move went nowhere and re-issues it.
      return failure(
        planned.reason === "missing_destination"
          ? "missing destination"
          : "no path",
        noPathMemory(
          step.characterId,
          planned.reason === "missing_destination" ? undefined : destination
        )
      );
    }

    if (planned.steps.length === 0) {
      // Already at destination — nothing to do.
      return { stateChanges: [], completed: true };
    }

    const currentPosition = dgsm.getCharacterPosition(step.characterId);
    routes.set(step.id, {
      routeSnapshot: planned.steps,
      currentStepIndex: 0,
      minutesIntoStep: 0,
      lastReachablePosition: currentPosition ?? planned.steps[0].from,
      targetPosition: planned.targetPosition,
    });
    return { stateChanges: [], completed: false };
  },

  onTick(step: ActionStep, ctx: FeatureReadContext): SubsystemStepResult {
    const dgsm = getActionSubsystemDgsm(ctx);
    if (!dgsm) {
      return failure("movement subsystem requires a DGSM-bearing context");
    }

    const route = routes.get(step.id);
    if (!route) {
      // No state — either onActivate failed or this is a stale tick after
      // completion. Treat as completed so the orchestrator clears the step.
      return { stateChanges: [], completed: true };
    }

    const stateChanges: StateChange[] = [];

    // Advance through any immediate (zero-duration) transitions queued at
    // the current index. Mirrors processImmediateMovementTransitions.
    let blocked = processImmediate(step, route, dgsm, stateChanges);
    if (blocked) {
      routes.delete(step.id);
      return { stateChanges, completed: false, failed: { reason: blocked } };
    }

    let stepEntry = route.routeSnapshot[route.currentStepIndex];
    if (!stepEntry) {
      // We've consumed the last step via immediate transitions — done.
      routes.delete(step.id);
      return { stateChanges, completed: true };
    }

    // Block check at the start of the step (mirrors advanceMovementNodeOneMinute
    // line 400-447).
    if (route.minutesIntoStep === 0 && stepEntry.blockCheck) {
      const reason = dgsm.getConnectionBlockReason(
        stepEntry.blockCheck.fromId,
        stepEntry.blockCheck.toId
      );
      if (reason) {
        routes.delete(step.id);
        return {
          stateChanges,
          completed: false,
          failed: { reason: `blocked: ${reason}` },
        };
      }
    }

    const duration = Math.max(1, stepEntry.durationMinutes);
    route.minutesIntoStep += 1;
    const progress = Math.min(route.minutesIntoStep / duration, 1);
    const nextPosition = interpolateMovementPosition(
      stepEntry.from,
      stepEntry.to,
      progress
    );
    route.lastReachablePosition = nextPosition;
    stateChanges.push({
      kind: "character.position",
      characterId: step.characterId,
      position: nextPosition,
      sourceSubsystem: SUBSYSTEM_ID,
    });

    if (progress >= 1) {
      route.currentStepIndex += 1;
      route.minutesIntoStep = 0;
      route.lastReachablePosition = stepEntry.to;
      // Drain any immediate (zero-duration) transitions chained after the
      // one we just finished.
      blocked = processImmediate(step, route, dgsm, stateChanges);
      if (blocked) {
        routes.delete(step.id);
        return { stateChanges, completed: false, failed: { reason: blocked } };
      }
      stepEntry = route.routeSnapshot[route.currentStepIndex];
      if (!stepEntry) {
        routes.delete(step.id);
        return { stateChanges, completed: true };
      }
    }

    return { stateChanges, completed: false };
  },

  onInterrupt(step: ActionStep): { stateChanges: StateChange[] } {
    routes.delete(step.id);
    return { stateChanges: [] };
  },
};

function readDestination(step: ActionStep): string | undefined {
  const fields = step.overlayFields;
  if (!fields) return undefined;
  const dest = fields.destination;
  return typeof dest === "string" && dest.length > 0 ? dest : undefined;
}

function failure(
  reason: string,
  stateChanges: StateChange[] = []
): SubsystemStepResult {
  return { stateChanges, completed: false, failed: { reason } };
}

/** memory.event feedback for an unroutable (or unstated) destination —
 *  without it the agent never learns the move failed (its next perception
 *  still shows the old scene) and re-issues the same departure every tick.
 *  The wording nudges the character toward re-deciding: name a different,
 *  real place, or check the map first. */
function noPathMemory(
  characterId: string,
  destination: string | undefined
): StateChange[] {
  const content = destination
    ? `I tried to head for "${destination}" but couldn't work out a way to get there from here. That may not be an actual place I can walk to — I should pick a real destination, or check the map first.`
    : "I meant to set off but never settled on where to go. I should decide on an actual destination first.";
  return [
    {
      kind: "memory.event",
      characterId,
      content,
    } as StateChange,
  ];
}

/**
 * Interpolate a position along a single MovementStep. Copied from
 * `runtime/movementTick.ts:100-114`. Only road-internal interpolation is
 * meaningful; for cross-type segments we snap on completion (progress >= 1).
 */
function interpolateMovementPosition(
  from: CharacterPosition,
  to: CharacterPosition,
  progress: number
): CharacterPosition {
  if (from.type === "road" && to.type === "road" && from.roadId === to.roadId) {
    return {
      type: "road",
      roadId: from.roadId,
      position: from.position + (to.position - from.position) * progress,
    };
  }
  return progress >= 1 ? to : from;
}

/**
 * Drain any zero-duration steps queued at the current index, emitting a
 * `character.position` change per drained step. Returns a non-empty string
 * if a blocked connection halts the drain; the route state is left pointing
 * at the blocked step so the caller can fail cleanly.
 */
function processImmediate(
  step: ActionStep,
  route: MovementRouteState,
  dgsm: DynamicGameStateManager,
  stateChanges: StateChange[]
): string | undefined {
  while (true) {
    const entry = route.routeSnapshot[route.currentStepIndex];
    if (!entry || entry.durationMinutes > 0) return undefined;

    if (entry.blockCheck) {
      const reason = dgsm.getConnectionBlockReason(
        entry.blockCheck.fromId,
        entry.blockCheck.toId
      );
      if (reason) return `blocked: ${reason}`;
    }

    stateChanges.push({
      kind: "character.position",
      characterId: step.characterId,
      position: entry.to,
      sourceSubsystem: SUBSYSTEM_ID,
    });
    route.currentStepIndex += 1;
    route.minutesIntoStep = 0;
    route.lastReachablePosition = entry.to;
  }
}
