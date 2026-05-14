# Feature Topology Adaptation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make fire, lighting, and stamina WorldFeatures topology-aware so they propagate through the road/junction graph instead of the flat scene connection graph.

**Architecture:** A shared `topologyHelpers.ts` module provides adjacency queries over the topology graph. Fire gains a `burnRange` model for road-based fire with weather-modified spread rate. Lighting replaces `scene.connections` with topology adjacency for fire light propagation. Stamina resolves character locations via `CharacterPosition`. Roads and junctions participate as virtual scenes — their IDs are valid keys for `featureState` and `scenarioConditions`.

**Tech Stack:** TypeScript, Vitest, pnpm

**Design Doc:** `docs/plans/2026-03-10-feature-topology-adaptation-design.md`

---

## Context

### Key Types (from `src/dynamicworldagent/world_builder/topologyTypes.ts`)

```typescript
type CharacterPosition =
  | { type: "junction"; junctionId: string }
  | { type: "road"; roadId: string; position: number }  // 0.0–1.0
  | { type: "scene"; sceneId: string };

interface TownTopology {
  junctions: Map<string, JunctionNode>;
  roads: Map<string, RoadNode>;
  junctionToRoads: Map<string, RoadNode[]>;
  sceneToParent: Map<string, { type: "junction"; junctionId: string } | { type: "road"; roadId: string; position: number }>;
}

interface RoadNode {
  id: string; endpointA: string; endpointB: string;
  travelTimeMinutes: number; alongConnections: AlongConnection[];
  parentLocationId: string; // "OUTDOOR"
  items: Item[]; clues: ScenarioClue[]; conditions: ScenarioCondition[]; events: string[];
}

interface JunctionNode {
  id: string; connectedSceneIds: string[];
  parentLocationId: string; // "OUTDOOR"
  items: Item[]; clues: ScenarioClue[]; conditions: ScenarioCondition[]; events: string[];
}
```

### DynamicGameStateManager Topology API

```typescript
getTopology(): TownTopology | null
getJunction(junctionId: string): JunctionNode | null
getRoad(roadId: string): RoadNode | null
getCharacterPosition(characterId: string): CharacterPosition | null
resolveLocationId(position: CharacterPosition): string
getCharactersAtJunction(junctionId: string): string[]
getCharactersOnRoad(roadId: string): Array<{ characterId: string; position: number }>
```

### Feature State API (all accept any string as key — sceneId, roadId, or junctionId)

```typescript
getFeatureSceneState(featureId: string, sceneId: string): unknown | undefined
setFeatureSceneState(featureId: string, sceneId: string, data: unknown): void
removeFeatureSceneState(featureId: string, sceneId: string): void
getFeatureState(featureId: string): Record<string, unknown>
appendSceneCondition(scenarioId: string, condition: SceneCondition): void
```

### Mock DGSM Pattern (from existing tests)

Tests use `createMockDgsm()` returning an object with `_addScene()`, `_featureState`, `_scenarioConditions`, etc. New tests should extend this mock to include topology fields.

### Build & Test Commands

```bash
pnpm build                                          # SWC compile
npx vitest run src/dynamicworldagent/engine/         # run engine tests
npx vitest run src/dynamicworldagent/engine/shared/__tests__/topologyHelpers.test.ts  # specific test
```

---

## Task 1: Topology Helper Utilities

**Files:**
- Create: `src/dynamicworldagent/engine/shared/topologyHelpers.ts`
- Create: `src/dynamicworldagent/engine/shared/__tests__/topologyHelpers.test.ts`
- Modify: `src/dynamicworldagent/engine/shared/index.ts` (add export)

**Step 1: Write the tests**

