# Simulation Map Viewer — Design Spec

**Date:** 2026-03-12
**Status:** Approved
**Context:** Frontend visualization for the NPC autonomous simulation system (see `docs/superpowers/plans/2026-03-11-npc-autonomous-simulation.md`)

---

## Overview

A dedicated page for observing NPC autonomous simulation in real-time through a pixel-art map. No player interaction — purely a viewer for watching NPCs move, act, and interact across the game world.

The map is a unified zoomable Phaser 3 canvas with three depth levels:

- **Level 1 (Global):** Zoomed-out town overview, NPCs as small dots
- **Level 2 (Area):** Zoomed-in street/junction detail, full NPC sprites and items visible
- **Level 3 (Building Interior):** Separate Tiled tilemap for indoor scenes, with sub-scene tab switching

---

## Page Layout

```
┌─────────────────────────────────┬───────────────────┐
│                                 │                    │
│   Unified Phaser Canvas         │   Side Panel       │
│                                 │   - Game Clock     │
│   Level 1: Town overview        │   - NPC List       │
│   Level 2: Area zoom-in         │   - Selected NPC   │
│   Level 3: Building interior    │   - Event Log      │
│                                 │                    │
│   Scroll to zoom / Click to     │                    │
│   enter buildings               │                    │
│                                 │                    │
├─────────────────────────────────┴───────────────────┤
│  ┌──────────────────────┐                            │
│  │ ▶/⏸  ⏭  │ 1x ▼  │  Floating Control Panel     │
│  └──────────────────────┘                            │
└─────────────────────────────────────────────────────┘
```

**Route:** `/simulation/:sessionId` — placed **outside** `ProtectedRoute`. No authentication required, consistent with the backend simulation API design.

Fully independent from the game chat page. No shared components with `GamePage`.

### Prerequisites

- Module must have JUNC/ROAD topology files. Modules without topology data cannot use the map viewer.
- Module must provide `[Module]_Maps/` directory with town.json, tilesets, sprites.
- Backend simulation system must be implemented (see simulation plan).

---

## Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Map rendering | **Phaser 3** (~1MB gzipped, new dependency) | Native Tiled JSON support, sprite animation, camera system. Import via Vite — initialize in `useEffect`, Phaser manages its own canvas. |
| Side panel | React + Tailwind | Standard UI, consistent with existing app |
| Floating controls | React (position: fixed) | Simple button group calling simulation API |
| React ↔ Phaser bridge | Phaser EventEmitter | React dispatches events to Phaser, Phaser emits back to React |
| Real-time updates | WebSocket | Existing simulation WebSocket infrastructure |

---

## Map Levels

### Level 1 & 2: Town Map (Single Tiled Map)

Level 1 and Level 2 are the **same Tiled map** (`town.json`) at different camera zoom levels.

**Camera behavior:**
- Default: zoom out to fit entire town
- Click area/NPC: camera smooth-zooms to that position
- Mouse wheel / pinch: manual zoom
- Drag: pan camera

**NPC rendering by zoom level:**
- Zoomed out (Level 1): NPCs rendered as colored dots (performance optimization)
- Zoomed in (Level 2): NPCs switch to full sprite sheets with walk animation
- **Zoom threshold:** When camera zoom < 0.5 (relative to 1.0 = 1:1 pixel), render dots. At zoom >= 0.5, render sprites. Threshold configurable in code.

**Tiled layer conventions for `town.json`:**

| Layer Name | Type | Required | Purpose |
|------------|------|----------|---------|
| `ground` | Tile Layer | Yes | Terrain (dirt, grass, pavement) |
| `roads` | Tile Layer | Yes | Road surfaces |
| `buildings` | Tile Layer | Yes | Building exteriors |
| `decoration` | Tile Layer | No | Trees, lampposts, fences |
| `collision` | Tile Layer | Yes | Unwalkable areas (NPC pathfinding) |
| `building_entrances` | Object Layer | No | Building entry points, linked to sceneId |
| `npc_spawns` | Object Layer | No | NPC default outdoor positions |
| `items` | Object Layer | No | Outdoor item positions |

