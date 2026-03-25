import { describe, expect, it } from "vitest";
import { NPCPlanningAgent } from "../NPCPlanningAgent.js";
import type { PlanNode } from "../types.js";

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: "node-1",
    characterId: "npc-1",
    characterName: "NPC",
    startTime: "09:00",
    endTime: "09:10",
    action: "Walk somewhere",
    location: "loc-1",
    type: "movement",
    impact: 0,
    status: "pending",
    executionMeta: { remainingMinutes: 10 },
    ...overrides,
  } as PlanNode;
}

describe("NPCPlanningAgent.shiftPendingNodesByDelta", () => {
  it("left-shifts later pending nodes without touching completed history", async () => {
    const planRecord = {
      nodes: [
        makeNode({
          nodeId: "done",
          status: "completed",
          startTime: "08:00",
          endTime: "08:30",
          type: "routine",
          action: "Breakfast",
        }),
        makeNode({
          nodeId: "move",
          status: "completed",
          startTime: "09:00",
          endTime: "09:10",
        }),
        makeNode({
          nodeId: "eat",
          type: "routine",
          action: "Eat",
          startTime: "09:10",
          endTime: "09:30",
        }),
        makeNode({
          nodeId: "work",
          type: "routine",
          action: "Work",
          startTime: "09:30",
          endTime: "10:00",
        }),
      ],
    };

    let updatedNodes: PlanNode[] | undefined;
    const prisma = {
      npcDailyPlan: {
        findUnique: async () => planRecord,
        update: async ({ data }: { data: { nodes: PlanNode[] } }) => {
          updatedNodes = data.nodes;
          return {};
        },
      },
    };

    const agent = new NPCPlanningAgent(prisma as any, {} as any);
    await agent.shiftPendingNodesByDelta("session", "npc-1", 1, "09:10", 2);

    expect(
      updatedNodes?.map((node) => [node.nodeId, node.startTime, node.endTime])
    ).toEqual([
      ["done", "08:00", "08:30"],
      ["move", "09:00", "09:10"],
      ["eat", "09:08", "09:28"],
      ["work", "09:28", "09:58"],
    ]);
  });

  it("right-shifts later pending nodes when movement finishes late", async () => {
    const planRecord = {
      nodes: [
        makeNode({
          nodeId: "move",
          status: "completed",
          startTime: "09:00",
          endTime: "09:10",
        }),
        makeNode({
          nodeId: "eat",
          type: "routine",
          action: "Eat",
          startTime: "09:10",
          endTime: "09:30",
        }),
        makeNode({
          nodeId: "work",
          type: "routine",
          action: "Work",
          startTime: "09:30",
          endTime: "10:00",
        }),
      ],
    };

    let updatedNodes: PlanNode[] | undefined;
    const prisma = {
      npcDailyPlan: {
        findUnique: async () => planRecord,
        update: async ({ data }: { data: { nodes: PlanNode[] } }) => {
          updatedNodes = data.nodes;
          return {};
        },
      },
    };

    const agent = new NPCPlanningAgent(prisma as any, {} as any);
    await agent.shiftPendingNodesByDelta("session", "npc-1", 1, "09:10", -3);

    expect(
      updatedNodes?.map((node) => [node.nodeId, node.startTime, node.endTime])
    ).toEqual([
      ["move", "09:00", "09:10"],
      ["eat", "09:13", "09:33"],
      ["work", "09:33", "10:03"],
    ]);
  });
});
