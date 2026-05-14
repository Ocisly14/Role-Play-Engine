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

### Structural Change

The call site of `scanUnplannedEncounters` **moves** from step 3 (pre-execution, injecting PlanNodes into the queue) to between step 5 and step 6 (post-execution, before impact propagation). This is deliberate: we need `tickActions` for deduplication (skip NPCs who already interacted this tick), and the function no longer produces executable nodes — only signals.

### Flow

```
executeSingleTick step 3: (NO encounter scan here anymore — removed)

executeSingleTick steps 4-5: execute all nodes, post-processing

executeSingleTick (between step 5 and step 6):
  ↓
scanUnplannedEncounters(dgsm, tickTime, tickActions, memoryManager?, sessionId, moduleId, gameDay):
  Group NPCs by location (scenes with 2+ NPCs)
  ↓
  Dedup: build set of NPC pairs from tickActions where type === "character_interaction"
  ↓
  For each NPC at a shared scene (skip if all their co-present pairs are already in dedup set):
    Collect names of all OTHER NPCs present
    If memoryManager: write witness memory
  ↓
  For each scene with 2+ NPCs (after dedup):
    Build one synthetic CharacterAction (impact=2, location=sceneId)
  ↓
  Return: CharacterAction[]

executeSingleTick step 6 (impact propagation):
  const impactEvents = [...tickActions.filter(a => a.impact > 0), ...encounterEvents];
  ↓
  Existing flow: findAffectedCharacters → characterEventsMap → runImpactGateForNpc
  (encounter events are NOT added to tickActions — they don't appear in returned actions/narrative)
  ↓
  Gate decides: shouldRevise / shouldReviseSchedule
  ↓
  Note: the post-gate witness memory write (existing code) will also fire for encounter events.
  This is intentional: the pre-gate memory is a lightweight "noticed X" signal,
  the post-gate memory is the gate's interpretation ("saw rival, felt uneasy").
  ↓
  If shouldRevise → revisePlans generates real PlanNodes for future ticks
```

### New Function Signature

```typescript
function scanUnplannedEncounters(
  dgsm: DynamicGameStateManager,
  tickTime: string,
  tickActions: CharacterAction[],     // for deduplication
  memoryManager: NpcMemoryManager | undefined,
  sessionId: string,
  moduleId: string,
  gameDay: number,
): CharacterAction[]                  // synthetic encounter events
```

### Synthetic CharacterAction Structure

One per scene (not per NPC pair), using a neutral `characterId` so no NPC is excluded from `findAffectedCharacters`:

```typescript
{
  characterId: "__encounter__",       // neutral ID, excluded by addChar self-filter
  characterName: "Co-presence",
  gameTime: tickTime,
  action: `NPCs present together at ${sceneName}`,  // human-readable scene name from dgsm.getScene(sceneId)?.name
  location: sceneId,                                 // machine-readable scene ID (matches getNpcLocation() values)
  type: "character_interaction" as PlanNodeType,
  impact: 2 as const,                // same-scene propagation
  status: "completed" as const,
  outcome: `${npcNames.join(", ")} are at ${sceneName}`,
}
```

- `location` uses scene ID (for `findAffectedCharacters` matching)
- `action` and `outcome` use human-readable scene name (for gate LLM readability)
- `sceneName` resolved via `dgsm.getScene(sceneId)?.name ?? sceneId`

### Witness Memory

Written per NPC before the gate runs. Guarded by `if (memoryManager)`:

```typescript
if (memoryManager) {
  await memoryManager.add({
    npcId,
    sessionId,
    moduleId,
    type: "witness",
    content: `Day${gameDay} ${tickTime} [${sceneName}] - Saw ${otherNpcNames.join(", ")} here`,
    gameDay,
    gameTime: tickTime,
    location: sceneId,
    metadata: {
      sourceCharacterId: "__encounter__",
      sourceAction: "co-presence",
      impact: 2,
    },
  });
}
```

The gate LLM receives this memory via `memoryManager.getContext({ purpose: "reaction", ... })`. The pre-gate memory and the post-gate witness memory (existing code) are **both intentional** — they serve different roles:
- Pre-gate: factual observation ("saw A, B here")
- Post-gate: NPC's interpreted reaction (generated by the gate LLM's `witnessEntry`)

### Deduplication

- Only process scenes where 2+ NPCs are present
- Build a set of interacting NPC pairs from `tickActions` (not from PlanNode queue — data source changes from pre-execution queue to post-execution results). `CharacterAction` carries `targetCharacterId` for `character_interaction` type actions.
- Skip NPC pairs that already have a `character_interaction` in `tickActions`
- The encounter scan runs once per tick after execution

### What Gets Removed

- `scanUnplannedEncounters` call at step 3 (pre-execution PlanNode injection)
- PlanNode generation for encounters
- Encounter nodes going through `characterInteractionHandler` (no skill rolls)
- Hardcoded `actionType: "social" | "combat"`
- `updateRelationshipViaLLM` at encounter time

### What Stays

- The `|score| >= 60` threshold is **removed** — all co-present NPCs are noticed
- The impact gate LLM has relationship context and decides significance
- `revisePlans` generates real, meaningful interaction nodes if needed
- Relationship updates happen naturally when those real interactions execute

## Files Changed

| File | Change |
|------|--------|
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | Rewrite `scanUnplannedEncounters` (new signature, returns `CharacterAction[]`, writes witness memories); move call site from step 3 to between steps 5-6; merge returned events into `impactEvents` |
| No other files | The impact gate pipeline, `findAffectedCharacters`, handlers, and `revisePlans` are unchanged |

## Edge Cases

- **Solo NPC at scene**: No encounter generated (needs 2+)
- **NPC already interacting with another NPC this tick**: Their pair is skipped (dedup via `tickActions`)
- **Player at same scene**: Player is included in `findAffectedCharacters` output (impact=2), handled as `playerEvents` — existing behavior
- **Many NPCs at same scene**: One synthetic event per scene, all NPCs go through gate in parallel — O(N) gate calls, not O(N^2)
- **`memoryManager` undefined**: Witness memory writes are skipped; encounter events still generated and fed into gate pipeline (gate runs without pre-written memory context)
- **Encounter events are NOT in returned `tickActions`**: They don't appear in `SingleTickResult.actions` or narrative output. They only feed into `impactEvents` for the gate.
