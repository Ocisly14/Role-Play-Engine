# Fire Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the fire WorldFeature — the first concrete demonstration of the tick/activate/propagate + featureState framework.

**Architecture:** Single file `fireFeature.ts` implementing the `WorldFeature` interface. Uses `dgsm.featureState` for fire-specific state, `scenarioConditions` for skill penalties, and `blockedConnections` for movement blocking. Three hooks: `activate()` (ignite/extinguish), `tick()` (intensity curve), `propagate()` (spatial spread).

**Tech Stack:** TypeScript, Vitest for tests

---

### Task 1: FireSceneState type + fire feature skeleton

**Files:**
- Create: `src/dynamicworldagent/engine/features/fireFeature.ts`

**Step 1: Create the fire feature file with type and skeleton**

```typescript
import type { WorldFeature, TickRuntimeContext, PropagationResult } from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { PlanNode } from "../../dynamicBasicAgent/npcPlanning/types.js";

// ===== Internal state (not exposed to framework) =====

interface FireSceneState {
  intensity: number;
  maxIntensity: number;       // fixed 5
  growthRate: number;         // default 1 (applied every 2 ticks)
  decayRate: number;          // default 1 (applied every 2 ticks)
  spreadThreshold: number;   // fixed 3 = ceil(5/2)
  phase: "growing" | "decaying";
  ticksInPhase: number;
  totalBurnTicks: number;
}

// ===== Constants =====

const DEFAULT_MAX_INTENSITY = 5;
const DEFAULT_SPREAD_THRESHOLD = Math.ceil(DEFAULT_MAX_INTENSITY / 2); // 3
const DEFAULT_GROWTH_RATE = 1;
const DEFAULT_DECAY_RATE = 1;
const TICKS_PER_INTENSITY_CHANGE = 2;
const BLOCK_THRESHOLD = DEFAULT_SPREAD_THRESHOLD; // block at intensity >= 3

const FEATURE_ID = "fire";

// ===== Helpers =====

function getFireState(dgsm: DynamicGameStateManager, sceneId: string): FireSceneState | undefined {
  return dgsm.getFeatureSceneState(FEATURE_ID, sceneId) as FireSceneState | undefined;
}

function setFireState(dgsm: DynamicGameStateManager, sceneId: string, state: FireSceneState): void {
  dgsm.setFeatureSceneState(FEATURE_ID, sceneId, state);
}

function removeFireState(dgsm: DynamicGameStateManager, sceneId: string): void {
  dgsm.removeFeatureSceneState(FEATURE_ID, sceneId);
}

function createFireState(initialIntensity: number): FireSceneState {
  return {
    intensity: Math.max(1, Math.min(initialIntensity, DEFAULT_MAX_INTENSITY)),
    maxIntensity: DEFAULT_MAX_INTENSITY,
    growthRate: DEFAULT_GROWTH_RATE,
    decayRate: DEFAULT_DECAY_RATE,
    spreadThreshold: DEFAULT_SPREAD_THRESHOLD,
    phase: "growing",
    ticksInPhase: 0,
    totalBurnTicks: 0,
  };
}

/** Skill penalties per intensity level */
function getSkillPenalties(intensity: number): Array<{ skill: string; delta: number }> {
  if (intensity <= 0) return [];
  const penalties: Array<{ skill: string; delta: number }> = [
    { skill: "Spot Hidden", delta: -10 * intensity },
  ];
  if (intensity >= 2) {
    penalties.push({ skill: "Listen", delta: -10 * (intensity - 1) });
  }
  return penalties;
}

/** Write fire scene condition (replaces any existing fire condition) */
function writeFireCondition(dgsm: DynamicGameStateManager, sceneId: string, intensity: number): void {
  const labels = ["", "Light smoke", "Thickening smoke", "Heavy smoke and flames", "Intense fire", "Raging inferno"];
  const description = `[Fire] ${labels[intensity] ?? `Fire intensity ${intensity}`}`;
  const penalties = getSkillPenalties(intensity);

  // Remove existing fire conditions first
  clearFireConditions(dgsm, sceneId);

  dgsm.appendSceneCondition(sceneId, {
    description,
    mechanicalEffect: penalties.length > 0 ? { skillPenalty: penalties } : undefined,
  });
}

/** Remove fire-related scene conditions */
function clearFireConditions(dgsm: DynamicGameStateManager, sceneId: string): void {
  const conditions = dgsm.getSceneConditions(sceneId);
  const nonFire = conditions.filter((c) => !c.description.startsWith("[Fire]"));
  // Replace all conditions (no removeSceneCondition method, so we overwrite)
  const state = dgsm.getState() as any;
  state.scenarioConditions[sceneId] = nonFire;
}

/** Write permanent aftermath condition based on total burn ticks */
function writeAftermathCondition(dgsm: DynamicGameStateManager, sceneId: string, totalBurnTicks: number): void {
  let description: string;
  let penalties: Array<{ skill: string; delta: number }> | undefined;

  if (totalBurnTicks <= 4) {
    description = "[Fire Aftermath] Minor smoke stains on walls and ceiling";
  } else if (totalBurnTicks <= 10) {
    description = "[Fire Aftermath] Partial burn damage — some items destroyed, soot covers surfaces";
    penalties = [{ skill: "Spot Hidden", delta: -5 }];
  } else if (totalBurnTicks <= 20) {
    description = "[Fire Aftermath] Severe burn damage — structural integrity compromised, many items destroyed";
    penalties = [{ skill: "Spot Hidden", delta: -10 }];
  } else {
    description = "[Fire Aftermath] Scene nearly destroyed by fire — most items and clues unavailable, structure unsafe";
    penalties = [{ skill: "Spot Hidden", delta: -20 }];
  }

  dgsm.appendSceneCondition(sceneId, {
    description,
    mechanicalEffect: penalties ? { skillPenalty: penalties } : undefined,
  });
}

/** Update blocked connections based on fire intensity */
function updateFireBlocking(dgsm: DynamicGameStateManager, sceneId: string, intensity: number): void {
  const scene = dgsm.getScene(sceneId);
  if (!scene) return;

  for (const connId of scene.connections) {
    const blockReason = `Blocked by fire (intensity ${intensity})`;
    if (intensity >= BLOCK_THRESHOLD) {
      // Only block if not already blocked by something else
      const currentlyBlocked = dgsm.isConnectionBlocked(connId, sceneId);
      if (!currentlyBlocked) {
        dgsm.setConnectionBlocked(connId, sceneId, true, blockReason);
      }
    } else {
      // Unblock only if we were the ones who blocked it (check reason)
      const state = dgsm.getState();
      const key1 = `${connId}::${sceneId}`;
      const key2 = `${sceneId}::${connId}`;
      const reason1 = state.blockedConnections.get(key1);
      const reason2 = state.blockedConnections.get(key2);
      if (reason1?.startsWith("Blocked by fire")) {
        dgsm.setConnectionBlocked(connId, sceneId, false, "");
      }
      if (reason2?.startsWith("Blocked by fire")) {
        dgsm.setConnectionBlocked(sceneId, connId, false, "");
      }
    }
  }
}

/** Get all scene IDs that currently have active fire */
function getAllBurningScenes(dgsm: DynamicGameStateManager): string[] {
  const allState = dgsm.getFeatureState(FEATURE_ID);
  return Object.keys(allState);
}

// ===== Fire Feature =====

export const fireFeature: WorldFeature = {
  id: FEATURE_ID,
  description: "Fire system — spreads between scenes, causes skill penalties and blocks connections",

  planningPrompt: `## Fire
