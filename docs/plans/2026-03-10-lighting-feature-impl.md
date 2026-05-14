# Lighting Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a unified lighting WorldFeature that aggregates sun, moon, fire, and item light sources into per-scene light levels with skill penalties.

**Architecture:** Lighting is a tick-only WorldFeature that reads fire featureState, weather featureState, scene items, and timeOfDay each tick. It computes max light level per scene from all contributing sources and writes sceneConditions with skill penalties. Must tick after fire and weather.

**Tech Stack:** TypeScript, Vitest

---

## Task 1: Add light source fields to SceneItem

**Files:**
- Modify: `src/dynamicworldagent/world_builder/types.ts:96-106`

**Step 1: Add fields**

In `SceneItem` interface (before closing `}`), add:

```typescript
  isLightSource?: boolean;
  lightLevel?: number;
```

**Step 2: Build**

Run: `pnpm build`
Expected: PASS

---

## Task 2: Create lightingFeature.ts — types, constants, sun curve

**Files:**
- Create: `src/dynamicworldagent/engine/features/lightingFeature.ts`

**Step 1: Write types, constants, and sun curve computation**

```typescript
import type {
  WorldFeature,
  TickRuntimeContext,
} from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";

// ===== Types =====

export interface LightingSceneState {
  lightLevel: number;   // final computed (1-5)
  sources: string[];    // contributing source names
}

// ===== Constants =====

const FEATURE_ID = "lighting";

const LIGHT_LEVEL_NAMES = ["", "pitch_black", "dark", "normal", "bright", "blinding"];
const LIGHT_LEVEL_LABELS = ["", "Pitch black", "Dark", "Normal lighting", "Bright", "Blinding light"];

// ===== Sun Curve =====

/** Compute base sun light level from HH:MM time string (smooth interpolation) */
function computeSunLevel(timeStr: string): number {
  const [hStr, mStr] = timeStr.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const t = h + m / 60; // decimal hours

  if (t < 4) return 1;
  if (t < 6) return lerp(1, 3, (t - 4) / 2);
  if (t < 7) return lerp(3, 4, (t - 6) / 1);
  if (t < 12) return lerp(4, 5, (t - 7) / 5);
  if (t < 13) return 5;
  if (t < 17) return lerp(5, 4, (t - 13) / 4);
  if (t < 18) return lerp(4, 3, (t - 17) / 1);
  if (t < 20) return lerp(3, 1, (t - 18) / 2);
  return 1;
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
}
```

**Step 2: Build**

Run: `pnpm build`
Expected: PASS

---

## Task 3: lightingFeature — weather modifier and fire mapping

**Files:**
- Modify: `src/dynamicworldagent/engine/features/lightingFeature.ts`

**Step 1: Add weather modifier and fire-to-light mapping**

Append after sun curve:

```typescript
// ===== Weather Modifier =====

function getWeatherLightModifier(dgsm: DynamicGameStateManager, regionId: string): number {
  const weatherState = dgsm.getFeatureSceneState("weather", regionId) as
    | { weatherType: string; intensity: number }
    | undefined;
  if (!weatherState) return 0;

  const { weatherType, intensity } = weatherState;

  if (weatherType === "fog") {
    if (intensity >= 5) return -2;
    if (intensity >= 3) return -1;
  }
  if (weatherType === "storm") {
    if (intensity >= 4) return -2;
    if (intensity >= 2) return -1;
  }
  if (weatherType === "rain") {
    if (intensity >= 4) return -1;
  }
  return 0;
}

// ===== Fire to Light Mapping =====

interface FireLightContribution {
  sceneId: string;
  lightLevel: number;
}

function getFireLightContributions(dgsm: DynamicGameStateManager): FireLightContribution[] {
  const contributions: FireLightContribution[] = [];
  const fireStates = dgsm.getFeatureState("fire");

  for (const [sceneId, state] of Object.entries(fireStates)) {
    const fs = state as { intensity: number } | undefined;
    if (!fs || fs.intensity <= 0) continue;

    // Map fire intensity to light level
    const fireLightLevel = Math.min(fs.intensity + 1, 5);
    contributions.push({ sceneId, lightLevel: fireLightLevel });

    // Adjacent scene contribution when fire intensity >= 3
    if (fs.intensity >= 3) {
      const scene = dgsm.getScene(sceneId);
      if (scene) {
        const adjacentLevel = fireLightLevel - 1;
        for (const connId of scene.connections) {
          contributions.push({ sceneId: connId, lightLevel: adjacentLevel });
        }
      }
    }
  }

  return contributions;
}
```

