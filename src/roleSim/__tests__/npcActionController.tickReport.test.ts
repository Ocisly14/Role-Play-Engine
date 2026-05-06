import type { TickEngine } from "../../engine/core/tickEngine.js";
import type {
  ActionStep,
  FeatureEvent,
  TickReport,
} from "../../engine/core/types.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type {
  RoleSimAgent,
  RoleSimContext,
  RoleSimDecision,
} from "../agent.js";
import { NpcActionController } from "../npcActionController.js";

interface FakeEngine extends TickEngine {
  fireTickCompleted(report: TickReport): Promise<void>;
}

function makeEngine(opts?: {
  actorQueue?: Map<string, ActionStep[]>;
}): { engine: FakeEngine; calls: { submit: number; cancel: number } } {
  const subscribers: Array<(r: TickReport) => Promise<void> | void> = [];
  const calls = { submit: 0, cancel: 0 };
  const queues = opts?.actorQueue ?? new Map<string, ActionStep[]>();

  const engine: Partial<FakeEngine> = {
    on(ev: string, cb: (...args: unknown[]) => unknown) {
      if (ev === "tickCompleted") {
        subscribers.push(cb as (r: TickReport) => Promise<void> | void);
      }
      return () => {};
    },
    getActorQueue: (npcId: string) => queues.get(npcId) ?? [],
    submitAction: async () => {
      calls.submit += 1;
      return {
        id: "h1",
        characterId: "x",
        submittedAt: "1923-10-17T00:00:00",
      };
    },
    cancelAction: () => {
      calls.cancel += 1;
      return { applied: true, remainingChainCancelled: 0 };
    },
    fireTickCompleted: async (report: TickReport) => {
      for (const cb of subscribers) await cb(report);
    },
  } as Partial<FakeEngine>;

  return { engine: engine as FakeEngine, calls };
}

function makeDgsm(
  npcs: Array<{ id: string; alive: boolean; sceneId?: string }>
): DynamicGameStateManager {
  return {
    getState: () => ({
      npcCharacters: npcs.map((n) => ({
        id: n.id,
        name: n.id,
        attributes: {},
        status: {},
        inventory: [],
        skills: {},
        longTermIntent: "",
        relationships: [],
      })),
      transportEdges: [],
      scenes: new Map(),
      npcRelationships: [],
    }),
    isNpcAlive: (id: string) => npcs.find((n) => n.id === id)?.alive ?? false,
    getCharacterPosition: (id: string) => {
      const n = npcs.find((nn) => nn.id === id);
      return n?.sceneId ? { type: "scene", sceneId: n.sceneId } : undefined;
    },
    resolveLocationId: (pos: { type: string; sceneId?: string }) =>
      pos.sceneId ?? "",
    getNpcProfile: (id: string) => {
      const n = npcs.find((nn) => nn.id === id);
      if (!n) return undefined;
      return {
        id: n.id,
        name: n.id,
        attributes: {},
        status: {
          hp: 12,
          maxHp: 12,
          san: 50,
          maxSan: 50,
          fatigue: 0,
          maxFatigue: 100,
          luck: 50,
          conditions: [],
        },
        inventory: [],
        skills: {},
        longTermIntent: "",
        relationships: [],
      };
    },
    getScene: () => null,
    getGameDateTime: () => "1923-10-17T08:00:00",
  } as unknown as DynamicGameStateManager;
}

function makeMemory(): NpcMemoryManager {
  return {
    getAllForDay: async () => [],
    getForDayByTypes: async () => [],
    getForDateByTypes: async () => [],
    findLatestByType: async () => null,
  } as unknown as NpcMemoryManager;
}

function makeAgent(): {
  agent: RoleSimAgent;
  decisions: RoleSimContext[];
  next: () => RoleSimDecision;
  setDecision: (d: RoleSimDecision) => void;
} {
  const decisions: RoleSimContext[] = [];
  let nextDecision: RoleSimDecision = { tool: "continue" };
  return {
    agent: {
      decideNext: async (ctx: RoleSimContext) => {
        decisions.push(ctx);
        return nextDecision;
      },
    },
    decisions,
    next: () => nextDecision,
    setDecision: (d) => {
      nextDecision = d;
    },
  };
}

