# Weather Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a regional weather WorldFeature with 7 weather types, Markov chain evolution, skill penalties, connection blocking, and HP drain.

**Architecture:** Weather is a tick-only WorldFeature (no activate/propagate). Each region (= parentLocationId) has independent weather evolving via Markov chain. Only outdoor scenes (indoor !== true) are affected. Module presets provide initial weather; first tick auto-initializes.

**Tech Stack:** TypeScript, Vitest

---

## Task 1: Add `indoor` field to DynamicScene

**Files:**
- Modify: `src/dynamicworldagent/world_builder/types.ts:82-93`

**Step 1: Add field**

In `DynamicScene` interface (line 92, before closing `}`), add:

```typescript
  indoor?: boolean;
```

**Step 2: Build**

Run: `pnpm build`
Expected: PASS (optional field, no breakage)

---

## Task 2: Add `weatherPresets` to ModuleDigest

**Files:**
- Modify: `src/dynamicworldagent/world_builder/types.ts:358-375`

**Step 1: Add field**

In `ModuleDigest` interface (before closing `}`), add:

```typescript
  weatherPresets?: Array<{
    regionId: string;
    weatherType: "clear" | "rain" | "fog" | "storm" | "snow" | "extreme_heat" | "extreme_cold";
    intensity: number;
  }>;
```

**Step 2: Build**

Run: `pnpm build`
Expected: PASS

---

## Task 3: Fix fireFeature "Spot Hidden" → "Perception"

**Files:**
- Modify: `src/dynamicworldagent/engine/features/fireFeature.ts`
- Test: `src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts`

**Step 1: Replace all `"Spot Hidden"` with `"Perception"` in fireFeature.ts**

Lines 72, 112, 115, 118 — replace `"Spot Hidden"` → `"Perception"`.

**Step 2: Update tests**

In `fireFeature.test.ts`, replace all `"Spot Hidden"` assertions with `"Perception"`.

**Step 3: Run tests**

Run: `pnpm test -- --run src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts`
Expected: ALL PASS

---

## Task 4: Create weatherFeature.ts — types, constants, Markov matrix

**Files:**
- Create: `src/dynamicworldagent/engine/features/weatherFeature.ts`

**Step 1: Write types, constants, and transition matrix**

```typescript
import type {
  WorldFeature,
  TickRuntimeContext,
} from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";

// ===== Types =====

export type WeatherType = "clear" | "rain" | "fog" | "storm" | "snow" | "extreme_heat" | "extreme_cold";

export interface WeatherRegionState {
  weatherType: WeatherType;
  intensity: number;           // 0-5
  ticksInState: number;
  affectedSceneIds: string[];  // outdoor scenes in this region
  exposureTicks: Record<string, number>; // characterId → accumulated extreme-temp exposure ticks
}

// ===== Constants =====

const FEATURE_ID = "weather";
const TICKS_PER_TRANSITION_CHECK = 6; // check every 30 min
const MAX_INTENSITY = 5;
const HP_DRAIN_INTERVAL = 6;          // every 6 ticks for extreme temp
const HP_DRAIN_INTENSITY_THRESHOLD = 3;
const BLOCKING_INTENSITY_THRESHOLD = 4;

const WEATHER_TYPES: WeatherType[] = [
  "clear", "rain", "fog", "storm", "snow", "extreme_heat", "extreme_cold",
];

// Row = current type, Col = next type (same order as WEATHER_TYPES)
const TRANSITION_MATRIX: number[][] = [
  // clear  rain   fog   storm  snow   heat   cold
  [  0.65,  0.10,  0.10, 0.02,  0.03,  0.05,  0.05 ], // clear
  [  0.10,  0.45,  0.10, 0.20,  0.05,  0.00,  0.10 ], // rain
  [  0.25,  0.15,  0.55, 0.00,  0.03,  0.02,  0.00 ], // fog
  [  0.05,  0.35,  0.00, 0.50,  0.05,  0.00,  0.05 ], // storm
  [  0.05,  0.05,  0.05, 0.05,  0.55,  0.00,  0.25 ], // snow
  [  0.25,  0.00,  0.05, 0.03,  0.00,  0.67,  0.00 ], // extreme_heat
  [  0.10,  0.00,  0.05, 0.05,  0.20,  0.00,  0.60 ], // extreme_cold
];

// Intensity change probabilities when type stays the same
const INTENSITY_NO_CHANGE = 0.60;
const INTENSITY_UP = 0.20;
// INTENSITY_DOWN = 0.20 (implicit)
```

