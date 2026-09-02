// A road position without its fraction cannot be planned from. It used to
// produce NaN minutes that reached the clock and threw the tick away (tick
// 67 of a measured run); now it fails the action back to the actor.

import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { CharacterPosition } from "../../../state/topologyTypes.js";
import { planMovementRoute } from "../movement.js";

describe("planMovementRoute", () => {
  it("refuses a road position with no fraction before touching the world", () => {
    const broken = {
      type: "road",
      roadId: "ROAD_main_street",
    } as unknown as CharacterPosition;
    const untouched = {} as DynamicGameStateManager;
    expect(
      planMovementRoute(untouched, "npc_1", "SCN_main_south", broken)
    ).toEqual({ ok: false, reason: "no_road_position" });
  });
});