```typescript
// src/dynamicworldagent/engine/shared/__tests__/topologyHelpers.test.ts
import { describe, it, expect } from "vitest";
import {
  getTopologyNeighbors,
  isRoadId,
  isJunctionId,
  resolveCharacterLocationId,
} from "../topologyHelpers.js";
import { buildTopology } from "../../../world_builder/topologyTypes.js";
import type { JunctionNode, RoadNode, TownTopology } from "../../../world_builder/topologyTypes.js";

// ===== Minimal topology fixture =====
// JUNC_1 --ROAD_1 (10 min)-- JUNC_2
// JUNC_1: connectedSceneIds = ["SCN_A"]
// ROAD_1: alongConnections = [{ sceneId: "SCN_B", position: 0.3 }]

function createTestTopology(): TownTopology {
  const junctions = new Map<string, JunctionNode>([
    ["JUNC_1", {
      id: "JUNC_1", name: "Junction 1", description: "", parentLocationId: "OUTDOOR",
      connectedSceneIds: ["SCN_A"], items: [], clues: [], conditions: [], events: [],
    }],
    ["JUNC_2", {
      id: "JUNC_2", name: "Junction 2", description: "", parentLocationId: "OUTDOOR",
      connectedSceneIds: [], items: [], clues: [], conditions: [], events: [],
    }],
  ]);
  const roads = new Map<string, RoadNode>([
    ["ROAD_1", {
      id: "ROAD_1", name: "Road 1", description: "", parentLocationId: "OUTDOOR",
      endpointA: "JUNC_1", endpointB: "JUNC_2", travelTimeMinutes: 10,
      alongConnections: [{ sceneId: "SCN_B", position: 0.3 }],
      items: [], clues: [], conditions: [], events: [],
    }],
  ]);
  return buildTopology(junctions, roads);
}

describe("topologyHelpers", () => {
  const topology = createTestTopology();

  describe("isRoadId / isJunctionId", () => {
    it("should identify road IDs", () => {
      expect(isRoadId("ROAD_1", topology)).toBe(true);
      expect(isRoadId("JUNC_1", topology)).toBe(false);
      expect(isRoadId("SCN_A", topology)).toBe(false);
    });

    it("should identify junction IDs", () => {
      expect(isJunctionId("JUNC_1", topology)).toBe(true);
      expect(isJunctionId("ROAD_1", topology)).toBe(false);
      expect(isJunctionId("SCN_A", topology)).toBe(false);
    });
  });

  describe("getTopologyNeighbors", () => {
    it("should return parent road/junction for a scene attached to junction", () => {
      const neighbors = getTopologyNeighbors("SCN_A", topology);
      expect(neighbors).toContain("JUNC_1");
    });

    it("should return parent road for a scene attached to road", () => {
      const neighbors = getTopologyNeighbors("SCN_B", topology);
      expect(neighbors).toContain("ROAD_1");
    });

    it("should return endpoints + along-road scenes for a road", () => {
      const neighbors = getTopologyNeighbors("ROAD_1", topology);
      expect(neighbors).toContain("JUNC_1");
      expect(neighbors).toContain("JUNC_2");
      expect(neighbors).toContain("SCN_B");
    });

    it("should return connected roads + connected scenes for a junction", () => {
      const neighbors = getTopologyNeighbors("JUNC_1", topology);
      expect(neighbors).toContain("ROAD_1");
      expect(neighbors).toContain("SCN_A");
    });

    it("should return empty array for unknown ID", () => {
      const neighbors = getTopologyNeighbors("UNKNOWN", topology);
      expect(neighbors).toEqual([]);
    });
  });

  describe("resolveCharacterLocationId", () => {
    it("should resolve using CharacterPosition when available", () => {
      const mockDgsm = {
        getCharacterPosition: (id: string) =>
          id === "npc1" ? { type: "road" as const, roadId: "ROAD_1", position: 0.5 } : null,
        getNpcLocation: (_id: string) => "SCN_A",
        resolveLocationId: (pos: any) => pos.roadId ?? pos.junctionId ?? pos.sceneId,
        getState: () => ({ currentSceneId: "SCN_A", playerCharacter: { id: "player1" } }),
      };
      expect(resolveCharacterLocationId("npc1", mockDgsm as any)).toBe("ROAD_1");
    });

    it("should fallback to getNpcLocation when no CharacterPosition", () => {
      const mockDgsm = {
        getCharacterPosition: () => null,
        getNpcLocation: () => "SCN_A",
        resolveLocationId: (pos: any) => pos.sceneId,
        getState: () => ({ currentSceneId: "SCN_X", playerCharacter: { id: "player1" } }),
      };
      expect(resolveCharacterLocationId("npc1", mockDgsm as any)).toBe("SCN_A");
    });

    it("should use currentSceneId for player character", () => {
      const mockDgsm = {
        getCharacterPosition: () => null,
        getNpcLocation: () => undefined,
        resolveLocationId: (pos: any) => pos.sceneId,
        getState: () => ({ currentSceneId: "SCN_X", playerCharacter: { id: "player1" } }),
      };
      expect(resolveCharacterLocationId("player1", mockDgsm as any)).toBe("SCN_X");
    });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/dynamicworldagent/engine/shared/__tests__/topologyHelpers.test.ts
```
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/dynamicworldagent/engine/shared/topologyHelpers.ts
import type { TownTopology } from "../../world_builder/topologyTypes.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";

/**
 * Check if a location ID corresponds to a road in the topology.
 */
export function isRoadId(locationId: string, topology: TownTopology): boolean {
  return topology.roads.has(locationId);
}

/**
 * Check if a location ID corresponds to a junction in the topology.
 */
export function isJunctionId(locationId: string, topology: TownTopology): boolean {
  return topology.junctions.has(locationId);
}

/**
 * Get topology neighbors for a location ID.
 * - Scene → parent road/junction (via sceneToParent)
 * - Road → endpoint junctions + along-road scenes
 * - Junction → connected roads + connected scenes
 */
export function getTopologyNeighbors(locationId: string, topology: TownTopology): string[] {
  const neighbors: string[] = [];

  // Check if it's a junction
  const junction = topology.junctions.get(locationId);
  if (junction) {
    // Connected roads
    const roads = topology.junctionToRoads.get(locationId) ?? [];
    for (const road of roads) {
      neighbors.push(road.id);
    }
    // Connected scenes
    for (const sceneId of junction.connectedSceneIds) {
      neighbors.push(sceneId);
    }
    return neighbors;
  }

  // Check if it's a road
  const road = topology.roads.get(locationId);
  if (road) {
    // Endpoint junctions
    neighbors.push(road.endpointA, road.endpointB);
    // Along-road scenes
    for (const along of road.alongConnections) {
      neighbors.push(along.sceneId);
    }
    return neighbors;
  }

  // Must be a scene — look up parent
  const parent = topology.sceneToParent.get(locationId);
  if (parent) {
    if (parent.type === "junction") {
      neighbors.push(parent.junctionId);
    } else {
      neighbors.push(parent.roadId);
    }
  }

  return neighbors;
}

/**
 * Resolve a character's current location ID, using CharacterPosition if available,
 * falling back to getNpcLocation() / currentSceneId.
 */
export function resolveCharacterLocationId(
  characterId: string,
  dgsm: DynamicGameStateManager,
): string | undefined {
  // Try CharacterPosition first
  const pos = dgsm.getCharacterPosition(characterId);
  if (pos) {
    return dgsm.resolveLocationId(pos);
  }

  // Fallback: player uses currentSceneId, NPC uses getNpcLocation
  const state = dgsm.getState();
  if (state.playerCharacter?.id === characterId) {
    return state.currentSceneId ?? undefined;
  }
  return dgsm.getNpcLocation(characterId);
}
```

**Step 4: Add export to `shared/index.ts`**

Add to `src/dynamicworldagent/engine/shared/index.ts`:
```typescript
export { getTopologyNeighbors, isRoadId, isJunctionId, resolveCharacterLocationId } from "./topologyHelpers.js";
```

**Step 5: Run tests**

```bash
npx vitest run src/dynamicworldagent/engine/shared/__tests__/topologyHelpers.test.ts
```
Expected: PASS (all tests)

**Step 6: Commit**

```bash
git add src/dynamicworldagent/engine/shared/topologyHelpers.ts \
        src/dynamicworldagent/engine/shared/__tests__/topologyHelpers.test.ts \
        src/dynamicworldagent/engine/shared/index.ts