**`building_entrances` object example:**
```json
{
  "name": "Hospital Entrance",
  "type": "entrance",
  "x": 384, "y": 160,
  "properties": [
    { "name": "sceneId", "value": "SCN_1_SUB_1" },
    { "name": "buildingName", "value": "星辰医院" }
  ]
}
```

### Level 3: Building Interior (Separate Tiled Maps)

Triggered by clicking a building entrance on the town map.

**Interior Tiled layer conventions:**

| Layer Name | Type | Required | Purpose |
|------------|------|----------|---------|
| `ground` | Tile Layer | Yes | Floor |
| `walls` | Tile Layer | Yes | Walls/barriers |
| `furniture` | Tile Layer | No | Furniture/decoration |
| `collision` | Tile Layer | Yes | Unwalkable areas |
| `spawns` | Object Layer | No | NPC default positions in this room |

**Sub-scene navigation:**
- Buildings with multiple sub-scenes (e.g., `SCN_1_SUB_1` through `SCN_1_SUB_6`) show the first sub-scene by default
- Tab bar at top allows switching between sub-scenes
- Back button returns to Level 2 (town map zoomed to building location)

**NPC visibility:**
- NPCs inside a building are NOT shown on the town map
- NPCs inside a building ARE shown in the interior view if viewing that sub-scene

---

## NPC Position Mapping

### Topology → Pixel Coordinates

`map_layout.json` maps junction IDs to pixel coordinates on the town Tiled map:

```json
{
  "junctions": {
    "JUNC_1": { "x": 400, "y": 50 },
    "JUNC_2": { "x": 400, "y": 250 }
  }
}
```

**CharacterPosition → pixel coordinate conversion:**

The map viewer uses `characterPositions: Record<string, CharacterPosition>` (topology-level, typed union) as the authoritative position source. The legacy `npcLocations: Record<string, string>` is not used — modules must have topology data.

| Position Type | Conversion |
|---------------|------------|
| `type: "junction"` | Use junction's `(x, y)` from `map_layout.json` directly |
| `type: "road"` | Linear interpolation between endpointA and endpointB junction coords using `position` (0.0–1.0). Road endpoints are junctions, so their coords come from `map_layout.json`. |
| `type: "scene"` | Look up scene's parent via `TownTopology.sceneToParent`. If parent is a junction: use junction coords. If parent is a road: interpolate using `sceneToParent.position` (this is the `AlongConnection.position` — the building's fixed position along the road, NOT the character's `CharacterPosition.position` which tracks movement along a road). If scene has a `building_entrances` object in the Tiled map, prefer that for precise pixel placement. If no Tiled entrance exists, fall back to topology-derived coords. Indoor NPCs (in interior view) use the interior tilemap's `spawns` object layer. |

### NPC Movement Animation

- **Scene-to-scene movement:** NPC position changes via WebSocket event. Sprite/dot animates from old position to new position.
- **Enter building:** Sprite walks to building entrance, then fades out.
- **Exit building:** Sprite fades in at building entrance.
- **In interior view:** Sprite moves to `spawns` point or random walkable position. Fade in/out on enter/leave.

---

## Module Asset Structure

```
data/Mods/[Module Name]/
├── module_digest.json
├── [Module]_npc/
├── [Module]_Scenarios/          # Existing: JUNC_*, ROAD_*, SCN_* JSONs
└── [Module]_Maps/               # NEW
    ├── map_layout.json          # Junction pixel coordinates
    ├── tilesets/                 # Tileset images
    │   ├── outdoor.png          # Outdoor tileset (streets, building exteriors, trees)
    │   ├── interior.png         # Indoor tileset
    │   └── ...
    ├── sprites/                 # NPC sprite sheets
    │   ├── tom_bartender.png
    │   ├── sarah_librarian.png
    │   └── ...
    ├── items/                   # Item icons (optional)
    │   └── ...
    ├── town.json                # Full town Tiled map (outdoor)
    └── interiors/               # Building interior Tiled maps
        ├── SCN_1_SUB_1.json     # Hospital lobby
        ├── SCN_1_SUB_2.json     # Hospital corridor
        └── ...
```