**Step 2: Build**

Run: `pnpm build`
Expected: PASS

---

## Task 5: weatherFeature — skill penalty definitions

**Files:**
- Modify: `src/dynamicworldagent/engine/features/weatherFeature.ts`

**Step 1: Add skill penalty config**

Append after constants:

```typescript
// ===== Skill Penalty Definitions =====

interface SkillPenaltyRule {
  skill: string;
  triggerIntensity: number;  // minimum intensity to apply
  deltaPerLevel: number;     // penalty per intensity level
}

const WEATHER_SKILL_PENALTIES: Partial<Record<WeatherType, SkillPenaltyRule[]>> = {
  rain: [
    { skill: "Perception", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Track", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Drive Auto", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Listen", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Climb", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Pistol", triggerIntensity: 3, deltaPerLevel: -5 },
    { skill: "Rifle", triggerIntensity: 3, deltaPerLevel: -5 },
    { skill: "Submachine Gun", triggerIntensity: 3, deltaPerLevel: -5 },
    { skill: "Bow", triggerIntensity: 3, deltaPerLevel: -5 },
    { skill: "Electrical Repair", triggerIntensity: 3, deltaPerLevel: -5 },
  ],
  fog: [
    { skill: "Perception", triggerIntensity: 1, deltaPerLevel: -10 },
    { skill: "Navigate", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Drive Auto", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Track", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Pistol", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Rifle", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Submachine Gun", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Bow", triggerIntensity: 2, deltaPerLevel: -5 },
  ],
  storm: [
    { skill: "Perception", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Listen", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Drive Auto", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Navigate", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Climb", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Swim", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Pilot (Boat)", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Pistol", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Rifle", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Submachine Gun", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Bow", triggerIntensity: 2, deltaPerLevel: -5 },
  ],
  snow: [
    { skill: "Perception", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Drive Auto", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Climb", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Track", triggerIntensity: 3, deltaPerLevel: -5 },
    { skill: "Navigate", triggerIntensity: 3, deltaPerLevel: -5 },
  ],
  extreme_heat: [
    { skill: "Climb", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Stealth", triggerIntensity: 3, deltaPerLevel: -5 },
  ],
  extreme_cold: [
    { skill: "Locksmith", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Sleight of Hand", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Climb", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Mechanical Repair", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Electrical Repair", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Swim", triggerIntensity: 2, deltaPerLevel: -10 },
    { skill: "Pistol", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Rifle", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Submachine Gun", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Bow", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "First Aid", triggerIntensity: 3, deltaPerLevel: -5 },
  ],
};
```

**Step 2: Build**

Run: `pnpm build`
Expected: PASS

---

## Task 6: weatherFeature — helper functions

**Files:**
- Modify: `src/dynamicworldagent/engine/features/weatherFeature.ts`

**Step 1: Add helper functions**

Append after skill penalty definitions:

```typescript
// ===== Helper Functions =====

function getWeatherState(dgsm: DynamicGameStateManager, regionId: string): WeatherRegionState | undefined {
  return dgsm.getFeatureSceneState(FEATURE_ID, regionId) as WeatherRegionState | undefined;
}

function setWeatherState(dgsm: DynamicGameStateManager, regionId: string, state: WeatherRegionState): void {
  dgsm.setFeatureSceneState(FEATURE_ID, regionId, state);
}

function getAllWeatherRegions(dgsm: DynamicGameStateManager): string[] {
  return Object.keys(dgsm.getFeatureState(FEATURE_ID));
}

function getOutdoorSceneIds(dgsm: DynamicGameStateManager, regionId: string): string[] {
  const sceneIds: string[] = [];
  const state = dgsm.getState();
  state.scenes.forEach((scene, id) => {
    if (scene.parentLocationId === regionId && !scene.indoor) {
      sceneIds.push(id);
    }
  });
  return sceneIds;
}

function createWeatherState(
  weatherType: WeatherType,
  intensity: number,
  affectedSceneIds: string[],
): WeatherRegionState {
  return {
    weatherType,
    intensity: weatherType === "clear" ? 0 : Math.max(1, Math.min(intensity, MAX_INTENSITY)),
    ticksInState: 0,
    affectedSceneIds,
    exposureTicks: {},
  };
}

/** Sample from transition matrix row using cumulative probabilities */
function sampleTransition(currentType: WeatherType): WeatherType {
  const rowIndex = WEATHER_TYPES.indexOf(currentType);
  const row = TRANSITION_MATRIX[rowIndex];
  const r = Math.random();
  let cumulative = 0;
  for (let i = 0; i < row.length; i++) {
    cumulative += row[i];
    if (r < cumulative) return WEATHER_TYPES[i];
  }
  return WEATHER_TYPES[row.length - 1]; // fallback (rounding)
}

/** Evolve intensity: 60% stay, 20% up, 20% down */
function evolveIntensity(current: number): number {
  const r = Math.random();
  if (r < INTENSITY_NO_CHANGE) return current;
  if (r < INTENSITY_NO_CHANGE + INTENSITY_UP) return Math.min(current + 1, MAX_INTENSITY);
  return current - 1; // may go to 0 → triggers revert to clear
}

function computeSkillPenalties(weatherType: WeatherType, intensity: number): Array<{ skill: string; delta: number }> {
  const rules = WEATHER_SKILL_PENALTIES[weatherType];
  if (!rules || intensity <= 0) return [];

  const penalties: Array<{ skill: string; delta: number }> = [];
  for (const rule of rules) {
    if (intensity >= rule.triggerIntensity) {
      penalties.push({ skill: rule.skill, delta: rule.deltaPerLevel * intensity });
    }
  }
  return penalties;
}

const WEATHER_LABELS: Record<WeatherType, string[]> = {
  clear: ["Clear skies"],
  rain: ["", "Light drizzle", "Moderate rain", "Heavy rain", "Downpour", "Torrential rain"],
  fog: ["", "Light mist", "Moderate fog", "Thick fog", "Dense fog", "Zero visibility fog"],
  storm: ["", "Light winds", "Gusty winds", "Strong storm", "Severe storm", "Hurricane-force winds"],
  snow: ["", "Light flurries", "Moderate snow", "Heavy snow", "Blizzard", "Severe blizzard"],
  extreme_heat: ["", "Warm", "Hot", "Very hot", "Extreme heat", "Lethal heat"],
  extreme_cold: ["", "Chilly", "Cold", "Very cold", "Extreme cold", "Lethal cold"],
};

function getWeatherLabel(weatherType: WeatherType, intensity: number): string {
  if (weatherType === "clear") return "Clear skies";
  const labels = WEATHER_LABELS[weatherType];
  return labels[intensity] ?? labels[labels.length - 1];
}

function writeWeatherConditions(dgsm: DynamicGameStateManager, regionState: WeatherRegionState): void {
  const { weatherType, intensity, affectedSceneIds } = regionState;

  for (const sceneId of affectedSceneIds) {
    // Clear existing weather conditions
    clearWeatherConditions(dgsm, sceneId);

    if (weatherType === "clear" || intensity <= 0) continue;

    const label = getWeatherLabel(weatherType, intensity);
    const penalties = computeSkillPenalties(weatherType, intensity);

    dgsm.appendSceneCondition(sceneId, {
      description: `[Weather] ${label}`,
      mechanicalEffect: penalties.length > 0 ? { skillPenalty: penalties } : undefined,
    });
  }
}

function clearWeatherConditions(dgsm: DynamicGameStateManager, sceneId: string): void {
  const state = dgsm.getState();
  const conditions = state.scenarioConditions[sceneId];
  if (!conditions) return;
  (dgsm.getState() as any).scenarioConditions[sceneId] = conditions.filter(
    c => !c.description.startsWith("[Weather]"),
  );
}

function updateWeatherBlocking(dgsm: DynamicGameStateManager, regionState: WeatherRegionState): void {
  const { weatherType, intensity, affectedSceneIds } = regionState;
  const shouldBlock = (weatherType === "storm" || weatherType === "snow") && intensity >= BLOCKING_INTENSITY_THRESHOLD;

  for (const sceneId of affectedSceneIds) {
    const scene = dgsm.getScene(sceneId);
    if (!scene) continue;

    for (const connId of scene.connections) {
      const connScene = dgsm.getScene(connId);
      // Only block outdoor-to-outdoor connections
      if (!connScene || connScene.indoor) continue;

      if (shouldBlock) {
        dgsm.setConnectionBlocked(connId, sceneId, true, `Blocked by ${weatherType} (intensity ${intensity})`);
      } else {
        // Unblock only weather-blocked connections
        const state = dgsm.getState();
        const key1 = `${connId}::${sceneId}`;
        const key2 = `${sceneId}::${connId}`;
        const reason1 = state.blockedConnections.get(key1);
        const reason2 = state.blockedConnections.get(key2);
        if (reason1 && (reason1.startsWith("Blocked by storm") || reason1.startsWith("Blocked by snow"))) {
          dgsm.setConnectionBlocked(connId, sceneId, false, "");
        }
        if (reason2 && (reason2.startsWith("Blocked by storm") || reason2.startsWith("Blocked by snow"))) {
          dgsm.setConnectionBlocked(sceneId, connId, false, "");
        }
      }
    }
  }
}
```

