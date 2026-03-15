# Unify NPC Position System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove legacy `npcLocations` and unify all NPC position tracking to `characterPositions: Record<string, CharacterPosition>`. Remove legacy BFS pathfinding. Require topology for all modules.

**Architecture:** Delete `npcLocations` field + accessor methods from DynamicGameState. All ~40 call sites switch to `getCharacterPosition()` + `resolveLocationId()`. Remove `findPath`/`calculateTravelTime`/`getAllLocations`. Simplify movementHandler to topology-only. Fix `moduleLoader` to always init positions as `{ type: "scene" }`.

**Tech Stack:** TypeScript, Vitest

---

## File Map

| File | Change | Responsibility |
|------|--------|---------------|
| `src/dynamicworldagent/state/DynamicGameState.ts` | Modify | Remove `npcLocations`, `getNpcLocation`, `setNpcLocation`, `getAllLocations`; make `topology` non-nullable |
| `src/dynamicworldagent/state/moduleLoader.ts` | Modify | Remove `npcLocations` init; require topology; simplify `characterPositions` init |
| `src/dynamicworldagent/engine/handlers/movementHandler.ts` | Modify | Remove BFS + direct fallback; fix skill movement; update description |
| `src/dynamicworldagent/engine/shared/pathfinding.ts` | Modify | Remove `findPath`, `calculateTravelTime` |
| `src/dynamicworldagent/engine/shared/topologyHelpers.ts` | Modify | Remove `getNpcLocation` fallback |
| `src/dynamicworldagent/engine/shared/impactPropagation.ts` | Modify | Use `characterPositions`; replace `getAllLocations` |
| `src/dynamicworldagent/engine/handlers/routineHandler.ts` | Modify | Use `getCharacterPosition` |
| `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts` | Modify | Use `getCharacterPosition` |
| `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts` | Modify | Use `getCharacterPosition` |
| `src/dynamicworldagent/engine/handlers/sceneInteractionHandler.ts` | Modify | Use `getCharacterPosition` |
| `src/dynamicworldagent/engine/features/sanityFeature.ts` | Modify | Use `characterPositions` |
| `src/dynamicworldagent/engine/features/lightingFeature.ts` | Modify | Replace `getAllLocations`; remove topology null guard |
| `src/dynamicworldagent/engine/features/weatherFeature.ts` | Modify | Replace `getAllLocations` |
| `src/dynamicworldagent/simulation/characterInjection.ts` | Modify | Remove `npcLocations` references |
| `src/dynamicworldagent/simulation/SimulationRunner.ts` | Modify | Use `characterPositions` |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts` | Modify | Use `characterPositions` |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | Modify | Use `characterPositions` |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/sceneMapFormatter.ts` | Modify | Use `characterPositions`; remove `formatFlatSceneMap` |
| `src/dynamicworldagent/state/types.ts` | Modify | Update doc comment |
| Test files (5) | Modify | Update mocks |

---

## Chunk 1: Core state — remove `npcLocations` from DynamicGameState

### Task 1: Remove `npcLocations` field and accessors from `DynamicGameState.ts`

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameState.ts`

- [ ] **Step 1: Remove `npcLocations` from the interface (line 58)**

Delete:
```typescript
  npcLocations: Record<string, string>; // npcId -> sceneId
```

Make topology non-nullable (line 75):
```typescript
  // OLD:
  topology: TownTopology | null;
  // NEW:
  topology: TownTopology;
```

- [ ] **Step 2: Remove `npcLocations` from `initialDynamicGameState` (line 106)**

Delete:
```typescript
  npcLocations: {},
```

Change `topology: null` to remove it (since topology is required, `initialDynamicGameState` shouldn't be used for production — it's a stub). Keep `topology: null as any` to avoid breaking the stub:
```typescript
  topology: null as unknown as TownTopology,
