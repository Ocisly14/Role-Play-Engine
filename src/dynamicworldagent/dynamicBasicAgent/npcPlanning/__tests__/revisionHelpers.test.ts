import { describe, expect, it } from "vitest";
import {
  buildInterruptedMovementAction,
  mergeRevisedNodesWithHistory,
} from "../revisionHelpers.js";
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
  it("interrupts in-progress movement while preserving history and revised pending nodes", () => {
    const completedNode = makeNode({
      nodeId: "done",
      status: "completed",
      action: "Finished breakfast",
      type: "routine",
    });
    const inProgressMovement = makeNode({
      nodeId: "move",
      status: "in_progress",
      executionMeta: {
        remainingMinutes: 3,
        movement: {
          routeSnapshot: [],
          currentStepIndex: 0,
          minutesIntoStep: 1,
          lastReachablePosition: { type: "road", roadId: "ROAD_1", position: 0.2 },
          targetPosition: { type: "scene", sceneId: "harbor" },
        },
      },
    });
    const pendingNode = makeNode({
      nodeId: "old-pending",
      action: "Old future plan",
    });
    const revisedNode = makeNode({
      nodeId: "new-pending",
      action: "New revised plan",
    });

    const result = mergeRevisedNodesWithHistory(
      [completedNode, inProgressMovement, pendingNode],
      [revisedNode],
      "10:02"
    );

    expect(result.nextNodes.map((node) => node.nodeId)).toEqual([
      "done",
      "move",
      "new-pending",
    ]);
    expect(result.interruptedNode?.status).toBe("interrupted");
    expect(result.interruptedNode?.executionMeta.interruptedAt).toBe("10:02");
  });

  it("builds an interrupted action for logging and UI", () => {
    const action = buildInterruptedMovementAction(
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
});
