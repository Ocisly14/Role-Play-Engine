# Stamina Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract existing binary staminaState into a WorldFeature with 3-level fatigue (rested/tired/exhausted), unified environmental drain, and NPC tracking.

**Architecture:** Stamina is a tick-driven WorldFeature that stores per-character state using characterId as featureState key. It reads fire and weather state each tick to accelerate fatigue in harsh environments. Registered last (after fire, weather, lighting) so it can read their state.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Create staminaFeature.ts with types and tick logic

**Files:**
- Create: `src/dynamicworldagent/engine/features/staminaFeature.ts`
- Test: `src/dynamicworldagent/engine/features/__tests__/staminaFeature.test.ts`

**Step 1: Write the test file with basic tick tests**

Create `src/dynamicworldagent/engine/features/__tests__/staminaFeature.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { staminaFeature } from "../staminaFeature.js";
import type { TickRuntimeContext } from "../../types.js";

// ===== Mock DGSM =====

function createMockDgsm() {
  const featureState: Record<string, Record<string, unknown>> = {};
  const npcLocations: Record<string, string> = {};
  const npcStats: Record<string, { hp: number; san: number }> = {};
  let currentSceneId = "town_square";
  const playerCharacter = {
    id: "player1",
    attributes: { con: 12 },
    status: { hp: 10, maxHp: 14, sanity: 50, maxSanity: 60 },
  };

  return {
    getFeatureSceneState(featureId: string, key: string) {
      return featureState[featureId]?.[key];
    },
    setFeatureSceneState(featureId: string, key: string, data: unknown) {
      if (!featureState[featureId]) featureState[featureId] = {};
      featureState[featureId][key] = data;
    },
    getFeatureState(featureId: string) {
      return featureState[featureId] ?? {};
    },
    getState() {
      return {
        currentSceneId,
        playerCharacter,
        npcLocations,
        npcStats,
      };
    },
    updateNpcHp(npcId: string, delta: number) {
      if (!npcStats[npcId]) return;
      npcStats[npcId].hp = Math.max(0, npcStats[npcId].hp + delta);
    },
    updateNpcSan(npcId: string, delta: number) {
      if (!npcStats[npcId]) return;
      npcStats[npcId].san = Math.max(0, npcStats[npcId].san + delta);
    },
    _addNpc(npcId: string, location: string, hp: number, san = 50) {
      npcLocations[npcId] = location;
      npcStats[npcId] = { hp, san };
    },
    _setCurrentScene(sceneId: string) { currentSceneId = sceneId; },
    _featureState: featureState,
    _playerCharacter: playerCharacter,
    _npcStats: npcStats,
  };
}

type MockDgsm = ReturnType<typeof createMockDgsm>;

function createRuntime(tickDuration = 5): TickRuntimeContext {
  return {
    sessionId: "test", gameDay: 1, language: "en",
    tickTime: "08:00", tickDurationMinutes: tickDuration,
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
    staminaFeature.tick!(dgsm as any, runtime);
  }
}

// ===== Tests =====

describe("staminaFeature", () => {
  let dgsm: MockDgsm;
  let runtime: TickRuntimeContext;

  beforeEach(() => {
    dgsm = createMockDgsm();
    runtime = createRuntime();
  });

  describe("initialization", () => {
    it("should initialize player stamina state on first tick", () => {
      runTicks(dgsm, runtime, 1);

      const state = dgsm.getFeatureSceneState("stamina", "player1") as any;
      expect(state).toBeDefined();
      expect(state.fatigueLevel).toBe(0);
      expect(state.minutesSinceLastRest).toBe(5); // one tick = 5 min
    });

    it("should initialize NPC stamina state on first tick", () => {
      dgsm._addNpc("npc_guard", "town_square", 10);
      runTicks(dgsm, runtime, 1);

      const state = dgsm.getFeatureSceneState("stamina", "npc_guard") as any;
      expect(state).toBeDefined();
      expect(state.fatigueLevel).toBe(0);
      expect(state.minutesSinceLastRest).toBe(5);
    });
  });

  describe("fatigue levels", () => {
    it("should stay rested below 480 minutes", () => {
      // 480 min / 5 min per tick = 96 ticks
      runTicks(dgsm, runtime, 95); // 475 min

      const state = dgsm.getFeatureSceneState("stamina", "player1") as any;
      expect(state.fatigueLevel).toBe(0);
      expect(state.minutesSinceLastRest).toBe(475);
    });

    it("should become tired at 480 minutes", () => {
      runTicks(dgsm, runtime, 96); // 480 min

      const state = dgsm.getFeatureSceneState("stamina", "player1") as any;
      expect(state.fatigueLevel).toBe(1);
    });

    it("should become exhausted at 960 minutes", () => {
      runTicks(dgsm, runtime, 192); // 960 min

      const state = dgsm.getFeatureSceneState("stamina", "player1") as any;
      expect(state.fatigueLevel).toBe(2);
    });
  });

  describe("environmental acceleration", () => {
    it("should accumulate 2x when in extreme weather scene", () => {
      // Set up extreme cold weather state for the region
      dgsm.setFeatureSceneState("weather", "town", {
        weatherType: "extreme_cold",
        intensity: 3,
        affectedSceneIds: ["town_square"],
      });

      // 1 tick = 5 normal + 5 extra = 10 min
      runTicks(dgsm, runtime, 1);

      const state = dgsm.getFeatureSceneState("stamina", "player1") as any;
      expect(state.minutesSinceLastRest).toBe(10);
    });

    it("should accumulate 2x when in fire smoke scene", () => {
      dgsm.setFeatureSceneState("fire", "town_square", {
        intensity: 2,
      });

      runTicks(dgsm, runtime, 1);

      const state = dgsm.getFeatureSceneState("stamina", "player1") as any;
      expect(state.minutesSinceLastRest).toBe(10);
    });

    it("should accumulate 3x when both extreme weather and fire", () => {
      dgsm.setFeatureSceneState("weather", "town", {
        weatherType: "extreme_heat",
        intensity: 4,
        affectedSceneIds: ["town_square"],
      });
      dgsm.setFeatureSceneState("fire", "town_square", {
        intensity: 3,
      });

      runTicks(dgsm, runtime, 1);

      const state = dgsm.getFeatureSceneState("stamina", "player1") as any;
      expect(state.minutesSinceLastRest).toBe(15); // 5 + 5 + 5
    });

    it("should not accelerate when weather intensity < 3", () => {
      dgsm.setFeatureSceneState("weather", "town", {
        weatherType: "extreme_cold",
        intensity: 2,
        affectedSceneIds: ["town_square"],
      });

      runTicks(dgsm, runtime, 1);

      const state = dgsm.getFeatureSceneState("stamina", "player1") as any;
      expect(state.minutesSinceLastRest).toBe(5);
    });

    it("should not accelerate when fire intensity < 2", () => {
      dgsm.setFeatureSceneState("fire", "town_square", {
        intensity: 1,
      });

      runTicks(dgsm, runtime, 1);

      const state = dgsm.getFeatureSceneState("stamina", "player1") as any;
      expect(state.minutesSinceLastRest).toBe(5);
    });
  });

  describe("exhausted HP + SAN drain", () => {
    it("should drain HP and SAN every 6 ticks when exhausted and CON check fails", () => {
      // Pre-set player to exhausted
      dgsm.setFeatureSceneState("stamina", "player1", {
        minutesSinceLastRest: 960,
        fatigueLevel: 2,
        exhaustedDrainTicks: 0,
      });

      const mockRandom = vi.spyOn(Math, "random");
      // 6 ticks of accumulation, then check fires
      // CON check fail: 0.10 < 0.30 (baseline)
      mockRandom.mockReturnValueOnce(0.10);
      // 1d3 SAN roll: floor(0.5 * 3) + 1 = 2
      mockRandom.mockReturnValueOnce(0.5);

      runTicks(dgsm, runtime, 6);

      expect(dgsm._playerCharacter.status.hp).toBe(9); // -1
      expect(dgsm._playerCharacter.status.sanity).toBe(48); // -2

      mockRandom.mockRestore();
    });

    it("should not drain when CON check passes", () => {
      dgsm.setFeatureSceneState("stamina", "player1", {
        minutesSinceLastRest: 960,
        fatigueLevel: 2,
        exhaustedDrainTicks: 0,
      });

      const mockRandom = vi.spyOn(Math, "random");
      // CON check pass: 0.50 > 0.30
      mockRandom.mockReturnValueOnce(0.50);

      runTicks(dgsm, runtime, 6);

      expect(dgsm._playerCharacter.status.hp).toBe(10);
      expect(dgsm._playerCharacter.status.sanity).toBe(50);

      mockRandom.mockRestore();
    });

    it("should drain NPC HP and SAN when exhausted", () => {
      dgsm._addNpc("npc_guard", "town_square", 10, 40);
      dgsm.setFeatureSceneState("stamina", "npc_guard", {
        minutesSinceLastRest: 960,
        fatigueLevel: 2,
        exhaustedDrainTicks: 0,
      });

      const mockRandom = vi.spyOn(Math, "random");
      // Player check (also at 6 ticks) — skip if not exhausted
      // npc_guard CON fail: 0.10 < 0.30
      mockRandom.mockReturnValueOnce(0.10);
      // 1d3 = 1
      mockRandom.mockReturnValueOnce(0.0);

      runTicks(dgsm, runtime, 6);

      expect(dgsm._npcStats["npc_guard"].hp).toBe(9);
      expect(dgsm._npcStats["npc_guard"].san).toBe(39);

      mockRandom.mockRestore();
    });

    it("should increase fail chance as exhaustion continues", () => {
      // At 1920 minutes: failChance = 0.3 + (1920-960)/960 * 0.3 = 0.6
      dgsm.setFeatureSceneState("stamina", "player1", {
        minutesSinceLastRest: 1920,
        fatigueLevel: 2,
        exhaustedDrainTicks: 0,
      });

      const mockRandom = vi.spyOn(Math, "random");
      // 0.55 < 0.60 → fail
      mockRandom.mockReturnValueOnce(0.55);
      // 1d3 = 3
      mockRandom.mockReturnValueOnce(0.99);

      runTicks(dgsm, runtime, 6);

      expect(dgsm._playerCharacter.status.hp).toBe(9);
      expect(dgsm._playerCharacter.status.sanity).toBe(47); // -3

      mockRandom.mockRestore();
    });
  });

  describe("stateDescription", () => {
    it("should return empty when no one is fatigued", () => {
      runTicks(dgsm, runtime, 1);
      const desc = staminaFeature.stateDescription(dgsm as any);
      expect(desc).toBe("");
    });

    it("should list tired characters", () => {
      dgsm.setFeatureSceneState("stamina", "player1", {
        minutesSinceLastRest: 500,
        fatigueLevel: 1,
        exhaustedDrainTicks: 0,
      });

      const desc = staminaFeature.stateDescription(dgsm as any);
      expect(desc).toContain("player1");
      expect(desc).toContain("Tired");
    });

    it("should list exhausted characters", () => {
      dgsm.setFeatureSceneState("stamina", "npc_guard", {
        minutesSinceLastRest: 1000,
        fatigueLevel: 2,
        exhaustedDrainTicks: 0,
      });

      const desc = staminaFeature.stateDescription(dgsm as any);
      expect(desc).toContain("npc_guard");
      expect(desc).toContain("Exhausted");
    });
  });

  describe("planningPrompt", () => {
    it("should describe fatigue rules", () => {
      expect(staminaFeature.planningPrompt).toContain("fatigue");
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test -- --run src/dynamicworldagent/engine/features/__tests__/staminaFeature.test.ts
```

