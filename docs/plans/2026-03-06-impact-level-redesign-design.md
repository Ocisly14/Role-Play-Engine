# Impact Level Redesign: 0–3 → 0–5

**Date:** 2026-03-06
**Branch:** tick
**Status:** Approved
**Depends on:** scene-graph-module-generation-design (two-level scene hierarchy + transport network)

## Problem

The current impact system uses 4 levels (0–3) designed for a flat scene model. With the new two-level scene graph (macro locations containing sub-scenes, connected by a transport network), the old levels conflate sub-scene and macro-location scope. Impact 2 uses an adjacency hack to approximate "nearby," which doesn't map cleanly to the new architecture.

## Design

### Impact Levels

| Level | Name | Scope | Tick Processor Behavior |
|-------|------|-------|-------------------------|
| **0** | Private | Self only | No notifications |
| **1** | Targeted | Target only | Notify `targetCharacterId` |
| **2** | Sub-scene | Current `DynamicScene` | Notify all characters in the same sub-scene |
| **3** | Macro location | Current `ScenarioOutline` | Notify all characters in any sub-scene under the same macro location |
| **4** | Neighborhood | Macro location + neighbors within 15 min travel | BFS on transport network, notify all characters in macro locations reachable within 15 minutes |
| **5** | Global | Entire game world | Notify all characters |

### Examples per Level

- **0**: Thinking, reading alone, checking belongings, recalling memories
- **1**: Whispering, passing a note, pickpocketing, private conversation
- **2**: Speaking loudly, fighting in a room, searching openly, breaking furniture
- **3**: Fire alarm in a building, shouting down a stairwell, an event audible throughout a building
- **4**: Explosion heard across the block, gunshot echoing through nearby streets, a building collapse
- **5**: Town-wide alarm, radio broadcast, ritual that alters reality, earthquake

### Neighborhood Discovery (Impact 4)

Uses BFS/Dijkstra on the `TransportEdge[]` network with a 15-minute threshold:

```typescript
function findNeighborMacroLocations(
  fromLocationId: string,
  transportEdges: TransportEdge[],
  maxTravelMinutes: number  // 15
): string[] {
  // BFS/Dijkstra on transportEdges
  // Returns all macroLocationIds reachable within maxTravelMinutes
  // Does NOT include fromLocationId itself (already covered by impact 3)
}
```

Why 15 minutes:
- Matches physical intuition (gunshots, explosions audible within ~15 min walking range)
- Large modules (13-20 macro locations): covers 2-3 neighbors, distinct from global
- Small modules (4-6 macro locations): covers roughly half the map, still distinct from impact 5

### Tick Processor Impact Gate

```typescript
for (const event of impactEvents) {
  // Level 1: targeted
  if (event.impact >= 1 && event.targetCharacterId)
    addEventForCharacter(event.targetCharacterId, event, 1);

  // Level 2: same sub-scene
  if (event.impact >= 2)
    notifyCharactersInScene(event.location);

  // Level 3: same macro location (all sub-scenes)
  if (event.impact >= 3)
    notifyCharactersInMacroLocation(getParentLocationId(event.location));

  // Level 4: neighboring macro locations (≤15 min travel)
  if (event.impact >= 4) {
    const neighbors = findNeighborMacroLocations(
      getParentLocationId(event.location),
      state.transportEdges,
      15
    );
    for (const neighborId of neighbors)
      notifyCharactersInMacroLocation(neighborId);
  }

  // Level 5: global
  if (event.impact >= 5)
    notifyAllCharacters();
}
```

Impact gate witness descriptions updated for NPC context:
- impact 1: directly targeted (private, one-on-one)
- impact 2: same room (directly witnessed)
- impact 3: same building (heard/felt through walls)
- impact 4: nearby area (distant sound, rumor, visible from outside)
- impact 5: global event (news, supernatural disturbance, widespread effect)

### Scene Event Logging

Unchanged: actions with `impact >= 2` and `status === "completed"` are logged to `scene.events`. This still makes sense — sub-scene-visible actions are the minimum threshold for scene history.

## Affected Files

| # | File | Change |
|---|------|--------|
| 1 | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts` | `impact: 0\|1\|2\|3` → `0\|1\|2\|3\|4\|5` on `PlanNode` and `CharacterAction` |
| 2 | `src/dynamicworldagent/dynamicBasicAgent/orchestrator/orchestratorTemplate.ts` | Update impact guide to 6 levels (0–5) |
| 3 | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts` | Update impact guide + impact gate witness level descriptions |
| 4 | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts` | Update impact guide to 6 levels |
| 5 | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | Rewrite impact gate: 5-level dispatch, add `findNeighborMacroLocations`, use `parentLocationId` for macro location grouping |
| 6 | `docs/plans/2026-03-06-scene-graph-module-generation-design.md` | Cross-reference this design |

## Not Changed

- Scene event logging threshold (`impact >= 2`) — still correct for sub-scene visibility
- Impact gate `shouldRevise` logic — NPC decides independently whether to revise plans
- `PlayerWitnessEvent` structure — only impact value range expands
- Multiplayer equivalents — out of scope

## Dependencies

This design requires the scene graph architecture to be implemented first:
- `DynamicScene.parentLocationId` must exist to resolve sub-scene → macro location
- `TransportEdge[]` must be available in `DynamicGameState` for neighborhood BFS
- `ScenarioOutline` grouping must be queryable to find all sub-scenes in a macro location