When a character starts a fire (arson, accident, ritual), add \`fireIntensity\` to the node.
Fire grows over time, causes smoke (skill penalties), and at high intensity blocks entry to the scene.
To extinguish a fire, add \`fireExtinguish: true\` to the node — requires an appropriate action (environmental actionType recommended).
Current fire state is shown in the World State section.`,

  planNodeSchema: {
    requiredFields: [
      { field: "fireIntensity", type: "number", description: "Initial fire intensity (typically 1)" },
    ],
    optionalFields: [
      { field: "fireExtinguish", type: "boolean", description: "Set to true to attempt to extinguish fire at this location" },
    ],
    exampleNode: {
      type: "scene_interaction",
      action: "Set fire to the old warehouse",
      fireIntensity: 1,
    },
  },

  propagation: {
    tickInterval: 2,
    maxHops: 3,
  },

  stateDescription(dgsm: DynamicGameStateManager): string {
    const burning = getAllBurningScenes(dgsm);
    if (burning.length === 0) return "";

    const lines = burning.map((sceneId) => {
      const fire = getFireState(dgsm, sceneId)!;
      const scene = dgsm.getScene(sceneId);
      const name = scene?.name ?? sceneId;
      const labels = ["", "light smoke", "thickening smoke", "heavy smoke + flames", "intense fire", "raging inferno"];
      return `- ${name} (${sceneId}): ${labels[fire.intensity] ?? `intensity ${fire.intensity}`}, phase: ${fire.phase}`;
    });

    return "Active fires:\n" + lines.join("\n");
  },

  activate(node: PlanNode, dgsm: DynamicGameStateManager): void {
    const nodeAny = node as Record<string, unknown>;

    // Extinguish
    if (nodeAny.fireExtinguish === true) {
      const existing = getFireState(dgsm, node.location);
      if (!existing) return;
      // Reduce intensity by 2 (or clear if already low)
      const newIntensity = existing.intensity - 2;
      if (newIntensity <= 0) {
        // Fire extinguished
        writeAftermathCondition(dgsm, node.location, existing.totalBurnTicks);
        clearFireConditions(dgsm, node.location);
        updateFireBlocking(dgsm, node.location, 0);
        removeFireState(dgsm, node.location);
      } else {
        existing.intensity = newIntensity;
        setFireState(dgsm, node.location, existing);
        writeFireCondition(dgsm, node.location, newIntensity);
        updateFireBlocking(dgsm, node.location, newIntensity);
      }
      return;
    }

    // Ignite
    const intensity = typeof nodeAny.fireIntensity === "number" ? nodeAny.fireIntensity : 1;
    const existing = getFireState(dgsm, node.location);
    if (existing) {
      // Fire already burning — boost intensity if new is higher
      if (intensity > existing.intensity) {
        existing.intensity = intensity;
        setFireState(dgsm, node.location, existing);
        writeFireCondition(dgsm, node.location, intensity);
        updateFireBlocking(dgsm, node.location, intensity);
      }
      return;
    }

    // New fire
    const fireState = createFireState(intensity);
    setFireState(dgsm, node.location, fireState);
    writeFireCondition(dgsm, node.location, fireState.intensity);
    updateFireBlocking(dgsm, node.location, fireState.intensity);
  },

  tick(dgsm: DynamicGameStateManager, _runtime: TickRuntimeContext): void {
    const burning = getAllBurningScenes(dgsm);

    for (const sceneId of burning) {
      const fire = getFireState(dgsm, sceneId);
      if (!fire) continue;

      fire.totalBurnTicks++;
      fire.ticksInPhase++;

      // Intensity changes every TICKS_PER_INTENSITY_CHANGE ticks
      if (fire.ticksInPhase >= TICKS_PER_INTENSITY_CHANGE) {
        fire.ticksInPhase = 0;
        const prevIntensity = fire.intensity;

        if (fire.phase === "growing") {
          fire.intensity = Math.min(fire.intensity + fire.growthRate, fire.maxIntensity);
          if (fire.intensity >= fire.maxIntensity) {
            fire.phase = "decaying";
            fire.ticksInPhase = 0;
          }
        } else {
          fire.intensity = Math.max(fire.intensity - fire.decayRate, 0);
        }

        // Update scene effects if intensity changed
        if (fire.intensity !== prevIntensity) {
          if (fire.intensity <= 0) {
            // Extinguished
            writeAftermathCondition(dgsm, sceneId, fire.totalBurnTicks);
            clearFireConditions(dgsm, sceneId);
            updateFireBlocking(dgsm, sceneId, 0);
            removeFireState(dgsm, sceneId);
            continue;
          }
          writeFireCondition(dgsm, sceneId, fire.intensity);
          updateFireBlocking(dgsm, sceneId, fire.intensity);
        }
      }

      // Update state (if not removed)
      if (getFireState(dgsm, sceneId)) {
        setFireState(dgsm, sceneId, fire);
      }
    }
  },

  async propagate(
    sourceSceneId: string,
    _currentHop: number,
    dgsm: DynamicGameStateManager,
    _runtime: TickRuntimeContext
  ): Promise<PropagationResult> {
    const fire = getFireState(dgsm, sourceSceneId);
    if (!fire || fire.intensity < fire.spreadThreshold) {
      return { spreadTo: [] };
    }

    const scene = dgsm.getScene(sourceSceneId);
    if (!scene) return { spreadTo: [] };

    const spreadTo: string[] = [];

    for (const connId of scene.connections) {
      // Skip if already on fire
      if (getFireState(dgsm, connId)) continue;

      // Skip if connection is blocked by non-fire reason
      const state = dgsm.getState();
      const key1 = `${sourceSceneId}::${connId}`;
      const key2 = `${connId}::${sourceSceneId}`;
      const reason = state.blockedConnections.get(key1) ?? state.blockedConnections.get(key2);
      if (reason && !reason.startsWith("Blocked by fire")) continue;

      // Ignite adjacent scene
      const newFire = createFireState(1);
      setFireState(dgsm, connId, newFire);
      writeFireCondition(dgsm, connId, 1);

      spreadTo.push(connId);
    }

    return { spreadTo };
  },
};
```

**Step 2: Verify it compiles**

Run: `pnpm build`
Expected: Successfully compiled

**Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/features/fireFeature.ts
git commit -m "feat: implement fire WorldFeature with tick/activate/propagate"
```

