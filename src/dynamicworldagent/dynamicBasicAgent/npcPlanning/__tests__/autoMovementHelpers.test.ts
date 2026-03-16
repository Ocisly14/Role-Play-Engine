import { describe, expect, it } from "vitest";
import { buildAutoMovementReplacement } from "../autoMovementHelpers.js";
import type { PlanNode } from "../types.js";

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: "action-1",
    characterId: "npc-1",
    characterName: "NPC",
    startTime: "08:05",
    endTime: "08:10",
    action: "Invite Lisa for coffee",
    location: "town_square",
    type: "character_interaction",
    impact: 1,
    status: "pending",
    targetCharacterId: "npc-2",
    executionMeta: { remainingMinutes: 0 },
    ...overrides,
  } as PlanNode;
}

describe("buildAutoMovementReplacement", () => {
  it("creates a movement node before resuming the original action", () => {
    const { movementNode, resumedNode } = buildAutoMovementReplacement(
      makeNode(),
      {
        currentTime: "08:05",
        fromLocation: "victor_office",
        travelMinutes: 4,
      }
    );

    expect(movementNode.type).toBe("movement");
    expect(movementNode.startTime).toBe("08:05");
    expect(movementNode.endTime).toBe("08:09");
    expect(movementNode.location).toBe("town_square");

    expect(resumedNode.nodeId).toBe("action-1");
    expect(resumedNode.status).toBe("pending");
    expect(resumedNode.executionMeta.remainingMinutes).toBe(5);
  });
});
