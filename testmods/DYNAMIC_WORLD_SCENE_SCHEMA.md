# Dynamic World Scene Schema (v2)

This document describes the module data consumed by `src/state/moduleLoader.ts`.
It is the authoring contract: everything here is enforced by the loader, and a
violation fails the LOAD with an aggregated error report — never silently at
runtime.

## Runtime files

```
<module>/
  module_setup.json            optional: introduction + weather presets
  npc_injection_policy.json    optional: which NPCs simulate, by tier
  <scenes-dir>/                SCN_*.json, ROAD_*.json, VEH_*.json
  scripted-events/*.json       optional: event definitions (arrays)
  transport_edges.json         optional legacy; empty graph when absent
```

These load into `DynamicScene`, `RoadNode`, `VehicleState`, `ScriptedEvent`,
`ModuleSetup`.

**Retired** (rejected or ignored by the loader): `scenarios_outline.json` and
the macro-location (`LOC_*`) layer — placement and geographic knowledge are
NPC-profile-side now (see the end of this document); `JUNC_*` files — a
crossroads or yard is a top-level scene; `truth_timeline.json`,
`knowledge_matrix.json`, `macro_scene.json`, `module_digest.json`.

## 1. module_setup.json

```json
{
  "startDate": "1985-07-08",
  "introduction": "…",
  "weatherPresets": [
    { "regionId": "OUTDOOR", "weatherType": "fog", "intensity": 2 }
  ]
}
```

`startDate` is required for session creation.

## 2. Place files: the prose-first format

`SCN_*` (scenes), `ROAD_*` (roads) and `VEH_*` (vehicles) share one idea:
**the description IS the data surface characters perceive.** It is complete
natural-language prose, and everything a character may point at is cited
inline with a stable `[reference-id]`.