**Step 2: Build**

Run: `pnpm build`
Expected: PASS

---

## Task 4: lightingFeature — skill penalties and scene condition writing

**Files:**
- Modify: `src/dynamicworldagent/engine/features/lightingFeature.ts`

**Step 1: Add skill penalty config and condition helpers**

Append after fire mapping:

```typescript
// ===== Skill Penalties =====

interface LightPenaltyEntry {
  skill: string;
  delta: number;
}

const LIGHT_LEVEL_PENALTIES: Record<number, LightPenaltyEntry[]> = {
  1: [
    { skill: "Perception", delta: -40 },
    { skill: "Navigate", delta: -30 },
    { skill: "Track", delta: -40 },
    { skill: "Pistol", delta: -40 },
    { skill: "Rifle", delta: -40 },
    { skill: "Submachine Gun", delta: -40 },
    { skill: "Bow", delta: -40 },
    { skill: "Climb", delta: -20 },
    { skill: "Drive Auto", delta: -30 },
    { skill: "Research", delta: -50 },
  ],
  2: [
    { skill: "Perception", delta: -20 },
    { skill: "Navigate", delta: -15 },
    { skill: "Track", delta: -20 },
    { skill: "Pistol", delta: -20 },
    { skill: "Rifle", delta: -20 },
    { skill: "Submachine Gun", delta: -20 },
    { skill: "Bow", delta: -20 },
    { skill: "Climb", delta: -10 },
    { skill: "Drive Auto", delta: -15 },
    { skill: "Research", delta: -20 },
  ],
  3: [],
  4: [],
  5: [
    { skill: "Perception", delta: -15 },
    { skill: "Track", delta: -10 },
    { skill: "Pistol", delta: -15 },
    { skill: "Rifle", delta: -15 },
    { skill: "Submachine Gun", delta: -15 },
    { skill: "Bow", delta: -15 },
  ],
};

// ===== Scene Condition Helpers =====

function writeLightingCondition(dgsm: DynamicGameStateManager, sceneId: string, lightLevel: number): void {
  clearLightingConditions(dgsm, sceneId);

  if (lightLevel === 3 || lightLevel === 4) return; // no condition needed for normal/bright

  const label = LIGHT_LEVEL_LABELS[lightLevel] ?? LIGHT_LEVEL_LABELS[1];
  const penalties = LIGHT_LEVEL_PENALTIES[lightLevel] ?? [];

  dgsm.appendSceneCondition(sceneId, {
    description: `[Lighting] ${label}`,
    mechanicalEffect: penalties.length > 0 ? { skillPenalty: penalties } : undefined,
  });
}

function clearLightingConditions(dgsm: DynamicGameStateManager, sceneId: string): void {
  const state = dgsm.getState();
  const conditions = state.scenarioConditions[sceneId];
  if (!conditions) return;
  (dgsm.getState() as any).scenarioConditions[sceneId] = conditions.filter(
    (c: any) => !c.description.startsWith("[Lighting]"),
  );
}
```

**Step 2: Build**

Run: `pnpm build`
Expected: PASS

---

## Task 5: lightingFeature — main computation and exported feature

**Files:**
- Modify: `src/dynamicworldagent/engine/features/lightingFeature.ts`

**Step 1: Add per-scene computation and the exported WorldFeature**

Append after condition helpers:

```typescript
// ===== State Helpers =====

function getLightingState(dgsm: DynamicGameStateManager, sceneId: string): LightingSceneState | undefined {
  return dgsm.getFeatureSceneState(FEATURE_ID, sceneId) as LightingSceneState | undefined;
}

function setLightingState(dgsm: DynamicGameStateManager, sceneId: string, state: LightingSceneState): void {
  dgsm.setFeatureSceneState(FEATURE_ID, sceneId, state);
}

// ===== Per-Scene Computation =====

function computeSceneLighting(
  dgsm: DynamicGameStateManager,
  sceneId: string,
  sunLevel: number,
  fireContributions: FireLightContribution[],
): LightingSceneState {
  const scene = dgsm.getScene(sceneId);
  if (!scene) return { lightLevel: 1, sources: [] };

  const isIndoor = (scene as any).indoor === true;
  const sources: Array<{ name: string; level: number }> = [];

  // Sun (outdoor only)
  if (!isIndoor && sunLevel > 0) {
    // Apply weather modifier
    const weatherMod = getWeatherLightModifier(dgsm, scene.parentLocationId);
    const adjustedSun = Math.max(1, sunLevel + weatherMod);
    sources.push({ name: "sun", level: adjustedSun });

    // Moon (outdoor, nighttime only — when base sun = 1)
    if (sunLevel === 1) {
      sources.push({ name: "moon", level: 2 });
    }
  }

  // Fire contributions
  for (const fc of fireContributions) {
    if (fc.sceneId === sceneId) {
      sources.push({ name: "fire", level: fc.lightLevel });
    }
  }

  // Item light sources
  if (scene.items) {
    for (const item of scene.items) {
      if (item.isLightSource && item.lightLevel && !item.damaged) {
        sources.push({ name: `item:${item.id}`, level: item.lightLevel });
      }
    }
  }

  // Final level = max of all sources, minimum 1
  const maxLevel = sources.length > 0
    ? Math.min(5, Math.max(...sources.map(s => s.level)))
    : 1;

  return {
    lightLevel: maxLevel,
    sources: sources.filter(s => s.level === maxLevel).map(s => s.name),
  };
}

// ===== Exported Feature =====

export const lightingFeature: WorldFeature = {
  id: FEATURE_ID,
  description: "Unified lighting system — aggregates sun, moon, fire, and item light sources with skill penalties",

  planningPrompt: `## Lighting
Current lighting conditions are shown in the state description below.
Lighting changes automatically based on time of day, weather, fire, and light source items.
Dark environments impose skill penalties. Blinding light also impairs vision.`,

  stateDescription(dgsm: DynamicGameStateManager): string {
    const allStates = dgsm.getFeatureState(FEATURE_ID);
    const entries = Object.entries(allStates);
    if (entries.length === 0) return "";

    const abnormal: string[] = [];
    for (const [sceneId, state] of entries) {
      const ls = state as LightingSceneState;
      if (ls.lightLevel !== 3 && ls.lightLevel !== 4) {
        const label = LIGHT_LEVEL_LABELS[ls.lightLevel] ?? "Unknown";
        abnormal.push(`- ${sceneId}: ${label} (level ${ls.lightLevel}/5)`);
      }
    }

    if (abnormal.length === 0) return "Lighting: Normal in all scenes";
    return "Lighting:\n" + abnormal.join("\n");
  },

  tick(dgsm: DynamicGameStateManager, runtime: TickRuntimeContext): void {
    const sunLevel = computeSunLevel(runtime.tickTime);
    const fireContributions = getFireLightContributions(dgsm);

    const state = dgsm.getState();
    state.scenes.forEach((_scene: any, sceneId: string) => {
      const lighting = computeSceneLighting(dgsm, sceneId, sunLevel, fireContributions);
      setLightingState(dgsm, sceneId, lighting);
      writeLightingCondition(dgsm, sceneId, lighting.lightLevel);
    });
  },
};
```

**Step 2: Build**

Run: `pnpm build`
Expected: PASS