---

### Task 2: Register fire feature in defaults

**Files:**
- Modify: `src/dynamicworldagent/engine/registerDefaults.ts`
- Modify: `src/dynamicworldagent/engine/index.ts`

**Step 1: Add fire feature to registerDefaults.ts**

Add import and registration:

```typescript
import { fireFeature } from "./features/fireFeature.js";
```

Inside `createDefaultRegistry()`, after the handler registrations, add:

```typescript
registry.registerFeature(fireFeature);
```

**Step 2: Export fireFeature from engine/index.ts**

Add to exports:

```typescript
export { fireFeature } from "./features/fireFeature.js";
```

**Step 3: Verify it compiles**

Run: `pnpm build`
Expected: Successfully compiled

**Step 4: Commit**

```bash
git add src/dynamicworldagent/engine/registerDefaults.ts src/dynamicworldagent/engine/index.ts
git commit -m "feat: register fire feature in default registry"
```

---

### Task 3: Unit tests for fire feature

**Files:**
- Create: `src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts`

**Step 1: Write tests**

Tests need a minimal mock of `DynamicGameStateManager` since the real one has heavy dependencies. We only need `featureState`, `scenarioConditions`, `blockedConnections`, and scene data.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { fireFeature } from "../fireFeature.js";
import type { PlanNode } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { TickRuntimeContext } from "../../types.js";