**Step 2: Build**

Run: `pnpm build`
Expected: PASS

---

## Task 7: weatherFeature — HP drain logic

**Files:**
- Modify: `src/dynamicworldagent/engine/features/weatherFeature.ts`

**Step 1: Add HP drain function**

Append after helper functions:

```typescript
// ===== HP Drain for Extreme Temperatures =====

function processExposureDrain(dgsm: DynamicGameStateManager, regionState: WeatherRegionState): void {
  const { weatherType, intensity, affectedSceneIds, exposureTicks } = regionState;

  const isExtreme = (weatherType === "extreme_heat" || weatherType === "extreme_cold") && intensity >= HP_DRAIN_INTENSITY_THRESHOLD;

  if (!isExtreme) {
    // Reset exposure when not extreme
    regionState.exposureTicks = {};
    return;
  }

  // Find all characters in affected outdoor scenes
  const state = dgsm.getState();
  const charsInRegion: string[] = [];

  // Check player location
  if (state.currentSceneId && affectedSceneIds.includes(state.currentSceneId)) {
    charsInRegion.push("__player__");
  }

  // Check NPC locations
  for (const [npcId, location] of Object.entries(state.npcLocations)) {
    if (affectedSceneIds.includes(location)) {
      charsInRegion.push(npcId);
    }
  }

  // Update exposure ticks and drain HP
  for (const charId of charsInRegion) {
    exposureTicks[charId] = (exposureTicks[charId] ?? 0) + 1;

    if (exposureTicks[charId] >= HP_DRAIN_INTERVAL) {
      exposureTicks[charId] = 0;

      // CON check: simple random check against CON/5 (simplified)
      // For now, 50% chance of failure at threshold, scaling with intensity
      const failChance = 0.3 + (intensity - HP_DRAIN_INTENSITY_THRESHOLD) * 0.15;
      if (Math.random() < failChance) {
        if (charId === "__player__") {
          // Damage player HP
          const player = state.playerCharacter;
          if (player?.status?.hp !== undefined) {
            player.status.hp = Math.max(0, player.status.hp - 1);
          }
        } else {
          // Damage NPC HP
          dgsm.updateNpcHp(charId, -1);
        }
      }
    }
  }

  // Clean up exposure for characters no longer in region
  for (const charId of Object.keys(exposureTicks)) {
    if (!charsInRegion.includes(charId)) {
      delete exposureTicks[charId];
    }
  }
}
```

**Step 2: Build**

Run: `pnpm build`
Expected: PASS

---

## Task 8: weatherFeature — init and tick logic + export

**Files:**
- Modify: `src/dynamicworldagent/engine/features/weatherFeature.ts`

**Step 1: Add init helper and the exported WorldFeature object**

Append after HP drain function:

```typescript
// ===== Initialization =====

function initWeatherFromPresets(dgsm: DynamicGameStateManager): void {
  const state = dgsm.getState();

  // Collect all unique regionIds (parentLocationId)
  const regionIds = new Set<string>();
  state.scenes.forEach(scene => {
    regionIds.add(scene.parentLocationId);
  });

  // Read module presets if available
  const presets: Array<{ regionId: string; weatherType: WeatherType; intensity: number }> =
    (state as any).moduleDigest?.weatherPresets ?? [];

  const presetMap = new Map<string, { weatherType: WeatherType; intensity: number }>();
  for (const p of presets) {
    presetMap.set(p.regionId, { weatherType: p.weatherType, intensity: p.intensity });
  }

  // Initialize each region
  for (const regionId of regionIds) {
    const outdoorScenes = getOutdoorSceneIds(dgsm, regionId);
    if (outdoorScenes.length === 0) continue; // skip fully indoor regions

    const preset = presetMap.get(regionId);
    const weatherType = preset?.weatherType ?? "clear";
    const intensity = preset?.intensity ?? 0;

    const regionState = createWeatherState(weatherType, intensity, outdoorScenes);
    setWeatherState(dgsm, regionId, regionState);

    // Write initial conditions
    if (weatherType !== "clear" && intensity > 0) {
      writeWeatherConditions(dgsm, regionState);
      updateWeatherBlocking(dgsm, regionState);
    }
  }
}

// ===== Exported Feature =====

export const weatherFeature: WorldFeature = {
  id: FEATURE_ID,
  description: "Regional weather system — Markov chain evolution with skill penalties, connection blocking, and HP drain",

  planningPrompt: `## Weather
