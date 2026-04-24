import { describe, expect, it, vi } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { DynamicNPCProfile } from "../../../state/types.js";
import { createDefaultCodeEngineRegistry } from "../../codeEngine/registry.js";
import { Applier } from "../applier.js";
import { EmergentEventEmitter } from "../emergentEventEmitter.js";
import { FeatureRunner } from "../featureRunner.js";
import { Queue } from "../queue.js";
import { TickOrchestrator } from "../tickOrchestrator.js";
import type { CharacterCondition } from "../types.js";

function makeNpc(id: string, conditions: CharacterCondition[]): DynamicNPCProfile {
  return {
    id,
    name: id.toUpperCase(),
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
      hp: 10,
      maxHp: 10,
      san: 50,
      maxSan: 50,
      fatigue: 0,
      maxFatigue: 100,
      luck: 50,
      conditions,
    },
    inventory: [],
    skills: {},
    longTermIntent: "",
    relationships: [],
  };
}

function makeOrchestrator(dgsm: DynamicGameStateManager): TickOrchestrator {
  const featureRunner = new FeatureRunner([]);
  const applier = new Applier(dgsm, featureRunner.getFeatureScopeMap());
  return new TickOrchestrator({
    dgsm,
    queue: new Queue(),
    featureRunner,
    scriptedEventRunner: { run: vi.fn().mockReturnValue([]) } as never,
    emergentEventEmitter: new EmergentEventEmitter(),
    applier,
    resolve: vi.fn(),
    codeEngineRegistry: createDefaultCodeEngineRegistry(),
    tickDurationMinutes: 1,
    lang: "en",
    hasInitialized: true, // skip Phase 0
  });
}

describe("TickOrchestrator — Phase 9.5 condition expiry sweep", () => {
  it("removes character conditions whose expiresAt is at or before tickTime", async () => {
    const dgsm = new DynamicGameStateManager();
    dgsm.registerNpcProfile(
      makeNpc("npc1", [
        {
          id: "bout-temp",
          description: "Temporary bout of madness",
          featureId: "sanity",
          expiresAt: { day: 1, tickTime: "08:00" },
        },
        {
          id: "bout-future",
          description: "Future bout",
          featureId: "sanity",
          expiresAt: { day: 1, tickTime: "10:00" },
        },
      ]),
    );
    // Set DGSM clock so tickDuration (1 min) advances to 09:00 in Phase 1.
    // 08:00 condition is expired; 10:00 condition is not.
    dgsm.setGameDay(1);
    dgsm.setTickTime("08:59");

    const orch = makeOrchestrator(dgsm);
    await orch.tick();

    const conds = dgsm.getNpcProfile("npc1")?.status?.conditions ?? [];
    expect(conds.find((c) => c.id === "bout-temp")).toBeUndefined();
    expect(conds.find((c) => c.id === "bout-future")).toBeDefined();
  });

  it("ignores conditions without expiresAt", async () => {
    const dgsm = new DynamicGameStateManager();
    dgsm.registerNpcProfile(
      makeNpc("npc1", [
        {
          id: "persistent-phobia",
          description: "Phobia of tentacles",
          featureId: "sanity",
          // no expiresAt — never auto-removes
        },
      ]),
    );
    dgsm.setGameDay(99);
    dgsm.setTickTime("23:00");

    const orch = makeOrchestrator(dgsm);
    await orch.tick();

    const conds = dgsm.getNpcProfile("npc1")?.status?.conditions ?? [];
    expect(conds).toHaveLength(1);
    expect(conds[0].id).toBe("persistent-phobia");
  });

  it("removes a condition exactly at its expiresAt boundary (at-or-before)", async () => {
    const dgsm = new DynamicGameStateManager();
    dgsm.registerNpcProfile(
      makeNpc("npc1", [
        {
          id: "boundary",
          description: "Expires exactly at 09:00",
          featureId: "sanity",
          expiresAt: { day: 1, tickTime: "09:00" },
        },
      ]),
    );
    dgsm.setGameDay(1);
    dgsm.setTickTime("08:59"); // → 09:00 after Phase 1

    const orch = makeOrchestrator(dgsm);
    await orch.tick();

    const conds = dgsm.getNpcProfile("npc1")?.status?.conditions ?? [];
    expect(conds.find((c) => c.id === "boundary")).toBeUndefined();
  });

  it("sweeps conditions across multiple NPCs", async () => {
    const dgsm = new DynamicGameStateManager();
    dgsm.registerNpcProfile(
      makeNpc("npcA", [
        {
          id: "a-expired",
          description: "expired",
          featureId: "sanity",
          expiresAt: { day: 1, tickTime: "07:00" },
        },
      ]),
    );
    dgsm.registerNpcProfile(
      makeNpc("npcB", [
        {
          id: "b-future",
          description: "future",
          featureId: "sanity",
          expiresAt: { day: 2, tickTime: "00:00" },
        },
      ]),
    );
    dgsm.setGameDay(1);
    dgsm.setTickTime("08:59"); // → 09:00 day 1

    const orch = makeOrchestrator(dgsm);
    await orch.tick();

    expect(dgsm.getNpcProfile("npcA")?.status?.conditions).toHaveLength(0);
    expect(dgsm.getNpcProfile("npcB")?.status?.conditions).toHaveLength(1);
  });
});