// ===== Minimal DGSM mock =====

function createMockDgsm(scenes: Record<string, { name: string; connections: string[] }> = {}) {
  const featureState: Record<string, Record<string, unknown>> = {};
  const scenarioConditions: Record<string, any[]> = {};
  const blockedConnections = new Map<string, string>();
  const scenesMap = new Map<string, any>();

  for (const [id, s] of Object.entries(scenes)) {
    scenesMap.set(id, { id, name: s.name, connections: s.connections, events: [] });
  }

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
    getSceneConditions(scenarioId: string) {
      return scenarioConditions[scenarioId] ?? [];
    },
    appendSceneCondition(scenarioId: string, condition: any) {
      if (!scenarioConditions[scenarioId]) scenarioConditions[scenarioId] = [];
      scenarioConditions[scenarioId].push(condition);
    },
    getScene(sceneId: string) {
      return scenesMap.get(sceneId);
    },
    getState() {
      return { scenarioConditions, blockedConnections };
    },
    isConnectionBlocked(fromId: string, toId: string) {
      return blockedConnections.has(`${fromId}::${toId}`) || blockedConnections.has(`${toId}::${fromId}`);
    },
    setConnectionBlocked(fromId: string, toId: string, blocked: boolean, reason: string) {
      const key = `${fromId}::${toId}`;
      if (blocked) blockedConnections.set(key, reason);
      else {
        blockedConnections.delete(key);
        blockedConnections.delete(`${toId}::${fromId}`);
      }
    },
    // Expose internals for assertions
    _featureState: featureState,
    _scenarioConditions: scenarioConditions,
    _blockedConnections: blockedConnections,
  } as any;
}

