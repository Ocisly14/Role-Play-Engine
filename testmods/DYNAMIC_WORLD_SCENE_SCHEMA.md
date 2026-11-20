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

## 2. Place files: setting and props (schema v3)

`SCN_*` (scenes), `ROAD_*` (roads) and `VEH_*` (vehicles) share one idea:
**a place is perceived by someone at some minute.** What the file authors is
the place itself — its **setting** — plus where each loose thing sits. Who is
here, what they are doing, the light, the weather and the conditions all come
from live state and are put together by the renderer at that minute.

```json
{
  "schemaVersion": 3,
  "id": "SCN_library",
  "name": "Town Library",
  "setting": "A long reading room under a low ceiling. Tall archive shelves line the back wall [item.library.archives]; a heavy oak desk stands by the door [item.library.desk]. A stairway behind the desk rises to the stacks [SCN_library_stacks]. The room smells of old paper.",
  "parentLocationId": "B_LIBRARY",
  "indoor": true,
  "references": {
    "items": [
      { "id": "item.library.archives", "name": "Archive shelves",
        "description": "Tall shelves of local newspapers and municipal records." },
      { "id": "item.library.desk", "name": "Oak desk",
        "description": "A heavy oak desk; its one drawer is shut." },
      { "id": "item.library.lamp", "name": "Reading lamp",
        "description": "A brass lamp with a green shade.",
        "placement": "on the desk", "isLightSource": true, "lightLevel": 2 },
      { "id": "item.library.ledger", "name": "Loan ledger",
        "description": "A cloth-bound ledger of loans.",
        "placement": "in the desk drawer", "container": "item.library.desk" }
    ],
    "connections": [
      { "id": "connection.library.stacks", "targetId": "SCN_library_stacks",
        "name": "Stairway to stacks", "description": "A narrow stairway behind the desk." }
    ],
    "conditions": [
      { "id": "cond.library.dim", "description": "The rear shelves are poorly lit.",
        "mechanicalEffect": { "skillPenalty": { "Investigation": -10 } } }
    ]
  }
}
```

### What the setting says

The test for every sentence: **is it still true at 3 a.m., with nobody here,
in any weather?** Write size and shape, layout and sightlines, materials and
wear, what walls, windows and doors let through, smells and sounds that
belong to the place itself, its fixtures and its ways out. Be concrete,
objective, present tense.