Expected: FAIL — cannot find `../staminaFeature.js`

**Step 3: Write the staminaFeature implementation**

Create `src/dynamicworldagent/engine/features/staminaFeature.ts`:

```typescript
import type {
  WorldFeature,
  TickRuntimeContext,
} from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";

// ===== Types =====

export interface StaminaCharacterState {
  minutesSinceLastRest: number;
  fatigueLevel: 0 | 1 | 2;
  exhaustedDrainTicks: number;
}

// ===== Constants =====

const FEATURE_ID = "stamina";

const TIRED_THRESHOLD = 480;       // 8 hours
const EXHAUSTED_THRESHOLD = 960;   // 16 hours
const DRAIN_INTERVAL = 6;          // check every 6 ticks

const WEATHER_ACCEL_INTENSITY = 3; // extreme weather intensity threshold
const FIRE_ACCEL_INTENSITY = 2;    // fire smoke intensity threshold

const FATIGUE_LABELS = ["Rested", "Tired", "Exhausted"];

// ===== Helpers =====

function getStaminaState(dgsm: DynamicGameStateManager, charId: string): StaminaCharacterState | undefined {
  return dgsm.getFeatureSceneState(FEATURE_ID, charId) as StaminaCharacterState | undefined;
}

function setStaminaState(dgsm: DynamicGameStateManager, charId: string, state: StaminaCharacterState): void {
  dgsm.setFeatureSceneState(FEATURE_ID, charId, state);
}

function createInitialState(): StaminaCharacterState {
  return { minutesSinceLastRest: 0, fatigueLevel: 0, exhaustedDrainTicks: 0 };
}

function computeFatigueLevel(minutes: number): 0 | 1 | 2 {
  if (minutes >= EXHAUSTED_THRESHOLD) return 2;
  if (minutes >= TIRED_THRESHOLD) return 1;
  return 0;
}

// ===== Environmental Acceleration =====

function getEnvironmentalMultiplier(
  dgsm: DynamicGameStateManager,
  charSceneId: string | null,
): number {
  if (!charSceneId) return 0;

  let extra = 0;

  // Check fire at character's scene
  const fireState = dgsm.getFeatureSceneState("fire", charSceneId) as
    | { intensity: number } | undefined;
  if (fireState && fireState.intensity >= FIRE_ACCEL_INTENSITY) {
    extra += 1;
  }

  // Check weather — need to find which region the scene belongs to
  const weatherStates = dgsm.getFeatureState("weather");
  for (const [_regionId, state] of Object.entries(weatherStates)) {
    const ws = state as {
      weatherType: string;
      intensity: number;
      affectedSceneIds: string[];
    } | undefined;
    if (!ws) continue;
    if (!ws.affectedSceneIds?.includes(charSceneId)) continue;
    if (
      (ws.weatherType === "extreme_heat" || ws.weatherType === "extreme_cold") &&
      ws.intensity >= WEATHER_ACCEL_INTENSITY
    ) {
      extra += 1;
      break; // one region match is enough
    }
  }

  return extra;
}

// ===== Exhausted Drain =====

function processExhaustedDrain(
  dgsm: DynamicGameStateManager,
  charId: string,
  stamina: StaminaCharacterState,
): void {
  if (stamina.fatigueLevel < 2) {
    stamina.exhaustedDrainTicks = 0;
    return;
  }

  stamina.exhaustedDrainTicks++;

  if (stamina.exhaustedDrainTicks < DRAIN_INTERVAL) return;

  stamina.exhaustedDrainTicks = 0;

  // Failure chance scales with exhaustion depth
  const overMinutes = stamina.minutesSinceLastRest - EXHAUSTED_THRESHOLD;
  const failChance = Math.min(0.6, 0.3 + (overMinutes / EXHAUSTED_THRESHOLD) * 0.3);

  if (Math.random() >= failChance) return;

  // Roll 1d3 for SAN damage
  const sanDamage = Math.floor(Math.random() * 3) + 1;

  const state = dgsm.getState();

  if (charId === state.playerCharacter?.id) {
    const player = state.playerCharacter;
    if (player?.status) {
      (player.status as any).hp = Math.max(0, player.status.hp - 1);
      (player.status as any).sanity = Math.max(0, player.status.sanity - sanDamage);
    }
  } else {
    dgsm.updateNpcHp(charId, -1);
    dgsm.updateNpcSan(charId, -sanDamage);
  }
}

// ===== Tick: gather all characters =====

function getAllCharacterLocations(dgsm: DynamicGameStateManager): Array<{ id: string; sceneId: string | null }> {
  const state = dgsm.getState();
  const chars: Array<{ id: string; sceneId: string | null }> = [];

  // Player
  if (state.playerCharacter?.id) {
    chars.push({ id: state.playerCharacter.id, sceneId: state.currentSceneId ?? null });
  }

  // NPCs
  for (const [npcId, location] of Object.entries(state.npcLocations)) {
    chars.push({ id: npcId, sceneId: location });
  }

  return chars;
}

// ===== Exported Feature =====

export const staminaFeature: WorldFeature = {
  id: FEATURE_ID,
  description: "3-level fatigue system — tracks activity time with environmental acceleration and exhaustion drain",

  planningPrompt: `## Stamina & Fatigue