```json
{
  "schemaVersion": 2,
  "id": "SCN_library",
  "name": "Town Library",
  "description": "Dusty archives fill the reading room [item.library.archives]. A stairway rises to the stacks [SCN_library_stacks]. The unlit back row is hard to examine [cond.library.dim].",
  "parentLocationId": "B_LIBRARY",
  "indoor": true,
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
        "id": "connection.library.stacks",
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

### Citation rules (cross-file validated, the heart of v2)

- Every `[citation]` must resolve to a **local item, a local condition, or the
  TARGET place of one of this file's connections**.
- An item cited in the prose is **in plain sight**, and is cited **exactly
  once**. An item that has a `references.items` row but is **not cited** is a
  thing nobody has noticed yet (a liner under a suitcase lining, bills at the
  bottom of a cash drawer) — that absence is the whole mechanism. Items carry
  **no `hidden` flag**; the loader rejects one. Whether a particular character
  notices an uncited item is decided per character at perception time; laying
  it open for everyone is done by rewriting the prose to cite it.
- Conditions are always cited exactly once.
- **Connections are cited by the place they lead to** (`[SCN_library_stacks]`,
  `[ROAD_main_street]`) — never by their own `connection.*` id. A passage is
  topology bookkeeping, not a pointable thing. Every non-concealed
  connection's target must be cited exactly once; a `concealed` connection's
  target must NOT be cited on that connection's account. **A door that
  matters as an object** (lockable, breakable, notable) **is authored as an
  item** in addition to the connection.
- Citing a place this file has no connection to is an error. Far landmarks a
  character can see but not walk to stay uncited prose.
- All place ids and reference ids share ONE module-wide namespace.

### Common fields

- `schemaVersion: 2` — required; v1 files are rejected.
- `id`, `name`, `description`.
- `parentLocationId` (optional): any non-empty value marks the scene as
  INTERIOR; **omit it to make the scene a top-level geography node** (street
  crossroads, yard, trailhead). The value itself is only a grouping label for
  the map viewer — it is not looked up anywhere. A vehicle's cab uses the
  vehicle id here.
- `indoor` (optional): lighting/weather exposure.
- `references.items`, `references.connections`, `references.conditions`.

Topology attaches interior scenes transitively by itself: a kitchen reached
only through the dining room inherits the dining room's attachment. No
container registry, no entry-scene declarations.

### Item

```ts
interface Item {
  id: string;               // module-unique; cited once = in plain sight,
                            // uncited = not yet noticed (no `hidden` flag)
  name: string;
  description?: string;     // the Engine reads prose and judges — no stat fields
  isLightSource?: boolean;  // summed by subsystem/sun.ts
  lightLevel?: number;
  position?: number;        // ROAD items only: 0.0 (endpointA) – 1.0 (endpointB).
                            // Perceivable within a 5-minute walk of it; a
                            // positionless road item is ambient (visible
                            // anywhere along). Invalid on scenes.
}
```

Design guideline: every scene carries **at least 3 visible items** — not all
plot-functional; environmental texture (a bench, a mushroom ring, a rusted
spike) is what emergent behavior grabs hold of.

### Connection

```ts
interface Connection {
  id: string;               // connection.<scene>.<thing>; never cited
  targetId: string;         // the place it leads to — what the prose cites
  name: string;
  description?: string;
  concealed?: boolean;      // physically obscured (a door behind a bookshelf),
                            // the same for everyone; its target is not cited
                            // on its account
}
```

`concealed` is a physical state of the passage, not anyone's knowledge of it.
There is no `discoveredBy` list (the loader rejects one): a character who
knows the way through keeps that as their own memory. Opening the passage
for everyone is a change of physical state — the Engine's
`connectionConcealed` or a scripted `connection.setConcealed` effect.

### SceneCondition

```json
{
  "id": "cond.library.dim",
  "description": "The rear shelves are poorly lit.",
  "featureId": "…",
  "mechanicalEffect": { "skillPenalty": { "Investigation": -10 } }
}
```

`skillPenalty` is `Record<skillName, number>` (the old array shape is
rejected).

### ROAD_*.json

A road is a linear path between two top-level node scenes, and a full
perceivable place of its own (name, prose, items, conditions).

- `travelTimeMinutes` (required, > 0): minutes to WALK the full length.
- `driveTimeMinutes` (optional, > 0): minutes to DRIVE it. **Present = the
  road takes vehicles; absent = it does not** (trails, alleys, cliff paths).
- Connections carry a `role`: exactly one `endpointA` and one `endpointB`
  (both targeting TOP-LEVEL `SCN_*` scenes), plus any number of `access`
  entries with `position` ∈ [0, 1] — buildings whose doors open onto the
  road at that point. The loader derives `alongConnections`.
- The prose cites endpoints and access targets by their place ids, like any
  connection.

### VEH_*.json — vehicles

A vehicle is a movable perception boundary: outside, an item-like presence
wherever it stands; inside, a normal scene whose occupants ride along for
free (driving moves the VEHICLE; nobody's position changes while riding).

```json
{
  "id": "VEH_frank_truck",
  "name": "Frank 的货车",
  "description": "…exterior prose, shown wherever the vehicle stands…",
  "interiorSceneId": "SCN_truck_cab",
  "initialLocation": "SCN_holt_gate"
}
```

- `id` must equal the file's entry id.
- `interiorSceneId` must be a loaded NON-top-level scene (give the cab
  `parentLocationId` = the vehicle id). The cab has no static connections —
  its place in the world is wherever the vehicle stands; it is authored like
  any scene (items, citations, the ≥3-item guideline included).
- `initialLocation` must be a loaded place (scene or road).
- Cargo: load items INTO the interior scene (`item.move` to
  `"scene:SCN_truck_cab"`).

## 3. scripted-events/*.json

Each file is an ARRAY of `ScriptedEvent` (see
`src/engine/scriptedEvents/types.ts` for the full contract). Two validation
passes at load: structural (op shapes, enums, HH:MM formats), then
**reference integrity** — every scene/road, connection id, NPC id and holder
string an event mentions must exist. Both fail the load with one aggregated
report.

Highlights of the vocabulary:

- Timing: `fireWhen`/`failWhen` predicates (`timeOfDay`, `regionWeather`,
  `sceneOccupied`, `characterAt`, trackers, and/or/not…), `fireDelayTicks`,
  `recurring` + `recurringCooldownTicks` (a daily window fires once per day;
  a recurring event re-arms on completion AND on failWhen).
- Effects: `item.create` (with `skipIfExists` for restock semantics),
  `item.move`, `scene.addCondition`/`removeCondition`,
  `character.hp/san/fatigue/…`, `connection.setBlock` (with a shared
  `featureId` so a lift-event can withdraw a raise-event's vote),
  `connection.setConcealed` with `concealed: boolean` (how a sealed door
  opens; formerly `connection.setHidden`/`hidden`), `event.emit`,
  `event.transition`.

### Holder grammar (one grammar everywhere)

```
a place:      "scene:<placeId>"      (roads and vehicle interiors included)
a character:  "<characterId>"        (bare id — never "npc:…")
```

The same grammar appears in Engine deltas, scripted-event effects and the
runtime. Misspellings are refused loudly at load (events) or by the state
layer (everything else) — never a phantom inventory.

## 4. NPC data (the parts that replaced the LOC layer)

NPC JSON is a separate import path, but two of its fields are part of world
placement now that macro locations are gone:

- `currentLocation` / `residence`: **scene or road ids**, placement at
  session start.
- `appearance` / `status.conditions`: an injury or impairment the character
  starts with goes in `status.conditions` — an id and a description stating
  the objective state AND the function it impairs — not in `appearance`
  prose. Both are read by the Engine and both reach perception, but only a
  condition has a handle the Engine can take away: treat the wound and it
  writes `removeCondition`. The same wound spelled out in `appearance` is a
  sentence nobody is obliged to rewrite, so it keeps asserting itself after
  the world has moved on, and the Engine narrates it as untreated tick after
  tick while characters dress it again and again. Keep `appearance` for what
  stays true of the body — build, hair, clothing, old scars.
- `memory[]`: authored memories, `map` type included — geographic knowledge
  is written per profile in the character's own voice. Nothing geographic is
  generated at bootstrap; a place absent from a character's memories does not
  exist for them (this IS the lost-in-the-woods mechanic).

  **Seeded memories carry tags.** A character may only point at ids they
  have been shown — in the prose they perceived, in their own inventory, or
  in their memories — so a memory that names a specific place (`SCN_*`,
  `ROAD_*`, `VEH_*`) or a specific item (`item.*`, from a place file's
  `references` or anyone's inventory) puts the bracketed id right after the
  name, in the character's own sentence:

  ```
  清早从维修铺 [SCN_batra_shop] 楼下出门，顺主街 [ROAD_main_street] 往北走一刻钟就到蓝鸟后厨 [SCN_bluebird_kitchen]
  ```

  People are never tagged (knowing who someone is is a separate fact). The
  loader checks that every tag names a real entity, and that every `map`
  memory carries at least one place tag — an untagged map memory is
  directions to nowhere the character can name. Tag the place the route
  actually reaches: a shop on the street is its street-facing room
  (`SCN_grocery_store`, not the back room), "the motel" is its yard
  `SCN_motel`, a house reached by a lane is the lane's end (`SCN_holt_gate`).
  Tagging an item also lets the character cite something they have not
  seen this session — that is the point for a secret they keep (Marisol's
  `[item.grocery_store.duplicate_bills]`, Vance's
  `[item.motel_room4.suitcase_liner]`), so tag only what the character
  really knows.
- `inventory[]`: what the character carries. Ids follow the same grammar as
  a place file's items, with the owner where the place would be:

  ```
  item.<owner>.<thing>     item.tommy.walkie_talkie, item.ray.sheriff_badge
  ```

  **An object exists in exactly one place, and the id is what says so.** A
  thing the character carries belongs here and nowhere else; a thing that
  lives in a room belongs in that room's `references.items` and the
  character picks it up. Writing it in both makes two objects that nothing
  can tell apart afterwards: they hold different ids, so `itemHolders` gives
  each its own holder, the owner perceives their own thing twice, and a
  delta that moves, damages or destroys one leaves its twin untouched. Ten
  such pairs were authored into Grayhaven before this rule was written down
  — a bicycle both in Tommy's hands and leaning at his gate, and he cited
  each of them in different minutes of the same errand.

  Two objects that merely resemble each other are fine and stay separate:
  Denny carries an inhaler and keeps a spare in his room; the stethoscope on
  the clinic's rack is Weaver's, not the one in Susan's bag.