---

## Task 6: Register lightingFeature

**Files:**
- Modify: `src/dynamicworldagent/engine/registerDefaults.ts`
- Modify: `src/dynamicworldagent/engine/index.ts`

**Step 1: Register in registerDefaults.ts**

Add import after weatherFeature import:

```typescript
import { lightingFeature } from "./features/lightingFeature.js";
```

Add registration after weatherFeature (order matters — lighting must tick last):

```typescript
  registry.registerFeature(lightingFeature);
```

**Step 2: Export from index.ts**

Add after weatherFeature export:

```typescript
export { lightingFeature } from "./features/lightingFeature.js";
```

**Step 3: Build**

Run: `pnpm build`
Expected: PASS

---

## Task 7: Tests

**Files:**
- Create: `src/dynamicworldagent/engine/features/__tests__/lightingFeature.test.ts`

**Step 1: Write tests**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { lightingFeature } from "../lightingFeature.js";
import type { TickRuntimeContext } from "../../types.js";
import type { SceneCondition } from "../../../dynamicBasicAgent/npcPlanning/types.js";

// ===== Mock DGSM =====

interface MockSceneItem {
  id: string;
  name: string;
  isLightSource?: boolean;
  lightLevel?: number;
  damaged?: boolean;
}

interface MockScene {
  id: string;
  name: string;
  parentLocationId: string;
  connections: string[];
  events: string[];
  indoor?: boolean;
  items?: MockSceneItem[];
  clues?: any[];
}

function createMockDgsm() {
  const featureState: Record<string, Record<string, unknown>> = {};
  const scenarioConditions: Record<string, SceneCondition[]> = {};
  const scenes = new Map<string, MockScene>();
  const blockedConnections = new Map<string, string>();

  return {
    getFeatureSceneState(featureId: string, sceneId: string) {
      return featureState[featureId]?.[sceneId];
    },
    setFeatureSceneState(featureId: string, sceneId: string, data: unknown) {
      if (!featureState[featureId]) featureState[featureId] = {};
      featureState[featureId][sceneId] = data;
    },
    getFeatureState(featureId: string) {
      return featureState[featureId] ?? {};
    },
    appendSceneCondition(scenarioId: string, condition: SceneCondition) {
      if (!scenarioConditions[scenarioId]) scenarioConditions[scenarioId] = [];
      scenarioConditions[scenarioId].push(condition);
    },
    getScene(sceneId: string) { return scenes.get(sceneId); },
    getState() {
      return { scenarioConditions, blockedConnections, scenes };
    },
    _addScene(scene: MockScene) { scenes.set(scene.id, scene); },
    _setFireState(sceneId: string, intensity: number) {
      if (!featureState["fire"]) featureState["fire"] = {};
      featureState["fire"][sceneId] = { intensity };
    },
    _setWeatherState(regionId: string, weatherType: string, intensity: number) {
      if (!featureState["weather"]) featureState["weather"] = {};
      featureState["weather"][regionId] = { weatherType, intensity, affectedSceneIds: [] };
    },
    _featureState: featureState,
    _scenarioConditions: scenarioConditions,
  };
}

type MockDgsm = ReturnType<typeof createMockDgsm>;

function createRuntime(tickTime: string): TickRuntimeContext {
  return {
    sessionId: "test", gameDay: 1, language: "en",
    tickTime, tickDurationMinutes: 5,
    npcPlanning: {
      getLongTermIntent: async () => "",
      getPendingNodes: async () => [],
      runImpactGateForNpc: async () => ({ shouldRevise: false, witnessEntry: "" }),
      appendMemoryLog: async () => {},
      getMemoryLog: async () => [],
      revisePlans: async () => {},
    },
  };
}

function setupScenes(dgsm: MockDgsm) {
  dgsm._addScene({ id: "street", name: "Street", parentLocationId: "town", connections: ["alley", "shop"], events: [] });
  dgsm._addScene({ id: "alley", name: "Dark Alley", parentLocationId: "town", connections: ["street"], events: [] });
  dgsm._addScene({ id: "shop", name: "Shop", parentLocationId: "town", connections: ["street"], events: [], indoor: true });
}

