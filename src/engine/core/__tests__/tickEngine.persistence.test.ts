import { describe, expect, it } from "vitest";
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

describe("TickEngine persistence", () => {
  it("round-trips queue + connection refcounts", async () => {
    const dgsm1 = new DynamicGameStateManager();
    seedNpc(dgsm1, "npc1");

    const engine1 = createTickEngine({
      dgsm: dgsm1,
      features: [],
      scriptedEvents: [],
      emergentScanners: [],
      interpretAction: async () => ({
        steps: [{ definitionId: "wait", actionText: "" } as never],
      }),
      resolve: async () => ({
        outcome: { stateChanges: [], elapsedMinutes: 10 } as never,
        plannedDuration: 10,
      }),
      getActorDex: () => 50,
      tickDurationMinutes: 1,
      lang: "en",
    });
    await engine1.submitAction({
      characterId: "npc1",
      actionText: "wait",
      sceneId: "s1",
    });

    const snapshot = engine1.serialize();
    expect(snapshot.queue).toHaveLength(1);
    expect(snapshot.dexByActor.npc1).toBe(50);

    const dgsm2 = new DynamicGameStateManager();
    seedNpc(dgsm2, "npc1");
    const engine2 = createTickEngine({
      dgsm: dgsm2,
      features: [],
      scriptedEvents: [],
      emergentScanners: [],
      interpretAction: async () => ({ steps: [] }),
      resolve: async () => ({
        outcome: { stateChanges: [], elapsedMinutes: 0 } as never,
        plannedDuration: 0,
      }),
      getActorDex: () => 50,
      tickDurationMinutes: 1,
      lang: "en",
      persistedState: snapshot,
    });
    expect(engine2.getActorQueue("npc1")).toHaveLength(1);
  });
});