git commit -m "feat(engine): add topology helper utilities for feature integration"
```

---

## Task 2: Fire Feature — Road Fire State Model

Extend fire feature to support `burnRange` on roads. Scene/junction fire keeps existing `FireSceneState`. Road fire uses `FireRoadState` with `{ start, end }` position range.

**Files:**
- Modify: `src/dynamicworldagent/engine/features/fireFeature.ts`
- Modify: `src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts`

**Step 1: Add `FireRoadState` type and helpers to `fireFeature.ts`**

After the existing `FireSceneState` interface (line 20), add:

```typescript
interface FireRoadState extends FireSceneState {
  /** Burning segment on road: 0.0–1.0 */
  burnRange: { start: number; end: number };
}

/** Minutes of road-distance fire spreads per tick (base rate, before weather) */
const ROAD_SPREAD_RATE_MINUTES = 2;

function isFireRoadState(state: FireSceneState): state is FireRoadState {
  return "burnRange" in state;
}

function createRoadFireState(initialIntensity: number, position: number): FireRoadState {
  const base = createFireState(initialIntensity);
  return {
    ...base,
    burnRange: { start: position, end: position },
  };
}
```

**Step 2: Add weather modifier for fire spread**

```typescript
/**
 * Get weather-based multiplier for fire spread rate on roads.
 * Rain reduces spread, dry/heat increases spread.
 */
function getWeatherSpreadMultiplier(dgsm: DynamicGameStateManager, roadParentLocationId: string): number {
  const weatherState = dgsm.getFeatureSceneState("weather", roadParentLocationId) as
    | { weatherType: string; intensity: number }
    | undefined;
  if (!weatherState) return 1.0;

  const { weatherType, intensity } = weatherState;

  if (weatherType === "rain") {
    if (intensity >= 4) return 0;     // heavy rain extinguishes
    if (intensity >= 3) return 0.1;   // near-extinguish
    if (intensity >= 2) return 0.5;   // significantly slower
    return 0.8;                       // light rain, slightly slower
  }
  if (weatherType === "storm") {
    if (intensity >= 3) return 0;     // storm extinguishes
    if (intensity >= 2) return 0.3;
    return 0.7;
  }
  if (weatherType === "extreme_heat") {
    if (intensity >= 3) return 1.5;   // heat accelerates fire
    return 1.2;
  }
  return 1.0;
}
```

**Step 3: Modify `tick()` to handle road fire burn range expansion**

In the `tick()` function, after the existing `fs.ticksInPhase >= TICKS_PER_INTENSITY_CHANGE` block, add road fire range expansion logic:

```typescript
// Road fire: expand burn range each tick
if (isFireRoadState(fs)) {
  const topology = dgsm.getTopology();
  const road = topology?.roads.get(sceneId);
  if (road) {
    const weatherMult = getWeatherSpreadMultiplier(dgsm, road.parentLocationId);

    // Heavy rain/storm can extinguish road fire
    if (weatherMult <= 0) {
      writeAftermathCondition(dgsm, sceneId, fs.totalBurnTicks);
      clearFireConditions(dgsm, sceneId);
      updateFireBlocking(dgsm, sceneId, 0);
      removeFireState(dgsm, sceneId);
      continue;
    }

    const spreadDelta = (ROAD_SPREAD_RATE_MINUTES / road.travelTimeMinutes) * weatherMult;
    fs.burnRange.start = Math.max(0, fs.burnRange.start - spreadDelta);
    fs.burnRange.end = Math.min(1, fs.burnRange.end + spreadDelta);

    // Damage along-road scenes within burn range
    for (const along of road.alongConnections) {
      if (along.position >= fs.burnRange.start && along.position <= fs.burnRange.end) {
        if (fs.intensity > 2) {
          damageByFire(dgsm, along.sceneId, fs.intensity);
        }
        // Write fire condition to affected scene
        writeFireCondition(dgsm, along.sceneId, Math.max(1, fs.intensity - 1));
      }
    }
  }
}
```

**Step 4: Write tests for road fire model**

Add to `fireFeature.test.ts`:

```typescript
describe("road fire model", () => {
  beforeEach(() => {
    // Add topology to mock DGSM
    const junctions = new Map([
      ["JUNC_1", { id: "JUNC_1", name: "J1", description: "", parentLocationId: "OUTDOOR",
        connectedSceneIds: [], items: [], clues: [], conditions: [], events: [] }],
      ["JUNC_2", { id: "JUNC_2", name: "J2", description: "", parentLocationId: "OUTDOOR",
        connectedSceneIds: [], items: [], clues: [], conditions: [], events: [] }],
    ]);
    const roads = new Map([
      ["ROAD_1", { id: "ROAD_1", name: "R1", description: "", parentLocationId: "OUTDOOR",
        endpointA: "JUNC_1", endpointB: "JUNC_2", travelTimeMinutes: 20,
        alongConnections: [{ sceneId: "SCN_ALONG", position: 0.5 }],
        items: [], clues: [], conditions: [], events: [] }],
    ]);
    const topology = buildTopology(junctions, roads);
    (dgsm as any).getTopology = () => topology;
    dgsm._addScene({ id: "SCN_ALONG", name: "Along Scene", connections: [], events: [] });
  });

  it("should create road fire with burnRange at given position", () => {
    // Manually set road fire state
    dgsm.setFeatureSceneState("fire", "ROAD_1", {
      ...createFireStateForTest(2),
      burnRange: { start: 0.3, end: 0.3 },
    });

    const fs = dgsm.getFeatureSceneState("fire", "ROAD_1") as any;
    expect(fs.burnRange.start).toBe(0.3);
    expect(fs.burnRange.end).toBe(0.3);
  });

  it("should expand burn range each tick", () => {
    // Road travelTime = 20 min, ROAD_SPREAD_RATE_MINUTES = 2
    // delta = 2/20 = 0.1 per tick
    dgsm.setFeatureSceneState("fire", "ROAD_1", {
      intensity: 2, maxIntensity: 5, growthRate: 1, decayRate: 1,
      spreadThreshold: 3, phase: "growing", ticksInPhase: 0,
      totalBurnTicks: 0, burnRange: { start: 0.5, end: 0.5 },
    });

    fireFeature.tick!(dgsm as any, runtime);

    const fs = dgsm.getFeatureSceneState("fire", "ROAD_1") as any;
    expect(fs.burnRange.start).toBeCloseTo(0.4, 1);
    expect(fs.burnRange.end).toBeCloseTo(0.6, 1);
  });

  it("should clamp burn range to 0.0-1.0", () => {
    dgsm.setFeatureSceneState("fire", "ROAD_1", {
      intensity: 2, maxIntensity: 5, growthRate: 1, decayRate: 1,
      spreadThreshold: 3, phase: "growing", ticksInPhase: 0,
      totalBurnTicks: 0, burnRange: { start: 0.05, end: 0.95 },
    });

    fireFeature.tick!(dgsm as any, runtime);

    const fs = dgsm.getFeatureSceneState("fire", "ROAD_1") as any;
    expect(fs.burnRange.start).toBe(0);
    expect(fs.burnRange.end).toBe(1);
  });

  it("should write fire condition to along-road scene within burn range", () => {
    dgsm.setFeatureSceneState("fire", "ROAD_1", {
      intensity: 3, maxIntensity: 5, growthRate: 1, decayRate: 1,
      spreadThreshold: 3, phase: "growing", ticksInPhase: 0,
      totalBurnTicks: 0, burnRange: { start: 0.4, end: 0.6 },
    });

    fireFeature.tick!(dgsm as any, runtime);

    // SCN_ALONG is at position 0.5, within [0.3, 0.7] after expansion
    const conditions = dgsm.getSceneConditions("SCN_ALONG");
    const fireCond = conditions.find(c => c.description.startsWith("[Fire]"));
    expect(fireCond).toBeDefined();
  });

  it("should not affect along-road scene outside burn range", () => {
    dgsm.setFeatureSceneState("fire", "ROAD_1", {
      intensity: 3, maxIntensity: 5, growthRate: 1, decayRate: 1,
      spreadThreshold: 3, phase: "growing", ticksInPhase: 0,
      totalBurnTicks: 0, burnRange: { start: 0.0, end: 0.2 },
    });

    fireFeature.tick!(dgsm as any, runtime);

    // SCN_ALONG is at position 0.5, outside [0.0, 0.3] after expansion
    const conditions = dgsm.getSceneConditions("SCN_ALONG");
    const fireCond = conditions.find(c => c.description.startsWith("[Fire]"));
    expect(fireCond).toBeUndefined();
  });
});
```

**Step 5: Run tests**

```bash
npx vitest run src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts
```
Expected: PASS

**Step 6: Commit**

```bash
git add src/dynamicworldagent/engine/features/fireFeature.ts \
        src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts
