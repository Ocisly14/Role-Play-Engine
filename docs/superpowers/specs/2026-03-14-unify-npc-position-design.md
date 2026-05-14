# Unify NPC Position System — Design Spec

## Goal

Remove the legacy `npcLocations: Record<string, string>` system entirely. All NPC position tracking uses `characterPositions: Record<string, CharacterPosition>`. Topology is required for all modules — remove legacy BFS pathfinding and all fallback movement paths.

## Current State

Two parallel position systems exist:

- `npcLocations` — `Record<string, string>` (npcId → scene/location ID string)
- `characterPositions` — `Record<string, CharacterPosition>` (npcId → typed position object)

These drift apart because non-topology movement paths only update `npcLocations`. The legacy BFS (`findPath`) operates on `scene.connections[]` and doesn't interact with topology at all.

## Design

### What Gets Removed

1. **`DynamicGameState.npcLocations`** field
2. **`getNpcLocation()` / `setNpcLocation()`** methods on `DynamicGameStateManager`
3. **`findPath()` / `calculateTravelTime()`** in `pathfinding.ts` (legacy BFS)
4. **`getAllLocations()`** on `DynamicGameStateManager` — callers replaced with direct `state.scenes` / `state.junctions` / `state.roads` iteration
5. **movementHandler fallback paths** — BFS fallback and direct movement fallback
6. **`resolveCharacterLocationId()` fallback** to `getNpcLocation()` in `topologyHelpers.ts`
7. **`formatFlatSceneMap()`** in `sceneMapFormatter.ts` — dead code when topology is always present

### What Stays

- `characterPositions: Record<string, CharacterPosition>` on `DynamicGameState`
- `getCharacterPosition()` / `setCharacterPosition()` on manager
- `getCharactersAtJunction()` / `getCharactersOnRoad()` / `getCharactersInScene()`
- `resolveLocationId(position)` on manager — returns string ID from a `CharacterPosition`
- `findTopologyPath()` — sole pathfinding implementation
- `resolveTargetPosition()` in movementHandler

### Position Initialization Rule

`moduleLoader.ts` currently maps NPC starting scenes to junction/road positions (e.g., scene at junction → `{ type: "junction" }`, scene along road → `{ type: "road" }`). This causes co-location mismatches because handlers use scene IDs in `node.location`.

**New rule:** NPCs in scenes always get `{ type: "scene", sceneId }`. Pathfinding handles the scene-to-junction/road resolution internally via `topology.sceneToParent`. This means:

- Scene at a junction → `{ type: "scene", sceneId: resolvedLocation }` (not junction)
- Scene along a road → `{ type: "scene", sceneId: resolvedLocation }` (not road)
- Junction ID directly → `{ type: "junction", junctionId }` (only if NPC profile says so)

### What Changes

#### DynamicGameState.ts

- Remove `npcLocations` from interface, `initialDynamicGameState`, `serialize()`, `deserialize()`, `clone()`
- Remove `getNpcLocation()`, `setNpcLocation()`
- Remove `getAllLocations()` method
- `topology` field type changes from `TownTopology | null` to `TownTopology`
- `getTopology()` return type changes from `TownTopology | null` to `TownTopology`
- Deserialization backward compat: if `data.characterPositions` is empty but `data.npcLocations` exists, convert each entry to `{ type: "scene", sceneId: locationId }`

#### moduleLoader.ts — `initRuntime()`

- Remove `npcLocations` initialization and output
- Throw error if topology is null (junctions + roads required)
- Simplify `characterPositions` init: always use `{ type: "scene", sceneId: resolvedLocation }` for NPCs in scenes

#### movementHandler.ts

- Remove BFS fallback (lines 149-181)
- Remove direct movement fallback (lines 183-207)
- Skill-based movement: add `setCharacterPosition()` call using `resolveTargetPosition()` (currently missing)
- Update `description` string — remove reference to BFS pathfinding
- Only two paths remain: skill-based (single hop) and topology-based

#### pathfinding.ts

- Remove `findPath()` function
- Remove `calculateTravelTime()` function
- Keep `findTopologyPath()`, `TopologyPath`, `TopologyPathStep`

#### topologyHelpers.ts — `resolveCharacterLocationId()`

- Remove fallback to `getNpcLocation()`. Only reads from `characterPositions`.

#### impactPropagation.ts

- `findAffectedCharacters()`: replace `getCharLocation` helper (which calls `getNpcLocation`) with `getCharacterPosition` + `resolveLocationId`
- `findAffectedScenes()`: replace `getAllLocations()` with direct iteration over `state.scenes`, `state.junctions`, `state.roads`

#### characterInjection.ts

- `injectCharacterIntoState()`: remove `setNpcLocation()` call (only `setCharacterPosition`)
- `removeCharacterFromState()`: remove `delete state.npcLocations[characterId]` and `npcLocations` from type cast

#### NPCPlanningAgent.ts

- All `state.npcLocations[npcId]` reads → `dgsm.getCharacterPosition(npcId)` + `dgsm.resolveLocationId(pos)`
- Co-location checks (e.g., `state.npcLocations[n.id] === currentLocation`) → compare resolved location IDs

#### tickProcessor.ts

- All `dgsm.getNpcLocation()` calls → `dgsm.getCharacterPosition()` + `dgsm.resolveLocationId()`

#### sceneMapFormatter.ts

- Read `characterPositions[npcId]` + resolve to location ID instead of `npcLocations[npcId]`
- Remove `formatFlatSceneMap()` dead code (topology always present, `formatTopologySceneMap` always used)