```

- [ ] **Step 3: Remove `getNpcLocation` and `setNpcLocation` methods (lines 656-662)**

Delete entirely:
```typescript
  getNpcLocation(npcId: string): string | undefined {
    return this.state.npcLocations[npcId];
  }

  setNpcLocation(npcId: string, scenarioId: string): void {
    this.state.npcLocations[npcId] = scenarioId;
  }
```

- [ ] **Step 4: Remove `getAllLocations` method (lines 166-198)**

Delete the entire `getAllLocations()` method.

- [ ] **Step 5: Update `getTopology` return type (line 850-852)**

```typescript
  // OLD:
  getTopology(): TownTopology | null {
    return this.state.topology;
  }
  // NEW:
  getTopology(): TownTopology {
    return this.state.topology;
  }
```

- [ ] **Step 6: Update `serialize()` — remove `npcLocations` from output**

In the return object of `serialize()`, the spread `...this.state` will no longer include `npcLocations` since it's removed from the interface. No explicit change needed beyond the interface removal.

- [ ] **Step 7: Update `deserialize()` — remove `npcLocations`, add backward compat**

Remove line 376:
```typescript
      npcLocations: data.npcLocations ?? {},
```

Add backward compat for `characterPositions` — if it's empty but `npcLocations` exists in old data, convert:
```typescript
      // Replace the characterPositions line:
      characterPositions: (() => {
        if (data.characterPositions && Object.keys(data.characterPositions).length > 0) {
          return data.characterPositions;
        }
        // Backward compat: convert old npcLocations to characterPositions
        if (data.npcLocations) {
          const positions: Record<string, CharacterPosition> = {};
          for (const [npcId, locId] of Object.entries(data.npcLocations)) {
            positions[npcId] = { type: "scene", sceneId: locId as string };
          }
          return positions;
        }
        return {};
      })(),
```

Also make topology required in deserialization — the existing code already builds topology from junctions/roads, which is correct. Change the `topology` line to assert non-null:
```typescript
      // topology is required — old data without it will fail at runtime
      topology: topology!,
```

- [ ] **Step 8: Build**

Run: `pnpm build`
Expected: Type errors in all files that reference `npcLocations`, `getNpcLocation`, `setNpcLocation`, `getAllLocations`. This is expected — we fix them in subsequent tasks.

---

## Chunk 2: Module loader + pathfinding + topology helpers

### Task 2: Update `moduleLoader.ts` — require topology, simplify position init

**Files:**
- Modify: `src/dynamicworldagent/state/moduleLoader.ts`

- [ ] **Step 1: Remove `npcLocations` and require topology**

Remove `npcLocations` declaration (line 193):
```typescript
  // DELETE this line:
  const npcLocations: Record<string, string> = {};
```

Add topology requirement after the topology build (after line 183):
```typescript
  if (!topology) {
    throw new Error(
      `Module ${moduleData.moduleId} has no topology (junctions/roads). Topology is required.`
    );
  }
```

- [ ] **Step 2: Simplify `characterPositions` init — always use scene type**

Replace the entire characterPositions block (lines 281-307) with:
```typescript
    // Initialize characterPosition — always scene type for NPCs in scenes
    characterPositions[npc.id] = { type: "scene", sceneId: resolvedLocation };
```

Remove the `if (topology)` guard since topology is now required and guaranteed non-null.

- [ ] **Step 3: Remove `npcLocations` from NPC loop and return**

Delete line 248:
```typescript
    npcLocations[npc.id] = resolvedLocation;
```

Remove `npcLocations` from the return object (line 340):
```typescript
    // DELETE:
    npcLocations,
