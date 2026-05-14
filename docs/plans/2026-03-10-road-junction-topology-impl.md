# Road & Junction Topology Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat scene-connection model with a Junction + Road endpoint topology that gives roads spatial structure, enables travel-time-based movement, and supports position-aware WorldFeature mechanics.

**Architecture:** Introduce `JunctionNode` and `RoadNode` as first-class data types alongside `DynamicScene`. Roads have two endpoints (Junctions) and along-the-way building connections with position markers. Characters track their position as a union type (junction / road+position / scene). Pathfinding is rewritten to traverse the Junction-Road graph. WorldModuleLoader classifies files by prefix (`JUNC_*`, `ROAD_*`, `SCN_*`).

**Tech Stack:** TypeScript, Vitest, existing DynamicGameStateManager / WorldModuleLoader / engine infrastructure

**Spec:** `docs/plans/2026-03-10-road-junction-topology-design.md`

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `src/dynamicworldagent/world_builder/topologyTypes.ts` | JunctionNode, RoadNode, AlongConnection, CharacterPosition, TownTopology types |
| `src/dynamicworldagent/engine/shared/__tests__/topologyPathfinding.test.ts` | Tests for new topology-aware pathfinding |
| `testmods/casssandra/Cassandra_Scenarios/JUNC_1.json` – `JUNC_11.json` | 11 junction data files |
| `testmods/casssandra/Cassandra_Scenarios/ROAD_5a.json` | Stone Pomegranate Lane north segment |
| `testmods/casssandra/Cassandra_Scenarios/ROAD_5b.json` | Stone Pomegranate Lane south segment |

### Modified files
| File | Change |
|---|---|
| `src/dynamicworldagent/world_builder/worldModuleLoader.ts` | Classify files by prefix, load junctions/roads separately, store in LoadedWorldModule |
| `src/dynamicworldagent/state/DynamicGameState.ts` | Add topology fields to DynamicGameState interface + manager APIs |
| `src/dynamicworldagent/engine/shared/pathfinding.ts` | Rewrite for Junction-Road graph traversal |
| `src/dynamicworldagent/engine/handlers/movementHandler.ts` | Use new topology pathfinding, support position-based movement |
| `testmods/casssandra/Cassandra_Scenarios/ROAD_1.json` – `ROAD_10.json` | Add endpointA/B, travelTimeMinutes, alongConnections; remove connections |
| `testmods/casssandra/Cassandra_Scenarios/ROAD_5.json` | Delete (replaced by ROAD_5a + ROAD_5b) |
| All `SCN_*_SUB_1.json` files referencing ROAD_* | Remove ROAD_* from `connections` (topology handles routing via `sceneToParent`); update junction-attached scenes to reference JUNC_* |

### Deleted files
| File | Reason |
|---|---|
| `testmods/casssandra/Cassandra_Scenarios/ROAD_5.json` | Split into ROAD_5a and ROAD_5b |

---

## Chunk 1: Type Definitions & State

### Task 1: Define topology types

**Files:**
- Create: `src/dynamicworldagent/world_builder/topologyTypes.ts`

- [ ] **Step 1: Write topology type definitions**

```typescript
// src/dynamicworldagent/world_builder/topologyTypes.ts

import type { ScenarioClue, ScenarioCondition } from "../../shared/agents/models/scenarioTypes.js";
import type { Item } from "./types.js";

/**
 * Junction — a first-class intersection/endpoint node.
 * Loaded from JUNC_*.json files.
 */
export interface JunctionNode {
  id: string;
  name: string;
  description: string;
  parentLocationId: string;       // typically "OUTDOOR"
  items: Item[];
  clues: ScenarioClue[];
  conditions: ScenarioCondition[];
  events: string[];
  /** Scene IDs directly accessible from this junction (buildings at the intersection) */
  connectedSceneIds: string[];
}

/**
 * Along-the-road connection — a building/scene accessible from a point on a road.
 */
export interface AlongConnection {
  sceneId: string;
  /** 0.0 = endpointA side, 1.0 = endpointB side */
  position: number;
}

/**
 * Road — a linear path between two Junctions.
 * Loaded from ROAD_*.json files.
 */
export interface RoadNode {
  id: string;
  name: string;
  description: string;
  parentLocationId: string;       // typically "OUTDOOR"
  /** Junction ID at the start */
  endpointA: string;
  /** Junction ID at the end */
  endpointB: string;
  /** Minutes to walk the full length */
  travelTimeMinutes: number;
  /** Buildings accessible along this road */
  alongConnections: AlongConnection[];
  items: Item[];
  clues: ScenarioClue[];
  conditions: ScenarioCondition[];
  events: string[];
}

/**
 * Character position — where a character currently is in the topology.
 */
export type CharacterPosition =
  | { type: "junction"; junctionId: string }
  | { type: "road"; roadId: string; position: number }  // 0.0–1.0
  | { type: "scene"; sceneId: string };

/**
 * Pre-computed topology index built after loading all nodes.
 */
export interface TownTopology {
  junctions: Map<string, JunctionNode>;
  roads: Map<string, RoadNode>;

  /** Junction ID → roads that have this junction as endpointA or endpointB */
  junctionToRoads: Map<string, RoadNode[]>;

  /** Scene ID → where this scene is attached */
  sceneToParent: Map<string, {
    type: "junction";
    junctionId: string;
  } | {
    type: "road";
    roadId: string;
    position: number;
  }>;
}

/**
 * Build a TownTopology index from loaded junctions and roads.
 */
export function buildTopology(
  junctions: Map<string, JunctionNode>,
  roads: Map<string, RoadNode>
): TownTopology {
  const junctionToRoads = new Map<string, RoadNode[]>();
  const sceneToParent = new Map<string, { type: "junction"; junctionId: string } | { type: "road"; roadId: string; position: number }>();

  // Index roads by their endpoint junctions
  for (const road of roads.values()) {
    for (const juncId of [road.endpointA, road.endpointB]) {
      const existing = junctionToRoads.get(juncId) ?? [];
      existing.push(road);
      junctionToRoads.set(juncId, existing);
    }

    // Index along connections
    for (const along of road.alongConnections) {
      sceneToParent.set(along.sceneId, {
        type: "road",
        roadId: road.id,
        position: along.position,
      });
    }
  }

  // Index junction connected scenes
  for (const junction of junctions.values()) {
    for (const sceneId of junction.connectedSceneIds) {
      sceneToParent.set(sceneId, {
        type: "junction",
        junctionId: junction.id,
      });
    }
  }

  return { junctions, roads, junctionToRoads, sceneToParent };
}
```