git commit -m "feat(fire): add road fire state model with burn range and weather interaction"
```

---

## Task 3: Fire Feature — Topology-Aware Propagation

Replace `scene.connections` in `propagate()` with topology adjacency. Fire spreads:
- Scene → parent road/junction
- Road → endpoint junctions (when burnRange reaches 0.0 or 1.0)
- Junction → connected roads
- Road → along-road scenes (position-gated, already handled in Task 2 tick)

**Files:**
- Modify: `src/dynamicworldagent/engine/features/fireFeature.ts`
- Modify: `src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts`

**Step 1: Rewrite `propagate()` in `fireFeature.ts`**

Replace the existing `propagate()` method body:

```typescript
async propagate(
  sourceId: string,
  _currentHop: number,
  dgsm: DynamicGameStateManager,
  _runtime: TickRuntimeContext
): Promise<PropagationResult> {
  const sourceState = getFireState(dgsm, sourceId);
  if (!sourceState || sourceState.intensity < sourceState.spreadThreshold) {
    return { spreadTo: [] };
  }

  const topology = dgsm.getTopology();
  const newIds: string[] = [];
  const state = dgsm.getState();

  // Helper: check if connection is blocked by non-fire reason
  const isNonFireBlocked = (a: string, b: string): boolean => {
    const reason1 = state.blockedConnections.get(`${a}::${b}`);
    const reason2 = state.blockedConnections.get(`${b}::${a}`);
    return (!!reason1 && !reason1.startsWith("Blocked by fire")) ||
           (!!reason2 && !reason2.startsWith("Blocked by fire"));
  };

  // Helper: ignite a new location
  const ignite = (targetId: string, position?: number) => {
    if (getFireState(dgsm, targetId)) return; // already burning
    if (isNonFireBlocked(sourceId, targetId)) return;

    if (position !== undefined) {
      // Road fire with position
      const newState = createRoadFireState(1, position);
      setFireState(dgsm, targetId, newState);
    } else {
      const newState = createFireState(1);
      setFireState(dgsm, targetId, newState);
    }
    writeFireCondition(dgsm, targetId, 1);
    newIds.push(targetId);
  };

  if (topology) {
    // Topology-aware propagation
    const road = topology.roads.get(sourceId);
    const junction = topology.junctions.get(sourceId);

    if (road && isFireRoadState(sourceState)) {
      // Road fire → spread to endpoint junctions when burnRange reaches endpoint
      if (sourceState.burnRange.start <= 0.05) ignite(road.endpointA);
      if (sourceState.burnRange.end >= 0.95) ignite(road.endpointB);
    } else if (junction) {
      // Junction fire → spread to connected roads (start fire at junction end)
      const connectedRoads = topology.junctionToRoads.get(sourceId) ?? [];
      for (const connRoad of connectedRoads) {
        const startPos = connRoad.endpointA === sourceId ? 0.0 : 1.0;
        ignite(connRoad.id, startPos);
      }
      // Also spread to directly connected scenes
      for (const sceneId of junction.connectedSceneIds) {
        ignite(sceneId);
      }
    } else {
      // Scene fire → spread to parent road/junction
      const parent = topology.sceneToParent.get(sourceId);
      if (parent) {
        if (parent.type === "road") {
          ignite(parent.roadId, parent.position);
        } else {
          ignite(parent.junctionId);
        }
      }
    }
  }

  // Fallback: also spread via scene.connections for scenes without topology
  if (!topology || (!topology.roads.has(sourceId) && !topology.junctions.has(sourceId) && !topology.sceneToParent.has(sourceId))) {
    const scene = dgsm.getScene(sourceId);
    if (scene) {
      for (const connId of scene.connections) {
        if (getFireState(dgsm, connId)) continue;
        if (isNonFireBlocked(sourceId, connId)) continue;
        const newState = createFireState(1);
        setFireState(dgsm, connId, newState);
        writeFireCondition(dgsm, connId, 1);
        newIds.push(connId);
      }
    }
  }

  return { spreadTo: newIds };
},
```

**Step 2: Update `updateFireBlocking()` to handle topology**

Add topology-aware blocking after the existing `scene.connections` logic:

```typescript
function updateFireBlocking(dgsm: DynamicGameStateManager, locationId: string, intensity: number): void {
  const state = dgsm.getState();

  // Scene-based blocking (existing)
  const scene = dgsm.getScene(locationId);
  if (scene) {
    const connectedSceneIds = scene.connections;
    if (intensity >= BLOCK_THRESHOLD) {
      for (const connId of connectedSceneIds) {
        dgsm.setConnectionBlocked(connId, locationId, true, `Blocked by fire (intensity ${intensity})`);
      }
    } else {
      for (const connId of connectedSceneIds) {
        const key1 = `${connId}::${locationId}`;
        const key2 = `${locationId}::${connId}`;
        if (state.blockedConnections.get(key1)?.startsWith("Blocked by fire")) {
          dgsm.setConnectionBlocked(connId, locationId, false, "");
        }
        if (state.blockedConnections.get(key2)?.startsWith("Blocked by fire")) {
          dgsm.setConnectionBlocked(locationId, connId, false, "");
        }
      }
    }
    return;
  }

  // Topology-based blocking (road/junction)
  const topology = dgsm.getTopology();
  if (!topology) return;

  const neighbors = [];
  const junction = topology.junctions.get(locationId);
  if (junction) {
    const roads = topology.junctionToRoads.get(locationId) ?? [];
    neighbors.push(...roads.map(r => r.id), ...junction.connectedSceneIds);
  }
  const road = topology.roads.get(locationId);
  if (road) {
    neighbors.push(road.endpointA, road.endpointB);
    neighbors.push(...road.alongConnections.map(a => a.sceneId));
  }

  if (intensity >= BLOCK_THRESHOLD) {
    for (const nId of neighbors) {
      dgsm.setConnectionBlocked(nId, locationId, true, `Blocked by fire (intensity ${intensity})`);
    }
  } else {
    for (const nId of neighbors) {
      const key1 = `${nId}::${locationId}`;
      const key2 = `${locationId}::${nId}`;
      if (state.blockedConnections.get(key1)?.startsWith("Blocked by fire")) {
        dgsm.setConnectionBlocked(nId, locationId, false, "");
      }
      if (state.blockedConnections.get(key2)?.startsWith("Blocked by fire")) {
        dgsm.setConnectionBlocked(locationId, nId, false, "");
      }
    }
  }
}
```

**Step 3: Write tests for topology propagation**

Add to `fireFeature.test.ts`:

```typescript
describe("topology-aware propagation", () => {
  let topology: TownTopology;

  beforeEach(() => {
    const junctions = new Map([
      ["JUNC_1", { id: "JUNC_1", name: "J1", description: "", parentLocationId: "OUTDOOR",
        connectedSceneIds: ["SCN_A"], items: [], clues: [], conditions: [], events: [] }],
      ["JUNC_2", { id: "JUNC_2", name: "J2", description: "", parentLocationId: "OUTDOOR",
        connectedSceneIds: [], items: [], clues: [], conditions: [], events: [] }],
    ]);
    const roads = new Map([
      ["ROAD_1", { id: "ROAD_1", name: "R1", description: "", parentLocationId: "OUTDOOR",
        endpointA: "JUNC_1", endpointB: "JUNC_2", travelTimeMinutes: 20,
        alongConnections: [{ sceneId: "SCN_B", position: 0.5 }],
        items: [], clues: [], conditions: [], events: [] }],
    ]);
    topology = buildTopology(junctions, roads);
    (dgsm as any).getTopology = () => topology;
    dgsm._addScene({ id: "SCN_A", name: "Scene A", connections: [], events: [] });
    dgsm._addScene({ id: "SCN_B", name: "Scene B", connections: [], events: [] });
  });

  it("should spread from scene to parent junction", async () => {
    const node = makeFireNode("SCN_A", { fireIntensity: 3 });
    fireFeature.activate!(node, dgsm as any);

    const result = await fireFeature.propagate!("SCN_A", 0, dgsm as any, runtime);
    expect(result.spreadTo).toContain("JUNC_1");
    expect(dgsm.getFeatureSceneState("fire", "JUNC_1")).toBeDefined();
  });

  it("should spread from junction to connected roads", async () => {
    dgsm.setFeatureSceneState("fire", "JUNC_1", createFireStateForTest(3));

    const result = await fireFeature.propagate!("JUNC_1", 0, dgsm as any, runtime);
    expect(result.spreadTo).toContain("ROAD_1");
    const roadFire = dgsm.getFeatureSceneState("fire", "ROAD_1") as any;
    expect(roadFire).toBeDefined();
    expect(roadFire.burnRange).toBeDefined();
    expect(roadFire.burnRange.start).toBe(0); // fire starts at JUNC_1's end (endpointA)
  });

  it("should spread from road to endpoint junction when burnRange reaches end", async () => {
    dgsm.setFeatureSceneState("fire", "ROAD_1", {
      ...createFireStateForTest(3),
      burnRange: { start: 0.0, end: 0.96 },
    });

    const result = await fireFeature.propagate!("ROAD_1", 0, dgsm as any, runtime);
    expect(result.spreadTo).toContain("JUNC_2");
  });

  it("should NOT spread from road to junction when burnRange hasn't reached endpoint", async () => {
    dgsm.setFeatureSceneState("fire", "ROAD_1", {
      ...createFireStateForTest(3),
      burnRange: { start: 0.3, end: 0.7 },
    });

    const result = await fireFeature.propagate!("ROAD_1", 0, dgsm as any, runtime);
    expect(result.spreadTo).not.toContain("JUNC_1");
    expect(result.spreadTo).not.toContain("JUNC_2");
  });
});

