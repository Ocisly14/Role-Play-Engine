import { describe, expect, it, vi } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { createDefaultCodeEngineRegistry } from "../../codeEngine/registry.js";
import { Applier } from "../applier.js";
import { EmergentEventEmitter } from "../emergentEventEmitter.js";
import { FeatureRunner } from "../featureRunner.js";
import { Queue } from "../queue.js";
import { TickOrchestrator } from "../tickOrchestrator.js";
import type { WorldFeature } from "../worldFeature.js";

function makeOrchestrator(opts: {
  dgsm: DynamicGameStateManager;
  features: WorldFeature[];
  hasInitialized: boolean;
}): TickOrchestrator {
  const featureRunner = new FeatureRunner(opts.features);
  const applier = new Applier(opts.dgsm, featureRunner.getFeatureScopeMap());
  const queue = new Queue();
  const emitter = new EmergentEventEmitter();
  const scriptedRunner = { run: vi.fn().mockReturnValue([]) };
  return new TickOrchestrator({
    dgsm: opts.dgsm,
    queue,
    featureRunner,
    scriptedEventRunner: scriptedRunner as never,
    emergentEventEmitter: emitter,
    applier,
    resolve: vi.fn(),
    codeEngineRegistry: createDefaultCodeEngineRegistry(),
    tickDurationMinutes: 1,
    lang: "en",
    hasInitialized: opts.hasInitialized,
  });
}

const sentinelFeature: WorldFeature = {
  id: "sentinel",
  description: "test sentinel",
  stateScope: "global",
  affectedKinds: ["feature.setState"],
  effectSummary: "writes a global flag from init() so we can assert Phase 0 ran",
  init() {
    return [
      {
        kind: "feature.setState",
        featureId: "sentinel",
        key: "ran",
        state: true,
      },
    ];
  },
};

describe("TickOrchestrator — Phase 0 (one-shot init)", () => {
  it("fresh session: first tick() runs feature.init() and writes init state", async () => {
    const dgsm = new DynamicGameStateManager();
    const orch = makeOrchestrator({
      dgsm,
      features: [sentinelFeature],
      hasInitialized: false,
    });

    expect(
      dgsm.getScopedFeatureState<boolean>("sentinel", "global", "ran"),
    ).toBeUndefined();

    await orch.tick();

    expect(dgsm.getScopedFeatureState<boolean>("sentinel", "global", "ran")).toBe(
      true,
    );
  });

  it("rehydrated session: first tick() does NOT run feature.init()", async () => {
    const dgsm = new DynamicGameStateManager();
    const orch = makeOrchestrator({
      dgsm,
      features: [sentinelFeature],
      hasInitialized: true,
    });

    await orch.tick();

    expect(
      dgsm.getScopedFeatureState<boolean>("sentinel", "global", "ran"),
    ).toBeUndefined();
  });

  it("fresh session: init() is only run once, not on every tick", async () => {
    const dgsm = new DynamicGameStateManager();
    const initSpy = vi.fn().mockReturnValue([]);
    const counted: WorldFeature = {
      id: "counted",
      description: "",
      stateScope: "global",
      affectedKinds: ["feature.setState"],
      effectSummary: "",
      init: initSpy,
    };
    const orch = makeOrchestrator({
      dgsm,
      features: [counted],
      hasInitialized: false,
    });

    await orch.tick();
    await orch.tick();
    await orch.tick();

    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it("init() exception in one feature doesn't prevent another's init from running; hasInitialized still latches", async () => {
    // Regression test for I1: previously a thrown exception aborted Phase 0
    // with hasInitialized still false, causing a retry next tick that
    // double-emitted scene conditions from features that had already succeeded.
    const dgsm = new DynamicGameStateManager();
    const exploding: WorldFeature = {
      id: "exploding",
      description: "",
      stateScope: "global",
      affectedKinds: ["feature.setState"],
      effectSummary: "throws from init()",
      init() {
        throw new Error("init boom");
      },
    };
    const sibling: WorldFeature = {
      id: "sibling",
      description: "",
      stateScope: "global",
      affectedKinds: ["feature.setState"],
      effectSummary: "initializes after exploding",
      init() {
        return [
          {
            kind: "feature.setState",
            featureId: "sibling",
            key: "ran",
            state: true,
          },
        ];
      },
    };
    const siblingSpy = vi.spyOn(sibling, "init");
    // Swallow the console.error from the isolated catch
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const orch = makeOrchestrator({
      dgsm,
      features: [exploding, sibling],
      hasInitialized: false,
    });

    await orch.tick();
    // Sibling's init ran in spite of exploding's throw
    expect(siblingSpy).toHaveBeenCalledTimes(1);
    expect(dgsm.getScopedFeatureState<boolean>("sibling", "global", "ran")).toBe(
      true,
    );

    // Second tick does NOT re-run sibling.init (hasInitialized latched)
    await orch.tick();
    expect(siblingSpy).toHaveBeenCalledTimes(1);

    errSpy.mockRestore();
  });
});
