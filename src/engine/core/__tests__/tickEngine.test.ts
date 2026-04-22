import { describe, expect, it, vi } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { createTickEngine } from "../tickEngine.js";

function seedNpc(d: DynamicGameStateManager, id: string): void {
  d.registerNpcProfile({
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
      hp: 10,
      maxHp: 10,
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
  });
}

describe("TickEngine", () => {
  it("submitAction → tick → actionCompleted event fires", async () => {
    const dgsm = new DynamicGameStateManager();
    seedNpc(dgsm, "npc1");

    const engine = createTickEngine({
      dgsm,
      features: [],
      scriptedEvents: [],
      emergentScanners: [],
      interpretAction: async () => ({
        steps: [{ definitionId: "idle", actionText: "wait" } as never],
      }),
      resolve: async () => ({
        outcome: { stateChanges: [], elapsedMinutes: 0 } as never,
        plannedDuration: 0,
      }),
      getActorDex: () => 50,
      tickDurationMinutes: 1,
      lang: "en",
    });

    const completedSpy = vi.fn();
    engine.on("actionCompleted", completedSpy);

    const handle = await engine.submitAction({
      characterId: "npc1",
      actionText: "wait",
      sceneId: "s1",
    });
    await engine.tick();
    expect(completedSpy).toHaveBeenCalled();
    expect(engine.getActionStatus(handle)).toBe("completed");
  });

  it("cancelAction idempotent: first call marks steps cancelled, second call returns applied:false", async () => {
    const dgsm = new DynamicGameStateManager();
    seedNpc(dgsm, "npc1");

    const engine = createTickEngine({
      dgsm,
      features: [],
      scriptedEvents: [],
      emergentScanners: [],
      interpretAction: async () => ({
        steps: [
          { definitionId: "idle", actionText: "" } as never,
          { definitionId: "idle2", actionText: "" } as never,
        ],
      }),
      resolve: async () => ({
        outcome: { stateChanges: [], elapsedMinutes: 5 } as never,
        plannedDuration: 5,
      }),
      getActorDex: () => 50,
      tickDurationMinutes: 1,
      lang: "en",
    });

    const cancelledSpy = vi.fn();
    engine.on("actionCancelled", cancelledSpy);

    const handle = await engine.submitAction({
      characterId: "npc1",
      actionText: "chain",
      sceneId: "s1",
    });
    const r1 = engine.cancelAction(handle);
    expect(r1.applied).toBe(true);
    expect(r1.remainingChainCancelled).toBe(2);

    const r2 = engine.cancelAction(handle);
    expect(r2.applied).toBe(false); // idempotent
    expect(r2.remainingChainCancelled).toBe(0);

    await engine.tick();
    expect(cancelledSpy).toHaveBeenCalledOnce(); // fires once, not twice
  });
});
