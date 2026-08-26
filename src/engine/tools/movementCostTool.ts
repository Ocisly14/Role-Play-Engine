// src/engine/tools/movementCostTool.ts
//
// Travel-time estimate for the unified Engine, e.g. when judging an `act`'s
// authoritative resolvedDurationTicks for a move or a composite action with a
// movement leg. Same mechanics as execution (planMovementRoute); one tick is
// one in-world minute, so ticks == ceil(minutes).

import { planMovementRoute } from "../subsystem/movement.js";
import type { CodeToolContext, EngineCodeTool } from "./codeTool.js";

export interface MovementCostInput {
  characterId: string;
  destinationId: string;
}

export type MovementCostOutput =
  | { reachable: true; totalMinutes: number; totalTicks: number }
  | {
      reachable: false;
      reason: "missing_destination" | "no_current_position" | "no_path";
    };

export const movementCostTool: EngineCodeTool<
  MovementCostInput,
  MovementCostOutput
> = {
  name: "movementCost",
  description:
    "Estimate travel time (minutes/ticks) from a character's current position to a destination id.",
  execute(input: MovementCostInput, ctx: CodeToolContext): MovementCostOutput {
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
      totalTicks: Math.ceil(planned.totalMinutes),
    };
  },
};
