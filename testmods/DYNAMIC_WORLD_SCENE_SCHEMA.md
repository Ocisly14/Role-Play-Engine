# Dynamic World Scene Schema

This document describes the scene-related JSON structures consumed by `src/state/moduleLoader.ts`.

## Runtime Files

The runtime scene layer currently uses these files:

1. `module_setup.json` (optional, introduction + weather)
2. `scenarios_outline.json`
3. `transport_edges.json` (optional)
4. `SCN_*.json`
5. `ROAD_*.json`

These files are loaded into:

- `DynamicScene`
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

`SCN_*.json` and `ROAD_*.json` use a prose-first authoring format. There is
no junction type any more: a street stretch, crossroads or yard is a
**top-level scene** — an `SCN_*` file with NO `parentLocationId` — and the
road network runs between top-level scenes. `JUNC_*` files are rejected by
the loader. `description` is complete natural-language scene text; every visible
object, exit, and condition is cited with a stable `[reference-id]`. The
corresponding machine-readable objects live in the same file under
`references`.

```json
{
  "schemaVersion": 2,
  "id": "SCN_library",
  "name": "Town Library",
  "description": "Dusty archives fill the reading room [item.library.archives]. A stairway rises to the stacks [exit.library.stacks]. The unlit back row is hard to examine [cond.library.dim].",
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
        "id": "cond.library.dim",
        "description": "The rear shelves are poorly lit.",
        "mechanicalEffect": { "skillPenalty": { "Investigation": -10 } }
      }
    ]
  }
}
```

### Common fields

- `schemaVersion: 2`
- `id`, `name`, `description`
- `parentLocationId` (optional): the containing macro location (outline id)
  or node scene. Omit it to make the scene a TOP-LEVEL geography node.
- `references.items: Item[]`
- `references.connections: Array<{ id, targetId, name?, description?, hidden? }>`
- `references.conditions: Array<{ id, description, mechanicalEffect?, featureId?, data? }>`

All reference ids must be module-unique. Every visible reference must occur in
the description as `[id]`; every citation must resolve to one reference in that
place. Hidden exits are excluded from the initial citation requirement.

### ROAD_*.json

Roads also use the common references array plus `travelTimeMinutes`. Their
connections add a required role: exactly one `endpointA`, one `endpointB`
(both targeting TOP-LEVEL `SCN_*` node scenes), and zero or more `access`
entries. Each `access` entry also has `position` from 0 to 1. The loader
derives `endpointA`, `endpointB`, and `alongConnections`.

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

Used in the `references.conditions` block of `SCN` and `ROAD` files.

```json
{
  "id": "cond.library.dim",
  "description": "The rear shelves are poorly lit.",
  "mechanicalEffect": {
    "skillPenalty": { "Investigation": -10 },
    "blockConnections": false
  }
}
```

### Fields

- `id: string` — module-unique, cited in the description as `[id]`
- `description: string`
- `featureId?: string`
- `data?: Record<string, unknown>`
- `mechanicalEffect?: { skillPenalty?: Record<string, number>; blockConnections?: boolean }`

`skillPenalty` is a `Record<skillName, number>`; the old array shape
(`[{ "skill": ..., "delta": ... }]`) is rejected by the loader.

## Item

`references.items` entries in scenes and roads match the runtime
`Item` type in `src/state/types.ts`: an object is a name and a paragraph —
the Engine reads the description and judges, so there are no mechanical
sub-typed fields.

```ts
interface Item {
  id: string;               // module-unique, cited in the description as [id]
  name: string;
  description?: string;
  hidden?: boolean;         // not visible to NPCs until revealed; hidden items
                            // must NOT be cited in the description
  isLightSource?: boolean;  // contributes to scene illumination (subsystem/sun.ts)
  lightLevel?: number;
}
```

## Notes

- `transport_edges.json` is optional; if absent, runtime falls back to an empty transport graph.
- The current loader reads `transport_edges.json`. If a test module still uses `transport_network.json`, it should be renamed or adapted.