```

- [ ] **Step 4: Change `topology` type in return to non-nullable**

The return object already assigns `topology` which is now guaranteed non-null after the check. No type annotation change needed — it will infer correctly.

---

### Task 3: Remove legacy BFS from `pathfinding.ts`

**Files:**
- Modify: `src/dynamicworldagent/engine/shared/pathfinding.ts`

- [ ] **Step 1: Delete `findPath` function (lines 11-47)**

Delete the entire `findPath` function and its JSDoc.

- [ ] **Step 2: Delete `calculateTravelTime` function (lines 49-80)**

Delete the entire `calculateTravelTime` function and its JSDoc.

- [ ] **Step 3: Remove unused import**

Remove `DynamicScene` and `TransportEdge` from imports (line 5) since they were only used by the deleted functions:
```typescript
// DELETE this import line:
import type { DynamicScene, TransportEdge } from "../../state/types.js";
```

---

### Task 4: Remove fallback in `topologyHelpers.ts`

**Files:**
- Modify: `src/dynamicworldagent/engine/shared/topologyHelpers.ts`

- [ ] **Step 1: Remove `getNpcLocation` fallback from `resolveCharacterLocationId` (lines 82-94)**

Replace the entire function:
```typescript
export function resolveCharacterLocationId(
  characterId: string,
  dgsm: DynamicGameStateManager
): string | undefined {
  const position = dgsm.getCharacterPosition(characterId);
  if (!position) return undefined;
  return dgsm.resolveLocationId(position);
}
```

---

### Task 5: Build and commit chunk 2

- [ ] **Step 1: Build**

Run: `pnpm build`
Expected: Still type errors in handler/feature/agent files. The core state + pathfinding changes are done.

- [ ] **Step 2: Commit**

```bash
git add src/dynamicworldagent/state/DynamicGameState.ts \
        src/dynamicworldagent/state/moduleLoader.ts \
        src/dynamicworldagent/engine/shared/pathfinding.ts \
        src/dynamicworldagent/engine/shared/topologyHelpers.ts
git commit -m "refactor: remove npcLocations, require topology, remove legacy BFS"
```

---

## Chunk 3: Handlers — switch to `getCharacterPosition`

### Task 6: Update `movementHandler.ts`

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/movementHandler.ts`

- [ ] **Step 1: Remove legacy BFS imports**

```typescript
// OLD:
import {
  calculateTravelTime,
  findPath,
  findTopologyPath,
} from "../shared/pathfinding.js";
// NEW:
import { findTopologyPath } from "../shared/pathfinding.js";
```

- [ ] **Step 2: Update `execute` — replace `getNpcLocation` with `getCharacterPosition`**

Replace line 45:
```typescript
    // OLD:
    const npcLocation = dgsm.getNpcLocation(node.characterId);
    // NEW:
    const currentPos = dgsm.getCharacterPosition(node.characterId);
    const npcLocation = currentPos ? dgsm.resolveLocationId(currentPos) : undefined;
```

- [ ] **Step 3: Fix skill-based movement — add `setCharacterPosition` call**

After line 81 (`dgsm.setNpcLocation(node.characterId, node.location);`), replace with:
```typescript
      // Update position
      const topology = dgsm.getTopology();
      const targetPos = resolveTargetPosition(node.location, topology);
      if (targetPos) {
        dgsm.setCharacterPosition(node.characterId, targetPos);
      }
```

- [ ] **Step 4: Simplify topology-based movement — remove `if (currentPos)` guard**

Since `characterPositions` is now always populated, simplify lines 92-147. Remove the `if (topology)` and `if (currentPos)` guards — topology is always present, and currentPos should always exist. Keep the null check as a safety bail:

```typescript
    // Topology-based movement
    const topology = dgsm.getTopology();
    if (!currentPos) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { reason: "character position unknown" }),
        { difficulty, failureReason: "location_mismatch" }
      );
    }
    const targetPos = resolveTargetPosition(node.location, topology);
    if (!targetPos) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { reason: `unknown destination: ${node.location}` }),
        { difficulty, failureReason: "location_mismatch" }
      );
    }
    const topologyPath = findTopologyPath(
      currentPos,
      targetPos,
      topology,
      state.blockedConnections
    );
    if (!topologyPath) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { reason: "no path available in topology" }),
        { difficulty, failureReason: "location_blocked" }
      );
    }
    dgsm.setCharacterPosition(node.characterId, targetPos);

    if (ctx.simulationEmitter) {
      const state = dgsm.getState();
      ctx.simulationEmitter.emitSimulationEvent(
        "npc_moved",
        node.characterId,
        node.location,
        state.gameDay,
        state.timeOfDay,
        { fromPosition: currentPos, toPosition: targetPos }
      );
    }

    return makeAction(
      node,
      "completed",
      buildOutcome(node, "completed", {
        reason: `Traveled via topology in ~${topologyPath.totalMinutes} min`,
      }),
      { difficulty, successLevel: resolvedSuccessLevel }
    );
```

