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
    if (!destination) {
      return failure("missing destination");
    }

    const currentPosition = dgsm.getCharacterPosition(step.characterId);
    if (!currentPosition) {
      return failure("no current position");
    }

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
        // Single 1-minute step inside the building; the durationMinutes
        // chosen here matches the legacy initializeMovementNode default
        // (Math.max(1, remainingMinutes)). We don't have remainingMinutes
        // at this layer, so we use 1 minute — consistent with the existing
        // "to_scene" step duration in pathfinding.
        const route: MovementStep[] = [
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
        ];
        routes.set(step.id, {
          routeSnapshot: route,
          currentStepIndex: 0,
          minutesIntoStep: 0,
          lastReachablePosition: currentPosition,
          targetPosition: targetPos,
        });
        return { stateChanges: [], completed: false };
      }
    }

    const topology = dgsm.getTopology();
    const targetPosition = resolveTargetPosition(destination, topology, dgsm);
    if (!targetPosition) {
      return failure("no path");
    }

    const route = buildMovementRouteIgnoringBlocks(
      currentPosition,
      targetPosition,
      topology,
      dgsm
    );
    if (!route) {
      return failure("no path");
    }

    if (route.steps.length === 0) {
      // Already at destination — nothing to do.
      return { stateChanges: [], completed: true };
    }

    routes.set(step.id, {
      routeSnapshot: route.steps,
      currentStepIndex: 0,
      minutesIntoStep: 0,
      lastReachablePosition: currentPosition,
      targetPosition,
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

function failure(reason: string): SubsystemStepResult {
  return { stateChanges: [], completed: false, failed: { reason } };
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