Current weather conditions are shown in the state description below.
Weather changes automatically — you do NOT need to set or control weather.
Weather affects outdoor scenes only (skill penalties, blocked paths in severe weather).`,

  // No planNodeSchema — LLM does not output weather fields
  // No propagation — weather does not spread spatially

  stateDescription(dgsm: DynamicGameStateManager): string {
    const regionIds = getAllWeatherRegions(dgsm);
    if (regionIds.length === 0) return "";

    const lines: string[] = [];
    for (const regionId of regionIds) {
      const ws = getWeatherState(dgsm, regionId);
      if (!ws || ws.weatherType === "clear") continue;
      const label = getWeatherLabel(ws.weatherType, ws.intensity);
      lines.push(`- ${regionId}: ${ws.weatherType} intensity ${ws.intensity}/5 (${label})`);
    }

    if (lines.length === 0) return "Weather: Clear in all regions";
    return "Weather:\n" + lines.join("\n");
  },

  tick(dgsm: DynamicGameStateManager, _runtime: TickRuntimeContext): void {
    // Auto-initialize on first tick
    const regions = getAllWeatherRegions(dgsm);
    if (regions.length === 0) {
      initWeatherFromPresets(dgsm);
      return; // first tick is init only
    }

    for (const regionId of regions) {
      const ws = getWeatherState(dgsm, regionId);
      if (!ws) continue;

      ws.ticksInState++;

      // Markov transition check every N ticks
      if (ws.ticksInState >= TICKS_PER_TRANSITION_CHECK) {
        ws.ticksInState = 0;

        const newType = sampleTransition(ws.weatherType);

        if (newType !== ws.weatherType) {
          // Type changed — start new weather at intensity 1
          ws.weatherType = newType;
          ws.intensity = newType === "clear" ? 0 : 1;
          ws.exposureTicks = {};
        } else if (ws.weatherType !== "clear") {
          // Same type — evolve intensity
          ws.intensity = evolveIntensity(ws.intensity);
          if (ws.intensity <= 0) {
            // Intensity dropped to 0 → revert to clear
            ws.weatherType = "clear";
            ws.intensity = 0;
            ws.exposureTicks = {};
          }
        }

        // Update scene conditions and blocking
        writeWeatherConditions(dgsm, ws);
        updateWeatherBlocking(dgsm, ws);
      }

      // Process HP drain for extreme temperatures
      processExposureDrain(dgsm, ws);

      // Persist
      setWeatherState(dgsm, regionId, ws);
    }
  },
};
```

**Step 2: Build**

Run: `pnpm build`
Expected: PASS

---

## Task 9: Register weatherFeature

**Files:**
- Modify: `src/dynamicworldagent/engine/registerDefaults.ts`
- Modify: `src/dynamicworldagent/engine/index.ts`

**Step 1: Register in registerDefaults.ts**

Add import (after fireFeature import):

```typescript
import { weatherFeature } from "./features/weatherFeature.js";
```

Add registration (after `registry.registerFeature(fireFeature)`):

```typescript
  registry.registerFeature(weatherFeature);
```

**Step 2: Export from index.ts**

Add (after fireFeature export):

```typescript
export { weatherFeature } from "./features/weatherFeature.js";
```

**Step 3: Build**

Run: `pnpm build`
Expected: PASS

---

## Task 10: Tests — Markov transition and intensity evolution

**Files:**
- Create: `src/dynamicworldagent/engine/features/__tests__/weatherFeature.test.ts`

**Step 1: Write tests**

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { weatherFeature } from "../weatherFeature.js";
import type { TickRuntimeContext } from "../../types.js";
import type { SceneCondition } from "../../../dynamicBasicAgent/npcPlanning/types.js";

// ===== Mock DGSM =====

interface MockScene {
  id: string;
  name: string;
  parentLocationId: string;
  connections: string[];
  events: string[];
  indoor?: boolean;
  clues?: any[];
  items?: any[];
}