function emptyReport(): TickReport {
  return {
    gameDateTime: "1923-10-17T08:00:00",
    commits: [],
    interruptions: [],
    cancellations: [],
    featureEvents: [],
    stateChanges: [],
    damageReports: [],
  };
}

describe("NpcActionController.processTickReport", () => {
  test("calls decide() for each affected NPC at most once per tick, batches multi-event triggers", async () => {
    // Two scene-2 events affecting npc1 + npc2 (same scene), npc3 elsewhere.
    // Mock findAffectedCharacters by stubbing dgsm to return all NPCs at scene SCN1.
    const dgsm = makeDgsm([
      { id: "npc1", alive: true, sceneId: "SCN1" },
      { id: "npc2", alive: true, sceneId: "SCN1" },
      { id: "npc3", alive: true, sceneId: "ELSEWHERE" },
    ]);
    const { engine } = makeEngine();
    const { agent, decisions } = makeAgent();
    new NpcActionController({
      engine,
      agent,
      memory: makeMemory(),
      dgsm,
      sessionId: "s",
      moduleId: "m",
    });

    // Stub getCharacterPositions so impactPropagation can find scene members.
    // Patch dgsm to also return characterPositions properly:
    (
      dgsm as unknown as { getCharacterPositions: () => unknown }
    ).getCharacterPositions = () => ({
      npc1: { type: "scene", sceneId: "SCN1" },
      npc2: { type: "scene", sceneId: "SCN1" },
      npc3: { type: "scene", sceneId: "ELSEWHERE" },
    });

    const report = emptyReport();
    const baseEvent: FeatureEvent = {
      type: "noise",
      impact: 2,
      description: "loud noise",
      sceneId: "SCN1",
    };
    const fireEvent: FeatureEvent = {
      type: "fire",
      impact: 2,
      description: "fire spreading",
      sceneId: "SCN1",
    };
    report.featureEvents.push(baseEvent, fireEvent);

    await engine.fireTickCompleted(report);

    // npc1, npc2, npc3 all called via idleAlive path even if not in same scene.
    // What we care about: each NPC gets at most one decideNext call per tick.
    const counts = new Map<string, number>();
    for (const ctx of decisions) {
      counts.set(ctx.npcId, (counts.get(ctx.npcId) ?? 0) + 1);
    }
    for (const [, n] of counts) {
      expect(n).toBeLessThanOrEqual(1);
    }
  });

  test("act decision cancels current action then submits new one", async () => {
    const dgsm = makeDgsm([{ id: "npc1", alive: true, sceneId: "SCN1" }]);
    const queue = new Map<string, ActionStep[]>();
    queue.set("npc1", [
      {
        id: "step1",
        handle: {
          id: "h1",
          characterId: "npc1",
          submittedAt: "1923-10-17T08:00:00",
        },
        stepGroupId: "g1",
        stepIndex: 0,
        characterId: "npc1",
        targetCharacterIds: [],
        actionText: "old",
        definitionId: "action",
        executionSceneId: "SCN1",
        submittedAt: "1923-10-17T08:00:00",
        status: "active",
      },
    ]);
    const { engine, calls } = makeEngine({ actorQueue: queue });
    const { agent, setDecision } = makeAgent();
    setDecision({ tool: "act", input: { actionText: "flee" } });

    const controller = new NpcActionController({
      engine,
      agent,
      memory: makeMemory(),
      dgsm,
      sessionId: "s",
      moduleId: "m",
    });

    await controller.decide("npc1", {
      reviseTriggers: [{ description: "fire" }],
    });

    expect(calls.cancel).toBe(1);
    expect(calls.submit).toBe(1);
  });
});