// Helper to create a simple fire state at given intensity for test setup
function createFireStateForTest(intensity: number) {
  return {
    intensity, maxIntensity: 5, growthRate: 1, decayRate: 1,
    spreadThreshold: 3, phase: "growing" as const, ticksInPhase: 0, totalBurnTicks: 0,
  };
}
```

**Step 4: Run tests**

```bash
npx vitest run src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/dynamicworldagent/engine/features/fireFeature.ts \
        src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts
git commit -m "feat(fire): topology-aware propagation through roads and junctions"
```

---

## Task 4: Fire Feature — Weather Extinguishing Road Fire

Rain at intensity >= 4 or storm >= 3 should extinguish road fires during tick. Already partially handled by `getWeatherSpreadMultiplier()` returning 0 — the tick code from Task 2 will remove fire when multiplier is 0. This task adds a test to verify the behavior.

**Files:**
- Modify: `src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts`

**Step 1: Write weather extinguishing test**

```typescript
describe("weather interaction on road fire", () => {
  beforeEach(() => {
    // Same topology setup as Task 2
    const junctions = new Map([
      ["JUNC_1", { id: "JUNC_1", name: "J1", description: "", parentLocationId: "OUTDOOR",
        connectedSceneIds: [], items: [], clues: [], conditions: [], events: [] }],
      ["JUNC_2", { id: "JUNC_2", name: "J2", description: "", parentLocationId: "OUTDOOR",
        connectedSceneIds: [], items: [], clues: [], conditions: [], events: [] }],
    ]);
    const roads = new Map([
      ["ROAD_1", { id: "ROAD_1", name: "R1", description: "", parentLocationId: "OUTDOOR",
        endpointA: "JUNC_1", endpointB: "JUNC_2", travelTimeMinutes: 20,
        alongConnections: [], items: [], clues: [], conditions: [], events: [] }],
    ]);
    const topology = buildTopology(junctions, roads);
    (dgsm as any).getTopology = () => topology;
  });

  it("should extinguish road fire when rain intensity >= 4", () => {
    // Set weather: rain intensity 4 in OUTDOOR region
    dgsm.setFeatureSceneState("weather", "OUTDOOR", { weatherType: "rain", intensity: 4 });

    // Set road fire
    dgsm.setFeatureSceneState("fire", "ROAD_1", {
      intensity: 2, maxIntensity: 5, growthRate: 1, decayRate: 1,
      spreadThreshold: 3, phase: "growing", ticksInPhase: 0,
      totalBurnTicks: 5, burnRange: { start: 0.3, end: 0.7 },
    });

    fireFeature.tick!(dgsm as any, runtime);

    // Fire should be extinguished
    expect(dgsm.getFeatureSceneState("fire", "ROAD_1")).toBeUndefined();
    // Aftermath condition should exist
    const conditions = dgsm.getSceneConditions("ROAD_1");
    const aftermath = conditions.find(c => c.description.startsWith("[Fire Aftermath]"));
    expect(aftermath).toBeDefined();
  });

  it("should slow road fire spread in light rain", () => {
    // Set weather: rain intensity 2 → multiplier 0.5
    dgsm.setFeatureSceneState("weather", "OUTDOOR", { weatherType: "rain", intensity: 2 });

    dgsm.setFeatureSceneState("fire", "ROAD_1", {
      intensity: 2, maxIntensity: 5, growthRate: 1, decayRate: 1,
      spreadThreshold: 3, phase: "growing", ticksInPhase: 0,
      totalBurnTicks: 0, burnRange: { start: 0.5, end: 0.5 },
    });

    fireFeature.tick!(dgsm as any, runtime);

    const fs = dgsm.getFeatureSceneState("fire", "ROAD_1") as any;
    // Normal delta = 2/20 = 0.1; with rain *0.5 = 0.05
    expect(fs.burnRange.start).toBeCloseTo(0.45, 1);
    expect(fs.burnRange.end).toBeCloseTo(0.55, 1);
  });
});
```

**Step 2: Run tests**

```bash
npx vitest run src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts
```
Expected: PASS

**Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts
git commit -m "test(fire): add weather interaction tests for road fire"
```

