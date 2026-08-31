// src/engine/tools/pathfindingTool.ts
//
// Route planning for the unified Engine. Thin wrapper over the movement
// subsystem's `planMovementRoute` — the exact mechanics execution runs on —
// so the Engine's reachability/route answers can never drift from what the
// mover would actually do (plan Phase 5: reuse, never copy).

import type { CharacterPosition } from "../../state/topologyTypes.js";
import type { MovementStep } from "../core/types.js";
import { planMovementRoute } from "../subsystem/movement.js";
import type { CodeToolContext, EngineCodeTool } from "./codeTool.js";

export interface PathfindingInput {
  characterId: string;
  /** Destination id: scene, junction, road ("ROAD_1" or "ROAD_1@0.3"),
   *  or scenario-outline id. */
  destinationId: string;
}

export type PathfindingOutput =
  | {
      reachable: true;
      totalMinutes: number;
      targetPosition: CharacterPosition;
      steps: Array<{
        kind: MovementStep["kind"];
        durationMinutes: number;
        roadId?: string;
      }>;
      alreadyThere: boolean;
    }
  | {
      reachable: false;
      reason: string;
    };

export const pathfindingTool: EngineCodeTool<
  PathfindingInput,
  PathfindingOutput
> = {
  name: "pathfinding",
  description:
    "Plan the route from a character's current position to a destination id; returns reachability, leg summary and total minutes.",
  execute(input: PathfindingInput, ctx: CodeToolContext): PathfindingOutput {
    const planned = planMovementRoute(
      ctx.dgsm,
      input.characterId,
      input.destinationId
    );
    if (!planned.ok) {
      return { reachable: false, reason: planned.reason };
    }
    return {
      reachable: true,
      totalMinutes: planned.totalMinutes,
      targetPosition: planned.targetPosition,
      steps: planned.steps.map((s) => ({
        kind: s.kind,
        durationMinutes: s.durationMinutes,
        ...(s.roadId !== undefined ? { roadId: s.roadId } : {}),
      })),
      alreadyThere: planned.steps.length === 0,
    };
  },
};
