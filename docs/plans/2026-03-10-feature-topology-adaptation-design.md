# Feature Topology Adaptation Design

> Adapt all WorldFeatures to work with the Road/Junction topology system.

**Goal:** Make fire, lighting, and stamina features topology-aware so they propagate and compute through the road/junction graph instead of the flat scene connection graph.

**Architecture:** Road and Junction nodes participate as "virtual scenes" in the feature system — they hold feature state and conditions using roadId/junctionId as keys. Existing `getFeatureSceneState(featureId, id)` interface unchanged; the `id` parameter now also accepts roadId/junctionId.

**Scope:** Single-player only (`dynamicBasicAgent` / `engine` / `state`).

---

## Core Architecture Decision

Road/Junction as virtual scenes:
- `featureState[featureId][roadId]` and `featureState[featureId][junctionId]` store feature data
- `scenarioConditions[roadId]` and `scenarioConditions[junctionId]` store conditions
- Road and Junction already have `conditions`, `items`, `events` fields in their type definitions
- No interface changes needed — just broader usage of existing APIs

---

## Feature Changes

### 1. Fire Feature (Major)

#### Road Fire Model
- Fire on a road has position range: `{ start: number, end: number }` (0.0-1.0)
- Each tick, range expands by fixed rate: `delta = spreadRateMinutes / road.travelTimeMinutes`
- Along-road buildings (`AlongConnection`) affected only when fire range covers their `position`
- Junction fire has no position range (point node)

#### Weather Interaction
- Applies to **road and junction** fire (both outdoor). Scene (building interior) fire unaffected.
- Rain (intensity >= 2): spread rate reduced (e.g., 50%)
- Rain (intensity >= 3): spread rate near zero, existing fire may extinguish
- Rain (intensity >= 4) or storm (>= 3): extinguish outdoor fire entirely
- Dry/heat weather: spread rate increased (e.g., 150%)
- Weather queried from same region (parentLocationId) as the road/junction
- Road: weather multiplier affects burnRange expansion rate
- Junction: weather multiplier affects intensity growth rate; multiplier 0 extinguishes

#### Propagation Path (replaces scene.connections)
- Scene → parent road/junction (via `sceneToParent`)
- Road → endpoint junctions (via `endpointA`, `endpointB`)
- Junction → connected roads (via `junctionToRoads`)
- Road → along-road scenes (via `alongConnections`, position-gated)
- Junction → directly connected scenes (via `connectedSceneIds`)

#### State Structure
```typescript
// For scenes/junctions (existing model, no position range)
interface FireSceneState {
  intensity: number;       // 0-5
  phase: "growing" | "decaying";
  totalBurnTicks: number;
}

// For roads (new, with position range)
interface FireRoadState {
  intensity: number;       // 0-5
  phase: "growing" | "decaying";
  totalBurnTicks: number;
  burnRange: { start: number; end: number };  // 0.0-1.0
}
```

### 2. Lighting Feature (Medium)

#### Sun/Moon
- Road/junction are outdoor — receive full sun/moon. No change needed.

#### Fire Light Propagation
- Replace `scene.connections` traversal with topology adjacency:
  - Scene fire → light visible at parent road/junction
  - Road/junction fire → light visible at connected scenes
- No position range for light — any fire on same road/junction = fire light visible
- Light intensity from adjacent fire: `fireIntensity - 1` (existing rule, unchanged)

### 3. Stamina Feature (Minor)

#### Character Location Resolution
- Replace `getNpcLocation(characterId)` with:
  ```
  position = getCharacterPosition(characterId)
  locationId = resolveLocationId(position)
  ```
- Use `locationId` to query fire state and weather conditions for acceleration
- Works uniformly for road, junction, and scene locations
- Fallback: if no CharacterPosition, use `getNpcLocation()` (backward compatibility)

### 4. Weather Feature (No Change)
- Already region-based via `parentLocationId`
- Road/junction are outdoor, naturally receive weather effects
- No structural change needed

### 5. Sanity Feature (No Change)
- Purely per-character, no location dependency
- No topology interaction

### 6. Impact Propagation (No Change)
- Keep existing `parentLocationId` + `transportEdges` system
- Topology affects physical features (fire, light), not narrative perception

---

## Topology Helper Needs

Features need a shared way to query topology adjacency. Utility functions:

- `getTopologyNeighbors(locationId, dgsm)` — returns adjacent location IDs via topology
  - For scene: returns parent road/junction
  - For road: returns endpoint junctions + along-road scenes
  - For junction: returns connected roads + connected scenes
- `isOnRoad(locationId, topology)` — check if ID is a road
- `isJunction(locationId, topology)` — check if ID is a junction

These can live in `engine/shared/` as a topology utility module.

---

## Files

### New
- `src/dynamicworldagent/engine/shared/topologyHelpers.ts` — topology adjacency utilities

### Modify
- `src/dynamicworldagent/engine/features/fireFeature.ts` — road fire model, topology propagation, weather interaction
- `src/dynamicworldagent/engine/features/lightingFeature.ts` — fire light via topology
- `src/dynamicworldagent/engine/features/staminaFeature.ts` — CharacterPosition resolution
- `src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts` — road fire tests
- `src/dynamicworldagent/engine/features/__tests__/lightingFeature.test.ts` — topology light tests
- `src/dynamicworldagent/engine/features/__tests__/staminaFeature.test.ts` — position resolution tests