---

## Task 5: Lighting Feature — Fire Light via Topology

Replace `scene.connections` traversal in `getFireLightContributions()` with topology adjacency. Also update `tick()` to compute lighting for roads and junctions.

**Files:**
- Modify: `src/dynamicworldagent/engine/features/lightingFeature.ts`
- Modify: `src/dynamicworldagent/engine/features/__tests__/lightingFeature.test.ts`

**Step 1: Import topology helpers and modify `getFireLightContributions()`**

Add import at top of `lightingFeature.ts`:
```typescript
import { getTopologyNeighbors } from "../shared/topologyHelpers.js";
```

Rewrite `getFireLightContributions()`:

```typescript
function getFireLightContributions(dgsm: DynamicGameStateManager): FireLightContribution[] {
  const contributions: FireLightContribution[] = [];
  const fireStates = dgsm.getFeatureState("fire");
  const topology = dgsm.getTopology();

  for (const [locationId, state] of Object.entries(fireStates)) {
    const fs = state as { intensity: number } | undefined;
    if (!fs || fs.intensity <= 0) continue;

    const fireLightLevel = Math.min(fs.intensity + 1, 5);
    contributions.push({ sceneId: locationId, lightLevel: fireLightLevel });

    // Spread fire light to neighbors
    if (fs.intensity >= 3) {
      const adjacentLevel = fireLightLevel - 1;

      if (topology) {
        // Topology-aware: use topology neighbors
        const neighbors = getTopologyNeighbors(locationId, topology);
        for (const neighborId of neighbors) {
          contributions.push({ sceneId: neighborId, lightLevel: adjacentLevel });
        }
      } else {
        // Fallback: use scene.connections
        const scene = dgsm.getScene(locationId);
        if (scene) {
          for (const connId of scene.connections) {
            contributions.push({ sceneId: connId, lightLevel: adjacentLevel });
          }
        }
      }
    }
  }

  return contributions;
}
```