function createMockDgsm() {
  const featureState: Record<string, Record<string, unknown>> = {};
  const scenarioConditions: Record<string, SceneCondition[]> = {};
  const blockedConnections = new Map<string, string>();
  const scenes = new Map<string, MockScene>();
  const npcLocations: Record<string, string> = {};
  const npcStats: Record<string, { hp: number; san: number }> = {};

  return {
    getFeatureSceneState(featureId: string, sceneId: string) {
      return featureState[featureId]?.[sceneId];
    },
    setFeatureSceneState(featureId: string, sceneId: string, data: unknown) {
      if (!featureState[featureId]) featureState[featureId] = {};
      featureState[featureId][sceneId] = data;
    },
    removeFeatureSceneState(featureId: string, sceneId: string) {
      if (featureState[featureId]) delete featureState[featureId][sceneId];
    },
    getFeatureState(featureId: string) {
      return featureState[featureId] ?? {};
    },
    appendSceneCondition(scenarioId: string, condition: SceneCondition) {
      if (!scenarioConditions[scenarioId]) scenarioConditions[scenarioId] = [];
      scenarioConditions[scenarioId].push(condition);
    },
    getScene(sceneId: string) {
      return scenes.get(sceneId);
    },
    getState() {
      return {
        scenarioConditions,
        blockedConnections,
        scenes,
        currentSceneId: "town_square",
        playerCharacter: { status: { hp: 10 } },
        npcLocations,
        npcStats,
      };
    },
    setConnectionBlocked(fromId: string, toId: string, blocked: boolean, reason: string) {
      const key = `${fromId}::${toId}`;
      if (blocked) blockedConnections.set(key, reason);
      else { blockedConnections.delete(key); blockedConnections.delete(`${toId}::${fromId}`); }
    },
    updateNpcHp(npcId: string, delta: number) {
      if (!npcStats[npcId]) return;
      npcStats[npcId].hp = Math.max(0, npcStats[npcId].hp + delta);
    },
    _addScene(scene: MockScene) { scenes.set(scene.id, scene); },
    _addNpc(npcId: string, location: string, hp: number) {
      npcLocations[npcId] = location;
      npcStats[npcId] = { hp, san: 50 };
    },
    _featureState: featureState,
    _scenarioConditions: scenarioConditions,
    _blockedConnections: blockedConnections,
  };
}

type MockDgsm = ReturnType<typeof createMockDgsm>;

