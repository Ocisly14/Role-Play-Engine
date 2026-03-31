#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { NPCPlanningAgent } from "../src/planning/NPCPlanningAgent.js";
import type { FailureTrigger, PlanNode } from "../src/planning/types.js";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../src/state/DynamicGameState.js";
import type { DynamicNPCProfile } from "../src/state/types.js";

function logSection(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function logPass(message: string): void {
  console.log(`PASS ${message}`);
}

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
    longTermIntent: "Keep going",
    relationships: [],
  };
}

function makeNode(
  npcId: string,
  status: PlanNode["status"],
  overrides: Partial<PlanNode> = {}
): PlanNode {
  return {
    nodeId: `${npcId}-${status}-${overrides.startTime ?? "08:00"}`,
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
  const unexpectedCall = (label: string) => {
    throw new Error(
      `Unexpected Prisma call while testing dead-NPC guard: ${label}`
    );
  };

  return {
    npcDailyPlan: {
      findUnique: async () => unexpectedCall("npcDailyPlan.findUnique"),
      findFirst: async () => unexpectedCall("npcDailyPlan.findFirst"),
      findMany: async () => unexpectedCall("npcDailyPlan.findMany"),
      update: async () => unexpectedCall("npcDailyPlan.update"),
      upsert: async () => unexpectedCall("npcDailyPlan.upsert"),
    },
    npcLongTermIntent: {
      findFirst: async () => unexpectedCall("npcLongTermIntent.findFirst"),
      upsert: async () => unexpectedCall("npcLongTermIntent.upsert"),
      updateMany: async () => unexpectedCall("npcLongTermIntent.updateMany"),
    },
  };
}

type PlanRecord = {
  sessionId: string;
  npcId: string;
  gameDay: number;
  moduleId?: string;
  schedule?: unknown[];
  nodes: PlanNode[];
};

function createInMemoryPrisma(seedPlans: PlanRecord[]) {
  const plans = new Map<string, PlanRecord>();
  const keyOf = (sessionId: string, npcId: string, gameDay: number) =>
    `${sessionId}:${npcId}:${gameDay}`;

  for (const plan of seedPlans) {
    plans.set(keyOf(plan.sessionId, plan.npcId, plan.gameDay), {
      ...plan,
      schedule: plan.schedule ?? [],
      nodes: [...plan.nodes],
    });
  }

  return {
    npcDailyPlan: {
      findUnique: async ({
        where,
      }: {
        where: {
          sessionId_npcId_gameDay: {
            sessionId: string;
            npcId: string;
            gameDay: number;
          };
        };
      }) => {
        const { sessionId, npcId, gameDay } = where.sessionId_npcId_gameDay;
        return plans.get(keyOf(sessionId, npcId, gameDay)) ?? null;
      },
      findFirst: async ({
        where,
        select,
      }: {
        where?: { sessionId?: string };
        select?: { moduleId?: boolean };
      }) => {
        const first = [...plans.values()].find((plan) =>
          where?.sessionId ? plan.sessionId === where.sessionId : true
        );
        if (!first) return null;
        if (select?.moduleId) return { moduleId: first.moduleId ?? "module" };
        return first;
      },
      findMany: async ({
        where,
      }: {
        where?: { sessionId?: string; gameDay?: number };
      }) =>
        [...plans.values()].filter((plan) => {
          if (where?.sessionId && plan.sessionId !== where.sessionId)
            return false;
          if (where?.gameDay && plan.gameDay !== where.gameDay) return false;
          return true;
        }),
      update: async ({
        where,
        data,
      }: {
        where: {
          sessionId_npcId_gameDay: {
            sessionId: string;
            npcId: string;
            gameDay: number;
          };
        };
        data: { nodes?: PlanNode[]; schedule?: unknown[] };
      }) => {
        const { sessionId, npcId, gameDay } = where.sessionId_npcId_gameDay;
        const key = keyOf(sessionId, npcId, gameDay);
        const existing = plans.get(key);
        if (!existing) throw new Error(`Plan not found for ${key}`);
        const next = {
          ...existing,
          nodes: data.nodes ? [...data.nodes] : existing.nodes,
          schedule: data.schedule ? [...data.schedule] : existing.schedule,
        };
        plans.set(key, next);
        return next;
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: {
          sessionId_npcId_gameDay: {
            sessionId: string;
            npcId: string;
            gameDay: number;
          };
        };
        create: PlanRecord;
        update: { nodes?: PlanNode[]; schedule?: unknown[] };
      }) => {
        const { sessionId, npcId, gameDay } = where.sessionId_npcId_gameDay;
        const key = keyOf(sessionId, npcId, gameDay);
        const existing = plans.get(key);
        const next = existing
          ? {
              ...existing,
              nodes: update.nodes ? [...update.nodes] : existing.nodes,
              schedule: update.schedule
                ? [...update.schedule]
                : existing.schedule,
            }
          : {
              ...create,
              schedule: create.schedule ?? [],
              nodes: [...create.nodes],
            };
        plans.set(key, next);
        return next;
      },
    },
    npcLongTermIntent: {
      findFirst: async () => null,
      upsert: async () => null,
      updateMany: async () => ({ count: 0 }),
    },
  };
}