Characters accumulate fatigue over time. After 8 hours of activity they become Tired (skill checks harder).
After 16 hours they become Exhausted (skill checks much harder, risk of HP and SAN loss).
Extreme weather and fire smoke accelerate fatigue.
Characters should rest (4+ hours) to recover. Consider having tired/exhausted NPCs seek rest.`,

  stateDescription(dgsm: DynamicGameStateManager): string {
    const allStates = dgsm.getFeatureState(FEATURE_ID);
    const entries = Object.entries(allStates);
    if (entries.length === 0) return "";

    const fatigued: string[] = [];
    for (const [charId, state] of entries) {
      const ss = state as StaminaCharacterState;
      if (ss.fatigueLevel > 0) {
        const label = FATIGUE_LABELS[ss.fatigueLevel];
        const hours = Math.round(ss.minutesSinceLastRest / 60);
        fatigued.push(`- ${charId}: ${label} (${hours}h active)`);
      }
    }

    if (fatigued.length === 0) return "";
    return "Stamina:\n" + fatigued.join("\n");
  },

  tick(dgsm: DynamicGameStateManager, runtime: TickRuntimeContext): void {
    const chars = getAllCharacterLocations(dgsm);

    for (const { id, sceneId } of chars) {
      let stamina = getStaminaState(dgsm, id);
      if (!stamina) {
        stamina = createInitialState();
      }

      // Base accumulation
      let minutes = runtime.tickDurationMinutes;

      // Environmental acceleration
      const extraMultiplier = getEnvironmentalMultiplier(dgsm, sceneId);
      minutes += extraMultiplier * runtime.tickDurationMinutes;

      stamina.minutesSinceLastRest += minutes;
      stamina.fatigueLevel = computeFatigueLevel(stamina.minutesSinceLastRest);

      // Exhausted drain
      processExhaustedDrain(dgsm, id, stamina);

      setStaminaState(dgsm, id, stamina);
    }
  },
};
```

