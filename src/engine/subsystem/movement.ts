// src/engine/subsystem/movement.ts
//
// Movement route planning + interpolation. The legacy per-ActionStep
// movement subsystem was removed with the tool-driven action engine cutover
// (plan Phase 11); per-tick execution now lives in
// `src/engine/actions/movementRuntime.ts`, which reuses these mechanics.

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterPosition } from "../../state/topologyTypes.js";
import type { MovementStep } from "../core/types.js";
import {
  buildMovementRouteIgnoringBlocks,
  nearestRoadPosition,
  resolveTargetPosition,
} from "../shared/pathfinding.js";

/** Result of planning a route without executing it. Shared by the
 *  Engine's pathfinding/movement-cost code tools and the movementRuntime
 *  executor (plan Phase 5: one set of mechanics, no copies). */
export type PlannedRoute =
  | {
      ok: true;
      steps: MovementStep[];
      totalMinutes: number;
      targetPosition: CharacterPosition;
    }
  | { ok: false; reason: string };

/**
 * Resolve a destination id and plan the movement route from `currentPosition`,
 * applying the standard policies: same-building shortcut,
 * road-end snapping for bare road destinations, block-ignoring route build
 * (blocks are enforced during execution, step by step).
 */
export function planMovementRoute(
  dgsm: DynamicGameStateManager,
  characterId: string,
  destination: string | undefined,
  fromPosition?: CharacterPosition
): PlannedRoute {
  if (!destination) return { ok: false, reason: "missing_destination" };

  const currentPosition =
    fromPosition ?? dgsm.getCharacterPosition(characterId);
  if (!currentPosition) return { ok: false, reason: "no_current_position" };

  // Same-building shortcut: scene → scene within the same parent location.
  const state = dgsm.getState();
  if (currentPosition.type === "scene") {
    const currentScene = state.scenes.get(currentPosition.sceneId);
    const targetScene = state.scenes.get(destination);
    if (
      currentScene?.parentLocationId &&
      targetScene &&
      currentScene.parentLocationId === targetScene.parentLocationId &&
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

/**
 * Interpolate a position along a single MovementStep. Copied from
 * `runtime/movementTick.ts:100-114`. Only road-internal interpolation is
 * meaningful; for cross-type segments we snap on completion (progress >= 1).
 * Exported for the EngineAction movement runtime (plan Phase 8) so both
 * executors share one interpolation.
 */
export function interpolateMovementPosition(
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
