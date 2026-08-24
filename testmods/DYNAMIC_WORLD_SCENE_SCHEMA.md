# Dynamic World Scene Schema

This document describes the scene-related JSON structures currently consumed by the Dynamic World runtime loader in `src/dynamicworldagent/state/worldModuleLoader.ts`.

## Runtime Files

The runtime scene layer currently uses these files:

1. `module_setup.json` (optional, introduction + weather)
2. `scenarios_outline.json`
3. `transport_edges.json` (optional)
4. `SCN_*.json`
5. `JUNC_*.json`
6. `ROAD_*.json`

These files are loaded into:

- `DynamicScene`
- `JunctionNode`
- `RoadNode`
- `ScenarioOutline`
- `TransportEdge`
- `ModuleSetup`

Files like `truth_timeline.json`, `knowledge_matrix.json`, `macro_scene.json`, and the old `module_digest.json` are no longer part of the runtime scene/module schema.

NPC JSON remains a separate import path for NPC data, not part of the runtime scene schema described here.

## 1. module_setup.json

Optional module-level runtime setup. It currently carries module introduction text and weather presets.

```json
{
  "introduction": "A rural mystery unfolds under gathering storm clouds.",
  "weatherPresets": [
    {
      "regionId": "LOC_downtown",
      "weatherType": "fog",
      "intensity": 2
    }
  ]
}
```

## 2. SCN_*.json

Represents a normal playable scene/building/interior node.

```json
{
  "id": "SCN_library",
  "name": "Town Library",
  "description": "A quiet public library with dusty archives.",
  "parentLocationId": "LOC_downtown",
  "items": [],
  "conditions": [],
  "connections": ["SCN_square", "SCN_archive"],
  "sceneImage": {
    "path": "Map/library.png"
  }
}
```

### Fields

- `id: string`
- `name: string`
- `description: string`
- `parentLocationId: string`
- `items: Item[]`
- `itemContexts?: ItemContexts`
- `conditions: SceneCondition[]`
- `connections: string[]`
- `sceneImage?: { path: string; mimeType?: string; generatedAt?: string }`
- `indoor?: boolean`

## 3. JUNC_*.json

Represents an outdoor junction/intersection node.

```json
{
  "id": "JUNC_square_north",
  "name": "North Square Junction",
  "description": "A cobblestone intersection with a dead streetlamp.",
  "parentLocationId": "OUTDOOR",
  "items": [],
  "conditions": [],
  "connectedSceneIds": ["SCN_library", "SCN_post_office"]
}
```

### Fields

- `id: string`
- `name: string`
- `description: string`
- `parentLocationId: string`
- `items: Item[]`
- `itemContexts?: ItemContexts`
- `conditions: SceneCondition[]`
- `connectedSceneIds: string[]`

## 4. ROAD_*.json

Represents a road/path segment between two junctions.

```json
{
  "id": "ROAD_market_lane",
  "name": "Market Lane",
  "description": "A narrow street lined with old brick storefronts.",
  "parentLocationId": "OUTDOOR",
  "endpointA": "JUNC_square_north",
  "endpointB": "JUNC_square_south",
  "travelTimeMinutes": 8,
  "alongConnections": [
    {
      "sceneId": "SCN_bookshop",
      "position": 0.35
    }
  ],
  "items": [],
  "conditions": []
}
```

### Fields

- `id: string`
- `name: string`
- `description: string`
- `parentLocationId: string`
- `endpointA: string`
- `endpointB: string`
- `travelTimeMinutes: number`
- `alongConnections: Array<{ sceneId: string; position: number }>`
- `items: Item[]`
- `itemContexts?: ItemContexts`
- `conditions: SceneCondition[]`

## 5. scenarios_outline.json

Provides macro-location containers and scenario grouping metadata.

```json
{
  "scenarios": [
    {
      "id": "LOC_downtown",
      "name": "Downtown",
      "description": "The commercial center of town.",
      "sourcePlaceId": "place_downtown",
      "sourcePlaceName": "Downtown",
      "residents": ["npc_librarian", "npc_clerk"],
      "subSceneCount": 4,
      "entrySceneId": "SCN_square"
    }
  ]
}
```