**Step 4: Run tests to verify they pass**

```bash
pnpm test -- --run src/dynamicworldagent/engine/features/__tests__/staminaFeature.test.ts
```

Expected: All tests PASS

**Step 5: Build to verify compilation**

```bash
pnpm build
```

Expected: Compiles successfully

---

### Task 2: Register staminaFeature and update exports

**Files:**
- Modify: `src/dynamicworldagent/engine/registerDefaults.ts`
- Modify: `src/dynamicworldagent/engine/index.ts`

**Step 1: Add import and registration in registerDefaults.ts**

Add after line 11 (`import { lightingFeature }...`):

```typescript
import { staminaFeature } from "./features/staminaFeature.js";
```

Add after line 23 (`registry.registerFeature(lightingFeature);`):

```typescript
  registry.registerFeature(staminaFeature);
```

**Step 2: Add export in index.ts**

Add after line 19 (`export { lightingFeature }...`):

```typescript
export { staminaFeature } from "./features/staminaFeature.js";
```

**Step 3: Build and run all feature tests**

```bash
pnpm build && pnpm test -- --run src/dynamicworldagent/engine/features/__tests__/
```

Expected: Build passes, all tests pass (fire 25 + weather 19 + lighting 20 + stamina ~15)

---

### Task 3: Remove HP drain from weatherFeature

