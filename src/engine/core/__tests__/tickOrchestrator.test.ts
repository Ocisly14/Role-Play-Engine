import { describe, expect, it, vi } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { Applier } from "../applier.js";
import { EmergentEventEmitter } from "../emergentEventEmitter.js";
import { FeatureRunner } from "../featureRunner.js";
import { Queue } from "../queue.js";
import { TickOrchestrator } from "../tickOrchestrator.js";
import type { WorldFeature } from "../worldFeature.js";

describe("TickOrchestrator", () => {
  it("runs phases in order and produces a TickReport", async () => {
    const dgsm = new DynamicGameStateManager();
    dgsm.registerNpcProfile({
      id: "npc1",
      name: "npc1",
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

    const queue = new Queue();
    const feature: WorldFeature = {
      id: "fire",
      description: "",
      stateScope: "scene",
      affectedKinds: ["character.hp"],
      effectSummary: "",
      onTick: () => [
        {
          kind: "character.hp",
          characterId: "npc1",
          delta: -1,
          sourceFeatureId: "fire",
          reason: "burn",
        },
      ],
    };
    const featureRunner = new FeatureRunner([feature]);
    const applier = new Applier(dgsm, featureRunner.getFeatureScopeMap());
    const scriptedRunner = { run: vi.fn().mockReturnValue([]) };
    const emitter = new EmergentEventEmitter();

    const orch = new TickOrchestrator({
      dgsm,
      queue,
      featureRunner,
      scriptedEventRunner: scriptedRunner as never,
      emergentEventEmitter: emitter,
      applier,
      resolve: vi.fn(),
      tickDurationMinutes: 1,
      lang: "en",
      hasInitialized: true,
    });

    const report = await orch.tick();
    expect(dgsm.getNpcProfile("npc1")!.status.hp).toBe(9);
    expect(report.damageReports).toHaveLength(1);
    expect(report.damageReports[0].finalValueAfter).toBe(9);
  });
});
