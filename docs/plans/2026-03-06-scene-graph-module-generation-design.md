# Scene Graph Module Generation Design

**Date:** 2026-03-06
**Branch:** tick
**Status:** Approved

## Overview

Refactor module generation with two major changes:

1. **Two-level scene architecture** -- macro locations (buildings/areas) contain multiple sub-scenes (rooms/floors). Street/outdoor scenes connect macro locations. Full scene graph with explicit connections and pathfinding.

2. **Pipeline inversion** -- generate the physical world first (scenes, streets, buildings), then weave the story into it (truth timeline, knowledge matrix, NPCs, clues). This produces more organic, lived-in worlds where story events are grounded in real geography.

## Core Concepts

### Two-Level Scene Hierarchy

| Level | Name | Example | Contains |
|---|---|---|---|
| Macro Location | `ScenarioOutline` | "The Golden Lion Bar" | Container: name, description, residents, subSceneCount |
| Sub-Scene | `DynamicScene` | "Bar - Ground Floor", "Bar - Upper Floor" | Full scene: items, clues, conditions, connections, events |

Macro locations are pure containers with no connections. All connections exist at the sub-scene level.

### Scene Graph

All movement happens between sub-scenes:
- Sub-scene <-> sub-scene (within a building: stairs, doors)
- Sub-scene <-> street scene (building exit to outdoor connector)
- Street scene <-> sub-scene (outdoor connector to another building)

Street/outdoor scenes are also `DynamicScene` instances under their own macro location (e.g. "Town Streets").

### Movement Model

**Normal movement:** Follow declared `connections`. Tick processor pathfinds (BFS) for long-distance moves, generating implicit hops.

**Creative movement:** Planner reads scene description, proposes non-connection move (e.g. jump from window to street). Requires `actionType` + skill check. Single hop, no pathfinding.

**Planning agent context:**
- Current scene connections (adjacent sub-scenes)
- Current macro location's neighboring macro locations (via transport network)
- Scene descriptions (for creative movement reasoning)

Planning agent specifies destination only. Tick processor handles pathfinding and multi-hop execution.

---

## Data Structures

### ScenarioOutline (Macro Location -- container only)

```typescript
interface ScenarioOutline {
  id: string;
  name: string;
  description: string;
  sourcePlaceId?: string;       // link to PLACE knowledge holder (set in Phase 7)
  sourcePlaceName?: string;
  residents?: string[];         // NPC IDs who live/rest here (set in Phase 9)
  subSceneCount: number;        // declared sub-scene count
}
```

No connections, no clues. Just a framework for grouping sub-scenes.

### DynamicScene (Sub-Scene)

```typescript
interface DynamicScene {
  id: string;
  name: string;
  description: string;
  parentLocationId: string;     // back-ref to ScenarioOutline.id
  items: SceneItem[];
  clues: ScenarioClue[];
  conditions: ScenarioCondition[];
  connections: string[];        // IDs of directly connected DynamicScenes
  sceneImage?: SceneImage;
  events: string[];
}

interface SceneItem {
  id: string;
  name: string;
  description?: string;
}
```

Connections are always between sub-scenes. A bar's ground floor connects to the upper floor (internal) and to "Main Street" (external). Street scenes connect to multiple building entry scenes.

### Transport Network

Generated during world building. Carries travel time distances between macro locations:

```typescript
interface TransportEdge {
  fromLocationId: string;       // macro location A
  toLocationId: string;         // macro location B
  streetSceneId: string;        // the street/outdoor scene connecting them
  travelTimeMinutes: number;    // time to traverse this edge
}
```

Examples:
- Bar <-> Town Square: 5 minutes
- Town Square <-> Hospital: 10 minutes
- Hospital <-> Residential District: 15 minutes

### Travel Time Calculation

Tick processor computes total travel time per movement:
- **Within building** (sub-scene to sub-scene): ~1-2 minutes per hop
- **Between buildings**: sum of `TransportEdge.travelTimeMinutes` along the path

Example: Hospital Ward (3F) -> Bar Floor 2:
- Hospital Ward -> Hospital Lobby: 1 min (internal)
- Hospital Lobby -> Main Street: 10 min (transport edge)
- Main Street -> Bar Floor 1: 5 min (transport edge)
- Bar Floor 1 -> Bar Floor 2: 1 min (internal)
- Total: ~17 minutes

### Runtime Blocked State

Static connections live on `DynamicScene.connections`. Runtime blocked state tracked separately in `DynamicGameState`:

```typescript
blockedConnections: Map<string, string>;  // "sceneA::sceneB" -> reason
```

- Connection in `scene.connections` + NOT in `blockedConnections` -> passable
- Connection in `scene.connections` + IS in `blockedConnections` -> blocked

`scene_interaction` with `sceneConnectionEffect` writes/removes entries from `blockedConnections`.

### DynamicNPCProfile (addition)

```typescript
interface DynamicNPCProfile extends DynamicCharacterProfile {
  // ... existing fields ...
  residence?: string;  // macroLocationId -- derived from ScenarioOutline.residents
}
```

### DynamicGameState (changes)