**Files:**
- Modify: `src/dynamicworldagent/engine/features/weatherFeature.ts`
- Modify: `src/dynamicworldagent/engine/features/__tests__/weatherFeature.test.ts`

**Step 1: Remove from weatherFeature.ts**

Remove these constants (lines 24-25):

```typescript
const HP_DRAIN_INTERVAL = 6;
const HP_DRAIN_INTENSITY_THRESHOLD = 3;
```

Remove `exposureTicks` from `WeatherRegionState` interface (line 16):

```typescript
  exposureTicks: Record<string, number>;
```

Remove `exposureTicks: {},` from `createWeatherState()` (line 150).

Remove `ws.exposureTicks = {};` from tick function (lines 396, 402).

Remove entire `processExposureDrain()` function (lines 260-310).

Remove `processExposureDrain(dgsm, ws);` call in tick (line 410).

Update feature description (line 352) — remove "and HP drain":

```typescript
  description: "Regional weather system — Markov chain evolution with skill penalties and connection blocking",
```

**Step 2: Update weather tests**

Remove the entire `describe("HP drain", ...)` block (lines 425-526) from `weatherFeature.test.ts`.

Remove `npcStats`-related fields from mock if only used by HP drain tests. Keep them if other tests use them — check first. The mock's `updateNpcHp`, `_addNpc`, `_setCurrentScene`, `_playerCharacter`, `npcLocations`, `npcStats` fields are only used in HP drain tests, so simplify the mock by removing unused helpers. Actually, keep them for safety — removing causes no harm.

**Step 3: Run weather tests**

```bash
pnpm test -- --run src/dynamicworldagent/engine/features/__tests__/weatherFeature.test.ts
```

Expected: All remaining tests PASS (was 19, now ~15 after removing 4 HP drain tests)

**Step 4: Run all feature tests together**

```bash
pnpm test -- --run src/dynamicworldagent/engine/features/__tests__/
```

Expected: All tests pass

---

### Task 4: Build and verify everything

**Step 1: Full build**

```bash
pnpm build
```

Expected: Compiles successfully

**Step 2: Run all feature tests**

```bash
pnpm test -- --run src/dynamicworldagent/engine/features/__tests__/
```

Expected: All tests pass (fire 25 + weather ~15 + lighting 20 + stamina ~15 = ~75)
