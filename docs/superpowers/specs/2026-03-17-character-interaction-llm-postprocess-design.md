# Character Interaction LLM Post-Processing

## Problem

The current `character_interaction` post-processing in `tickProcessor.ts` is mechanical: string template concatenation for outcomes/memories, hardcoded item transfer logic in the handler, and embedding-based semantic matching for discovery. This produces formulaic, low-quality narrative output that doesn't leverage the rich context available (NPC personalities, relationships, scene atmosphere).

## Solution

Replace the entire `character_interaction` post-processing pipeline with a single LLM call. Extend the `NodeHandler` interface with an optional async `postProcess` method. The `characterInteractionHandler` implements this method to:

1. Gather rich context (both NPCs' profiles, stats, memories, relationship, scene, discovery candidates)
2. Call LLM with a structured prompt
3. Return a `PostProcessResult` that the tickProcessor applies generically

## Design

### 1. NodeHandler Interface Extension

**File:** `src/dynamicworldagent/engine/types.ts`

Add to `NodeHandler`:

```typescript
postProcess?(ctx: PostProcessContext): Promise<PostProcessResult>;
```

New types:

```typescript
interface PostProcessContext {
  node: PlanNode;
  action: CharacterAction;           // handler's base result (with successLevel)
  dgsm: DynamicGameStateManager;
  memoryManager?: NpcMemoryManager;
  sessionId: string;
  moduleId: string;
  gameDay: number;
  language: string;
  runtime: any;                       // for generateText
  modelClass?: ModelClass;            // ModelClass.SMALL or ModelClass.MEDIUM, default MEDIUM
}

interface PostProcessResult {
  // Narrative outcome (overwrites action.outcome)
  outcome: string;

  // Relationship change (absorbs the existing updateRelationshipViaLLM call —
  // the single postProcess LLM call now produces scoreDelta + note directly)
  relationshipChange?: {
    scoreDelta: number;
    note: string;
  };

  // Event memories
  initiatorMemory: string;
  targetMemory?: string;

  // Item transfers (replaces hardcoded logic in execute)
  itemTransfers?: Array<{
    itemId: string;
    fromNpcId: string;
    toNpcId: string;
  }>;

  // Knowledge transfers (applyPostProcessResult validates co-location before writing)
  knowledgeTransfers?: Array<{
    targetNpcId: string;
    content: string;
    sourceKnowledgeId?: string;
  }>;

  // Discovery — LLM selects from candidate list by ID
  // (applyPostProcessResult validates IDs exist in candidate set before processing)
  discoveredIds?: string[];

  // Additional side effects
  sideEffects?: {
    itemChanges?: Array<{
      itemId: string;
      updates: Partial<Item>;
    }>;
    sceneConditions?: Array<{
      sceneId: string;
      condition: { description: string; mechanicalEffect?: MechanicalEffect };
    }>;
    damagedEvidenceId?: string;
  };
}
```

### 2. characterInteractionHandler Changes

**File:** `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts`

`execute()` is simplified to pure pre-checks only:
1. Location check → fail with `location_mismatch`
2. Target presence check → fail with `target_absent`
3. Skill roll (if skill present) → fail with `skill_roll_failed`
4. Return base `CharacterAction` with `successLevel` — **no state mutations** (no item transfer)

New `postProcess()` method:
- Gathers context (NPCs, relationship, scene, memories, discovery candidates)
- Builds prompt via `buildCharacterInteractionPrompt()`
- Calls `generateText()` with configurable model class (default MEDIUM)
- Parses JSON response into `PostProcessResult`
- On LLM failure (network error, malformed JSON): falls back to a minimal `PostProcessResult` with a generic outcome derived from the action description + successLevel, no relationship change, no discoveries (graceful degradation, tick loop is not blocked)

### 3. Prompt Template

**File:** `src/dynamicworldagent/engine/handlers/characterInteractionPrompt.ts` (new)

Prompt input context:
- **Initiator:** NPC profile (personality, background, goals), current HP/SAN, inventory, last 5 event memories
- **Target(s):** Same as above — only NPCs actually present at the same location are included
- **Relationship:** score + note between initiator and each target
- **Scene:** name, description, items (with evidence markers), conditions
- **Action:** node.action, payload (transferType, itemId, informationContent)
- **Dice result:** skill, difficulty, successLevel
- **Discovery candidates:** Scene items where `category === "evidence"` (with IDs) + target NPC's knowledge/secrets (with IDs, difficulty ratings)

Prompt constraints:
- Success level gates discovery difficulty ceiling: critical→extreme, hard→hard, regular→regular, fail→automatic only, fumble→nothing + may damage evidence
- Output must conform to `PostProcessResult` JSON schema
- Language parameter controls output language

### 4. tickProcessor Changes

**File:** `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

The node execution loop transforms from:

```
handler.execute(node) → action
if (character_interaction && completed) { relationship update via LLM }
if (character_interaction && completed) { mirror memory }
if (character_interaction && completed) { mark completed + log }
if (character_interaction && information) { knowledge transfer }
if (completed) { discovery }
if (fumble) { damage evidence }
```

To:

```
handler.execute(node) → action
if (handler.postProcess) {
  if (action.status === "completed") {
    result = await handler.postProcess({ node, action, dgsm, ... })
    applyPostProcessResult(result, ...)
    markNodeCompleted(...)
  } else if (action.successLevel === "fumble") {
    // Fumble: still invoke postProcess for damage decision
    result = await handler.postProcess({ node, action, dgsm, ... })
    applyPostProcessResult(result, ...)  // only sideEffects.damagedEvidenceId applies
  }
  // failed (non-fumble) → revisePlans (unchanged)
} else {
  // existing hardcoded post-processing (backward compatible for other handlers)
}
```

**`applyPostProcessResult()`** — generic function that executes state writes in order:
1. Overwrite `action.outcome` with `result.outcome`
2. Execute `itemTransfers` (dgsm.removeItemFromNpc + dgsm.addItemToNpc)
3. Update relationship (dgsm.updateRelationship — direct write, no separate LLM call)
4. Write `initiatorMemory` via memoryManager.add (type: "event")
5. Write `targetMemory` via memoryManager.add (type: "event")
6. Write `knowledgeTransfers` via memoryManager.add (type: "information") — **validates co-location** via `arePositionsCoLocated()` before each write
7. Process `discoveredIds` → **validate IDs exist** in candidate set → set action.discoveries → `embedDiscoveries()` → `markMemoryRevealed()`
8. Apply `sideEffects`: itemChanges, sceneConditions, damagedEvidence
9. Call `npcPlanningAgent.markNodeCompleted()` to finalize the node

**Failed actions** (non-fumble) do not go through postProcess — they go straight to the existing revisePlans logic.

**Fumble actions** invoke postProcess to allow LLM to decide which evidence to damage (via `sideEffects.damagedEvidenceId`). The prompt includes fumble context so the LLM can make a narratively appropriate damage choice.

**Other handler types** (movement, routine, object_interaction, scene_interaction) are unaffected — they have no `postProcess` and follow the existing path. Note: the existing discovery block (`discoverEvidence` + `discoverNpcKnowledge`) continues to run for non-postProcess handlers. For `character_interaction` with postProcess, the existing discovery block is skipped since discovery is handled by the LLM.

### 5. Backward Compatibility

- `NPCPlanningAgent.updateRelationshipViaLLM` is preserved (other callers like encounter logic may use it). For character_interaction, the relationship delta is now produced by the single postProcess LLM call, eliminating the separate relationship LLM call.
- `discoverEvidence()` and `discoverNpcKnowledge()` functions preserved (other handler types still use them via the existing discovery block)
- All other handlers unchanged
- tickProcessor falls back to existing logic when `handler.postProcess` is undefined

### 6. Model Configuration

The `PostProcessContext.modelClass` field allows per-call model selection:
- Default: `ModelClass.MEDIUM` (richer output quality)
- Can be set to `ModelClass.SMALL` for speed/cost optimization
- Configurable by the caller (tickProcessor passes through)

## File Changes Summary

| File | Change |
|---|---|
| `engine/types.ts` | Add `postProcess` to `NodeHandler`; add `PostProcessResult`, `PostProcessContext` types |
| `engine/handlers/characterInteractionHandler.ts` | Simplify `execute` (remove item transfer); add `postProcess` implementation with LLM fallback |
| `engine/handlers/characterInteractionPrompt.ts` | **New** — prompt template builder |
| `npcPlanning/tickProcessor.ts` | Add postProcess detection + `applyPostProcessResult` (with `markNodeCompleted`, `embedDiscoveries`, co-location validation, candidate ID validation); remove character_interaction hardcoded post-processing (~150 lines); keep discovery/fumble blocks for non-postProcess handlers |
| `engine/handlers/__tests__/characterInteractionHandler.test.ts` | Update tests for new postProcess flow |