async function testSimulatedSet(): Promise<void> {
  logSection("Simulated NPC Filter");
  const dgsm = createDgsm();
  assert.deepEqual(
    dgsm.getSimulatedNpcs().map((npc) => npc.id),
    ["alive"]
  );
  logPass("dead NPCs are excluded from simulated NPC ids");
}

async function testPlanningGuards(): Promise<void> {
  logSection("Planning Entry Guards");
  const dgsm = createDgsm();
  const prisma = createThrowingPrisma();
  const agent = new NPCPlanningAgent(prisma as any, {});
  const trigger: FailureTrigger = {
    type: "failure",
    failureReason: "target_absent",
    action: "look for someone",
    gameTime: "08:00",
  };

  await agent.generateSingleNpcSchedule(
    dgsm,
    "session",
    "module",
    "dead",
    1,
    "en"
  );
  assert.deepEqual(
    await agent.generateDetailedNodes(dgsm, "session", "dead", 1, "en"),
    []
  );
  await agent.ensureNpcNodesAvailable(
    dgsm,
    "session",
    "dead",
    1,
    "08:00",
    "en"
  );
  await agent.reviseSchedule(dgsm, "session", "dead", "manual update", "en");
  assert.deepEqual(
    await agent.revisePlans(
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
    ),
    {}
  );
  logPass("dead NPC planning entry points short-circuit before Prisma");
}

async function testQueryFiltersAndInterruption(): Promise<void> {
  logSection("Plan Query And Interruption");
  const dgsm = createDgsm();
  const prisma = createInMemoryPrisma([
    {
      sessionId: "session",
      npcId: "alive",
      gameDay: 1,
      moduleId: "module",
      nodes: [
        makeNode("alive", "pending", {
          startTime: "08:00",
          action: "alive-pending-action",
        }),
        makeNode("alive", "in_progress", {
          startTime: "08:01",
          action: "alive-current-action",
        }),
      ],
    },
    {
      sessionId: "session",
      npcId: "dead",
      gameDay: 1,
      moduleId: "module",
      nodes: [
        makeNode("dead", "pending", {
          startTime: "08:00",
          action: "dead-pending-action",
        }),
        makeNode("dead", "in_progress", {
          startTime: "08:01",
          action: "dead-current-action",
        }),
        makeNode("dead", "completed", {
          startTime: "07:30",
          endTime: "07:35",
          action: "dead-completed-action",
        }),
      ],
    },
  ]);
  const agent = new NPCPlanningAgent(prisma as any, {});

  const due = await agent.getDueNpcNodes("session", 1, "08:00", dgsm);
  assert.deepEqual(
    due.map((node) => node.characterId),
    ["alive"]
  );
  logPass("dead NPC pending nodes are excluded from due-node selection");

  const inProgress = await agent.getInProgressNodes("session", 1, dgsm);
  assert.deepEqual(
    inProgress.map((node) => node.characterId),
    ["alive"]
  );
  logPass("dead NPC in-progress nodes are excluded from active execution");

  const currentActionsBefore = await agent.getCurrentNpcActions(
    "session",
    1,
    "08:02",
    dgsm
  );
  assert.equal(currentActionsBefore.alive, "alive-current-action");
  assert.equal(currentActionsBefore.dead, null);
  logPass("dead NPC currentAction resolves to null");

  await agent.interruptOpenNodesForDeath("session", "dead", 1, "08:30");
  const deadPlan = await (prisma as any).npcDailyPlan.findUnique({
    where: {
      sessionId_npcId_gameDay: {
        sessionId: "session",
        npcId: "dead",
        gameDay: 1,
      },
    },
  });
  assert.ok(deadPlan);
  const deadNodes = deadPlan.nodes as PlanNode[];
  const deadPending = deadNodes.find(
    (node) => node.action === "dead-pending-action"
  );
  const deadCurrent = deadNodes.find(
    (node) => node.action === "dead-current-action"
  );
  const deadCompleted = deadNodes.find(
    (node) => node.action === "dead-completed-action"
  );

  assert.equal(deadPending?.status, "interrupted");
  assert.equal(deadCurrent?.status, "interrupted");
  assert.equal(deadCompleted?.status, "completed");
  assert.equal(deadPending?.executionMeta.interruptionReason, "character_dead");
  assert.equal(deadCurrent?.executionMeta.interruptionReason, "character_dead");
  assert.equal(deadPending?.executionMeta.remainingMinutes, 0);
  assert.equal(deadCurrent?.executionMeta.remainingMinutes, 0);
  logPass("dead NPC open nodes are interrupted and no longer executable");
}

async function main(): Promise<void> {
  console.log("Testing dead-NPC simulation guards...");

  await testSimulatedSet();
  await testPlanningGuards();
  await testQueryFiltersAndInterruption();

  console.log("\nAll dead-NPC simulation guard checks passed.");
}

main().catch((error) => {
  console.error(
    "\nDead-NPC simulation guard script failed:",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