- [ ] **Step 2: Verify file compiles**

Run: `npx tsc --noEmit src/dynamicworldagent/world_builder/topologyTypes.ts`
Expected: no errors (or run `pnpm build` to catch issues)

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/world_builder/topologyTypes.ts
git commit -m "feat(topology): add JunctionNode, RoadNode, CharacterPosition types"
```

### Task 2: Add topology fields to DynamicGameState

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameState.ts`

- [ ] **Step 1: Add imports and new fields to DynamicGameState interface**

Add import at top of file:
```typescript
import type {
  JunctionNode,
  RoadNode,
  CharacterPosition,
  TownTopology,
} from "../world_builder/topologyTypes.js";
```

Add fields to `DynamicGameState` interface (after `transportEdges` line ~160):
```typescript
  // Road & Junction topology (null if module has no JUNC/ROAD files)
  topology: TownTopology | null;

  // Character positions (player + NPC)
  characterPositions: Record<string, CharacterPosition>;
```

- [ ] **Step 2: Update initialDynamicGameState defaults**

Add defaults in the `initialDynamicGameState` function (after `transportEdges: []` line ~234):
```typescript
  topology: null,
  characterPositions: {},
```

- [ ] **Step 3: Add topology manager methods to DynamicGameStateManager**

Add the following methods to the `DynamicGameStateManager` class:

```typescript
  // === Topology ===

  getJunction(junctionId: string): JunctionNode | null {
    return this.state.topology?.junctions.get(junctionId) ?? null;
  }

  getRoad(roadId: string): RoadNode | null {
    return this.state.topology?.roads.get(roadId) ?? null;
  }

  getTopology(): TownTopology | null {
    return this.state.topology;
  }

  setTopology(topology: TownTopology): void {
    this.state.topology = topology;
    this.state.lastUpdated = new Date();
  }

  // === Character Position ===

  getCharacterPosition(characterId: string): CharacterPosition | null {
    return this.state.characterPositions[characterId] ?? null;
  }

  setCharacterPosition(characterId: string, position: CharacterPosition): void {
    this.state.characterPositions[characterId] = position;
    this.state.lastUpdated = new Date();
  }

  getCharactersAtJunction(junctionId: string): string[] {
    return Object.entries(this.state.characterPositions)
      .filter(([_, pos]) => pos.type === "junction" && pos.junctionId === junctionId)
      .map(([id]) => id);
  }

  getCharactersOnRoad(roadId: string): Array<{ characterId: string; position: number }> {
    return Object.entries(this.state.characterPositions)
      .filter(([_, pos]) => pos.type === "road" && pos.roadId === roadId)
      .map(([id, pos]) => ({
        characterId: id,
        position: (pos as { type: "road"; roadId: string; position: number }).position,
      }));
  }

  getCharactersInScene(sceneId: string): string[] {
    return Object.entries(this.state.characterPositions)
      .filter(([_, pos]) => pos.type === "scene" && pos.sceneId === sceneId)
      .map(([id]) => id);
  }

  /**
   * Resolve the "location ID" for a character position, for backward compatibility.
   * Returns the scene/junction/road ID the character is at.
   */
  resolveLocationId(position: CharacterPosition): string {
    switch (position.type) {
      case "junction": return position.junctionId;
      case "road": return position.roadId;
      case "scene": return position.sceneId;
    }
  }
```

- [ ] **Step 4: Update serialize() to handle topology**

In the `serialize()` method (~line 528), add topology serialization:

```typescript
    // Convert topology Maps to plain objects
    let topologyObj: any = null;
    if (this.state.topology) {
      const junctionsObj: Record<string, any> = {};
      this.state.topology.junctions.forEach((j, id) => { junctionsObj[id] = j; });
      const roadsObj: Record<string, any> = {};
      this.state.topology.roads.forEach((r, id) => { roadsObj[id] = r; });
      topologyObj = { junctions: junctionsObj, roads: roadsObj };
    }
```

And in the return object, add:
```typescript
      topology: topologyObj,
      characterPositions: this.state.characterPositions,
```

- [ ] **Step 5: Update deserialize() to rebuild topology**

In the `static deserialize()` method (~line 565), after the blockedConnections reconstruction, add:

```typescript
    // Reconstruct topology from serialized junctions/roads
    import { buildTopology } from "../world_builder/topologyTypes.js";
    // (move this import to file top)

    let topology: import("../world_builder/topologyTypes.js").TownTopology | null = null;
    if (data.topology?.junctions && data.topology?.roads) {
      const junctions = new Map<string, import("../world_builder/topologyTypes.js").JunctionNode>();
      Object.entries(data.topology.junctions).forEach(([id, j]) => junctions.set(id, j as any));
      const roads = new Map<string, import("../world_builder/topologyTypes.js").RoadNode>();
      Object.entries(data.topology.roads).forEach(([id, r]) => roads.set(id, r as any));
      topology = buildTopology(junctions, roads);
    }
```

And in the return object, add:
```typescript
      topology,
      characterPositions: data.characterPositions ?? {},
```

- [ ] **Step 6: Verify build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/dynamicworldagent/state/DynamicGameState.ts
git commit -m "feat(topology): add topology fields, position APIs, and serialization to DynamicGameState"
```

---

## Chunk 2: Loader

### Task 3: Modify WorldModuleLoader to load junctions and roads

**Files:**
- Modify: `src/dynamicworldagent/world_builder/worldModuleLoader.ts`

- [ ] **Step 1: Add imports**

Add at top of worldModuleLoader.ts:
```typescript
import type { JunctionNode, RoadNode, AlongConnection } from "./topologyTypes.js";
import { buildTopology } from "./topologyTypes.js";
```

- [ ] **Step 2: Add junctions and roads to LoadedWorldModule interface**

Add fields to `LoadedWorldModule` (after `transportEdges` line ~48):
```typescript
  junctions: Map<string, JunctionNode>;
  roads: Map<string, RoadNode>;