- [ ] **Step 5: Delete BFS fallback (old lines 149-181) and direct movement fallback (old lines 183-207)**

These are entirely removed — the topology path above is the only movement path.

- [ ] **Step 6: Update handler `description` string**

```typescript
  description:
    "Move a character to a different location. " +
    "If skill is set, a creative single-hop movement with skill check is attempted. " +
    "Otherwise, topology pathfinding is used to find a route through the town graph.",
```

---

### Task 7: Update remaining handlers — `routineHandler`, `characterInteractionHandler`, `objectInteractionHandler`, `sceneInteractionHandler`

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/routineHandler.ts`
- Modify: `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts`
- Modify: `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts`
- Modify: `src/dynamicworldagent/engine/handlers/sceneInteractionHandler.ts`

All four handlers have the same pattern. Replace:
```typescript
const npcLocation = dgsm.getNpcLocation(node.characterId);
```
With:
```typescript
const pos = dgsm.getCharacterPosition(node.characterId);
const npcLocation = pos ? dgsm.resolveLocationId(pos) : undefined;
```

- [ ] **Step 1: Update `routineHandler.ts` (line 38)**

- [ ] **Step 2: Update `characterInteractionHandler.ts` (line 42 and line 70)**

Line 42:
```typescript
const pos = dgsm.getCharacterPosition(node.characterId);
const npcLocation = pos ? dgsm.resolveLocationId(pos) : undefined;
```

Line 70 — target presence check:
```typescript
      const targetPos = dgsm.getCharacterPosition(node.targetCharacterId);
      const targetLocation = targetPos ? dgsm.resolveLocationId(targetPos) : undefined;
```

- [ ] **Step 3: Update `objectInteractionHandler.ts` (line 158)**

```typescript
const pos = dgsm.getCharacterPosition(node.characterId);
const npcLocation = pos ? dgsm.resolveLocationId(pos) : undefined;
```

- [ ] **Step 4: Update `sceneInteractionHandler.ts` (line 40)**

```typescript
const pos = dgsm.getCharacterPosition(node.characterId);
const npcLocation = pos ? dgsm.resolveLocationId(pos) : undefined;
```

---

### Task 8: Commit chunk 3

- [ ] **Step 1: Build**

Run: `pnpm build`

- [ ] **Step 2: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/
git commit -m "refactor: switch all handlers from getNpcLocation to getCharacterPosition"
```

---

## Chunk 4: Features + shared

### Task 9: Update `impactPropagation.ts`

**Files:**
- Modify: `src/dynamicworldagent/engine/shared/impactPropagation.ts`

- [ ] **Step 1: Replace `getCharLocation` helper in `findAffectedCharacters` (line 67-69)**

```typescript
  // OLD:
  const getCharLocation = (charId: string): string | undefined => {
    return dgsm.getNpcLocation(charId);
  };
  // NEW:
  const getCharLocation = (charId: string): string | undefined => {
    const pos = dgsm.getCharacterPosition(charId);
    return pos ? dgsm.resolveLocationId(pos) : undefined;
  };
```

- [ ] **Step 2: Replace `getAllLocations()` in `findAffectedScenes` (line 145)**

```typescript
  // OLD:
  const allLocations = dgsm.getAllLocations();
  // NEW:
  const state = dgsm.getState();
```