### Fields

- `id: string`
- `name: string`
- `description: string`
- `sourcePlaceId?: string`
- `sourcePlaceName?: string`
- `residents?: string[]`
- `subSceneCount: number`
- `entrySceneId?: string`

## 6. transport_edges.json

Optional macro travel graph used by non-topology movement fallback.

```json
{
  "transportEdges": [
    {
      "fromLocationId": "LOC_downtown",
      "toLocationId": "LOC_harbor",
      "streetSceneId": "SCN_harbor_road",
      "travelTimeMinutes": 5
    }
  ]
}
```

### Fields

- `fromLocationId: string`
- `toLocationId: string`
- `streetSceneId: string`
- `travelTimeMinutes: number`

## SceneCondition

Used in `SCN`, `JUNC`, and `ROAD` files.

```json
{
  "description": "Heavy smoke reduces visibility.",
  "mechanicalEffect": {
    "skillPenalty": [
      {
        "skill": "Perception",
        "delta": -20
      }
    ],
    "blocked": false
  }
}
```

### Fields

- `description: string`
- `mechanicalEffect?: { skillPenalty?: Array<{ skill: string; delta: number }>; blocked?: boolean }`

## Item

`items` in scenes, junctions, and roads use this structure.

```json
{
  "id": "itm_note_001",
  "name": "Blood-stained Note",
  "description": "A torn note with occult symbols.",
  "type": "document",
  "category": "evidence",
  "reveals": ["clue_ritual_site"]
}
```

Actual supported shape:

```ts
interface Item {
  id: string;
  name: string;
  description?: string;
  type?: "weapon" | "consumable" | "tool" | "lighting" | "container" | "key" | "document" | "other";
  category?: "evidence" | "mundane";
  reveals?: string[];
  discoveryMethod?: string;
  era?: string;
  damaged?: boolean;
  damageDetails?: {
    damagedBy: string;
    damagedAt: string;
    reason: string;
  };
  isLightSource?: boolean;
  lightLevel?: number;
  weaponStats?: {
    skill: string;
    damage: string;
    range: string;
    attacksPerRound: number;
    ammo?: number;
    malfunction?: number;
    era?: string;
  };
  consumableStats?: {
    uses?: number;
    effect?: string;
    duration?: number;
  };
  containerStats?: {
    capacity?: number;
    locked?: boolean;
    lockDifficulty?: "easy" | "regular" | "hard" | "extreme";
    contents?: string[];
  };
}
```

### Minimal item

```json
{
  "id": "itm_note_001",
  "name": "Blood-stained Note"
}
```

### Evidence item

```json
{
  "id": "itm_note_001",
  "name": "Blood-stained Note",
  "description": "A torn note with occult symbols.",
  "type": "document",
  "category": "evidence",
  "discoveryMethod": "search desk",
  "reveals": ["clue_ritual_site"]
}
```

### Lighting item

```json
{
  "id": "itm_lantern_001",
  "name": "Oil Lantern",
  "type": "lighting",
  "isLightSource": true,
  "lightLevel": 2
}
```

### Container item

```json
{
  "id": "itm_box_001",
  "name": "Locked Metal Box",
  "type": "container",
  "containerStats": {
    "capacity": 10,
    "locked": true,
    "lockDifficulty": "hard",
    "contents": ["itm_key_001", "itm_letter_003"]
  }
}
```

### Weapon item

```json
{
  "id": "itm_revolver_001",
  "name": "Service Revolver",
  "type": "weapon",
  "weaponStats": {
    "skill": "Handgun",
    "damage": "1d10",
    "range": "15 yd",
    "attacksPerRound": 1,
    "ammo": 6,
    "malfunction": 100
  }
}
```

## Notes

- `category: "evidence"` is special-cased by discovery logic in the tick processor.
- `damaged` and `damageDetails` are used by evidence/fire-related logic.
- `transport_edges.json` is optional; if absent, runtime falls back to an empty transport graph.
- The current loader reads `transport_edges.json`. If a test module still uses `transport_network.json`, it should be renamed or adapted.
