import { describe, expect, it } from "vitest";
import { buildInterruptedAction } from "../revisionHelpers.js";
import type { PlanNode } from "../types.js";

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: "node-1",
    characterId: "npc-1",
    characterName: "NPC",
    startTime: "10:00",
    endTime: "10:05",
    action: "Walk to the harbor",
    location: "harbor",
    type: "movement",
    impact: 0,
    status: "pending",
    executionMeta: { remainingMinutes: 5 },
    ...overrides,
  } as PlanNode;
}

describe("revisionHelpers", () => {
  it("builds an interrupted action for logging and UI", () => {
    const action = buildInterruptedAction(
      makeNode({
        status: "interrupted",
      }),
      "10:02",
      "ROAD_1"
    );

    expect(action.status).toBe("interrupted");
    expect(action.interruptionReason).toBe("revise_replan");
    expect(action.location).toBe("ROAD_1");
  });

  it("produces Chinese outcome when language is zh", () => {
    const action = buildInterruptedAction(
      makeNode({ status: "interrupted", action: "走到港口" }),
      "10:02",
      "SCN_HARBOR",
      "zh"
    );

    expect(action.outcome).toContain("因重新规划而中断");
    expect(action.outcome).toContain("走到港口");
    expect(action.outcome).toContain("SCN_HARBOR");
  });
});