Then update the iteration at level 3 (line 151):
```typescript
  // OLD:
  for (const [id, scene] of allLocations) {
    if (scene.parentLocationId === parent) scenes.add(id);
  }
  // NEW:
  for (const [id, scene] of state.scenes) {
    if (scene.parentLocationId === parent) scenes.add(id);
  }
  for (const [id, junc] of state.junctions) {
    if (junc.parentLocationId === parent) scenes.add(id);
  }
  for (const [id, road] of state.roads) {
    if (road.parentLocationId === parent) scenes.add(id);
  }
```

Same pattern for level 4 (line 166) and level 5 (line 179):
```typescript
  // Level 4: replace allLocations iteration
  for (const [id, scene] of state.scenes) {
    if (scene.parentLocationId && neighbors.includes(scene.parentLocationId)) scenes.add(id);
  }
  for (const [id, junc] of state.junctions) {
    if (junc.parentLocationId && neighbors.includes(junc.parentLocationId)) scenes.add(id);
  }
  for (const [id, road] of state.roads) {
    if (road.parentLocationId && neighbors.includes(road.parentLocationId)) scenes.add(id);
  }

  // Level 5: replace allLocations iteration
  for (const id of state.scenes.keys()) scenes.add(id);
  for (const id of state.junctions.keys()) scenes.add(id);
  for (const id of state.roads.keys()) scenes.add(id);
```

Remove unused variable `allLocations`.

---

### Task 10: Update `sanityFeature.ts`

**Files:**
- Modify: `src/dynamicworldagent/engine/features/sanityFeature.ts`

- [ ] **Step 1: Replace `state.npcLocations` iteration (line 579)**

```typescript
  // OLD:
  for (const npcId of Object.keys(state.npcLocations)) {
  // NEW:
  for (const npcId of Object.keys(state.characterPositions)) {
```

---

### Task 11: Update `lightingFeature.ts`

**Files:**
- Modify: `src/dynamicworldagent/engine/features/lightingFeature.ts`

- [ ] **Step 1: Replace `getAllLocations()` in `tick()` (line 335)**

```typescript
  // OLD:
  dgsm.getAllLocations().forEach((_scene: any, sceneId: string) => {
  // NEW:
  state.scenes.forEach((_scene, sceneId) => {
```

- [ ] **Step 2: Remove `if (topology)` guard (line 348)**

```typescript
  // OLD:
  const topology = dgsm.getTopology();
  if (topology) {
    ...
  }
  // NEW:
  const topology = dgsm.getTopology();
  for (const [roadId, road] of topology.roads) {
    ...
  }
  for (const [juncId, junc] of topology.junctions) {
    ...
  }
```

---

### Task 12: Update `weatherFeature.ts`

**Files:**
- Modify: `src/dynamicworldagent/engine/features/weatherFeature.ts`

- [ ] **Step 1: Replace `getAllLocations()` in `getOutdoorSceneIds` (line 152)**

```typescript
  // OLD:
  dgsm.getAllLocations().forEach((scene: any, id: string) => {
    if (scene.parentLocationId === regionId && !scene.indoor) {
      sceneIds.push(id);
    }
  });
  // NEW:
  const state = dgsm.getState();
  for (const [id, scene] of state.scenes) {
    if (scene.parentLocationId === regionId && !(scene as any).indoor) {
      sceneIds.push(id);
    }
  }
  // Also check junctions and roads (outdoor by default)
  for (const [id, junc] of state.junctions) {
    if (junc.parentLocationId === regionId) {
      sceneIds.push(id);
    }
  }
  for (const [id, road] of state.roads) {
    if (road.parentLocationId === regionId) {
      sceneIds.push(id);
    }
  }
```

- [ ] **Step 2: Replace `getAllLocations()` in `initWeatherFromPresets` (line 355)**