function createMockRuntime(): TickRuntimeContext {
  return {
    sessionId: "test-session",
    gameDay: 1,
    language: "en",
    tickTime: "10:00",
    tickDurationMinutes: 5,
    npcPlanning: {} as any,
  };
}

function makeFireNode(location: string, overrides: Record<string, unknown> = {}): PlanNode {
  return {
    nodeId: "test-node",
    characterId: "player1",
    characterName: "Test Player",
    gameTime: "10:00",
    action: "Start a fire",
    location,
    type: "scene_interaction",
    impact: 3,
    timeAdvanceMinutes: 10,
    status: "pending",
    fireIntensity: 1,
    ...overrides,
  } as PlanNode;
}

// ===== Tests =====

describe("fireFeature", () => {
  describe("activate — ignite", () => {
    it("should create fire state at scene with default parameters", () => {
      const dgsm = createMockDgsm();
      const node = makeFireNode("warehouse");

      fireFeature.activate!(node, dgsm);

      const state = dgsm.getFeatureSceneState("fire", "warehouse");
      expect(state).toBeDefined();
      expect(state.intensity).toBe(1);
      expect(state.maxIntensity).toBe(5);
      expect(state.spreadThreshold).toBe(3);
      expect(state.phase).toBe("growing");
      expect(state.totalBurnTicks).toBe(0);
    });

    it("should write fire scene condition with skill penalties", () => {
      const dgsm = createMockDgsm();
      const node = makeFireNode("warehouse");

      fireFeature.activate!(node, dgsm);

      const conditions = dgsm.getSceneConditions("warehouse");
      expect(conditions.length).toBe(1);
      expect(conditions[0].description).toContain("[Fire]");
      expect(conditions[0].mechanicalEffect.skillPenalty).toContainEqual({ skill: "Spot Hidden", delta: -10 });
    });

    it("should not create duplicate fire at same scene", () => {
      const dgsm = createMockDgsm();
      fireFeature.activate!(makeFireNode("warehouse"), dgsm);
      fireFeature.activate!(makeFireNode("warehouse"), dgsm);

      // Still just one fire
      const state = dgsm.getFeatureSceneState("fire", "warehouse");
      expect(state.intensity).toBe(1);
    });

    it("should boost intensity if new fire is stronger", () => {
      const dgsm = createMockDgsm();
      fireFeature.activate!(makeFireNode("warehouse", { fireIntensity: 1 }), dgsm);
      fireFeature.activate!(makeFireNode("warehouse", { fireIntensity: 3 }), dgsm);

      const state = dgsm.getFeatureSceneState("fire", "warehouse");
      expect(state.intensity).toBe(3);
    });
  });

  describe("activate — extinguish", () => {
    it("should reduce fire intensity by 2", () => {
      const dgsm = createMockDgsm();
      fireFeature.activate!(makeFireNode("warehouse", { fireIntensity: 4 }), dgsm);

      // Manually set intensity to 4 (activate clamps to initial)
      const state = dgsm.getFeatureSceneState("fire", "warehouse");
      state.intensity = 4;
      dgsm.setFeatureSceneState("fire", "warehouse", state);

      fireFeature.activate!(makeFireNode("warehouse", { fireIntensity: undefined, fireExtinguish: true }), dgsm);

      const after = dgsm.getFeatureSceneState("fire", "warehouse");
      expect(after.intensity).toBe(2);
    });

    it("should fully extinguish and write aftermath if intensity drops to 0", () => {
      const dgsm = createMockDgsm();
      fireFeature.activate!(makeFireNode("warehouse"), dgsm);

      fireFeature.activate!(makeFireNode("warehouse", { fireIntensity: undefined, fireExtinguish: true }), dgsm);

      const state = dgsm.getFeatureSceneState("fire", "warehouse");
      expect(state).toBeUndefined();

      const conditions = dgsm.getSceneConditions("warehouse");
      expect(conditions.some((c: any) => c.description.includes("[Fire Aftermath]"))).toBe(true);
    });
  });

  describe("tick — intensity curve", () => {
    it("should not change intensity on first tick (needs 2 ticks)", () => {
      const dgsm = createMockDgsm();
      const runtime = createMockRuntime();
      fireFeature.activate!(makeFireNode("warehouse"), dgsm);

      fireFeature.tick!(dgsm, runtime);

      const state = dgsm.getFeatureSceneState("fire", "warehouse");
      expect(state.intensity).toBe(1);
      expect(state.totalBurnTicks).toBe(1);
      expect(state.ticksInPhase).toBe(1);
    });

    it("should increase intensity after 2 ticks", () => {
      const dgsm = createMockDgsm();
      const runtime = createMockRuntime();
      fireFeature.activate!(makeFireNode("warehouse"), dgsm);

      fireFeature.tick!(dgsm, runtime); // tick 1
      fireFeature.tick!(dgsm, runtime); // tick 2 — intensity change

      const state = dgsm.getFeatureSceneState("fire", "warehouse");
      expect(state.intensity).toBe(2);
    });

    it("should switch to decaying phase at max intensity", () => {
      const dgsm = createMockDgsm();
      const runtime = createMockRuntime();
      fireFeature.activate!(makeFireNode("warehouse"), dgsm);

      // Grow from 1 → 5: needs 8 ticks (4 intensity changes × 2 ticks each)
      for (let i = 0; i < 8; i++) fireFeature.tick!(dgsm, runtime);

      const state = dgsm.getFeatureSceneState("fire", "warehouse");
      expect(state.intensity).toBe(5);
      expect(state.phase).toBe("decaying");
    });

    it("should extinguish after full lifecycle and write aftermath", () => {
      const dgsm = createMockDgsm();
      const runtime = createMockRuntime();
      fireFeature.activate!(makeFireNode("warehouse"), dgsm);

      // Full lifecycle: grow 1→5 (8 ticks) + decay 5→0 (10 ticks) = 18 ticks
      for (let i = 0; i < 18; i++) fireFeature.tick!(dgsm, runtime);

      const state = dgsm.getFeatureSceneState("fire", "warehouse");
      expect(state).toBeUndefined();

      const conditions = dgsm.getSceneConditions("warehouse");
      expect(conditions.some((c: any) => c.description.includes("[Fire Aftermath]"))).toBe(true);
    });
  });

  describe("tick — blocking", () => {
    it("should block connections when intensity reaches threshold", () => {
      const dgsm = createMockDgsm({
        warehouse: { name: "Warehouse", connections: ["hallway"] },
        hallway: { name: "Hallway", connections: ["warehouse"] },
      });
      const runtime = createMockRuntime();
      fireFeature.activate!(makeFireNode("warehouse"), dgsm);

      // Grow to intensity 3 (threshold): 4 ticks
      for (let i = 0; i < 4; i++) fireFeature.tick!(dgsm, runtime);

      expect(dgsm.isConnectionBlocked("hallway", "warehouse")).toBe(true);
    });

    it("should unblock connections when intensity drops below threshold", () => {
      const dgsm = createMockDgsm({
        warehouse: { name: "Warehouse", connections: ["hallway"] },
        hallway: { name: "Hallway", connections: ["warehouse"] },
      });
      const runtime = createMockRuntime();
      fireFeature.activate!(makeFireNode("warehouse"), dgsm);

      // Grow to max (8 ticks) then decay past threshold
      // 1→5 = 8 ticks, 5→2 = 6 ticks = 14 total
      for (let i = 0; i < 14; i++) fireFeature.tick!(dgsm, runtime);

      expect(dgsm.isConnectionBlocked("hallway", "warehouse")).toBe(false);
    });
  });

  describe("propagate — spatial spread", () => {
    it("should not spread when below threshold", async () => {
      const dgsm = createMockDgsm({
        warehouse: { name: "Warehouse", connections: ["hallway"] },
        hallway: { name: "Hallway", connections: ["warehouse"] },
      });
      const runtime = createMockRuntime();
      fireFeature.activate!(makeFireNode("warehouse"), dgsm);

      const result = await fireFeature.propagate!("warehouse", 0, dgsm, runtime);
      expect(result.spreadTo).toHaveLength(0);
    });

    it("should spread to adjacent scene when at threshold", async () => {
      const dgsm = createMockDgsm({
        warehouse: { name: "Warehouse", connections: ["hallway"] },
        hallway: { name: "Hallway", connections: ["warehouse"] },
      });
      const runtime = createMockRuntime();
      fireFeature.activate!(makeFireNode("warehouse"), dgsm);

      // Grow to intensity 3
      for (let i = 0; i < 4; i++) fireFeature.tick!(dgsm, runtime);

      const result = await fireFeature.propagate!("warehouse", 0, dgsm, runtime);
      expect(result.spreadTo).toContain("hallway");

      const hallwayFire = dgsm.getFeatureSceneState("fire", "hallway");
      expect(hallwayFire).toBeDefined();
      expect(hallwayFire.intensity).toBe(1);
    });

    it("should not spread to scene that is already on fire", async () => {
      const dgsm = createMockDgsm({
        warehouse: { name: "Warehouse", connections: ["hallway"] },
        hallway: { name: "Hallway", connections: ["warehouse"] },
      });
      const runtime = createMockRuntime();

      // Both scenes on fire
      fireFeature.activate!(makeFireNode("warehouse"), dgsm);
      fireFeature.activate!(makeFireNode("hallway"), dgsm);

      // Grow warehouse to threshold
      const state = dgsm.getFeatureSceneState("fire", "warehouse");
      state.intensity = 3;
      dgsm.setFeatureSceneState("fire", "warehouse", state);

      const result = await fireFeature.propagate!("warehouse", 0, dgsm, runtime);
      expect(result.spreadTo).toHaveLength(0);
    });
  });

  describe("stateDescription", () => {
    it("should return empty string when no fires", () => {
      const dgsm = createMockDgsm();
      expect(fireFeature.stateDescription(dgsm)).toBe("");
    });

    it("should list all burning scenes", () => {
      const dgsm = createMockDgsm({
        warehouse: { name: "Warehouse", connections: [] },
      });
      fireFeature.activate!(makeFireNode("warehouse"), dgsm);

      const desc = fireFeature.stateDescription(dgsm);
      expect(desc).toContain("warehouse");
      expect(desc).toContain("light smoke");
    });
  });
});
```

**Step 2: Run tests**

Run: `pnpm vitest run src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts
git commit -m "test: add unit tests for fire feature"
```