```

- [ ] **Step 3: Add loadJunctions method**

Add a new private method to `WorldModuleLoader`:

```typescript
  /**
   * Load junction nodes from JUNC_*.json files.
   */
  private loadJunctions(scenariosDir: string): Map<string, JunctionNode> {
    const junctions = new Map<string, JunctionNode>();
    if (!fs.existsSync(scenariosDir)) return junctions;

    const files = fs.readdirSync(scenariosDir)
      .filter((f) => f.startsWith("JUNC_") && f.endsWith(".json"));

    for (const file of files) {
      try {
        const filePath = path.join(scenariosDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const junction: JunctionNode = {
          id: data.id,
          name: data.name,
          description: data.description || "",
          parentLocationId: data.parentLocationId || "OUTDOOR",
          items: data.items || [],
          clues: data.clues || [],
          conditions: data.conditions || [],
          events: data.events || [],
          connectedSceneIds: data.connectedSceneIds || [],
        };
        junctions.set(junction.id, junction);
      } catch (error) {
        console.warn(`    Failed to load junction file ${file}:`, error);
      }
    }
    return junctions;
  }
```

- [ ] **Step 4: Add loadRoads method**

```typescript
  /**
   * Load road nodes from ROAD_*.json files.
   * Detects new format (has endpointA/endpointB) vs old format (has connections).
   */
  private loadRoads(scenariosDir: string): Map<string, RoadNode> {
    const roads = new Map<string, RoadNode>();
    if (!fs.existsSync(scenariosDir)) return roads;

    const files = fs.readdirSync(scenariosDir)
      .filter((f) => f.startsWith("ROAD_") && f.endsWith(".json"));

    for (const file of files) {
      try {
        const filePath = path.join(scenariosDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

        // Only load new-format roads (with endpointA/B)
        if (!data.endpointA || !data.endpointB) {
          // Old format — load as DynamicScene (handled by loadDynamicScenes)
          continue;
        }

        const road: RoadNode = {
          id: data.id,
          name: data.name,
          description: data.description || "",
          parentLocationId: data.parentLocationId || "OUTDOOR",
          endpointA: data.endpointA,
          endpointB: data.endpointB,
          travelTimeMinutes: data.travelTimeMinutes ?? 10,
          alongConnections: (data.alongConnections || []).map((ac: any) => ({
            sceneId: ac.sceneId,
            position: ac.position,
          })),
          items: data.items || [],
          clues: data.clues || [],
          conditions: data.conditions || [],
          events: data.events || [],
          indoor: data.indoor,
        };
        roads.set(road.id, road);
      } catch (error) {
        console.warn(`    Failed to load road file ${file}:`, error);
      }
    }
    return roads;
  }
```

- [ ] **Step 5: Update loadDynamicScenes to skip JUNC_* and new-format ROAD_* files**

In the existing `loadDynamicScenes` method, add a filter to skip `JUNC_*` files:

```typescript
    const files = fs
      .readdirSync(scenariosDir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("JUNC_"));
```

Then inside the file-reading loop, add an early continue for new-format ROAD files (which have `endpointA` and would be incorrectly loaded as DynamicScene because they have `parentLocationId`):

```typescript
        // Skip new-format ROAD files (handled by loadRoads)
        if (data.endpointA && data.endpointB) {
          continue;
        }
```

Add this check right after `const data = JSON.parse(content);` and before the `parentLocationId` format detection.
Old-format ROAD files (with `connections` array, no `endpointA`) continue to load as DynamicScene for backward compatibility.

- [ ] **Step 6: Call new loaders in loadWorldModule**

In `loadWorldModule()`, after loading scenes (step 7, around line 291), add:

```typescript
      // 7b. Load junctions and roads
      console.log(`  [7b/9] Loading junctions and roads...`);
      const junctions = this.loadJunctions(scenariosDir);
      const roads = this.loadRoads(scenariosDir);
      console.log(`    Junctions loaded: ${junctions.size}`);
      console.log(`    Roads loaded: ${roads.size}`);
```

And add `junctions` and `roads` to the `loadedModule` object:

```typescript
        junctions,
        roads,
```

- [ ] **Step 7: Verify build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/dynamicworldagent/world_builder/worldModuleLoader.ts
git commit -m "feat(topology): load JUNC_* and ROAD_* files in WorldModuleLoader"
```

### Task 4: Wire topology into DynamicGameStateLoader

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameStateLoader.ts`

- [ ] **Step 1: Find where scenes are loaded into state and add topology loading**

After `LoadedWorldModule.scenes` are loaded into `DynamicGameState.scenes`, add:

```typescript
import { buildTopology } from "../world_builder/topologyTypes.js";

// ... inside the loader function where scenes are set ...

// Load topology if junctions/roads available
if (module.junctions.size > 0 || module.roads.size > 0) {
  const topology = buildTopology(module.junctions, module.roads);
  dgsm.setTopology(topology);
}
```

Note: The exact insertion point depends on the loader structure. Find where `state.scenes` is populated from `module.scenes` and add topology loading after it.

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/state/DynamicGameStateLoader.ts
git commit -m "feat(topology): build topology index during state loading"
```

---

## Chunk 3: Pathfinding & Movement

### Task 5: Rewrite pathfinding for topology

**Files:**
- Modify: `src/dynamicworldagent/engine/shared/pathfinding.ts`
- Create: `src/dynamicworldagent/engine/shared/__tests__/topologyPathfinding.test.ts`

- [ ] **Step 1: Write failing tests for topology pathfinding**

```typescript
// src/dynamicworldagent/engine/shared/__tests__/topologyPathfinding.test.ts

import { describe, it, expect } from "vitest";
import { findTopologyPath, calculateTopologyTravelTime } from "../pathfinding.js";
import type { JunctionNode, RoadNode, TownTopology } from "../../../world_builder/topologyTypes.js";
import { buildTopology } from "../../../world_builder/topologyTypes.js";

// Helper: build a simple test topology
//   JUNC_A -- ROAD_1 (10min) -- JUNC_B -- ROAD_2 (5min) -- JUNC_C
//                                  |
//                              ROAD_3 (15min)
//                                  |
//                               JUNC_D
function makeTestTopology(): TownTopology {
  const junctions = new Map<string, JunctionNode>([
    ["JUNC_A", { id: "JUNC_A", name: "A", description: "", parentLocationId: "OUTDOOR", items: [], clues: [], conditions: [], events: [], connectedSceneIds: ["SCN_1"] }],
    ["JUNC_B", { id: "JUNC_B", name: "B", description: "", parentLocationId: "OUTDOOR", items: [], clues: [], conditions: [], events: [], connectedSceneIds: [] }],
    ["JUNC_C", { id: "JUNC_C", name: "C", description: "", parentLocationId: "OUTDOOR", items: [], clues: [], conditions: [], events: [], connectedSceneIds: ["SCN_2"] }],
    ["JUNC_D", { id: "JUNC_D", name: "D", description: "", parentLocationId: "OUTDOOR", items: [], clues: [], conditions: [], events: [], connectedSceneIds: [] }],
  ]);

  const roads = new Map<string, RoadNode>([
    ["ROAD_1", { id: "ROAD_1", name: "R1", description: "", parentLocationId: "OUTDOOR", endpointA: "JUNC_A", endpointB: "JUNC_B", travelTimeMinutes: 10, alongConnections: [{ sceneId: "SCN_3", position: 0.5 }], items: [], clues: [], conditions: [], events: [] }],
    ["ROAD_2", { id: "ROAD_2", name: "R2", description: "", parentLocationId: "OUTDOOR", endpointA: "JUNC_B", endpointB: "JUNC_C", travelTimeMinutes: 5, alongConnections: [], items: [], clues: [], conditions: [], events: [] }],
    ["ROAD_3", { id: "ROAD_3", name: "R3", description: "", parentLocationId: "OUTDOOR", endpointA: "JUNC_B", endpointB: "JUNC_D", travelTimeMinutes: 15, alongConnections: [], items: [], clues: [], conditions: [], events: [] }],
  ]);

  return buildTopology(junctions, roads);
}

describe("findTopologyPath", () => {
  const topology = makeTestTopology();
  const blocked = new Map<string, string>();

  it("finds path between two junctions", () => {
    const path = findTopologyPath(
      { type: "junction", junctionId: "JUNC_A" },
      { type: "junction", junctionId: "JUNC_C" },
      topology,
      blocked
    );
    expect(path).not.toBeNull();
    // A -> ROAD_1 -> B -> ROAD_2 -> C
    expect(path!.steps.length).toBeGreaterThanOrEqual(2);
  });

  it("finds path from scene to junction via road", () => {
    // SCN_3 is at ROAD_1 position 0.5
    const path = findTopologyPath(
      { type: "scene", sceneId: "SCN_3" },
      { type: "junction", junctionId: "JUNC_C" },
      topology,
      blocked
    );
    expect(path).not.toBeNull();
  });

  it("finds path from junction-connected scene", () => {
    // SCN_1 is at JUNC_A
    const path = findTopologyPath(
      { type: "scene", sceneId: "SCN_1" },
      { type: "scene", sceneId: "SCN_2" },
      topology,
      blocked
    );
    expect(path).not.toBeNull();
  });

  it("returns null when path is blocked", () => {
    const blockedConns = new Map<string, string>();
    blockedConns.set("JUNC_A::ROAD_1", "fire");
    blockedConns.set("JUNC_B::ROAD_1", "fire");
    const path = findTopologyPath(
      { type: "junction", junctionId: "JUNC_A" },
      { type: "junction", junctionId: "JUNC_C" },
      topology,
      blockedConns
    );
    expect(path).toBeNull();
  });

  it("same location returns zero-step path", () => {
    const path = findTopologyPath(
      { type: "junction", junctionId: "JUNC_A" },
      { type: "junction", junctionId: "JUNC_A" },
      topology,
      blocked
    );
    expect(path).not.toBeNull();
    expect(path!.totalMinutes).toBe(0);
  });
});

describe("calculateTopologyTravelTime", () => {
  const topology = makeTestTopology();

  it("calculates time across two roads", () => {
    // JUNC_A -> ROAD_1 (10min) -> JUNC_B -> ROAD_2 (5min) -> JUNC_C = 15min
    const path = findTopologyPath(
      { type: "junction", junctionId: "JUNC_A" },
      { type: "junction", junctionId: "JUNC_C" },
      topology,
      new Map()
    );
    expect(path!.totalMinutes).toBe(15);
  });

  it("calculates partial road time from midpoint", () => {
    // SCN_3 at ROAD_1 position 0.5 -> JUNC_B (half of 10min = 5min) -> ROAD_2 (5min) -> JUNC_C
    const path = findTopologyPath(
      { type: "scene", sceneId: "SCN_3" },
      { type: "junction", junctionId: "JUNC_C" },
      topology,
      new Map()
    );
    expect(path!.totalMinutes).toBe(10); // 5 + 5
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/dynamicworldagent/engine/shared/__tests__/topologyPathfinding.test.ts`
Expected: FAIL (findTopologyPath not exported)

- [ ] **Step 3: Implement topology pathfinding**

Add to `src/dynamicworldagent/engine/shared/pathfinding.ts`:

```typescript
import type { CharacterPosition, TownTopology } from "../../world_builder/topologyTypes.js";

/** A step in a topology path */
export interface TopologyPathStep {
  /** What the character traverses */
  type: "road" | "enter_scene" | "exit_scene" | "junction";
  id: string;
  /** Travel time for this step in minutes */
  minutes: number;
}

/** Result of topology pathfinding */
export interface TopologyPath {
  steps: TopologyPathStep[];
  totalMinutes: number;
}

/**
 * BFS pathfinding on the Junction-Road topology graph.
 * Supports starting/ending at junctions, roads (with position), or scenes.
 */
export function findTopologyPath(
  from: CharacterPosition,
  to: CharacterPosition,
  topology: TownTopology,
  blockedConnections: Map<string, string>
): TopologyPath | null {
  // Resolve start and end to junction(s) + partial road time
  const startInfo = resolveToJunctions(from, topology);
  const endInfo = resolveToJunctions(to, topology);

  if (!startInfo || !endInfo) return null;

  // Same location check
  if (positionsEqual(from, to)) {
    return { steps: [], totalMinutes: 0 };
  }

  // BFS on junctions
  const visited = new Set<string>();
  const queue: Array<{
    junctionId: string;
    steps: TopologyPathStep[];
    minutes: number;
  }> = [];

  // Seed queue with start junction(s)
  for (const entry of startInfo) {
    queue.push({
      junctionId: entry.junctionId,
      steps: entry.initialSteps,
      minutes: entry.initialMinutes,
    });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.junctionId)) continue;
    visited.add(current.junctionId);

    // Check if we reached any end junction
    for (const end of endInfo) {
      if (current.junctionId === end.junctionId) {
        const finalSteps = [...current.steps, ...end.finalSteps];
        const finalMinutes = current.minutes + end.finalMinutes;
        return { steps: finalSteps, totalMinutes: finalMinutes };
      }
    }

    // Expand: find all roads connected to this junction
    const roads = topology.junctionToRoads.get(current.junctionId) ?? [];
    for (const road of roads) {
      const otherJunctionId = road.endpointA === current.junctionId
        ? road.endpointB
        : road.endpointA;

      if (visited.has(otherJunctionId)) continue;

      // Check if road is blocked
      // Topology blocking uses "junctionId::roadId" format.
      // This is separate from old-style "sceneA::sceneB" blocking which is used by legacy BFS.
      const key1 = `${current.junctionId}::${road.id}`;
      const key2 = `${road.id}::${current.junctionId}`;
      if (blockedConnections.has(key1) || blockedConnections.has(key2)) continue;

      const roadStep: TopologyPathStep = {
        type: "road",
        id: road.id,
        minutes: road.travelTimeMinutes,
      };

      queue.push({
        junctionId: otherJunctionId,
        steps: [...current.steps, roadStep],
        minutes: current.minutes + road.travelTimeMinutes,
      });
    }
  }

  return null;
}

/** Resolve a CharacterPosition to reachable junction(s) with initial travel cost */
function resolveToJunctions(
  pos: CharacterPosition,
  topology: TownTopology
): Array<{
  junctionId: string;
  initialSteps: TopologyPathStep[];
  initialMinutes: number;
  finalSteps: TopologyPathStep[];
  finalMinutes: number;
}> | null {
  switch (pos.type) {
    case "junction":
      return [{
        junctionId: pos.junctionId,
        initialSteps: [],
        initialMinutes: 0,
        finalSteps: [],
        finalMinutes: 0,
      }];

    case "road": {
      const road = topology.roads.get(pos.roadId);
      if (!road) return null;
      const toA = pos.position * road.travelTimeMinutes;
      const toB = (1 - pos.position) * road.travelTimeMinutes;
      return [
        {
          junctionId: road.endpointA,
          initialSteps: [{ type: "road", id: road.id, minutes: toA }],
          initialMinutes: toA,
          finalSteps: [{ type: "road", id: road.id, minutes: toA }],
          finalMinutes: toA,
        },
        {
          junctionId: road.endpointB,
          initialSteps: [{ type: "road", id: road.id, minutes: toB }],
          initialMinutes: toB,
          finalSteps: [{ type: "road", id: road.id, minutes: toB }],
          finalMinutes: toB,
        },
      ];
    }

    case "scene": {
      const parent = topology.sceneToParent.get(pos.sceneId);
      if (!parent) return null;

      if (parent.type === "junction") {
        return [{
          junctionId: parent.junctionId,
          initialSteps: [{ type: "exit_scene", id: pos.sceneId, minutes: 1 }],
          initialMinutes: 1,
          finalSteps: [{ type: "enter_scene", id: pos.sceneId, minutes: 1 }],
          finalMinutes: 1,
        }];
      }

      // Scene on a road — can reach either junction
      const road = topology.roads.get(parent.roadId);
      if (!road) return null;
      const toA = parent.position * road.travelTimeMinutes;
      const toB = (1 - parent.position) * road.travelTimeMinutes;
      return [
        {
          junctionId: road.endpointA,
          initialSteps: [
            { type: "exit_scene", id: pos.sceneId, minutes: 1 },
            { type: "road", id: road.id, minutes: toA },
          ],
          initialMinutes: 1 + toA,
          finalSteps: [
            { type: "road", id: road.id, minutes: toA },
            { type: "enter_scene", id: pos.sceneId, minutes: 1 },
          ],
          finalMinutes: 1 + toA,
        },
        {
          junctionId: road.endpointB,
          initialSteps: [
            { type: "exit_scene", id: pos.sceneId, minutes: 1 },
            { type: "road", id: road.id, minutes: toB },
          ],
          initialMinutes: 1 + toB,
          finalSteps: [
            { type: "road", id: road.id, minutes: toB },
            { type: "enter_scene", id: pos.sceneId, minutes: 1 },
          ],
          finalMinutes: 1 + toB,
        },
      ];
    }
  }
}

function positionsEqual(a: CharacterPosition, b: CharacterPosition): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "junction": return a.junctionId === (b as typeof a).junctionId;
    case "road": return a.roadId === (b as typeof a).roadId && a.position === (b as typeof a).position;
    case "scene": return a.sceneId === (b as typeof a).sceneId;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dynamicworldagent/engine/shared/__tests__/topologyPathfinding.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dynamicworldagent/engine/shared/pathfinding.ts src/dynamicworldagent/engine/shared/__tests__/topologyPathfinding.test.ts
git commit -m "feat(topology): add topology-aware pathfinding with BFS on junction-road graph"
```

### Task 6: Update movementHandler for topology

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/movementHandler.ts`

- [ ] **Step 1: Add topology path resolution to movement handler**

Add imports:
```typescript
import { findTopologyPath } from "../shared/pathfinding.js";
import type { CharacterPosition } from "../../world_builder/topologyTypes.js";
```

In the `execute` method, before the existing BFS pathfinding block (line ~72), add a topology-first path:

```typescript
    // Topology-based movement (preferred when topology is loaded)
    const topology = dgsm.getTopology();
    if (topology) {
      const currentPos = dgsm.getCharacterPosition(node.characterId);
      if (currentPos) {
        // Resolve target: could be a junction, road, or scene
        const targetPos = resolveTargetPosition(node.location, topology);
        if (targetPos) {
          const topologyPath = findTopologyPath(
            currentPos,
            targetPos,
            topology,
            state.blockedConnections
          );

          if (!topologyPath) {
            return makeAction(
              node,
              "failed",
              buildOutcome(node, "failed", { reason: "no path available in topology" }),
              { difficulty, failureReason: "location_blocked" }
            );
          }

          dgsm.setCharacterPosition(node.characterId, targetPos);
          // Also update legacy npcLocation for backward compatibility
          dgsm.setNpcLocation(node.characterId, node.location);
          return makeAction(
            node,
            "completed",
            buildOutcome(node, "completed", {
              reason: `Traveled via topology in ~${topologyPath.totalMinutes} min`,
            }),
            { difficulty, successLevel: resolvedSuccessLevel }
          );
        }
      }
    }
```

Add the helper function outside the handler:

```typescript
function resolveTargetPosition(
  locationId: string,
  topology: import("../../world_builder/topologyTypes.js").TownTopology
): CharacterPosition | null {
  // Check junctions
  if (topology.junctions.has(locationId)) {
    return { type: "junction", junctionId: locationId };
  }
  // Check scenes (including buildings along roads and at junctions)
  if (topology.sceneToParent.has(locationId)) {
    return { type: "scene", sceneId: locationId };
  }
  // Roads are not valid direct targets — characters move to junctions or scenes.
  // If the LLM outputs a road ID, resolve to the nearest endpoint junction.
  const road = topology.roads.get(locationId);
  if (road) {
    return { type: "junction", junctionId: road.endpointB };
  }
  return null;
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/movementHandler.ts
git commit -m "feat(topology): update movementHandler to use topology pathfinding"
```

---

## Chunk 4: Cassandra Scenario Data

### Task 7: Create JUNC_*.json files

**Files:**
- Create: 11 files in `testmods/casssandra/Cassandra_Scenarios/`

- [ ] **Step 1: Create all 11 junction files**

Create `JUNC_1.json`:
```json
{
  "id": "JUNC_1",
  "name": "星辰大道北端",
  "description": "星辰大道的北端尽头。左手边是焚化厂高耸的烟囱冒着灰烟，空气中弥漫着刺鼻的焦灼味。路面上有几道深深的车辙印，地面覆着一层薄薄的灰尘。",
  "parentLocationId": "OUTDOOR",
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天路口，受天气影响。靠近焚化厂，空气质量较差。"
    }
  ],
  "events": [],
  "connectedSceneIds": ["SCN_2_SUB_1"]
}
```

Create `JUNC_2.json`:
```json
{
  "id": "JUNC_2",
  "name": "星辰大道南端三岔口",
  "description": "星辰大道在此分叉，东南方向延伸出石榴巷，西南方向是卡森德拉北新街。路口中央有一棵枯萎的老橡树。",
  "parentLocationId": "OUTDOOR",
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天路口，受天气影响。"
    }
  ],
  "events": [],
  "connectedSceneIds": []
}
```

Create `JUNC_3.json`:
```json
{
  "id": "JUNC_3",
  "name": "北新街端点三岔口",
  "description": "北新街的终点，西边通往卡森德拉旧街，东边通往卡森德拉南新街。路口附近有几棵行道树，冬季已经落尽了叶子。",
  "parentLocationId": "OUTDOOR",
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天路口，受天气影响。"
    }
  ],
  "events": [],
  "connectedSceneIds": []
}
```

Create `JUNC_4.json`:
```json
{
  "id": "JUNC_4",
  "name": "南新街东端三岔口",
  "description": "卡森德拉南新街的东端路口，东南方向通往新月街A大道北，西北方向通往石榴巷。",
  "parentLocationId": "OUTDOOR",
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天路口，受天气影响。"
    }
  ],
  "events": [],
  "connectedSceneIds": []
}
```

Create `JUNC_5.json`:
```json
{
  "id": "JUNC_5",
  "name": "新月街十字路口",
  "description": "新月街的交通枢纽，四条道路在此交汇。西通A大道南，东通B大道，南通C大道，西北通A大道北。路口有一盏路灯。",
  "parentLocationId": "OUTDOOR",
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天路口，受天气影响。"
    }
  ],
  "events": [],
  "connectedSceneIds": []
}
```

Create `JUNC_6.json`:
```json
{
  "id": "JUNC_6",
  "name": "石榴巷/日暮大道分叉",
  "description": "石榴巷的中段，向东北方向分叉出日暮大道。巷道在此稍微变宽，路灯稀疏。",
  "parentLocationId": "OUTDOOR",
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天路口，受天气影响。"
    },
    {
      "type": "lighting",
      "description": "分叉处路灯稀少，夜间昏暗。"
    }
  ],
  "events": [],
  "connectedSceneIds": []
}
```

Create `JUNC_7.json`:
```json
{
  "id": "JUNC_7",
  "name": "旧街西端·火车站前",
  "description": "卡森德拉旧街的西端尽头，正对面就是火车站。路面更加不平整，铺着旧石砖。",
  "parentLocationId": "OUTDOOR",
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天路口，受天气影响。"
    }
  ],
  "events": [],
  "connectedSceneIds": ["SCN_21_SUB_1"]
}
```

Create `JUNC_8.json`:
```json
{
  "id": "JUNC_8",
  "name": "新月街A南西端·警察局前",
  "description": "新月街A大道南的西端尽头，警察局就在路边。",
  "parentLocationId": "OUTDOOR",
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天路口，受天气影响。"
    }
  ],
  "events": [],
  "connectedSceneIds": ["SCN_3_SUB_1"]
}
```

Create `JUNC_9.json`:
```json
{
  "id": "JUNC_9",
  "name": "新月街B东端",
  "description": "新月街B大道的东端尽头，道路在此终止。附近有一栋二层木屋。",
  "parentLocationId": "OUTDOOR",
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天路口，受天气影响。"
    }
  ],
  "events": [],
  "connectedSceneIds": ["SCN_6_SUB_1"]
}
```

Create `JUNC_10.json`:
```json
{
  "id": "JUNC_10",
  "name": "新月街C南端",
  "description": "新月街C大道的南端尽头，道路通向菲利普的住宅。",
  "parentLocationId": "OUTDOOR",
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天路口，受天气影响。"
    }
  ],
  "events": [],
  "connectedSceneIds": ["SCN_8_SUB_1"]
}
```

Create `JUNC_11.json`:
```json
{
  "id": "JUNC_11",
  "name": "日暮大道东端·森林入口",
  "description": "日暮大道的东端尽头，前方是茂密的森林。道路在此化为泥土小径，几乎无人问津。",
  "parentLocationId": "OUTDOOR",
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天区域，受天气影响。靠近森林，空气潮湿阴冷。"
    },
    {
      "type": "lighting",
      "description": "远离镇中心，完全没有路灯，夜间极为昏暗。",
      "mechanicalEffect": {
        "skillPenalty": [
          { "skill": "Spot Hidden", "delta": -20 }
        ]
      }
    }
  ],
  "events": [],
  "connectedSceneIds": []
}
```

- [ ] **Step 2: Commit junction files**

```bash
git add testmods/casssandra/Cassandra_Scenarios/JUNC_*.json
git commit -m "feat(cassandra): add 11 junction node files"
```

### Task 8: Rewrite ROAD_*.json files with endpoint format

**Files:**
- Modify: `ROAD_1.json` through `ROAD_10.json`
- Create: `ROAD_5a.json`, `ROAD_5b.json`
- Delete: `ROAD_5.json`

- [ ] **Step 1: Rewrite all ROAD files**

`ROAD_1.json`:
```json
{
  "id": "ROAD_1",
  "name": "星辰大道",
  "description": "卡森德拉镇北部的一条南北走向大道，北端尽头是焚化厂，南端分叉连接卡森德拉北新街和石榴巷。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_1",
  "endpointB": "JUNC_2",
  "travelTimeMinutes": 15,
  "alongConnections": [
    { "sceneId": "SCN_1_SUB_1", "position": 0.5 }
  ],
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天街道，受天气影响。冬季气温低，偶有降雪。"
    }
  ],
  "events": []
}
```

`ROAD_2.json`:
```json
{
  "id": "ROAD_2",
  "name": "卡森德拉北新街",
  "description": "从星辰大道南端向西南延伸的街道，沿途有占星屋、花店和海伦的餐桌。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_2",
  "endpointB": "JUNC_3",
  "travelTimeMinutes": 10,
  "alongConnections": [
    { "sceneId": "SCN_11_SUB_1", "position": 0.2 },
    { "sceneId": "SCN_9_SUB_1", "position": 0.5 },
    { "sceneId": "SCN_10_SUB_1", "position": 0.8 }
  ],
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天街道，受天气影响。冬季寒冷，街上行人稀少。"
    }
  ],
  "events": []
}
```

`ROAD_3.json`:
```json
{
  "id": "ROAD_3",
  "name": "卡森德拉南新街",
  "description": "案发的街道，从三岔路口向东延伸。沿途有酒厂、五金店、教堂、广场和驯鹿酒吧。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_3",
  "endpointB": "JUNC_4",
  "travelTimeMinutes": 12,
  "alongConnections": [
    { "sceneId": "SCN_13_SUB_1", "position": 0.15 },
    { "sceneId": "SCN_18_SUB_1", "position": 0.3 },
    { "sceneId": "SCN_17_SUB_1", "position": 0.5 },
    { "sceneId": "SCN_16_SUB_1", "position": 0.7 },
    { "sceneId": "SCN_16_SUB_2", "position": 0.85 }
  ],
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天街道，受天气影响。案发所在的街道，近期气氛紧张。"
    }
  ],
  "events": []
}
```

Note: The exact SCN IDs for 酒厂, 五金店, 教堂, 广场, 驯鹿酒吧 need to be verified against existing SCN files. The above uses existing SCN_13/16/17/18 IDs. Adjust after checking.

`ROAD_4.json`:
```json
{
  "id": "ROAD_4",
  "name": "卡森德拉旧街",
  "description": "镇子西侧的老街，从三岔路口向西延伸至火车站。沿途有珊德拉小屋和钟表店。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_3",
  "endpointB": "JUNC_7",
  "travelTimeMinutes": 10,
  "alongConnections": [
    { "sceneId": "SCN_14_SUB_1", "position": 0.3 },
    { "sceneId": "SCN_12_SUB_1", "position": 0.7 }
  ],
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天街道，受天气影响。旧街路面不太平整，冬季更加寒冷。"
    }
  ],
  "events": []
}
```

Delete `ROAD_5.json` and create `ROAD_5a.json`:
```json
{
  "id": "ROAD_5a",
  "name": "石榴巷北段",
  "description": "从星辰大道南端分叉向南延伸的巷道北段，通往日暮大道分叉处。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_2",
  "endpointB": "JUNC_6",
  "travelTimeMinutes": 8,
  "alongConnections": [],
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天巷道，受天气影响。巷道较窄，两侧建筑遮挡部分风雪。"
    },
    {
      "type": "lighting",
      "description": "巷道路灯稀疏，夜间光线昏暗。",
      "mechanicalEffect": {
        "skillPenalty": [
          { "skill": "Spot Hidden", "delta": -10 }
        ]
      }
    }
  ],
  "events": []
}
```

Create `ROAD_5b.json`:
```json
{
  "id": "ROAD_5b",
  "name": "石榴巷南段",
  "description": "石榴巷南段，从日暮大道分叉处向南延伸至南新街东端路口。沿途有阿道夫的屋子。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_6",
  "endpointB": "JUNC_4",
  "travelTimeMinutes": 6,
  "alongConnections": [
    { "sceneId": "SCN_15_SUB_1", "position": 0.5 }
  ],
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天巷道，受天气影响。"
    },
    {
      "type": "lighting",
      "description": "巷道路灯稀疏，夜间光线昏暗。",
      "mechanicalEffect": {
        "skillPenalty": [
          { "skill": "Spot Hidden", "delta": -10 }
        ]
      }
    }
  ],
  "events": []
}
```

`ROAD_6.json`:
```json
{
  "id": "ROAD_6",
  "name": "新月街A大道北",
  "description": "从南新街东端路口向东南延伸的大道，沿途有帕拉迪尔大酒店和马塞尔家。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_4",
  "endpointB": "JUNC_5",
  "travelTimeMinutes": 10,
  "alongConnections": [
    { "sceneId": "SCN_4_SUB_1", "position": 0.35 },
    { "sceneId": "SCN_5_SUB_1", "position": 0.7 }
  ],
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天街道，受天气影响。沿途有大酒店，街道较为宽敞。"
    }
  ],
  "events": []
}
```

`ROAD_7.json`:
```json
{
  "id": "ROAD_7",
  "name": "新月街A大道南",
  "description": "从新月街十字路口向西延伸的大道，尽头是警察局。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_5",
  "endpointB": "JUNC_8",
  "travelTimeMinutes": 8,
  "alongConnections": [],
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天街道，受天气影响。通往警察局的街道，行人不多。"
    }
  ],
  "events": []
}
```

`ROAD_8.json`:
```json
{
  "id": "ROAD_8",
  "name": "新月街B大道",
  "description": "从新月街十字路口向东延伸的大道，沿途有下水道入口，尽头是一间二层木屋。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_5",
  "endpointB": "JUNC_9",
  "travelTimeMinutes": 8,
  "alongConnections": [
    { "sceneId": "SCN_7_SUB_1", "position": 0.5 }
  ],
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天街道，受天气影响。街道两旁有住宅和木屋。"
    }
  ],
  "events": []
}
```

`ROAD_9.json`:
```json
{
  "id": "ROAD_9",
  "name": "新月街C大道",
  "description": "从新月街十字路口向南延伸的大道，尽头是菲利普的住宅。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_5",
  "endpointB": "JUNC_10",
  "travelTimeMinutes": 6,
  "alongConnections": [],
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天街道，受天气影响。通往菲利普住宅的安静街道。"
    }
  ],
  "events": []
}
```

`ROAD_10.json`:
```json
{
  "id": "ROAD_10",
  "name": "日暮大道",
  "description": "从石榴巷中段分叉向东北延伸的大道，沿途经过墓地，尽头是森林和废弃的伐木场。",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_6",
  "endpointB": "JUNC_11",
  "travelTimeMinutes": 20,
  "alongConnections": [
    { "sceneId": "SCN_19_SUB_1", "position": 0.4 },
    { "sceneId": "SCN_20_SUB_1", "position": 0.8 }
  ],
  "items": [],
  "clues": [],
  "conditions": [
    {
      "type": "weather",
      "description": "露天大道，受天气影响。通往森林和伐木场，越往深处越荒凉。"
    },
    {
      "type": "lighting",
      "description": "大道远端靠近森林处路灯稀少，夜间极为昏暗。",
      "mechanicalEffect": {
        "skillPenalty": [
          { "skill": "Spot Hidden", "delta": -15 }
        ]
      }
    }
  ],
  "events": []
}
```

- [ ] **Step 2: Delete old ROAD_5.json**

```bash
rm testmods/casssandra/Cassandra_Scenarios/ROAD_5.json
```

- [ ] **Step 3: Commit road files**

```bash
git add testmods/casssandra/Cassandra_Scenarios/ROAD_*.json
git add testmods/casssandra/Cassandra_Scenarios/ROAD_5a.json testmods/casssandra/Cassandra_Scenarios/ROAD_5b.json
git rm testmods/casssandra/Cassandra_Scenarios/ROAD_5.json
git commit -m "feat(cassandra): rewrite ROAD files with endpoint topology, split ROAD_5"
```

### Task 9: Update SCN connections for topology

**Files:**
- Modify: SCN files that currently reference ROAD_* in connections

- [ ] **Step 1: Update ALL SCN files that reference ROAD_* in connections**

Under the new topology, scene-to-road routing is handled by `sceneToParent` (from `alongConnections` and `connectedSceneIds`), so **remove all ROAD_* entries** from SCN `connections` arrays. For scenes attached to junctions, add the JUNC_* ID instead.

**Junction-attached scenes** (replace ROAD_* with JUNC_*):
- `SCN_2_SUB_1.json`: `"ROAD_1"` → `"JUNC_1"` (焚化厂 at JUNC_1)
- `SCN_3_SUB_1.json`: `"ROAD_7"` → `"JUNC_8"` (警察局 at JUNC_8)
- `SCN_6_SUB_1.json`: `"ROAD_8"` → `"JUNC_9"` (木屋 at JUNC_9)
- `SCN_8_SUB_1.json`: `"ROAD_9"` → `"JUNC_10"` (菲利普家 at JUNC_10)
- `SCN_21_SUB_1.json`: `"ROAD_4"` → `"JUNC_7"` (火车站 at JUNC_7)

**Road-attached scenes** (remove ROAD_* from connections entirely — topology handles routing):
- `SCN_1_SUB_1.json`: Remove `"ROAD_1"` (医院, along ROAD_1)
- `SCN_9_SUB_1.json`: Remove `"ROAD_2"` (花店, along ROAD_2)
- `SCN_10_SUB_1.json`: Remove `"ROAD_2"` (餐厅, along ROAD_2)
- `SCN_11_SUB_1.json`: Remove `"ROAD_2"` (占卜, along ROAD_2)
- `SCN_12_SUB_1.json`: Remove `"ROAD_4"` (钟表店, along ROAD_4)
- `SCN_13_SUB_1.json`: Remove `"ROAD_3"` or `"ROAD_4"` (酒厂, along ROAD_3)
- `SCN_14_SUB_1.json`: Remove `"ROAD_4"` (珊德拉小屋, along ROAD_4)
- `SCN_15_SUB_1.json`: Remove `"ROAD_5"` (阿道夫, along ROAD_5b)
- `SCN_16_SUB_1.json`: Remove `"ROAD_3"` (along ROAD_3)
- `SCN_17_SUB_1.json`: Remove `"ROAD_3"` (along ROAD_3)
- `SCN_18_SUB_1.json`: Remove `"ROAD_3"` (along ROAD_3)
- `SCN_4_SUB_1.json`: Remove `"ROAD_6"` (大酒店, along ROAD_6)
- `SCN_5_SUB_1.json`: Remove `"ROAD_6"` (马塞尔家, along ROAD_6)
- `SCN_7_SUB_1.json`: Remove `"ROAD_8"` (下水道, along ROAD_8)
- `SCN_19_SUB_1.json`: Remove `"ROAD_10"` (墓地, along ROAD_10)
- `SCN_20_SUB_1.json`: Remove `"ROAD_10"` (伐木场, along ROAD_10)

For each file, edit the `connections` array. Internal sub-scene connections (e.g., `"SCN_1_SUB_2"`) remain unchanged.

- [ ] **Step 2: Commit SCN updates**

```bash
git add testmods/casssandra/Cassandra_Scenarios/SCN_*.json
git commit -m "feat(cassandra): update SCN connections for junction/road topology"
```

### Task 10: Verify full loading pipeline

- [ ] **Step 1: Build and verify no errors**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 2: Write a quick smoke test**

Create a minimal test that loads the Cassandra module and verifies topology:

```typescript
// Quick manual test - can be run with: npx tsx test-topology.ts
import { WorldModuleLoader } from "./src/dynamicworldagent/world_builder/worldModuleLoader.js";

