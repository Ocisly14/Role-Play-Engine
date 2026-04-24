import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterPosition } from "../../state/topologyTypes.js";
import type { FeatureReadContext } from "../core/featureReadContext.js";
import type {
  ActionStep,
  MovementStep,
  StateChange,
} from "../core/types.js";
import {
  buildMovementRouteIgnoringBlocks,
  resolveTargetPosition,
} from "../shared/pathfinding.js";
import { getCodeEngineDgsm } from "./types.js";
import type { CodeEngineStepResult, CodeEngineSubsystem } from "./types.js";

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

/**
 * MovementSubsystem — per-step CodeEngine handler ported from the legacy
 * `runtime/movementTick.ts` Cluster C functions:
 *   - `initializeMovementNode` (lines 140-258) → onActivate
 *   - `advanceMovementNodeOneMinute` (lines 306-584) → onTick
 *   - `interpolateMovementPosition` (lines 100-114) → interpolate (private)
 *   - `processImmediateMovementTransitions` (lines 260-304) → processImmediate
 *
 * The legacy `buildMovementAction` helper (lines 116-138) is dropped — the
 * dual-engine architecture no longer constructs legacy CharacterAction
 * objects from movement progress; the orchestrator handles step lifecycle and
 * the renderer (post-Phase-E) handles per-NPC perception narratives.
 *
 * Inputs from `ActionStep`:
 *   - `characterId` — the moving actor.
 *   - `overlayFields.destination` (string) — the target location ID
 *     (scene/junction/road) populated by the interpreter when matching the
 *     movement definition.
 *
 * Outputs (via `StateChange[]`):
 *   - `character.position` — the new interpolated position each tick.
 *
 * The subsystem keeps its routes keyed by `step.id` so re-activation of the
 * same step (rare but possible during persistence round-trips) can be
 * differentiated from concurrent independent moves.
 */
export class MovementSubsystem implements CodeEngineSubsystem {
  readonly id = "movement";
  private routes = new Map<string, MovementRouteState>();

  onActivate(step: ActionStep, ctx: FeatureReadContext): CodeEngineStepResult {
    const dgsm = getCodeEngineDgsm(ctx);
    // FeatureReadContext intentionally hides DGSM from features. Movement is
    // a code-engine subsystem (not a feature) and needs full read+write
    // access for pathfinding (which calls into the topology + scene maps the
    // ctx doesn't expose). The orchestrator threads a DGSM-bearing context
    // through `makeCodeEngineContext` (see tickOrchestrator wiring).
    if (!dgsm) {
      return failure(
        "movement subsystem requires a DGSM-bearing context; orchestrator must call makeCodeEngineContext"
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
        this.routes.set(step.id, {
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

    this.routes.set(step.id, {
      routeSnapshot: route.steps,
      currentStepIndex: 0,
      minutesIntoStep: 0,
      lastReachablePosition: currentPosition,
      targetPosition,
    });
    return { stateChanges: [], completed: false };
  }

  onTick(step: ActionStep, ctx: FeatureReadContext): CodeEngineStepResult {
    const dgsm = getCodeEngineDgsm(ctx);
    if (!dgsm) {
      return failure(
        "movement subsystem requires a DGSM-bearing context"
      );
    }

    const route = this.routes.get(step.id);
    if (!route) {
      // No state — either onActivate failed or this is a stale tick after
      // completion. Treat as completed so the orchestrator clears the step.
      return { stateChanges: [], completed: true };
    }

    const stateChanges: StateChange[] = [];

    // Advance through any immediate (zero-duration) transitions queued at
    // the current index. Mirrors processImmediateMovementTransitions.
    let blocked = this.processImmediate(step, route, dgsm, stateChanges);
    if (blocked) {
      this.routes.delete(step.id);
      return { stateChanges, completed: false, failed: { reason: blocked } };
    }

    let stepEntry = route.routeSnapshot[route.currentStepIndex];
    if (!stepEntry) {
      // We've consumed the last step via immediate transitions — done.
      this.routes.delete(step.id);
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
        this.routes.delete(step.id);
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
      sourceSubsystem: this.id,
    });

    if (progress >= 1) {
      route.currentStepIndex += 1;
      route.minutesIntoStep = 0;
      route.lastReachablePosition = stepEntry.to;
      // Drain any immediate (zero-duration) transitions chained after the
      // one we just finished.
      blocked = this.processImmediate(step, route, dgsm, stateChanges);
      if (blocked) {
        this.routes.delete(step.id);
        return { stateChanges, completed: false, failed: { reason: blocked } };
      }
      stepEntry = route.routeSnapshot[route.currentStepIndex];
      if (!stepEntry) {
        this.routes.delete(step.id);
        return { stateChanges, completed: true };
      }
    }

    return { stateChanges, completed: false };
  }

  onInterrupt(step: ActionStep): { stateChanges: StateChange[] } {
    this.routes.delete(step.id);
    return { stateChanges: [] };
  }

  /**
   * Drain any zero-duration steps queued at the current index, emitting a
   * `character.position` change per drained step. Returns a non-empty string
   * if a blocked connection halts the drain; the route state is left pointing
   * at the blocked step so the caller can fail cleanly.
   */
  private processImmediate(
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
        sourceSubsystem: this.id,
      });
      route.currentStepIndex += 1;
      route.minutesIntoStep = 0;
      route.lastReachablePosition = entry.to;
    }
  }
}

function readDestination(step: ActionStep): string | undefined {
  const fields = step.overlayFields;
  if (!fields) return undefined;
  const dest = fields.destination;
  return typeof dest === "string" && dest.length > 0 ? dest : undefined;
}

function failure(reason: string): CodeEngineStepResult {
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