// ===== Tests =====

describe("lightingFeature", () => {
  let dgsm: MockDgsm;

  beforeEach(() => {
    dgsm = createMockDgsm();
    setupScenes(dgsm);
  });

  describe("sun curve — outdoor scenes", () => {
    it("should be bright at noon", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(5);
      expect(streetState.sources).toContain("sun");
    });

    it("should be dark at midnight", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      // Outdoor at night: sun=1, moon=2, max=2
      expect(streetState.lightLevel).toBe(2);
      expect(streetState.sources).toContain("moon");
    });

    it("should be normal at dawn (06:00)", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("06:00"));

      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(3);
    });

    it("should be normal at dusk (18:00)", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("18:00"));

      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(3);
    });
  });

  describe("indoor scenes", () => {
    it("should be pitch black without light sources", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const shopState = dgsm.getFeatureSceneState("lighting", "shop") as any;
      expect(shopState.lightLevel).toBe(1);
    });

    it("should use item light sources", () => {
      const shop = dgsm.getScene("shop")!;
      shop.items = [
        { id: "lamp", name: "Oil Lamp", isLightSource: true, lightLevel: 3 },
      ];

      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const shopState = dgsm.getFeatureSceneState("lighting", "shop") as any;
      expect(shopState.lightLevel).toBe(3);
      expect(shopState.sources).toContain("item:lamp");
    });

    it("should ignore damaged light sources", () => {
      const shop = dgsm.getScene("shop")!;
      shop.items = [
        { id: "lamp", name: "Oil Lamp", isLightSource: true, lightLevel: 3, damaged: true },
      ];

      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const shopState = dgsm.getFeatureSceneState("lighting", "shop") as any;
      expect(shopState.lightLevel).toBe(1); // no working light source
    });
  });

  describe("fire light contribution", () => {
    it("should add fire light to burning scene", () => {
      dgsm._setFireState("shop", 2); // fire intensity 2 → light level 3

      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      const shopState = dgsm.getFeatureSceneState("lighting", "shop") as any;
      expect(shopState.lightLevel).toBe(3);
      expect(shopState.sources).toContain("fire");
    });

    it("should not spread fire light to adjacent when intensity < 3", () => {
      dgsm._setFireState("alley", 2);

      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      // Street has moon (2), no fire contribution from alley (intensity < 3)
      expect(streetState.lightLevel).toBe(2);
    });

    it("should spread fire light to adjacent when intensity >= 3", () => {
      dgsm._setFireState("alley", 3); // fire 3 → light 4, adjacent gets 3

      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      // Alley itself
      const alleyState = dgsm.getFeatureSceneState("lighting", "alley") as any;
      expect(alleyState.lightLevel).toBe(4);

      // Street (adjacent) — fire adjacent=3, moon=2, max=3
      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(3);
    });

    it("should map fire intensity 5 to blinding (level 5)", () => {
      dgsm._setFireState("alley", 5); // fire 5 → light 5 (capped)

      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      const alleyState = dgsm.getFeatureSceneState("lighting", "alley") as any;
      expect(alleyState.lightLevel).toBe(5);
    });
  });

  describe("weather modifier", () => {
    it("should reduce sun level during heavy fog", () => {
      dgsm._setWeatherState("town", "fog", 5); // -2 modifier

      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      // Sun base = 5, fog modifier = -2, adjusted = 3
      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(3);
    });

    it("should reduce sun level during storm", () => {
      dgsm._setWeatherState("town", "storm", 4); // -2 modifier

      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(3);
    });

    it("should not affect indoor scenes", () => {
      dgsm._setWeatherState("town", "fog", 5);
      const shop = dgsm.getScene("shop")!;
      shop.items = [{ id: "lamp", name: "Lamp", isLightSource: true, lightLevel: 4 }];

      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const shopState = dgsm.getFeatureSceneState("lighting", "shop") as any;
      expect(shopState.lightLevel).toBe(4); // unaffected by weather
    });
  });

  describe("skill penalties", () => {
    it("should write penalties for pitch black", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      // Shop is indoor, no light sources → pitch black (1)
      const conditions = dgsm._scenarioConditions["shop"] ?? [];
      const lightCond = conditions.find(c => c.description.startsWith("[Lighting]"));
      expect(lightCond).toBeDefined();
      expect(lightCond!.description).toContain("Pitch black");

      const perception = lightCond!.mechanicalEffect?.skillPenalty?.find(p => p.skill === "Perception");
      expect(perception?.delta).toBe(-40);
    });

    it("should write penalties for blinding", () => {
      dgsm._setFireState("street", 5);

      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const conditions = dgsm._scenarioConditions["street"] ?? [];
      const lightCond = conditions.find(c => c.description.startsWith("[Lighting]"));
      expect(lightCond).toBeDefined();
      expect(lightCond!.description).toContain("Blinding");

      const perception = lightCond!.mechanicalEffect?.skillPenalty?.find(p => p.skill === "Perception");
      expect(perception?.delta).toBe(-15);
    });

    it("should not write condition for normal light", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("06:00"));

      // Street at 06:00 → sun level 3 (normal), no condition
      const conditions = dgsm._scenarioConditions["street"] ?? [];
      const lightCond = conditions.find(c => c.description.startsWith("[Lighting]"));
      expect(lightCond).toBeUndefined();
    });
  });

  describe("stateDescription", () => {
    it("should show abnormal lighting only", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      const desc = lightingFeature.stateDescription(dgsm as any);
      // Shop (pitch black) and street/alley (dark - moon) should appear
      expect(desc).toContain("shop");
      expect(desc).toContain("Pitch black");
    });

    it("should say normal when all scenes are normal", () => {
      // Give shop a light source
      const shop = dgsm.getScene("shop")!;
      shop.items = [{ id: "lamp", name: "Lamp", isLightSource: true, lightLevel: 4 }];

      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const desc = lightingFeature.stateDescription(dgsm as any);
      expect(desc).toContain("Normal");
    });
  });

  describe("max aggregation", () => {
    it("should take max of multiple light sources", () => {
      // Indoor shop with candle (2) + lamp (4)
      const shop = dgsm.getScene("shop")!;
      shop.items = [
        { id: "candle", name: "Candle", isLightSource: true, lightLevel: 2 },
        { id: "lamp", name: "Lamp", isLightSource: true, lightLevel: 4 },
      ];

      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      const shopState = dgsm.getFeatureSceneState("lighting", "shop") as any;
      expect(shopState.lightLevel).toBe(4);
      expect(shopState.sources).toContain("item:lamp");
    });
  });
});
```

**Step 2: Run tests**

Run: `pnpm test -- --run src/dynamicworldagent/engine/features/__tests__/lightingFeature.test.ts`
Expected: ALL PASS

---

## Task 8: Build and verify all feature tests pass

**Step 1: Full build**

Run: `pnpm build`
Expected: PASS

**Step 2: Run all feature tests**

Run: `pnpm test -- --run src/dynamicworldagent/engine/features/__tests__/`
Expected: ALL PASS (fire + weather + lighting)

---

## Summary of All File Changes

| File | Action |
|------|--------|
| `src/dynamicworldagent/world_builder/types.ts` | Add `isLightSource?`, `lightLevel?` to SceneItem |
| `src/dynamicworldagent/engine/features/lightingFeature.ts` | **NEW** — full lighting feature |
| `src/dynamicworldagent/engine/features/__tests__/lightingFeature.test.ts` | **NEW** — lighting tests |
| `src/dynamicworldagent/engine/registerDefaults.ts` | Register lightingFeature (after weather) |
| `src/dynamicworldagent/engine/index.ts` | Export lightingFeature |
