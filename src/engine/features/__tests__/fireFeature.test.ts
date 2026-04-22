import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import {
  buildTopology,
  type JunctionNode,
  type RoadNode,
} from "../../../state/topologyTypes.js";
import type { ActionStep, StateChange } from "../../core/types.js";
import { DEFAULT_ENVIRONMENT_READING } from "../../core/types.js";
import { makeDGSMFeatureReadContext } from "../../core/featureReadContext.js";
import {
  type FireSceneState,
  fireFeature,
} from "../fireFeature.js";

// ===== Test plumbing =====

/**
 * Build a per-feature read context. Allows overriding `tickDurationMinutes`
 * (which the default factory pins to 1) so tests can advance fire's 10-minute
 * intensity steps without 90+ tick loops.
 */
function makeFireCtx(
  dgsm: DynamicGameStateManager,
  overrides?: { tickDurationMinutes?: number },
) {
  const base = makeDGSMFeatureReadContext(dgsm, {
    callerFeatureId: "fire",
    callerScope: "scene",
  });
  if (!overrides?.tickDurationMinutes) return base;
  return { ...base, tickDurationMinutes: overrides.tickDurationMinutes };
}

/**
 * Mini-applier — apply ONLY the kinds the new fireFeature emits that mutate
 * persistent state we read across ticks. We intentionally skip env/
 * connection/condition kinds because they're either single-tick contributions
 * (env) or the tests assert on the raw StateChange list.
 */
function applyFireMutations(
  dgsm: DynamicGameStateManager,
  changes: StateChange[],
): void {
  for (const c of changes) {
    if (c.kind === "feature.setState" && c.featureId === "fire") {
      dgsm.setScopedFeatureState("fire", "scene", c.key, c.state);
    } else if (c.kind === "feature.removeState" && c.featureId === "fire") {
      dgsm.removeScopedFeatureState("fire", "scene", c.key);
    }
  }
}

function igniteAt(
  dgsm: DynamicGameStateManager,
  sceneId: string,
  intensity: number,
): StateChange[] {
  const ctx = makeFireCtx(dgsm);
  const step: ActionStep = {
    id: "step-1",
    handle: {
      id: "h1",
      characterId: "npc-1",
      submittedAt: { day: 1, tickTime: "08:00" },
    },
    stepGroupId: "g1",
    stepIndex: 0,
    characterId: "npc-1",
    targetCharacterIds: [],
    actionText: "Set fire",
    definitionId: "ignite",
    executionSceneId: sceneId,
    overlayFields: { fireIntensity: intensity },
    submittedAt: { day: 1, tickTime: "08:00" },
    status: "active",
  };
  const changes =
    fireFeature.onActionCommit?.(
      step,
      { stateChanges: [], elapsedMinutes: 0 },
      ctx,
    ) ?? [];
  applyFireMutations(dgsm, changes);
  return changes;
}

function seedSimpleScene(
  dgsm: DynamicGameStateManager,
  sceneId: string,
): void {
  dgsm.updateScene(sceneId, {
    id: sceneId,
    name: sceneId,
    description: "",
    parentLocationId: "town",
    items: [],
    conditions: [],
    connections: [],
  });
}

function runFireTicks(
  dgsm: DynamicGameStateManager,
  count: number,
  tickDurationMinutes = 5,
): StateChange[] {
  const allChanges: StateChange[] = [];
  for (let i = 0; i < count; i++) {
    const ctx = makeFireCtx(dgsm, { tickDurationMinutes });
    const changes = fireFeature.onTick?.(ctx) ?? [];
    applyFireMutations(dgsm, changes);
    allChanges.push(...changes);
  }
  return allChanges;
}

function lastFireState(
  dgsm: DynamicGameStateManager,
  sceneId: string,
): FireSceneState | undefined {
  return dgsm.getScopedFeatureState<FireSceneState>("fire", "scene", sceneId);
}

// ===== Tests =====

