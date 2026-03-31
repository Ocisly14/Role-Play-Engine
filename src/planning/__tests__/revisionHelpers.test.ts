import { describe, expect, it } from "vitest";
import {
  buildInterruptedAction,
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
      type: "action",
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
          lastReachablePosition: {
            type: "road",
            roadId: "ROAD_1",
            position: 0.2,
          },
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

  it("interrupts in-progress non-movement nodes (e.g. character_interaction)", () => {
    const inProgressInteraction = makeNode({
      nodeId: "talk",
      status: "in_progress",
      type: "character_interaction",
      action: "Talk to the librarian",
      executionMeta: { remainingMinutes: 2 },
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
      [inProgressInteraction, pendingNode],
      [revisedNode],
      "10:03"
    );

    expect(result.nextNodes.map((node) => node.nodeId)).toEqual([
      "talk",
      "new-pending",
    ]);
    expect(result.interruptedNode?.status).toBe("interrupted");
    expect(result.interruptedNode?.executionMeta.remainingMinutes).toBe(0);
    expect(result.interruptedNode?.executionMeta.interruptedAt).toBe("10:03");
  });

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

  it("mergeRevisedNodesWithHistory produces Chinese outcome for zh", () => {
    const inProgressNode = makeNode({
      nodeId: "move",
      status: "in_progress",
      action: "走到图书馆",
      executionMeta: { remainingMinutes: 3 },
    });

    const result = mergeRevisedNodesWithHistory(
      [inProgressNode],
      [],
      "10:05",
      "zh"
    );

    expect(result.interruptedNode?.outcome).toContain("因重新规划而中断");
    expect(result.interruptedNode?.outcome).toContain("走到图书馆");
  });
});