### Sprite Sheet Convention

Standard 4-direction walk animation:

```
Each frame: 32x48 pixels (width x height)
Row 0: Down  (3 frames)
Row 1: Left  (3 frames)
Row 2: Right (3 frames)
Row 3: Up    (3 frames)

Total sheet size: 96x192
```

### Tilemap ↔ Scene ID Binding

Extend the `ModuleDigest` interface in `src/dynamicworldagent/world_builder/types.ts` with:

```typescript
// Add to ModuleDigest interface
sceneMapBindings?: Record<string, string>;  // sceneId → relative path to interior Tiled JSON
spriteBindings?: Record<string, string>;    // npcId → relative path to sprite sheet
```

Update `ModuleLoader` to parse these new fields from `module_digest.json`.

Example in `module_digest.json`:

```json
{
  "sceneMapBindings": {
    "SCN_1_SUB_1": "interiors/SCN_1_SUB_1.json",
    "SCN_1_SUB_2": "interiors/SCN_1_SUB_2.json"
  },
  "spriteBindings": {
    "npc-tom-001": "sprites/tom_bartender.png",
    "npc-sarah-002": "sprites/sarah_librarian.png"
  }
}
```

---

## Frontend Components

### Component Tree

```
SimulationPage                     # Route: /simulation/:sessionId
├── useSimulationWebSocket         # Hook: WS connection, receive events
├── useSimulationState             # Hook: manage NPC positions, statuses, events
│
├── PhaserContainer                # Phaser game wrapper
│   ├── TownScene                  # Level 1 & 2: town.json + camera zoom
│   └── InteriorScene              # Level 3: building interior tilemap
│
├── SidePanel                      # Right panel (React + Tailwind)
│   ├── GameClock                  # Game time (Day X, HH:MM)
│   ├── NpcList                    # All NPC status cards
│   │   └── NpcCard                # Single NPC: avatar, location, status, current action
│   ├── NpcDetail                  # Expanded NPC detail (on click)
│   └── EventLog                   # Event timeline
│       └── EventEntry             # Single event
│
├── SubSceneTabs                   # Level 3 only: tab bar for sub-scene switching
│
└── ControlPanel                   # Floating panel (position: fixed, bottom-left)
    ├── PlayPauseButton            # ▶ / ⏸ toggle
    ├── StepButton                 # ⏭ advance one tick
    └── SpeedSelector              # 1x / 2x / 5x / 10x
```

### Type Definitions

```typescript
/**
 * Junction coordinates on the town Tiled map.
 * Road pixel positions are derived by interpolating between endpoint junction coords
 * using TownTopology.roads[roadId].endpointA/endpointB — MapLayout alone is not sufficient.
 * The frontend must have both MapLayout AND TownTopology loaded to resolve road positions.
 */
interface MapLayout {
  junctions: Record<string, { x: number; y: number }>;
}

/**
 * Assembled by the /api/simulation/:id/npc-statuses endpoint from multiple sources:
 * - name: from DynamicNPCProfile.name
 * - hp/maxHp: from npcStats.hp + DynamicNPCProfile.status.maxHp
 * - sanity/maxSanity: from npcStats.san + DynamicNPCProfile.status.maxSanity
 *   (uses "sanity"/"maxSanity" naming to match CharacterStatus convention)
 * - location: resolved from CharacterPosition via topology lookup to human-readable name
 * - inventory: from npcInventories (full Item objects)
 * - currentAction: from most recent CharacterAction in the tick
 */
interface NpcStatusInfo {
  npcId: string;
  name: string;
  hp: number;
  maxHp: number;
  sanity: number;                   // Matches CharacterStatus naming
  maxSanity: number;                // Matches CharacterStatus naming
  currentAction: string | null;
  location: string;                 // Human-readable location name
  inventory: ItemInfo[];            // Full item objects (not just names)
  isAlive: boolean;
}

/** Re-uses existing Item type from world_builder/types.ts */
type ItemInfo = import("../world_builder/types").Item;
```