**Step 2: Update `tick()` to include roads and junctions**

Modify the `tick()` method to iterate roads/junctions alongside scenes:

```typescript
tick(dgsm: DynamicGameStateManager, runtime: TickRuntimeContext): void {
  const sunLevel = computeSunLevel(runtime.tickTime);
  const fireContributions = getFireLightContributions(dgsm);

  const state = dgsm.getState();

  // Process all scenes
  state.scenes.forEach((_scene: any, sceneId: string) => {
    const lighting = computeSceneLighting(dgsm, sceneId, sunLevel, fireContributions);
    setLightingState(dgsm, sceneId, lighting);
    writeLightingCondition(dgsm, sceneId, lighting.lightLevel);
  });

  // Process roads and junctions (outdoor, always receive sun)
  const topology = dgsm.getTopology();
  if (topology) {
    for (const [roadId, road] of topology.roads) {
      const lighting = computeOutdoorLighting(dgsm, roadId, road.parentLocationId, sunLevel, fireContributions);
      setLightingState(dgsm, roadId, lighting);
      writeLightingCondition(dgsm, roadId, lighting.lightLevel);
    }
    for (const [juncId, junc] of topology.junctions) {
      const lighting = computeOutdoorLighting(dgsm, juncId, junc.parentLocationId, sunLevel, fireContributions);
      setLightingState(dgsm, juncId, lighting);
      writeLightingCondition(dgsm, juncId, lighting.lightLevel);
    }
  }
},
```

**Step 3: Add `computeOutdoorLighting()` helper**

```typescript
function computeOutdoorLighting(
  dgsm: DynamicGameStateManager,
  locationId: string,
  parentLocationId: string,
  sunLevel: number,
  fireContributions: FireLightContribution[],
): LightingSceneState {
  const sources: Array<{ name: string; level: number }> = [];

  // Outdoor: always get sun (with weather modifier)
  const weatherMod = getWeatherLightModifier(dgsm, parentLocationId);
  const adjustedSun = Math.max(1, sunLevel + weatherMod);
  sources.push({ name: "sun", level: adjustedSun });

  if (sunLevel === 1) {
    sources.push({ name: "moon", level: 2 });
  }

  // Fire light contributions
  for (const fc of fireContributions) {
    if (fc.sceneId === locationId) {
      sources.push({ name: "fire", level: fc.lightLevel });
    }
  }

  const maxLevel = sources.length > 0
    ? Math.min(5, Math.max(...sources.map(s => s.level)))
    : 1;

  return {
    lightLevel: maxLevel,
    sources: sources.filter(s => s.level === maxLevel).map(s => s.name),
  };
}
```

**Step 4: Write tests**

Add to `lightingFeature.test.ts`:

```typescript
describe("topology fire light propagation", () => {
  it("should propagate fire light from scene to parent junction via topology", () => {
    // Setup topology
    const junctions = new Map([
      ["JUNC_1", { id: "JUNC_1", name: "J1", description: "", parentLocationId: "OUTDOOR",
        connectedSceneIds: ["SCN_A"], items: [], clues: [], conditions: [], events: [] }],
    ]);
    const roads = new Map();
    const topology = buildTopology(junctions, roads);
    (dgsm as any).getTopology = () => topology;

    // Set fire at SCN_A with intensity 3 (triggers light spread)
    dgsm.setFeatureSceneState("fire", "SCN_A", { intensity: 3 });

    lightingFeature.tick!(dgsm as any, runtime);

    // JUNC_1 should have fire light contribution
    const juncLighting = dgsm.getFeatureSceneState("lighting", "JUNC_1") as any;
    expect(juncLighting).toBeDefined();
  });

  it("should compute lighting for roads and junctions", () => {
    const junctions = new Map([
      ["JUNC_1", { id: "JUNC_1", name: "J1", description: "", parentLocationId: "OUTDOOR",
        connectedSceneIds: [], items: [], clues: [], conditions: [], events: [] }],
    ]);
    const roads = new Map([
      ["ROAD_1", { id: "ROAD_1", name: "R1", description: "", parentLocationId: "OUTDOOR",
        endpointA: "JUNC_1", endpointB: "JUNC_1", travelTimeMinutes: 10,
        alongConnections: [], items: [], clues: [], conditions: [], events: [] }],
    ]);
    const topology = buildTopology(junctions, roads);
    (dgsm as any).getTopology = () => topology;

    // Daytime: road and junction should get sun
    const dayRuntime = { ...runtime, tickTime: "12:00" };
    lightingFeature.tick!(dgsm as any, dayRuntime);

    const roadLighting = dgsm.getFeatureSceneState("lighting", "ROAD_1") as any;
    expect(roadLighting).toBeDefined();
    expect(roadLighting.lightLevel).toBeGreaterThanOrEqual(4);

    const juncLighting = dgsm.getFeatureSceneState("lighting", "JUNC_1") as any;
    expect(juncLighting).toBeDefined();
    expect(juncLighting.lightLevel).toBeGreaterThanOrEqual(4);
  });
});
```

**Step 5: Run tests**

```bash
npx vitest run src/dynamicworldagent/engine/features/__tests__/lightingFeature.test.ts
```
Expected: PASS

**Step 6: Commit**

```bash
git add src/dynamicworldagent/engine/features/lightingFeature.ts \
        src/dynamicworldagent/engine/features/__tests__/lightingFeature.test.ts
git commit -m "feat(lighting): topology-aware fire light propagation and road/junction lighting"
```

---

## Task 6: Stamina Feature — CharacterPosition Resolution

Replace `getNpcLocation()` with `resolveCharacterLocationId()` for determining environment acceleration.

**Files:**
- Modify: `src/dynamicworldagent/engine/features/staminaFeature.ts`
- Modify: `src/dynamicworldagent/engine/features/__tests__/staminaFeature.test.ts`

**Step 1: Import helper and modify `getTrackedCharacters()`**

Add import at top of `staminaFeature.ts`:
```typescript
import { resolveCharacterLocationId } from "../shared/topologyHelpers.js";
```

Rewrite `getTrackedCharacters()`:

```typescript
function getTrackedCharacters(dgsm: DynamicGameStateManager): Array<{
  characterId: string;
  locationId: string;
  isPlayer: boolean;
}> {
  const state = dgsm.getState();
  const result: Array<{
    characterId: string;
    locationId: string;
    isPlayer: boolean;
  }> = [];

  // Player
  if (state.playerCharacter?.id) {
    const locationId = resolveCharacterLocationId(state.playerCharacter.id, dgsm);
    if (locationId) {
      result.push({
        characterId: state.playerCharacter.id,
        locationId,
        isPlayer: true,
      });
    }
  }

  // NPCs
  for (const npc of state.npcCharacters) {
    const locationId = resolveCharacterLocationId(npc.id, dgsm);
    if (locationId) {
      result.push({
        characterId: npc.id,
        locationId,
        isPlayer: false,
      });
    }
  }

  return result;
}
```

**Step 2: Update `tick()` to use `locationId` instead of `sceneId`**

Change the destructuring in tick from `{ characterId, sceneId, isPlayer }` to `{ characterId, locationId, isPlayer }`, and update the `getAccelerationMultiplier` call:

```typescript
for (const { characterId, locationId, isPlayer } of characters) {
  // ... existing code ...
  const multiplier = getAccelerationMultiplier(dgsm, locationId);
  // ... rest unchanged ...
}
```

**Step 3: Update test mock to include topology methods**

Add to the mock DGSM in `staminaFeature.test.ts`:

```typescript
// Add these methods to the existing mock:
getCharacterPosition: (_id: string) => null,  // no topology position by default
resolveLocationId: (pos: any) => pos.junctionId ?? pos.roadId ?? pos.sceneId,
```

**Step 4: Add test for CharacterPosition resolution**

```typescript
it("should use CharacterPosition for acceleration when available", () => {
  // Set up character on a road
  (dgsm as any).getCharacterPosition = (id: string) =>
    id === "npc1" ? { type: "road", roadId: "ROAD_1", position: 0.5 } : null;
  (dgsm as any).resolveLocationId = (pos: any) => pos.roadId ?? pos.junctionId ?? pos.sceneId;

  // Set fire on ROAD_1
  dgsm.setFeatureSceneState("fire", "ROAD_1", { intensity: 3 });

  const runtime = createMockRuntime({ tickDurationMinutes: 60 });
  staminaFeature.tick!(dgsm as any, runtime);

  const stamina = dgsm.getFeatureSceneState("stamina", "npc1") as any;
  // With fire acceleration: 60 * 2 = 120 minutes
  expect(stamina.minutesSinceLastRest).toBe(120);
});
```

**Step 5: Run tests**

```bash
npx vitest run src/dynamicworldagent/engine/features/__tests__/staminaFeature.test.ts
```
Expected: PASS

**Step 6: Run all engine tests + build**

```bash
npx vitest run src/dynamicworldagent/engine/ && pnpm build
```
Expected: All tests pass, build succeeds

**Step 7: Commit**

```bash
git add src/dynamicworldagent/engine/features/staminaFeature.ts \
        src/dynamicworldagent/engine/features/__tests__/staminaFeature.test.ts
git commit -m "feat(stamina): use CharacterPosition for location resolution"
```

---

## Verification

After all tasks, run:
```bash
npx vitest run src/dynamicworldagent/engine/  # all engine tests pass
pnpm build                                     # SWC compilation succeeds
```

All existing tests must continue to pass. The topology features gracefully degrade when `dgsm.getTopology()` returns null (no topology loaded).