function createMockRuntime(): TickRuntimeContext {
  return {
    sessionId: "test", gameDay: 1, language: "en",
    tickTime: "08:00", tickDurationMinutes: 5,
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

function runTicks(dgsm: MockDgsm, runtime: TickRuntimeContext, count: number) {
  for (let i = 0; i < count; i++) {
    weatherFeature.tick!(dgsm as any, runtime);
  }
}

function setupDefaultScenes(dgsm: MockDgsm) {
  dgsm._addScene({ id: "town_square", name: "Town Square", parentLocationId: "town", connections: ["main_street"], events: [] });
  dgsm._addScene({ id: "main_street", name: "Main Street", parentLocationId: "town", connections: ["town_square", "tavern"], events: [] });
  dgsm._addScene({ id: "tavern", name: "Tavern", parentLocationId: "town", connections: ["main_street"], events: [], indoor: true });
  dgsm._addScene({ id: "forest_path", name: "Forest Path", parentLocationId: "forest", connections: ["forest_clearing"], events: [] });
  dgsm._addScene({ id: "forest_clearing", name: "Forest Clearing", parentLocationId: "forest", connections: ["forest_path"], events: [] });
}

// ===== Tests =====

describe("weatherFeature", () => {
  let dgsm: MockDgsm;
  let runtime: TickRuntimeContext;

  beforeEach(() => {
    dgsm = createMockDgsm();
    runtime = createMockRuntime();
    setupDefaultScenes(dgsm);
  });

  describe("initialization", () => {
    it("should auto-initialize regions on first tick", () => {
      runTicks(dgsm, runtime, 1);

      // Two regions: town and forest
      const townState = dgsm.getFeatureSceneState("weather", "town") as any;
      const forestState = dgsm.getFeatureSceneState("weather", "forest") as any;
      expect(townState).toBeDefined();
      expect(forestState).toBeDefined();
      expect(townState.weatherType).toBe("clear");
      expect(forestState.weatherType).toBe("clear");
    });

    it("should only include outdoor scenes in affectedSceneIds", () => {
      runTicks(dgsm, runtime, 1);

      const townState = dgsm.getFeatureSceneState("weather", "town") as any;
      expect(townState.affectedSceneIds).toContain("town_square");
      expect(townState.affectedSceneIds).toContain("main_street");
      expect(townState.affectedSceneIds).not.toContain("tavern"); // indoor
    });
  });

  describe("stateDescription", () => {
    it("should show clear when all regions are clear", () => {
      runTicks(dgsm, runtime, 1);
      const desc = weatherFeature.stateDescription(dgsm as any);
      expect(desc).toContain("Clear");
    });
  });

  describe("tick — Markov transition", () => {
    it("should not change weather before transition check interval", () => {
      runTicks(dgsm, runtime, 1); // init

      // Manually set weather to rain
      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "rain";
      ws.intensity = 3;
      ws.ticksInState = 0;
      dgsm.setFeatureSceneState("weather", "town", ws);

      // Run 5 ticks (< 6 threshold)
      runTicks(dgsm, runtime, 5);

      const updated = dgsm.getFeatureSceneState("weather", "town") as any;
      expect(updated.weatherType).toBe("rain");
      expect(updated.intensity).toBe(3);
      expect(updated.ticksInState).toBe(5);
    });

    it("should check transition at interval and potentially change", () => {
      runTicks(dgsm, runtime, 1); // init

      // Set to rain and run enough ticks to trigger check
      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "rain";
      ws.intensity = 3;
      ws.ticksInState = 5; // next tick triggers check
      dgsm.setFeatureSceneState("weather", "town", ws);

      // Mock Math.random to force specific transition
      const mockRandom = vi.spyOn(Math, "random");
      // First call: sampleTransition — rain row: cumsum = [0.10, 0.55, 0.65, 0.85, 0.90, 0.90, 1.00]
      // random = 0.01 → clear
      mockRandom.mockReturnValueOnce(0.01);

      runTicks(dgsm, runtime, 1);

      const updated = dgsm.getFeatureSceneState("weather", "town") as any;
      expect(updated.weatherType).toBe("clear");
      expect(updated.intensity).toBe(0);

      mockRandom.mockRestore();
    });

    it("should evolve intensity when type stays the same", () => {
      runTicks(dgsm, runtime, 1); // init

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "rain";
      ws.intensity = 2;
      ws.ticksInState = 5;
      dgsm.setFeatureSceneState("weather", "town", ws);

      const mockRandom = vi.spyOn(Math, "random");
      // sampleTransition: rain row cumsum [0.10, 0.55, ...], random=0.30 → rain (stays)
      mockRandom.mockReturnValueOnce(0.30);
      // evolveIntensity: random=0.75 → up (0.60 < 0.75 < 0.80)
      mockRandom.mockReturnValueOnce(0.75);

      runTicks(dgsm, runtime, 1);

      const updated = dgsm.getFeatureSceneState("weather", "town") as any;
      expect(updated.weatherType).toBe("rain");
      expect(updated.intensity).toBe(3);

      mockRandom.mockRestore();
    });

    it("should revert to clear when intensity drops to 0", () => {
      runTicks(dgsm, runtime, 1); // init

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "rain";
      ws.intensity = 1;
      ws.ticksInState = 5;
      dgsm.setFeatureSceneState("weather", "town", ws);

      const mockRandom = vi.spyOn(Math, "random");
      // sampleTransition: stay rain
      mockRandom.mockReturnValueOnce(0.30);
      // evolveIntensity: random=0.95 → down (>=0.80), 1-1=0 → clear
      mockRandom.mockReturnValueOnce(0.95);

      runTicks(dgsm, runtime, 1);

      const updated = dgsm.getFeatureSceneState("weather", "town") as any;
      expect(updated.weatherType).toBe("clear");
      expect(updated.intensity).toBe(0);

      mockRandom.mockRestore();
    });
  });

  describe("skill penalties", () => {
    it("should write fog penalties to outdoor scenes only", () => {
      runTicks(dgsm, runtime, 1); // init

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "fog";
      ws.intensity = 3;
      ws.ticksInState = 5;
      dgsm.setFeatureSceneState("weather", "town", ws);

      // Force stay fog
      const mockRandom = vi.spyOn(Math, "random");
      mockRandom.mockReturnValueOnce(0.50); // fog stays (cumsum 0.25, 0.40, 0.95)
      mockRandom.mockReturnValueOnce(0.30); // intensity no change
      // forest region transition (also needs random values)
      mockRandom.mockReturnValueOnce(0.50); // clear stays
      runTicks(dgsm, runtime, 1);

      // town_square should have weather condition
      const squareConditions = dgsm._scenarioConditions["town_square"] ?? [];
      const weatherCond = squareConditions.find(c => c.description.startsWith("[Weather]"));
      expect(weatherCond).toBeDefined();
      expect(weatherCond!.mechanicalEffect?.skillPenalty).toBeDefined();

      const perception = weatherCond!.mechanicalEffect!.skillPenalty!.find(p => p.skill === "Perception");
      expect(perception).toBeDefined();
      expect(perception!.delta).toBe(-30); // -10 * 3

      // tavern (indoor) should have NO weather condition
      const tavernConditions = dgsm._scenarioConditions["tavern"] ?? [];
      const tavernWeather = tavernConditions.find(c => c.description.startsWith("[Weather]"));
      expect(tavernWeather).toBeUndefined();

      mockRandom.mockRestore();
    });
  });

  describe("connection blocking", () => {
    it("should block outdoor connections during severe storm", () => {
      runTicks(dgsm, runtime, 1); // init

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "storm";
      ws.intensity = 4;
      ws.ticksInState = 5;
      dgsm.setFeatureSceneState("weather", "town", ws);

      const mockRandom = vi.spyOn(Math, "random");
      mockRandom.mockReturnValueOnce(0.40); // storm stays
      mockRandom.mockReturnValueOnce(0.30); // intensity no change
      mockRandom.mockReturnValueOnce(0.50); // forest clear stays
      runTicks(dgsm, runtime, 1);

      // town_square <-> main_street should be blocked
      expect(dgsm._blockedConnections.has("main_street::town_square") || dgsm._blockedConnections.has("town_square::main_street")).toBe(true);

      // main_street <-> tavern should NOT be blocked (tavern is indoor)
      expect(dgsm._blockedConnections.has("tavern::main_street")).toBe(false);
      expect(dgsm._blockedConnections.has("main_street::tavern")).toBe(false);

      mockRandom.mockRestore();
    });
  });

  describe("HP drain", () => {
    it("should drain HP for characters in extreme cold outdoor scenes", () => {
      runTicks(dgsm, runtime, 1); // init

      // Place NPC in outdoor scene
      dgsm._addNpc("npc_guard", "town_square", 10);

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "extreme_cold";
      ws.intensity = 4;
      ws.ticksInState = 0;
      dgsm.setFeatureSceneState("weather", "town", ws);

      // Run 6 ticks (HP_DRAIN_INTERVAL) — no transition check yet
      const mockRandom = vi.spyOn(Math, "random");
      // For processExposureDrain: failChance = 0.3 + (4-3)*0.15 = 0.45
      // We need to mock the random for CON check on tick 6
      // Ticks 1-5: exposure increments, no drain
      // Tick 6: exposure reaches 6 → drain check
      for (let i = 0; i < 5; i++) {
        mockRandom.mockReturnValueOnce(0.99); // no drain (random > failChance)
      }
      mockRandom.mockReturnValueOnce(0.10); // tick 6: drain succeeds (0.10 < 0.45)

      runTicks(dgsm, runtime, 6);

      const npcHp = dgsm.getState().npcStats["npc_guard"].hp;
      expect(npcHp).toBe(9); // lost 1 HP

      mockRandom.mockRestore();
    });
  });
});
```

**Step 2: Run tests**

Run: `pnpm test -- --run src/dynamicworldagent/engine/features/__tests__/weatherFeature.test.ts`
Expected: ALL PASS

---

## Task 11: Build and verify all tests pass

**Step 1: Full build**

Run: `pnpm build`
Expected: PASS

**Step 2: Run all feature tests**

Run: `pnpm test -- --run src/dynamicworldagent/engine/features/__tests__/`
Expected: ALL PASS (both fire and weather tests)

---

## Summary of All File Changes

| File | Action |
|------|--------|
| `src/dynamicworldagent/world_builder/types.ts` | Add `indoor?` to DynamicScene, `weatherPresets?` to ModuleDigest |
| `src/dynamicworldagent/engine/features/fireFeature.ts` | Replace `"Spot Hidden"` → `"Perception"` |
| `src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts` | Replace `"Spot Hidden"` → `"Perception"` in assertions |
| `src/dynamicworldagent/engine/features/weatherFeature.ts` | **NEW** — full weather feature implementation |
| `src/dynamicworldagent/engine/features/__tests__/weatherFeature.test.ts` | **NEW** — weather feature tests |
| `src/dynamicworldagent/engine/registerDefaults.ts` | Register weatherFeature |
| `src/dynamicworldagent/engine/index.ts` | Export weatherFeature |