### useSimulationState

```typescript
interface SimulationViewState {
  // Topology (loaded once on init)
  topology: TownTopology;
  mapLayout: MapLayout;

  // NPC real-time state
  npcPositions: Map<string, CharacterPosition>;
  npcStatuses: Map<string, NpcStatusInfo>;

  // Scene items (uses existing Item type)
  sceneItems: Map<string, ItemInfo[]>;

  // UI state
  currentLevel: 1 | 2 | 3;
  focusedBuildingId: string | null;          // Level 3: which building
  focusedSubSceneId: string | null;          // Level 3: which sub-scene
  selectedNpcId: string | null;              // Side panel focus

  // Simulation state
  gameDay: number;
  timeOfDay: string;
  simulationState: SimulationState;

  // Event log — capped at 200 entries, oldest pruned on overflow
  eventLog: SimulationEvent[];
}
```

### React ↔ Phaser Communication

```typescript
// React → Phaser
phaserGame.events.emit('npc-position-update', { npcId, position });
phaserGame.events.emit('zoom-to', { x, y, zoom });
phaserGame.events.emit('enter-building', { sceneId });
phaserGame.events.emit('exit-building');
phaserGame.events.emit('switch-sub-scene', { subSceneId });
phaserGame.events.emit('item-update', { sceneId, items });

// Phaser → React
phaserGame.events.on('npc-clicked', (npcId) => setSelectedNpcId(npcId));
phaserGame.events.on('building-clicked', (sceneId) => enterBuilding(sceneId));
phaserGame.events.on('zoom-level-changed', (level) => setCurrentLevel(level));
```

---

## Backend API

### New Endpoints (for map viewer)

| Endpoint | Method | Response |
|----------|--------|----------|
| `/api/simulation/:id/topology` | GET | `{ junctions, roads, scenes }` from TownTopology |
| `/api/simulation/:id/map-layout` | GET | `map_layout.json` content |
| `/api/simulation/:id/positions` | GET | All NPC `CharacterPosition` records |
| `/api/simulation/:id/npc-statuses` | GET | All NPC HP, SAN, current action, inventory |
| `/api/maps/:moduleName/*` | GET | Static file serving for tilesets, sprites, tilemaps |

### Backend Simulation Plan Modifications Required

The existing simulation plan (`2026-03-11-npc-autonomous-simulation.md`) needs these additions for the map viewer:

**1. New event type: `"npc_moved"`**

Add `"npc_moved"` to `SimulationEventType` union in `src/dynamicworldagent/simulation/types.ts`. The tick processor already calls `dgsm.setCharacterPosition()` during NPC movement — wire the `SimulationEventEmitter` at that call site to emit:

```typescript
{
  type: "npc_moved",
  actorNpcId: npcId,
  location: resolvedLocationName,
  data: {
    fromPosition: CharacterPosition,  // previous position
    toPosition: CharacterPosition     // new position
  }
}
```

**2. New API endpoint: `PUT /api/simulation/:id/config`**

For runtime speed adjustment. Updates `tickIntervalMs` on the running `SimulationRunner` and restarts the interval timer.

### WebSocket Event Data Extensions

Ensure `SimulationEvent.data` includes these fields by event type:

| Event Type | Required fields in `data` |
|----------|--------------------------|
| `npc_moved` (NEW) | `fromPosition: CharacterPosition`, `toPosition: CharacterPosition` |
| `action_executed` / `action_failed` | `action`, `location`, `outcome` (already present) |
| `npc_death` | `npcName`, `hp`, `san` |
| Item-related actions | `itemId`, `sceneId`, `action: "picked_up" \| "dropped" \| "destroyed"` (encoded in `action_executed.data`) |

### Initialization Flow

When frontend opens `/simulation/:sessionId`:

```
1. GET /api/simulation/:id/topology       → Build map structure
2. GET /api/simulation/:id/map-layout     → Junction coordinates
3. GET /api/simulation/:id/positions      → NPC initial positions
4. GET /api/simulation/:id/npc-statuses   → NPC initial states
5. Connect WebSocket (type=simulation)    → Start receiving real-time events
6. Load town.json tilemap                 → Render town map
7. Interior tilemaps loaded on demand     → When user clicks building entrance
```

---

## Control Panel

| Button | Action |
|--------|--------|
| ▶ / ⏸ | `POST /api/simulation/:id/start` or `/pause` |
| ⏭ | `POST /api/simulation/:id/step` (paused state only) |
| Speed | Adjusts `tickIntervalMs` (needs new API: `PUT /api/simulation/:id/config`) |
| Stop | Page-level action (top-right), `POST /api/simulation/:id/stop` |

---

## Side Panel Details

### NPC List (Default View)

```
┌─────────────────────┐
│ Day 1  08:30        │
├─────────────────────┤
│ 📍 Tom (酒馆)       │  ← Click to focus
│    HP: 45/50 SAN: 60│
│    Action: 擦拭吧台  │
├─────────────────────┤
│ 📍 Sarah (图书馆)   │
│    HP: 35/35 SAN: 55│
│    Action: 翻阅古籍  │
├─────────────────────┤
│ 💀 Old Man (码头)   │
│    Deceased          │
├─────────────────────┤
│ ─── Event Log ───   │
│ 08:30 Tom executed   │
│   "检查地下室"       │
│ 08:25 Sarah moved    │
│   码头 → 图书馆      │
│ 08:20 Sarah found    │
│   [旧航海日志]       │
└─────────────────────┘
```

### Selected NPC Detail (Expanded)

- Full attributes (HP, SAN, key skills)
- Current position (scene name)
- Recent action history
- Held items
- Click "Back to list" to return to overview
- Click NPC name to zoom camera to their location

---

## Phaser Scene Details

### TownScene

- Loads `town.json` as Phaser Tilemap
- Creates tile layers: ground, roads, buildings, decoration
- Creates collision layer (invisible)
- Parses `building_entrances` object layer → clickable zones
- Manages NPC sprites/dots based on zoom level
- Camera: bounded to map size, zoom range clamped

### InteriorScene

- Loads interior Tiled JSON for specific sub-scene
- Creates tile layers: ground, walls, furniture
- Creates collision layer
- Manages NPC sprites within the room
- Displays items on floor
- Tab bar communicated via React (SubSceneTabs component)

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Session not found or not a simulation | Show error page with link back to simulation list |
| WebSocket disconnects | Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s). Show "Reconnecting..." indicator. On reconnect, re-fetch positions and statuses to sync state. |
| Building clicked but no interior tilemap (`sceneMapBindings` missing) | Show tooltip "No interior map available" — do not navigate to Level 3 |
| Module has no `[Module]_Maps/` directory | Map viewer unavailable — show message directing to text-based simulation view |
| Phaser fails to load tilemap/tileset | Show fallback message in canvas area, side panel still functional |

---

## Key Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Map scope | Unified zoomable map | More intuitive than split panels |
| Visual style | Pixel art top-down (Stardew Valley) | Clear aesthetic, community resources |
| Rendering engine | Phaser 3 | Native Tiled support, sprite animation, camera |
| Scene data source | Module author creates with Tiled | Highest quality, full control |
| Tileset source | Per-module (author provides) | Maximum customization |
| NPC sprites | Per-module (author provides) | Unique character visuals |
| Interactivity | Display-only (no player input) | This is a simulation observer |
| Displayed entities | NPCs + items + scenes | Complete world state visualization |
| NPC focus model | Global overview, click to focus | See all NPCs at once |
| Control panel | Floating (bottom-left corner) | Minimal space usage |
| Town map | Single Tiled map, camera zoom for levels 1/2 | Simpler than multiple views |
| Building interiors | Separate Tiled maps per sub-scene | Independent from town map |
| Sub-scene navigation | Tab switching, first sub-scene by default | Simple progressive disclosure |
| NPC movement | Driven by backend CharacterPosition changes | No map-side pathfinding needed |