const loader = new WorldModuleLoader({} as any);
const module = await loader.loadWorldModule("./testmods/casssandra", true);
if (module) {
  console.log(`Junctions: ${module.junctions.size}`);
  console.log(`Roads: ${module.roads.size}`);
  console.log(`Scenes: ${module.scenes.size}`);

  // Verify topology
  for (const [id, road] of module.roads) {
    const hasA = module.junctions.has(road.endpointA);
    const hasB = module.junctions.has(road.endpointB);
    console.log(`  ${id}: ${road.endpointA}(${hasA}) → ${road.endpointB}(${hasB})`);
  }
}
```

Run: `npx tsx test-topology.ts`
Expected: 11 junctions, 11 roads (ROAD_1-4, 5a, 5b, 6-10), all endpoints resolved

- [ ] **Step 3: Clean up and commit**

```bash
rm test-topology.ts
git add -A
git commit -m "feat(topology): complete road & junction topology implementation"
```

---

## Future Work (Not In This Plan)

These items are documented in the design but deferred to separate plans:

1. **Fire Feature adaptation** — Support position ranges on roads, propagation along road segments
2. **Lighting Feature adaptation** — Per-position light levels on roads
3. **Tick-based movement** — Characters moving along roads over multiple ticks instead of instant teleport
4. **Serialization** — Persist topology and character positions through checkpoints/saves
5. **DynamicGameStateLoader** — Load topology from database (currently only from files)