Do **not** write:
- the hour, the crowd or the weather ("packed with regulars", "fog still
  hanging over the street");
- noise that needs someone doing it ("the coffee machine hisses") — that is
  an action, rendered from what happens;
- loose things (they are items with a `placement`);
- conditions (they are state, listed on their own);
- people's names, or what only someone who knows the place would know
  ("the owner keeps count of everyone's sugar") — that belongs in that
  character's memories;
- mood or judgement — that belongs to whoever is looking.

### Items: fixture, placed, or in a container

Every item at a place is exactly one of:

| state | how | seen by |
|---|---|---|
| fixture | cited once in the setting; no `placement`, no `container` | everyone here |
| placed | `placement`, no `container`, not cited | everyone here |
| in a container | `placement` + `container`, not cited | whoever notices it this minute |

- `placement` is where the thing is, as a short phrase ("on the desk", "in
  the desk drawer"). Brackets are stripped and it is capped at 120
  characters, like a character's spot.
- `container` is the id of another item **of the same place** that the thing
  sits inside, under or behind, when that item can hide it: a drawer, a
  closed cabinet, a suitcase, a mattress, a glass case. An open shelf, a
  knife block or an open basket hides nothing and is not a container. No
  item names itself; no chain loops.
- **A container's description says only what can be seen from outside it**:
  clear or solid, open or shut, which way its opening faces. What is inside
  is authored as items with `container`. Whether a given person sees them
  right now is judged per viewer at render time from the container's
  description, where they stand and what they are doing.
- Anything small that someone would pick up or use on its own — money, a
  knife, matches, papers, medicine, food — is its own item. Things that go
  wherever their container goes (coins in a tip jar) stay in the container's
  description; pure background (plates stacked on a shelf) stays in the
  fixture's description until someone acts on it.
- A fixture is something nobody would carry off in ordinary life (a counter,
  a phone fixed to the wall, a till). When unsure, make it a fixture.

### Citation rules (cross-file validated)

- Every `[citation]` in a setting must resolve to a **local item** (a fixture)
  or the **target place of one of this file's connections**.
- Conditions are never cited.
- **Connections are cited by the place they lead to** (`[SCN_library_stacks]`,
  `[ROAD_main_street]`) — never by their own `connection.*` id. Every
  non-concealed connection's target must be cited exactly once; a `concealed`
  connection's target must NOT be cited on that connection's account. **A
  door that matters as an object** (lockable, breakable, notable) **is
  authored as an item** in addition to the connection.
- Citing a place this file has no connection to is an error. Far landmarks a
  character can see but not walk to stay uncited prose.
- All place ids and reference ids share ONE module-wide namespace.

### Common fields

- `schemaVersion: 3` — required; any other version is rejected.
- `id`, `name`, `setting` (a `description` key on a place is rejected).
- `parentLocationId` (optional): any non-empty value marks the scene as
  INTERIOR; **omit it to make the scene a top-level geography node** (street
  crossroads, yard, trailhead). The value itself is only a grouping label for
  the map viewer — it is not looked up anywhere. A vehicle's cab uses the
  vehicle id here.
- `indoor` (optional): lighting/weather exposure.
- `coordinates` (optional, `SCN_*` only): `{ "x": 120, "y": -340, "z": 4 }`,
  the place's center in **meters** — `x` east, `y` north, `z` the floor's
  elevation above sea level (default 0; an upper floor sits ~3 m above the
  one below). Pick any origin, one per module. This is the straight-line
  distance perception reads: sound and sight cross walls, floors and open
  ground directly, they do not walk the roads (two rooms sharing a wall
  without a door are meters apart; the cliff top is close to the beach below
  it). A place without coordinates falls back to the walking time by the ways
  that join it. Not on `ROAD_*` (a road's points lie on the straight line
  between its endpoints) and not on a vehicle's interior scene (it is
  wherever the vehicle is) — both are rejected. Movement never reads it:
  travel time is the roads' `travelTimeMinutes` and one minute per door.
- `references.items`, `references.connections`, `references.conditions`.

Topology attaches interior scenes transitively by itself: a kitchen reached
only through the dining room inherits the dining room's attachment. No
container registry, no entry-scene declarations.

### Item

```ts
interface Item {
  id: string;               // module-unique; cited once = a fixture
  name: string;
  description?: string;     // the Engine reads prose and judges — no stat fields
  isLightSource?: boolean;  // summed by subsystem/sun.ts
  lightLevel?: number;
  position?: number;        // ROAD items only: 0.0 (endpointA) – 1.0 (endpointB).
                            // Perceivable within a 5-minute walk of it; a
                            // positionless road item is ambient (visible
                            // anywhere along). Invalid on scenes.
  placement?: string;       // where it is; required unless cited (a fixture)
  container?: string;       // the item of this place that can hide it
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
  blocked?: string;         // cannot be walked when the session starts, and
                            // why ("灯塔铁门锁着") — a locked or sealed door
}
```

`blocked` is the passage's **starting** block, not a field the runtime keeps.
The loader seeds the session's block map from it, and from then on that map is
the one record: walking stops at the passage and the actor is told the reason;
whoever unlocks, forces or climbs it is judged by the Engine on their next
command (a one-use `passBlockedConnectionId`, or `connectionBlock
{blocked:false}` to open it for everyone), exactly as for a passage the weather
closed. A block belongs to the passage between two places, so authoring it on
either side's connection blocks both directions; when both sides author it the
reasons must match. A lock described only in prose stops nobody — movement
reads the block, not the setting — so a door the prose calls locked needs
`blocked` too. A door that is merely closed is not blocked.

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
