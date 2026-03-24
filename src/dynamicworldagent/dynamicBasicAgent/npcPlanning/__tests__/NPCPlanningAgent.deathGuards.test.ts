import { describe, expect, it, vi } from "vitest";
import { NPCPlanningAgent } from "../NPCPlanningAgent.js";
import type {
  FailureTrigger,
  PlanNode,
} from "../types.js";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../../../state/DynamicGameState.js";
import type { DynamicNPCProfile } from "../../../state/types.js";

function makeNpc(id: string, hp: number): DynamicNPCProfile {
  return {
    id,
    name: id,
    attributes: {
      STR: 50,
      CON: 50,
      DEX: 50,
      APP: 50,
      POW: 50,
      SIZ: 50,
      INT: 50,
      EDU: 50,
    },
    status: {
      hp,
      maxHp: 10,
      sanity: 50,
      maxSanity: 50,
      luck: 50,
      conditions: [],
    },
    inventory: [],
    skills: {},
    longTermIntent: "Keep moving",
    relationships: [],
  };
}

function makeNode(
  npcId: string,
  status: PlanNode["status"],
  overrides: Partial<PlanNode> = {}
): PlanNode {
  return {
    nodeId: `${npcId}-${status}`,
    characterId: npcId,
    characterName: npcId,
    startTime: "08:00",
    endTime: "08:05",
    action: `${npcId}-${status}-action`,
    location: "SCENE_1",
    type: "routine",
    impact: 1,
    status,
    executionMeta: { remainingMinutes: 5 },
    ...overrides,
  };
}

function createDgsm(): DynamicGameStateManager {
  const state = initialDynamicGameState({
    sessionId: "session",
    moduleName: "module",
    gameDay: 1,
    timeOfDay: "08:00",
  });
  state.npcCharacters = [makeNpc("alive", 10), makeNpc("dead", 0)];
  state.npcStats = {
    alive: { hp: 10, san: 50 },
    dead: { hp: 0, san: 50 },
  };
  state.characterPositions = {
    alive: { type: "scene", sceneId: "SCENE_1" },
    dead: { type: "scene", sceneId: "SCENE_1" },
  };
  state.npcInjectionPolicy = {
    mode: "manual",
    tiers: {
      daily_sim: ["alive", "dead"],
      investigator_sim: [],
      background: [],
    },
  } as any;
  return new DynamicGameStateManager(state);
}

function createThrowingPrisma() {
  const shouldNotRun = vi.fn(() => {
    throw new Error("Prisma should not be called for dead NPC planning guards");
  });

  return {
    npcDailyPlan: {
      findUnique: shouldNotRun,
      findFirst: shouldNotRun,
      findMany: shouldNotRun,
      update: shouldNotRun,
      upsert: shouldNotRun,
    },
    npcLongTermIntent: {
      findFirst: shouldNotRun,
      upsert: shouldNotRun,
      updateMany: shouldNotRun,
    },
  } as any;
}

describe("NPCPlanningAgent death guards", () => {
  it("short-circuits planning entry points for dead NPCs", async () => {
    const dgsm = createDgsm();
    const prisma = createThrowingPrisma();
    const agent = new NPCPlanningAgent(prisma, {});
    const trigger: FailureTrigger = {
      type: "failure",
      failureReason: "target_absent",
      action: "look for someone",
      gameTime: "08:00",
    };

    await expect(
      agent.generateSingleNpcSchedule(
        dgsm,
        "session",
        "module",
        "dead",
        1,
        "en"
      )
    ).resolves.toBeUndefined();
    await expect(
      agent.generateDetailedNodes(dgsm, "session", "dead", 1, "en")
    ).resolves.toEqual([]);
    await expect(
      agent.ensureNpcNodesAvailable(
        dgsm,
        "session",
        "dead",
        1,
        "08:00",
        "en"
      )
    ).resolves.toBeUndefined();
    await expect(
      agent.reviseSchedule(dgsm, "session", "dead", "manual update", "en")
    ).resolves.toBeUndefined();
    await expect(
      agent.revisePlans(
        dgsm,
        "session",
        "dead",
        {
          longTermIntent: "",
          memoryLog: [],
          pendingNodes: [],
          trigger,
        },
        "en"
      )
    ).resolves.toEqual({});

    expect(prisma.npcDailyPlan.findUnique).not.toHaveBeenCalled();
    expect(prisma.npcDailyPlan.findFirst).not.toHaveBeenCalled();
    expect(prisma.npcDailyPlan.findMany).not.toHaveBeenCalled();
    expect(prisma.npcLongTermIntent.findFirst).not.toHaveBeenCalled();
  });

  it("filters dead NPCs out of due, in-progress, and current-action queries", async () => {
    const alivePending = makeNode("alive", "pending", { startTime: "08:00" });
    const aliveInProgress = makeNode("alive", "in_progress", {
      startTime: "08:01",
      action: "alive-current-action",
    });
    const deadPending = makeNode("dead", "pending", { startTime: "08:00" });
    const deadInProgress = makeNode("dead", "in_progress", {
      startTime: "08:01",
      action: "dead-current-action",
    });
    const prisma = {
      npcDailyPlan: {
        findMany: vi.fn(async () => [
          { npcId: "alive", nodes: [alivePending, aliveInProgress] },
          { npcId: "dead", nodes: [deadPending, deadInProgress] },
        ]),
      },
    } as any;
    const agent = new NPCPlanningAgent(prisma, {});
    const dgsm = createDgsm();

    await expect(
      agent.getDueNpcNodes("session", 1, "08:00", dgsm)
    ).resolves.toEqual([alivePending]);
    await expect(
      agent.getInProgressNodes("session", 1, dgsm)
    ).resolves.toEqual([aliveInProgress]);
    await expect(
      agent.getCurrentNpcActions("session", 1, "08:02", dgsm)
    ).resolves.toEqual({
      alive: "alive-current-action",
      dead: null,
    });
  });
});