```typescript
  // OLD:
  dgsm.getAllLocations().forEach((scene: any) => {
    regionIds.add(scene.parentLocationId);
  });
  // NEW:
  for (const [, scene] of state.scenes) {
    if (scene.parentLocationId) regionIds.add(scene.parentLocationId);
  }
  for (const [, junc] of state.junctions) {
    if (junc.parentLocationId) regionIds.add(junc.parentLocationId);
  }
  for (const [, road] of state.roads) {
    if (road.parentLocationId) regionIds.add(road.parentLocationId);
  }
```

---

### Task 13: Update `staminaFeature.ts`

**Files:**
- Modify: `src/dynamicworldagent/engine/features/staminaFeature.ts`

- [ ] **Step 1: Update `getTrackedCharacters` doc comment (line 197-198)**

```typescript
  // OLD:
  * Uses CharacterPosition when available (topology-aware), falling back to
  * npcLocations.
  // NEW:
  * Uses CharacterPosition to resolve location IDs.
```

The function body already uses `resolveCharacterLocationId()` which will now only use `characterPositions` after the topologyHelpers fix. No code change needed in the body.

---

### Task 14: Commit chunk 4

- [ ] **Step 1: Build**

Run: `pnpm build`

- [ ] **Step 2: Commit**

```bash
git add src/dynamicworldagent/engine/shared/impactPropagation.ts \
        src/dynamicworldagent/engine/features/
git commit -m "refactor: switch features and impactPropagation from npcLocations to characterPositions"
```

---

## Chunk 5: Planning system + simulation

### Task 15: Update `NPCPlanningAgent.ts`

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts`

Five call sites to fix:

- [ ] **Step 1: Line 181 — `generateDailySchedule`**

```typescript
  // OLD:
  const npcLocation = state.npcLocations[npc.id];
  // NEW:
  const npcPos = dgsm.getCharacterPosition(npc.id);
  const npcLocation = npcPos ? dgsm.resolveLocationId(npcPos) : undefined;
```

- [ ] **Step 2: Lines 272, 295 — `generateDetailedNodes`**

Line 272:
```typescript
  // OLD:
  const currentLocation = state.npcLocations[npcId] ?? "";
  // NEW:
  const currentPos = dgsm.getCharacterPosition(npcId);
  const currentLocation = currentPos ? dgsm.resolveLocationId(currentPos) : "";
```

Line 295 (co-location check):
```typescript
  // OLD:
  (n) => n.id !== npcId && state.npcLocations[n.id] === currentLocation
  // NEW:
  (n) => {
    if (n.id === npcId) return false;
    const otherPos = dgsm.getCharacterPosition(n.id);
    const otherLoc = otherPos ? dgsm.resolveLocationId(otherPos) : "";
    return otherLoc === currentLocation;
  }
```

- [ ] **Step 3: Line 473 — `reviseSchedule`**

```typescript
  // OLD:
  const npcLocation = state.npcLocations[npcId];
  // NEW:
  const npcPos = dgsm.getCharacterPosition(npcId);
  const npcLocation = npcPos ? dgsm.resolveLocationId(npcPos) : undefined;
```

- [ ] **Step 4: Lines 541, 551 — `revisePlans`**

Line 541:
```typescript
  // OLD:
  const currentLocation = state.npcLocations[npcId] ?? "";
  // NEW:
  const currentPos = dgsm.getCharacterPosition(npcId);
  const currentLocation = currentPos ? dgsm.resolveLocationId(currentPos) : "";
```

Line 551 (co-location check):
```typescript
  // OLD:
  (n) => n.id !== npcId && state.npcLocations[n.id] === currentLocation
  // NEW:
  (n) => {
    if (n.id === npcId) return false;
    const otherPos = dgsm.getCharacterPosition(n.id);
    const otherLoc = otherPos ? dgsm.resolveLocationId(otherPos) : "";
    return otherLoc === currentLocation;
  }