#### Handlers (routine, characterInteraction, objectInteraction, sceneInteraction)

- Replace `dgsm.getNpcLocation(node.characterId)` with `dgsm.getCharacterPosition(node.characterId)` + `dgsm.resolveLocationId(pos)`

#### Features

- **sanityFeature.ts**: replace `Object.keys(state.npcLocations)` iteration with `Object.keys(state.characterPositions)`
- **staminaFeature.ts**: replace `getNpcLocation()` calls with position-based lookups
- **lightingFeature.ts**: replace `dgsm.getAllLocations().forEach(...)` with `state.scenes.forEach(...)` (junctions/roads already handled separately in the topology block below); remove `if (topology)` guard (topology always present)
- **weatherFeature.ts**: replace `dgsm.getAllLocations().forEach(...)` in `getOutdoorSceneIds()` and `initWeatherFromPresets()` with direct iteration over `state.scenes`, `state.junctions`, `state.roads`

#### SimulationRunner.ts

- Replace `gameState.npcLocations[npc.id]` with position-based lookup

#### state/types.ts

- Update doc comment at line 168 to remove `npcLocations` reference

#### Tests

- `engine/handlers/__tests__/objectInteractionHandler.test.ts` — replace `npcLocations` mock with `characterPositions`
- `engine/shared/__tests__/topologyHelpers.test.ts` — remove `npcLocations` mock and fallback test cases (lines 280, 299)
- `engine/features/__tests__/sanityFeature.test.ts` — replace `npcLocations` mock
- `engine/features/__tests__/staminaFeature.test.ts` — replace `npcLocations` mock; remove "fallback to npcLocations" test (line 538)
- `engine/features/__tests__/weatherFeature.test.ts` — replace `npcLocations` mock

### Co-location Comparison Pattern

Before:
```typescript
const loc = dgsm.getNpcLocation(npcId);
if (loc === action.location) { ... }
```

After:
```typescript
const pos = dgsm.getCharacterPosition(npcId);
if (pos && dgsm.resolveLocationId(pos) === action.location) { ... }
```

This works reliably because:
- NPCs in scenes have `{ type: "scene", sceneId }` → `resolveLocationId` returns `sceneId`
- `node.location` from LLM is always a scene ID or junction ID
- NPCs are never left at road positions (movement always resolves to scene/junction destinations)

### Topology Required Invariant

`initRuntime()` will throw if the module has no junctions/roads:
```typescript
if (!topology) {
  throw new Error(`Module ${moduleData.moduleId} has no topology (junctions/roads). Topology is required.`);
}
```

`DynamicGameState.topology` type changes to `TownTopology` (non-nullable).

## Files Changed

| File | Action |
|------|--------|
| `src/dynamicworldagent/state/DynamicGameState.ts` | Remove `npcLocations`, `getNpcLocation`, `setNpcLocation`, `getAllLocations`; make `topology` non-nullable; add deserialization compat |
| `src/dynamicworldagent/state/moduleLoader.ts` | Remove `npcLocations` init; add topology-required check; simplify `characterPositions` init |
| `src/dynamicworldagent/state/types.ts` | Update doc comment |
| `src/dynamicworldagent/engine/handlers/movementHandler.ts` | Remove BFS + direct fallback; fix skill movement; update description |
| `src/dynamicworldagent/engine/shared/pathfinding.ts` | Remove `findPath`, `calculateTravelTime` |
| `src/dynamicworldagent/engine/shared/topologyHelpers.ts` | Remove `getNpcLocation` fallback |
| `src/dynamicworldagent/engine/shared/impactPropagation.ts` | Use `characterPositions`; replace `getAllLocations` in `findAffectedScenes` |
| `src/dynamicworldagent/simulation/characterInjection.ts` | Remove `npcLocations` references |
| `src/dynamicworldagent/simulation/SimulationRunner.ts` | Use `characterPositions` |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts` | Use `characterPositions` |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | Use `characterPositions` |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/sceneMapFormatter.ts` | Use `characterPositions`; remove `formatFlatSceneMap` |
| `src/dynamicworldagent/engine/handlers/routineHandler.ts` | Use `getCharacterPosition` |
| `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts` | Use `getCharacterPosition` |
| `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts` | Use `getCharacterPosition` |
| `src/dynamicworldagent/engine/handlers/sceneInteractionHandler.ts` | Use `getCharacterPosition` |
| `src/dynamicworldagent/engine/features/sanityFeature.ts` | Use `characterPositions` |
| `src/dynamicworldagent/engine/features/staminaFeature.ts` | Use `characterPositions` |
| `src/dynamicworldagent/engine/features/lightingFeature.ts` | Replace `getAllLocations` with `state.scenes`; remove topology null guard |
| `src/dynamicworldagent/engine/features/weatherFeature.ts` | Replace `getAllLocations` with direct scene/junction/road iteration |
| `client/server/simulation/mapService.ts` | Use `characterPositions` |
| `engine/handlers/__tests__/objectInteractionHandler.test.ts` | Update mocks |
| `engine/shared/__tests__/topologyHelpers.test.ts` | Update mocks; remove fallback tests |
| `engine/features/__tests__/sanityFeature.test.ts` | Update mocks |
| `engine/features/__tests__/staminaFeature.test.ts` | Update mocks; remove fallback test |
| `engine/features/__tests__/weatherFeature.test.ts` | Update mocks |
