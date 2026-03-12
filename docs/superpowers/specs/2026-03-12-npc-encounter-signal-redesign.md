# NPC Encounter Signal Redesign

## Problem

Current `scanUnplannedEncounters` generates fake `PlanNode` objects with hardcoded template strings ("Friendly encounter with B" / "Hostile confrontation with B") that go through the full handler pipeline — skill rolls, relationship updates, memory writes, and then impact propagation. This produces:

- Empty interactions with no meaningful content
- Redundant LLM calls (relationship update + impact gate)
- Hardcoded `actionType` (social/combat) that may not match the situation
- Encounter outcomes that are too shallow to drive interesting NPC behavior

## Design

### Core Change

Replace the PlanNode-based encounter with a **signal-only** approach:

1. Detect NPC co-presence per scene (no relationship filter)
2. Write a lightweight witness memory per NPC
3. Feed a synthetic impact-2 event into the existing gate pipeline
4. Let `revisePlans` generate real interaction nodes if the gate fires

### Flow

```
executeSingleTick (after step 5, before step 6):
  ↓
scanUnplannedEncounters(dgsm, tickTime, memoryManager, sessionId, moduleId, gameDay):
  Group NPCs by location (scenes with 2+ NPCs)
  ↓
  For each NPC at such a scene:
    Collect names of all OTHER NPCs present
    Write witness memory: "在 [location] 看见了 [name1, name2, ...]"
  ↓
  For each scene with 2+ NPCs:
    Return one synthetic CharacterAction (impact=2, location=scene)
  ↓
  Return: { encounterEvents: CharacterAction[] }

executeSingleTick step 6 (impact propagation):
  Merge encounterEvents into impactEvents
  ↓
  Existing flow: findAffectedCharacters → characterEventsMap → runImpactGateForNpc
  ↓
  Gate decides: shouldRevise / shouldReviseSchedule
  ↓
  If shouldRevise → revisePlans generates real PlanNodes for future ticks
```

### Synthetic CharacterAction Structure

One per scene (not per NPC pair), using a neutral `characterId` so no NPC is excluded from `findAffectedCharacters`:

```typescript
{
  characterId: "__encounter__",       // neutral ID, excluded by addChar self-filter
  characterName: "Co-presence",
  gameTime: tickTime,
  action: `NPCs present together at ${locationName}`,
  location: sceneId,
  type: "character_interaction" as PlanNodeType,
  impact: 2 as const,                // same-scene propagation
  status: "completed" as const,
  outcome: `${npcNames.join(", ")} are at ${locationName}`,
}
```

With impact=2, `findAffectedCharacters` finds all characters at the same sub-scene. Since `characterId` is `"__encounter__"` (not a real NPC), no NPC is self-excluded.

### Witness Memory

Written per NPC before the gate runs, so the gate LLM has context:

```typescript
await memoryManager.add({
  npcId,
  sessionId,
  moduleId,
  type: "witness",
  content: `Day${gameDay} ${tickTime} [${location}] - Saw ${otherNpcNames.join(", ")} here`,
  gameDay,
  gameTime: tickTime,
  location,
  metadata: {
    sourceCharacterId: "__encounter__",
    sourceAction: "co-presence",
    impact: 2,
  },
});
```

### Deduplication

- Only process scenes where 2+ NPCs are present
- Skip NPC pairs that already have a `character_interaction` node in the current tick's `tickActions` (they already interacted — no need for a "noticed" signal)
- The encounter scan runs once per tick; NPCs who move within the tick won't trigger duplicate encounters

### What Gets Removed

- `scanUnplannedEncounters` no longer pushes PlanNodes into the execution queue
- No encounter nodes go through `characterInteractionHandler`
- No hardcoded `actionType: "social" | "combat"`
- No `updateRelationshipViaLLM` at encounter time
- No skill rolls for encounters

### What Stays

- The `|score| >= 60` threshold is **removed** — all co-present NPCs are noticed
- The impact gate LLM has relationship context and decides significance
- `revisePlans` generates real, meaningful interaction nodes if needed
- Relationship updates happen naturally when those real interactions execute

## Files Changed

| File | Change |
|------|--------|
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | Rewrite `scanUnplannedEncounters` to return encounter events + write memories; merge events into impact propagation in `executeSingleTick` |
| No other files | The impact gate pipeline, `findAffectedCharacters`, handlers, and `revisePlans` are unchanged |

## Edge Cases

- **Solo NPC at scene**: No encounter generated (needs 2+)
- **NPC already interacting with another NPC this tick**: Their pair is skipped (dedup via `tickActions`)
- **Player at same scene**: Player is included in `findAffectedCharacters` output (impact=2), handled as `playerEvents` — existing behavior
- **Many NPCs at same scene**: One synthetic event per scene, all NPCs go through gate in parallel — O(N) gate calls, not O(N^2)
