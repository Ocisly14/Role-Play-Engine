# Dynamic World Scene Schema

This document describes the scene-related JSON structures consumed by `src/state/moduleLoader.ts`.

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
  "map": {
    "htmlPath": "map.html",
    "imagePath": "map.png",
    "imageMimeType": "image/png"
  },
  "weatherPresets": [
    {
      "regionId": "LOC_downtown",
      "weatherType": "fog",
      "intensity": 2
    }
  ]
}
```

When `map.htmlPath` is configured, every macro id in `scenarios_outline.json`
must occur exactly once in `map.html` as `data-location-id="<outline-id>"`.
The HTML is for UI rendering; `imagePath` is the optional raster vision asset.

## 2. Schema v2 place files

`SCN_*.json`, `JUNC_*.json`, and `ROAD_*.json` all use a prose-first authoring
format. `description` is complete natural-language scene text; every visible
object, exit, and condition is cited with a stable `[reference-id]`. The
corresponding machine-readable objects live in the same file under
`references`.

```json
{
  "schemaVersion": 2,
  "id": "SCN_library",
  "name": "Town Library",
  "description": "Dusty archives fill the reading room [item.library.archives]. A stairway rises to the stacks [exit.library.stacks]. The unlit back row is hard to examine [condition.library.dim].",
  "parentLocationId": "LOC_downtown",
  "references": {
    "items": [
      {
        "id": "item.library.archives",
        "name": "Archive shelves",
        "description": "Tall shelves of local newspapers and municipal records."
      }
    ],
    "connections": [
      {
        "id": "exit.library.stacks",
        "targetId": "SCN_library_stacks",
        "name": "Stairway to stacks",
        "description": "A narrow stairway behind the circulation desk."
      }
    ],
    "conditions": [
      {
        "id": "condition.library.dim",
        "description": "The rear shelves are poorly lit.",
        "mechanicalEffect": { "skillPenalty": { "Perception": -10 } }
      }
    ]
  }
}
```

### Common fields

- `schemaVersion: 2`
- `id`, `name`, `description`, `parentLocationId`
- `references.items: Item[]`
- `references.connections: Array<{ id, targetId, name?, description?, hidden? }>`
- `references.conditions: Array<{ id, description, mechanicalEffect?, featureId?, data? }>`

All reference ids must be module-unique. Every visible reference must occur in
the description as `[id]`; every citation must resolve to one reference in that
place. Hidden exits are excluded from the initial citation requirement.

### JUNC_*.json

Junction connections use the common `references.connections` array. Each
connection targets an enterable `SCN_*`; the loader derives the runtime
`connectedSceneIds` list.

### ROAD_*.json

Roads also use the common references array plus `travelTimeMinutes`. Their
connections add a required role: exactly one `endpointA`, one `endpointB`, and
zero or more `access` entries. Each `access` entry also has `position` from 0
to 1. The loader derives `endpointA`, `endpointB`, and `alongConnections`.

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
