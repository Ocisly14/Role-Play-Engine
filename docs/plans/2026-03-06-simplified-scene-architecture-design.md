# Simplified Scene Architecture Design

Date: 2026-03-06
Branch: tick

## Problem

`DynamicScenarioSnapshot` has 14 fields, many are UI/runtime metadata irrelevant to the game engine. The "snapshot" concept (historical versioning, Director-driven scene updates) adds complexity without matching the tick-based architecture. Character presence is redundantly tracked on both the scene and NPC profiles.

## Design

### New `DynamicScene` interface (replaces `DynamicScenarioSnapshot`)

```typescript
interface DynamicScene {
  id: string;
  name: string;
  description: string;           // base scene description (static after load)
  domain?: string;               // NPC id or faction controlling this scene
  items: SceneItem[];            // physical objects present in the scene
  clues: ScenarioClue[];         // discoverable clues (tick engine reads/mutates)
  conditions: ScenarioCondition[]; // environmental conditions
  sceneImage?: SceneImage;       // generated image
  events: string[];              // tick processor appends scene changes here
}

interface SceneItem {
  id: string;
  name: string;
  description?: string;
}
```

### Removed fields (from DynamicScenarioSnapshot)

| Field | Reason |
|---|---|
| `gameTime` | Redundant with `DynamicGameState.timeOfDay` |
| `timestamp` | System metadata, not scene data |
| `snapshotType` | Snapshot concept removed |
| `location` | Redundant with `name` |
| `showMap`, `mapImagePath` | UI concern, stays on `ScenarioOutline` |
| `characters[]` | Derived from NPC `currentLocation` |
| `keeperNotes` | Removed |
| `estimatedShortActions` | Runtime metadata, stays on `ScenarioOutline` |
| `timeRestriction` | Scheduling concern, stays on `ScenarioOutline` |
| `initialSnapshot` | One-time flag, removed |

### State structure changes

| Before | After |
|---|---|
| `currentScenario: DynamicScenarioSnapshot \| null` | `currentSceneId: string \| null` |
| `updatedDynamicScenarioSnapshots: Map<string, DynamicScenarioSnapshot[]>` | `scenes: Map<string, DynamicScene>` |
| `temporaryInfo.previousScenario: DynamicScenarioSnapshot \| null` | Removed |

- `scenes` is a flat map: one mutable scene per ID, no history stack
- Scene switch = update `currentSceneId`, scene data already in the Map
- Character presence = derived via `npcCharacters.filter(n => n.currentLocation === sceneId)`

### Tick processor: single scene writer

The tick processor resolves all actions and is the only thing that mutates scene state:
- `scene.clues` — discovery/damage (already implemented)
- `scene.items` — pickup/place/destroy (move between scene and NPC inventory)
- `scene.conditions` — environmental action effects
- `scene.events` — append descriptions of physical scene changes (e.g., "a lamp was smashed")

### Director scope reduction

Director no longer:
- Updates scene snapshots / worldline updates
- Manages `updatedDynamicScenarioSnapshots`
- Stores `previousScenario`

Director still:
- Checks game ending conditions
- Monitors story progression

### ScenarioOutline (static, unchanged)

Retains: `id`, `name`, `description`, `connections[]`, `tags`, `evidence`, `clues` (seeds). Gains fields moved from snapshot: `showMap`, `mapImagePath`, `estimatedShortActions`, `timeRestriction`.

### Keeper template changes

- Reads scene from `scenes.get(currentSceneId)` instead of `currentScenario`
- Connections resolved from `ScenarioOutline` (already the case)
- `scene.events` injected into template so Keeper can narrate recent scene changes
- No more `clueRevelations` output (already removed on tick branch)

### Affected files (21 files, ~170 references to DynamicScenarioSnapshot)

1. `src/dynamicworldagent/world_builder/types.ts` — replace interface
2. `src/dynamicworldagent/state/DynamicGameState.ts` — replace state fields + manager methods
3. `src/dynamicworldagent/state/DynamicGameStateLoader.ts` — load into flat Map
4. `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` — add scene item/event mutations
5. `src/dynamicworldagent/dynamicBasicAgent/keeper/keeperAgent.ts` — read from scenes Map
6. `src/dynamicworldagent/dynamicBasicAgent/keeper/keeperTemplate.ts` — add events section
7. `src/dynamicworldagent/dynamicBasicAgent/director/` — strip scene update logic
8. `src/dynamicworldagent/dynamicBasicAgent/character/characterAgent.ts` — derive presence from NPC currentLocation
9. `src/dynamicworldagent/dynamicBasicAgent/memory/checkpoint.ts` — serialize scenes Map
10. `src/dynamicworldagent/graph/dynamicGraph.ts` — use currentSceneId + scenes
11. `src/dynamicworldagent/visual/sceneImage.ts` — use DynamicScene
12. `src/template.ts` — update type reference
13. `src/dynamicworldagent/world_builder/worldModuleLoader.ts` — output DynamicScene
