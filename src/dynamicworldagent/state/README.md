# Dynamic Game State

NPC simulation engine runtime state, separate from the old multi-agent `GameState`.

## Core Interface

`DynamicGameState` contains only fields actively used by the tick processor, node handlers, world features, and SimulationRunner.

```typescript
interface DynamicGameState {
  sessionId: string;
  scenes: Map<string, DynamicScene>;
  gameDay: number;
  timeOfDay: string;      // "HH:MM"
  npcCharacters: DynamicNPCProfile[];
  discoveredKnowledge: DiscoveredKnowledge[];
  moduleName: string;
  moduleDigest: ModuleDigest | null;
  scenarioOutlines: ScenarioOutline[];
  featureState: Record<string, Record<string, unknown>>;
  npcLocations: Record<string, string>;
  npcStats: Record<string, { hp: number; san: number }>;
  npcInventories: Record<string, Item[]>;
  npcDiscoveredKnowledge: Record<string, string[]>;
  npcRelationshipGraph: Record<string, Record<string, { score: number; note: string }>>;
  scenarioConditions: Record<string, SceneCondition[]>;
  blockedConnections: Map<string, string>;
  npcResidences: Record<string, string>;
  transportEdges: TransportEdge[];
  topology: TownTopology | null;
  characterPositions: Record<string, CharacterPosition>;
  loadedAt: Date;
  lastUpdated: Date;
}
```

## Usage

```typescript
import { loadDynamicGameState, DynamicGameStateManager } from "./state/index.js";

const dynamicState = await loadDynamicGameState(db, "Module Name");
if (dynamicState) {
  const manager = new DynamicGameStateManager(dynamicState);
  // Use manager methods for NPC locations, stats, inventory, relationships, etc.
}
```

## Serialization

```typescript
const serialized = manager.serialize();
const restored = DynamicGameStateManager.deserialize(serialized);
```

## Module Data Layer

Module metadata types (`MacroSceneStructure`, `TruthEvent`, `RedHerring`, etc.) live in `types.ts` and represent the on-disk JSON file format. They are loaded by `WorldModuleLoader` and persisted to the database but are **not** part of the simulation runtime state.