```

---

### Task 16: Update `tickProcessor.ts`

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

- [ ] **Step 1: Line 573 — encounter detection filter**

```typescript
  // OLD:
  const loc = dgsm.getNpcLocation(id);
  // NEW:
  const locPos = dgsm.getCharacterPosition(id);
  const loc = locPos ? dgsm.resolveLocationId(locPos) : undefined;
```

- [ ] **Step 2: Line 817 — impact gate witness context**

```typescript
  // OLD:
  currentLocation: dgsm.getNpcLocation(npcId) ?? "unknown",
  // NEW:
  currentLocation: (() => {
    const p = dgsm.getCharacterPosition(npcId);
    return p ? dgsm.resolveLocationId(p) : "unknown";
  })(),
```

- [ ] **Step 3: Line 833 — witness memory location**

```typescript
  // OLD:
  const npcLoc = dgsm.getNpcLocation(npcId) ?? "unknown";
  // NEW:
  const npcLocPos = dgsm.getCharacterPosition(npcId);
  const npcLoc = npcLocPos ? dgsm.resolveLocationId(npcLocPos) : "unknown";
```

- [ ] **Step 4: Line 1008 — `scanUnplannedEncounters` location grouping**

```typescript
  // OLD:
  const loc = dgsm.getNpcLocation(npc.id);
  // NEW:
  const locPos = dgsm.getCharacterPosition(npc.id);
  const loc = locPos ? dgsm.resolveLocationId(locPos) : undefined;
```

---

### Task 17: Update `sceneMapFormatter.ts`

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/sceneMapFormatter.ts`

- [ ] **Step 1: Update `formatTopologySceneMap` — NPC position (line 62)**

```typescript
  // OLD:
  const npcLocation = state.npcLocations[npcId];
  // NEW:
  const npcPos = state.characterPositions[npcId];
  const npcLocation = npcPos
    ? npcPos.type === "scene" ? npcPos.sceneId
    : npcPos.type === "junction" ? npcPos.junctionId
    : npcPos.roadId
    : undefined;
```

- [ ] **Step 2: Remove `formatFlatSceneMap` function (lines 186-271) and update `formatSceneMap`**

Replace `formatSceneMap` (lines 7-21):
```typescript
export function formatSceneMap(
  dgsm: DynamicGameStateManager,
  npcId: string
): string {
  return formatTopologySceneMap(dgsm, npcId);
}
```

Delete the entire `formatFlatSceneMap` function.

---

### Task 18: Update `characterInjection.ts` and `SimulationRunner.ts`

**Files:**
- Modify: `src/dynamicworldagent/simulation/characterInjection.ts`
- Modify: `src/dynamicworldagent/simulation/SimulationRunner.ts`

- [ ] **Step 1: `characterInjection.ts` — `injectCharacterIntoState` (line 69)**

Delete:
```typescript
  dgsm.setNpcLocation(profile.id, entrySceneId);
```

- [ ] **Step 2: `characterInjection.ts` — `removeCharacterFromState` (lines 129, 140)**

Remove `npcLocations` from the type cast (line 129):
```typescript
  // DELETE this line from the type cast:
  npcLocations: Record<string, string>;
```

Delete line 140:
```typescript
  delete state.npcLocations[characterId];
```

- [ ] **Step 3: `SimulationRunner.ts` — comment at line 264**

Update comment:
```typescript
  // OLD:
  // 1. Inject into game state (npcCharacters, npcStats, npcLocations, etc.)
  // NEW:
  // 1. Inject into game state (npcCharacters, npcStats, characterPositions, etc.)
```

- [ ] **Step 4: `SimulationRunner.ts` — line 496**

```typescript
  // OLD:
  const location = gameState.npcLocations[npc.id] ?? "unknown";
  // NEW:
  const pos = gameState.characterPositions[npc.id];
  const location = pos
    ? pos.type === "scene" ? pos.sceneId : pos.type === "junction" ? pos.junctionId : pos.roadId
    : "unknown";
```

---

### Task 19: Update `state/types.ts` doc comment