```typescript
// Remove:
connectionStates: ScenarioConnectionState[];

// Add:
blockedConnections: Map<string, string>;    // blocked edges + reason
npcResidences: Record<string, string>;      // npcId -> macroLocationId
transportEdges: TransportEdge[];            // travel time between macro locations
```

---

## Generation Pipeline

Pipeline is inverted: **physical world first, then story woven in**.

### Phase 0: Prompt Structurizer (unchanged)

User's creative prompt -> `StructuredStoryElements` (era, themes, tone, horror type).

### Phase 1: Setting + Story Seed (modified macro scene agent)

Generates high-level world context only -- no detailed plot yet:
- `MacroSceneStructure` (era, location type, atmosphere, geography)
- `MythosEvents` (historical backstory -- happened in the past, not scene-specific)
- `EndStateDefinition` (what happens if players don't intervene)
- **Story premise** -- 1-2 paragraph seed: what kind of mystery, general themes

Truth timeline and knowledge matrix are **NOT** generated here.

### Phase 2: Macro Location Generation

**Input:** Setting + story premise + module size config
**Output:** `ScenarioOutline[]` (macro locations with subSceneCount)

The LLM generates buildings/areas guided by the story premise:
- "1920s college town with dark academic secrets" -> university, library, faculty houses, downtown shops, church, etc.
- Filler locations for realism (houses, shops, inns)
- `subSceneCount` per location

No clues, no evidence, no NPC assignment yet -- pure physical world.

Module size controls scale:

```typescript
interface ModuleSizeConfig {
  size: "small" | "medium" | "large";
  macroLocationCount: [number, number];     // [min, max]
  subSceneRange: [number, number];          // per macro location
  outdoorSceneRange: [number, number];      // street/connector scenes
  totalSceneCap: number;                    // soft upper bound
}

const MODULE_SIZE_CONFIGS = {
  small:  { macroLocationCount: [4, 6],   subSceneRange: [1, 3], outdoorSceneRange: [2, 4],  totalSceneCap: 25  },
  medium: { macroLocationCount: [7, 12],  subSceneRange: [2, 4], outdoorSceneRange: [3, 6],  totalSceneCap: 50  },
  large:  { macroLocationCount: [13, 20], subSceneRange: [2, 5], outdoorSceneRange: [5, 10], totalSceneCap: 80  },
};
```

### Phase 3: Transport Network Generation

**Input:** `ScenarioOutline[]` (macro locations)
**Output:** Street/outdoor scenes + `TransportEdge[]` with travel times

The LLM generates:
- Street/outdoor connector scenes (e.g. "Main Street", "Town Square", "Forest Path")
- Connection edges: which street scene connects which macro locations
- Travel time (minutes) per edge
- Each street scene is a `DynamicScene` under a "Town Streets" (or equivalent) macro location

### Phase 4: Sub-Scene Generation (parallel)

**Input per macro location:** ScenarioOutline + setting context
**Output per macro location:** `DynamicScene[]` + internal connections

For each macro location, the LLM generates:
- N sub-scenes as declared in Phase 2
- Internal connection graph (which rooms connect to which)
- One scene is the entry scene (connects to outdoor/street scenes per Phase 3)
- Items, conditions, scene descriptions
- No clues yet -- clues are placed after story generation

All macro locations processed **in parallel**.

### Phase 5: Graph Assembly (no LLM)

Pure code:
1. Merge sub-scenes from all macro locations + outdoor connector scenes
2. Wire entry scenes to outdoor connectors based on Phase 3 transport edges
3. Validate: all scenes reachable (BFS from any scene), no orphans
4. Build `TransportEdge[]` for runtime
5. Output: complete scene set + transport network

--- **Story phases start here -- world already exists** ---

### Phase 6: Truth Timeline

**Input:** Setting, mythos events, end state, **all existing scenes + macro locations**
**Output:** `TruthEvent[]`

Events are placed in specific existing scenes. The LLM knows the actual geography and can say "the ritual happens in University Basement" rather than inventing a location.

### Phase 7: Knowledge Matrix

**Input:** Truth timeline, **all existing scenes + macro locations**
**Output:** `KnowledgeHolder[]`

- PLACE holders map to existing macro locations (sets `sourcePlaceId` on ScenarioOutline)
- ROLE/ORGANIZATION/OBJECT holders are abstract (become NPCs later)
- Red herrings generated here or as sub-step

### Phase 8: Red Herrings

**Input:** Truth timeline, knowledge matrix, existing scenes
**Output:** `RedHerring[]` -- false explanations placed in the existing world

### Phase 9: NPC Generation

**Input:** Knowledge matrix, existing scenes
**Output:** `DynamicNPCProfile[]`

- NPCs instantiated from knowledge holders (mostly unchanged)
- Assigned to scenes they're associated with
- `residents` arrays set on `ScenarioOutline` for residential locations
- `residence` derived on NPC profiles

### Phase 10: Clue/Evidence Placement

**Input:** Truth timeline, knowledge matrix, NPCs, existing scenes
**Output:** Clues distributed across `DynamicScene.clues` + NPC clues

Key benefit: when the truth timeline says "the professor hid the artifact", the LLM already knows the professor's office is on University Building Floor 2 -- clue placement is naturally grounded in real geography.

### Phase 11: Module Digest + Persistence (mostly unchanged)

- Module digest generation (keeper guidance, victory conditions)
- Save to JSON files + database

---

## Tick Processor Pathfinding

### BFS Path Finding

```typescript
function findPath(
  fromSceneId: string,
  toSceneId: string,
  scenes: Map<string, DynamicScene>,
  blockedConnections: Map<string, string>
): string[] | null {
  // BFS on scene.connections, skipping blocked edges
  // Returns ordered scene IDs: [from, hop1, hop2, ..., to]
  // Returns null if unreachable
}
```

### Multi-Hop Movement Execution

Each hop in the path becomes an implicit movement sub-step:
- Compute time per hop: internal (1-2 min) or transport edge time
- Update NPC location after each successful hop
- If any hop blocked mid-path -> movement fails with `"path_blocked"` reason
- NPC's `gameTime` advances accordingly

### Creative Movement

- No pathfinding -- single direct hop to non-connected scene
- Requires `actionType` on the movement node (e.g. `environmental`, `stealth`)
- Tick processor performs skill check
- Failure can cause side effects (fall damage, detection, etc.)

---

## Planning Agent Context

When generating daily plans or revising plans, the planning agent receives:

```typescript
{
  currentScene: {
    id, name, description,
    connections: { id, name }[],         // adjacent scene IDs with names
  },
  currentMacroLocation: {
    id, name, description,
  },
  nearbyMacroLocations: {               // reachable via transport network
    id, name, description,
    entrySceneId, entrySceneName,
    travelTimeMinutes,
  }[],
  residenceMacroLocationId: string,      // where NPC goes home to rest
  // ... existing context (longTermIntent, actionLog, relationships, etc.)
}
```

Movement node output:
- `location`: destination scene ID
- Normal move: tick processor pathfinds
- Creative move: include `actionType` for skill check

---

## NPC Residence

- `ScenarioOutline.residents: string[]` declares which NPCs live at a macro location
- At game init, derive `npcResidences: Record<npcId, macroLocationId>` from this
- Add `residence: string` to `DynamicNPCProfile`
- Planning agent uses `residence` to generate sleep/rest routines (go home at night)
- Sub-scene generation for locations with residents creates appropriate living spaces

---

## Module Size Scaling

Scale is controlled by module size (small/medium/large), consistent with existing module system:

| Size | Macro Locations | Sub-Scenes/Location | Outdoor Scenes | Total Cap |
|---|---|---|---|---|
| Small | 4-6 | 1-3 | 2-4 | ~25 |
| Medium | 7-12 | 2-4 | 3-6 | ~50 |
| Large | 13-20 | 2-5 | 5-10 | ~80 |

---

## Files Changed

### New Files

```
src/dynamicworldagent/world_builder/
  sceneGraphBuilder.ts            # Phase 3: transport network generation
  sceneGraphBuilderTemplate.ts    # LLM prompts for graph building
  subSceneBuilder.ts              # Phase 4: parallel sub-scene content fill
  subSceneBuilderTemplate.ts      # LLM prompts for sub-scene generation
  cluePlacementAgent.ts           # Phase 10: clue distribution across scenes
  cluePlacementTemplate.ts        # LLM prompts for clue placement
  moduleSizeConfig.ts             # S/M/L scaling constants
```

### Modified Files

```
src/dynamicworldagent/world_builder/
  types.ts                        # ScenarioOutline simplified, DynamicScene + connections + parentLocationId, TransportEdge
  scenarioBuilderAgent.ts         # Phase 2: generates macro locations (no clues, no NPCs)
  scenarioBuilderTemplate.ts      # Updated prompts for macro location generation
  macroSceneAgent.ts              # Phase 1: generates setting + story seed (deferred truth timeline + knowledge matrix)
  macroSceneTemplate.ts           # Updated prompts -- lighter output, story premise only
  worldBuilderService.ts          # Orchestrates new pipeline phases (0-11)
  worldModuleLoader.ts            # Load/save scene graph + sub-scenes + transport edges

src/dynamicworldagent/state/
  DynamicGameState.ts             # Replace connectionStates -> blockedConnections, add npcResidences + transportEdges
  DynamicGameStateLoader.ts       # Build scene graph from loaded scenes, init npcResidences

src/dynamicworldagent/dynamicBasicAgent/npcPlanning/
  tickProcessor.ts                # Add BFS pathfinding, multi-hop movement, travel time calculation
  NPCPlanningAgent.ts             # Updated context: connections + nearby macro locations
  NPCPlanningTemplate.ts          # Updated prompts with scene graph context
```

### Removed

```
# ScenarioConnectionState type -- replaced by DynamicScene.connections + blockedConnections
# connectionStates field from DynamicGameState
```

---

## Out of Scope

- Multiplayer equivalents (separate follow-up)
- Prisma schema migrations for new scene graph tables
- Scene image generation for sub-scenes (keep current approach)
- Starting scene selection (may need redesign for sub-scene granularity)