describe("fireFeature internal invariants", () => {
  // ----- 1) Lifecycle 1 → 5 → 0 -----
  it("ignites then walks 1 → 5 (growing) → 0 (decaying), emitting aftermath at extinguish", () => {
    const dgsm = new DynamicGameStateManager();
    seedSimpleScene(dgsm, "warehouse");
    igniteAt(dgsm, "warehouse", 1);
    expect(lastFireState(dgsm, "warehouse")?.intensity).toBe(1);

    // 5-minute ticks; intensity steps every 10 minutes (= every 2 ticks).
    // Growing 1→5 = 4 transitions × 2 ticks = 8 ticks.
    runFireTicks(dgsm, 8);
    const peak = lastFireState(dgsm, "warehouse");
    expect(peak?.intensity).toBe(5);
    expect(peak?.phase).toBe("decaying");

    // Decaying 5→0 = 5 transitions × 2 ticks = 10 ticks.
    const decayChanges = runFireTicks(dgsm, 10);

    // Fire state removed.
    expect(lastFireState(dgsm, "warehouse")).toBeUndefined();

    // Final batch must include feature.removeState + scene.removeCondition + aftermath addCondition.
    const removed = decayChanges.find(
      (c) => c.kind === "feature.removeState" && c.featureId === "fire",
    );
    expect(removed).toBeDefined();
    const aftermath = decayChanges.find(
      (c) =>
        c.kind === "scene.addCondition" &&
        c.condition.featureId === "fire" &&
        c.condition.description.startsWith("[Fire Aftermath]"),
    );
    expect(aftermath).toBeDefined();
  });

  // ----- 2) Aftermath threshold buckets -----
  it("aftermath description bucket is selected by totalBurnMinutes", () => {
    const cases: Array<{
      totalBurnMinutes: number;
      contains: string;
      expectedPenalty?: number;
    }> = [
      { totalBurnMinutes: 15, contains: "Minor smoke stains" },
      {
        totalBurnMinutes: 45,
        contains: "Partial burn damage",
        expectedPenalty: -5,
      },
      {
        totalBurnMinutes: 90,
        contains: "Severe burn damage",
        expectedPenalty: -10,
      },
      {
        totalBurnMinutes: 200,
        contains: "Scene nearly destroyed",
        expectedPenalty: -20,
      },
    ];

    for (const tc of cases) {
      const dgsm = new DynamicGameStateManager();
      seedSimpleScene(dgsm, "room");
      // Seed a decaying fire that will tip over 0 on the next 10-min step.
      // intensity 1, decaying, minutesInPhase already at 5 → +5 (one tick) = 10 → step.
      const seed: FireSceneState = {
        intensity: 1,
        maxIntensity: 5,
        growthRate: 1,
        decayRate: 1,
        spreadThreshold: 3,
        phase: "decaying",
        minutesInPhase: 5,
        totalBurnMinutes: tc.totalBurnMinutes - 5, // +5 from the tick we run
      };
      dgsm.setScopedFeatureState("fire", "scene", "room", seed);

      const changes = runFireTicks(dgsm, 1);
      const aftermath = changes.find(
        (c) =>
          c.kind === "scene.addCondition" &&
          c.condition.featureId === "fire" &&
          c.condition.description.startsWith("[Fire Aftermath]"),
      );
      expect(aftermath, `bucket for ${tc.totalBurnMinutes}min`).toBeDefined();
      if (aftermath?.kind === "scene.addCondition") {
        expect(aftermath.condition.description).toContain(tc.contains);
        const penalty =
          aftermath.condition.mechanicalEffect?.skillPenalty?.Perception;
        if (tc.expectedPenalty === undefined) {
          expect(penalty).toBeUndefined();
        } else {
          expect(penalty).toBe(tc.expectedPenalty);
        }
      }
    }
  });

  // ----- 3) Topology spread -----
  it("scene fire propagates to its parent junction via topology", () => {
    const dgsm = new DynamicGameStateManager();

    const junctions = new Map<string, JunctionNode>([
      [
        "JUNC_1",
        {
          id: "JUNC_1",
          name: "Crossroads",
          description: "",
          parentLocationId: "OUTDOOR",
          items: [],
          conditions: [],
          connectedSceneIds: ["SCN_A"],
        },
      ],
      [
        "JUNC_2",
        {
          id: "JUNC_2",
          name: "End",
          description: "",
          parentLocationId: "OUTDOOR",
          items: [],
          conditions: [],
          connectedSceneIds: [],
        },
      ],
    ]);
    const roads = new Map<string, RoadNode>([
      [
        "ROAD_1",
        {
          id: "ROAD_1",
          name: "Main Road",
          description: "",
          parentLocationId: "OUTDOOR",
          endpointA: "JUNC_1",
          endpointB: "JUNC_2",
          travelTimeMinutes: 20,
          alongConnections: [{ sceneId: "SCN_B", position: 0.3 }],
          items: [],
          conditions: [],
        },
      ],
    ]);
    dgsm.setTopology(buildTopology(junctions, roads));

    dgsm.updateScene("SCN_A", {
      id: "SCN_A",
      name: "A",
      description: "",
      parentLocationId: "JUNC_1",
      items: [],
      conditions: [],
      connections: [],
    });
    dgsm.updateScene("SCN_B", {
      id: "SCN_B",
      name: "B",
      description: "",
      parentLocationId: "ROAD_1",
      items: [],
      conditions: [],
      connections: [],
    });

    // Seed an intensity-3 (above spread threshold) fire at the scene attached to JUNC_1.
    const seed: FireSceneState = {
      intensity: 3,
      maxIntensity: 5,
      growthRate: 1,
      decayRate: 1,
      spreadThreshold: 3,
      phase: "growing",
      minutesInPhase: 0,
      totalBurnMinutes: 0,
    };
    dgsm.setScopedFeatureState("fire", "scene", "SCN_A", seed);

    const ctx = makeFireCtx(dgsm);
    const result = fireFeature.onPropagate?.(
      { sceneId: "SCN_A", hop: 0 },
      ctx,
    );
    expect(result).toBeDefined();
    expect(result?.spreadToSceneIds).toContain("JUNC_1");

    // The returned changes should ignite JUNC_1 with a fresh intensity-1 fire.
    const ignited = result?.changes.find(
      (c) =>
        c.kind === "feature.setState" &&
        c.featureId === "fire" &&
        c.key === "JUNC_1",
    );
    expect(ignited).toBeDefined();
    if (ignited?.kind === "feature.setState") {
      const state = ignited.state as FireSceneState;
      expect(state.intensity).toBe(1);
      expect(state.phase).toBe("growing");
    }
  });

  // ----- 4) Cold-rain decay acceleration -----
  it("cold ambient temperature halves the decaying-phase wall-clock", () => {
    const seedDecaying = (dgsm: DynamicGameStateManager) => {
      seedSimpleScene(dgsm, "barn");
      const seed: FireSceneState = {
        intensity: 5,
        maxIntensity: 5,
        growthRate: 1,
        decayRate: 1,
        spreadThreshold: 3,
        phase: "decaying",
        minutesInPhase: 0,
        totalBurnMinutes: 40,
      };
      dgsm.setScopedFeatureState("fire", "scene", "barn", seed);
    };

    // Baseline (warm temperature): 1-min ticks, 5→0 needs 5 transitions × 10 min = 50 ticks.
    const warmDgsm = new DynamicGameStateManager();
    seedDecaying(warmDgsm);
    warmDgsm.setEnvironmentReading("barn", {
      ...DEFAULT_ENVIRONMENT_READING,
      temperature: 20,
    });
    let warmTicks = 0;
    while (lastFireState(warmDgsm, "barn")) {
      runFireTicks(warmDgsm, 1, 1);
      warmTicks++;
      if (warmTicks > 200) break;
    }

    // Cold (sub-threshold temperature): minutesInPhase advances 2x →
    // each 10-min step takes 5 ticks instead of 10, total 25 ticks.
    const coldDgsm = new DynamicGameStateManager();
    seedDecaying(coldDgsm);
    coldDgsm.setEnvironmentReading("barn", {
      ...DEFAULT_ENVIRONMENT_READING,
      temperature: 0,
    });
    let coldTicks = 0;
    while (lastFireState(coldDgsm, "barn")) {
      runFireTicks(coldDgsm, 1, 1);
      coldTicks++;
      if (coldTicks > 200) break;
    }

    expect(coldTicks).toBeLessThan(warmTicks);
    // Specifically: cold should be ~half the warm tick count.
    expect(coldTicks).toBeLessThanOrEqual(Math.ceil(warmTicks / 2) + 1);
  });
});