**Files:**
- Modify: `src/dynamicworldagent/state/types.ts`

- [ ] **Step 1: Update comment at line 168**

```typescript
  // OLD:
  * Location is tracked via npcLocations/characterPositions, not on the profile.
  // NEW:
  * Location is tracked via characterPositions, not on the profile.
```

---

### Task 20: Commit chunk 5

- [ ] **Step 1: Build**

Run: `pnpm build`
Expected: Clean build (may still have test failures).

- [ ] **Step 2: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/ \
        src/dynamicworldagent/simulation/ \
        src/dynamicworldagent/state/types.ts
git commit -m "refactor: switch planning system and simulation to characterPositions"
```

---

## Chunk 6: Tests

### Task 21: Update test files

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/__tests__/objectInteractionHandler.test.ts`
- Modify: `src/dynamicworldagent/engine/shared/__tests__/topologyHelpers.test.ts`
- Modify: `src/dynamicworldagent/engine/features/__tests__/sanityFeature.test.ts`
- Modify: `src/dynamicworldagent/engine/features/__tests__/staminaFeature.test.ts`
- Modify: `src/dynamicworldagent/engine/features/__tests__/weatherFeature.test.ts`

Each test file has a mock DGSM that includes `npcLocations` and `getNpcLocation`. Replace with `characterPositions` and `getCharacterPosition` + `resolveLocationId`.

- [ ] **Step 1: `objectInteractionHandler.test.ts`**

Replace `npcLocations` mock (line 12) with `characterPositions`:
```typescript
const characterPositions: Record<string, { type: string; sceneId?: string; junctionId?: string; roadId?: string }> = {};
```

Replace `getNpcLocation` mock (lines 26-28) with:
```typescript
    getCharacterPosition(npcId: string) {
      return characterPositions[npcId] ?? null;
    },
    resolveLocationId(pos: any) {
      if (pos.type === "scene") return pos.sceneId;
      if (pos.type === "junction") return pos.junctionId;
      return pos.roadId;
    },
```

Replace `setNpcLocation` mock (line 64) with:
```typescript
      characterPositions[npcId] = { type: "scene", sceneId: location };
```

Update all test setup that sets `npcLocations[id] = scene` to instead set `characterPositions[id] = { type: "scene", sceneId: scene }`.

- [ ] **Step 2: `topologyHelpers.test.ts`**

Remove `npcLocations` from mock (lines 101, 105). Replace `getNpcLocation` mock (lines 128-129) with `getCharacterPosition` + `resolveLocationId`.

Delete the fallback test case at line 280 ("falls back to getNpcLocation for NPCs without CharacterPosition").

Update the test at line 299 that uses `npcLocations` to use `characterPositions`.

- [ ] **Step 3: `sanityFeature.test.ts`**

Replace `npcLocations` mock (line 30) with `characterPositions`. Replace `setNpcLocation` mock (line 81) with `setCharacterPosition`. Add `getCharacterPosition` and `resolveLocationId` to mock.

- [ ] **Step 4: `staminaFeature.test.ts`**

Replace `npcLocations` mock (line 9) with `characterPositions`. Replace `getNpcLocation` mock (line 62) with `getCharacterPosition` + `resolveLocationId`. Replace `setNpcLocation` mock (line 50) with position-based setter.

Delete the fallback test at line 538 ("should fallback to npcLocations when no CharacterPosition").

- [ ] **Step 5: `weatherFeature.test.ts`**

Replace `npcLocations` mock (line 23) with `characterPositions`. Replace `setNpcLocation` mock (line 77) with position-based setter.

---

### Task 22: Run tests and commit

- [ ] **Step 1: Build**

Run: `pnpm build`
Expected: Clean build, zero type errors.

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/__tests__/ \
        src/dynamicworldagent/engine/shared/__tests__/ \
        src/dynamicworldagent/engine/features/__tests__/
git commit -m "test: update all test mocks from npcLocations to characterPositions"
```
