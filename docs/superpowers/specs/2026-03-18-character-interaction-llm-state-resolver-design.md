# Character Interaction LLM State Resolver

**Date:** 2026-03-18
**Status:** Draft
**Scope:** `character_interaction` handler only

## Summary

Replace the hardcoded item transfer and knowledge transfer logic in the `character_interaction` handler and tickProcessor post-execution with an LLM-based state resolver. The LLM receives full data for both the acting and target NPCs, the executed node, skill roll result, and scene context, then outputs a structured JSON delta describing all state changes for both characters — including HP/SAN, items, position, conditions, appearance, event memory, and knowledge gained.

## Motivation

The current `character_interaction` handler only supports two rigid operations via `CharacterInteractionPayload.transferType`:
- `"item"` — move one item from actor to target
- `"information"` — write knowledge memory to target (handled in tickProcessor post-execution)

This cannot express richer interactions that are natural in Call of Cthulhu scenarios:
- Leading or escorting an NPC to another location
- Forcing/driving an NPC away
- Physical altercations (HP changes for both sides)
- Intimidation causing SAN loss
- Searching/disarming someone (removing their items)
- Appearance changes from interaction (torn clothing, visible injuries)

An LLM resolver makes character_interaction a general-purpose handler for any NPC-to-NPC interaction, with the LLM reasoning about realistic state consequences.

## Design

### New Types

```typescript
// In types.ts

export interface CharacterStateDelta {
  hpDelta?: number;              // +/- HP change
  sanDelta?: number;             // +/- SAN change
  moveTo?: string;               // target location ID (validated by code)
  addItems?: string[];           // item IDs gained (from counterpart or scene)
  removeItems?: string[];        // item IDs lost
  addConditions?: string[];      // status conditions to add
  removeConditions?: string[];   // status conditions to remove
  appearanceChange?: string;     // new appearance description (replaces current)
  memory: string;                // event memory from this character's perspective
  knowledgeGained?: string[];    // information learned (written as type: "information" memories)
}

export interface InteractionStateDelta {
  actorChanges: CharacterStateDelta;
  targetChanges: Record<string, CharacterStateDelta>;  // targetCharacterId -> delta
}
```

Note: `targetChanges` is keyed by character ID to support multi-target interactions (e.g. announcing to a group). For single-target interactions, it contains one entry keyed by `node.targetCharacterId`.

### CharacterAction Extension

```typescript
// In types.ts — add optional field to existing CharacterAction interface
// Existing CharacterAction fields (characterId, characterName, gameTime, action,
// location, type, skill, impact, difficulty, successLevel, status, outcome,
// failureReason, interruptionReason, targetCharacterId, discoveries, damagedEvidence)
// remain unchanged. Add:

stateMemories?: Record<string, string>;  // characterId -> memory text
```

When `stateMemories` is present on a CharacterAction, tickProcessor uses these instead of auto-generating event memories.

### CharacterInteractionPayload Simplification

```typescript
// In types.ts — replace existing CharacterInteractionPayload
export interface CharacterInteractionPayload {
  targetCharacterIds?: string[];  // for multi-target interactions
}
```

Removed fields: `transferType`, `itemId`, `informationContent`, `relatedKnowledgeIds`. All state changes are now determined by the LLM resolver.

### NodeHandler Interface Change

```typescript
// In engine/types.ts — line 15-19, change return type
execute(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  ctx: ExecutionContext
): CharacterAction | Promise<CharacterAction>;  // allow async
```

All existing sync handlers (routine, movement, object_interaction, scene_interaction) are unaffected — sync return values are compatible with `await`.

### Handler Flow

```
characterInteractionHandler.execute(node, dgsm, ctx): Promise<CharacterAction>

  1. Location check (isCharacterAtLocation)         -> fail: location_mismatch
  2. Target presence check (arePositionsCoLocated)   -> fail: target_absent
  3. Skill roll (if node.skill, difficulty != luck_only) -> fail: skill_roll_failed
  4. Resolve target list:
     - targets = node.characterInteractionPayload?.targetCharacterIds
                 ?? (node.targetCharacterId ? [node.targetCharacterId] : [])
  5. Call resolveInteractionState() — LLM state resolver
     Input: actor + all targets full data + node + skill result + scene + relationships
     Output: InteractionStateDelta
  6. applyCharacterDelta(dgsm, actorId, actorChanges, targets)
  7. For each targetId in targetChanges:
       applyCharacterDelta(dgsm, targetId, targetChanges[targetId], actorId)
     - moveTo: validate topology -> reachable: setCharacterPosition
                                 -> blocked: write blocked memory (equivalent to impact)
     - addItems/removeItems: transfer between inventories + scene items
     - hpDelta/sanDelta: updateNpcHp / updateNpcSan
     - conditions: mutate npcCharacters[].status.conditions directly
     - appearanceChange: mutate npcCharacters[].appearance directly
     - knowledgeGained: write type "information" memories via memoryManager
  8. Return CharacterAction with:
     - outcome = actorChanges.memory
     - stateMemories = { actorId: actorChanges.memory, ...targetId: targetChanges[targetId].memory }
```

### LLM State Resolver

**New file:** `engine/handlers/interactionStateResolver.ts`

**Function:** `resolveInteractionState(node, dgsm, skillRollResult, language): Promise<InteractionStateDelta>`

**Model:** MEDIUM (same as generateDetailedNodes — needs rich reasoning)

**LLM failure fallback:** If the LLM call fails (network error, malformed JSON, rate limit), return a minimal delta with empty changes and a generic memory string. The handler returns a "completed" CharacterAction with no state mutations — the interaction "happened" narratively but had no mechanical effect. This prevents a single LLM failure from crashing the tick.

**System prompt:**
```
You are a Call of Cthulhu 7th Edition game state resolver.
Given a character interaction that has already been determined to succeed/fail,
determine the concrete state changes for both characters.

Rules:
- Only output changes that logically follow from the action and its result.
- HP/SAN changes must be proportional to CoC 7e mechanics.
- moveTo must be a location ID from the provided scene context.
- Items can only transfer between the two characters or from scene items.
  addItems/removeItems use item IDs.
- memory is written from that character's first-person perspective, in {language}.
- knowledgeGained contains specific facts or information learned, in {language}.
- If no change is needed for a field, omit it.
- Do not invent items or locations that don't exist in the provided data.

Output strict JSON matching the schema. No extra text.
```

**User prompt injects:**
- Action node (full JSON)
- Skill roll result (successLevel + detail, or "auto success")
- Actor full data: profile summary, stats (from `npcStats` — authoritative runtime source), inventory, position, conditions
- Target(s) full data: profile summary, stats, inventory, position, conditions
- Relationship(s): score + note (per target)
- Current scene: description, conditions, items, connected locations
- Output schema (InteractionStateDelta)

**Language:** memory and knowledgeGained in module language; system prompt in English.

### applyCharacterDelta

**Function:** `applyCharacterDelta(dgsm, characterId, delta, counterpartId, memoryManager?, sessionId?, moduleId?, gameDay?, gameTime?): Promise<{ blocked?: boolean }>`

**HP/SAN:** Uses `dgsm.updateNpcHp()` / `dgsm.updateNpcSan()` which update `DynamicGameState.npcStats`. This is the authoritative runtime source for HP/SAN. `DynamicNPCProfile.status.hp/sanity` is the initial template value and is NOT updated at runtime.

**Conditions and appearance:** Updated by directly mutating the `DynamicNPCProfile` entry in `dgsm.getState().npcCharacters[]`:
- `npc.status.conditions` — Set-based add/remove
- `npc.appearance` — Direct string replacement

No new DGSM methods are needed — `applyCharacterDelta` finds the NPC in `state.npcCharacters` and mutates in place (same pattern as existing `DynamicGameStateManager.applyActionUpdate()`).

**Item transfer priority:**
1. Counterpart inventory -> character inventory (trade, theft)
2. Scene items -> character inventory (pickup)
3. Not found -> silently skip (guard against LLM hallucination)

**Position validation:**
1. `resolveTargetPosition(delta.moveTo, topology, dgsm)` to get CharacterPosition (imported from movementHandler.ts)
2. `findTopologyPath(currentPos, targetPos, topology, blockedConnections)` to verify reachability (imported from shared/pathfinding)
3. Reachable: `setCharacterPosition(characterId, targetPos)`
4. Blocked: write blocked event memory, do not change position. The NPC will be affected via next impact propagation cycle.

**Knowledge gained:**
- Each string in `knowledgeGained` is written as an `NpcMemory` with `type: "information"` via memoryManager.

### tickProcessor Changes

**Handler invocation (line ~1193):**
```typescript
// Before:
const action = handler.execute(node, dgsm, ctx);
// After:
const action = await handler.execute(node, dgsm, ctx);
```

**character_interaction post-execution — removed logic:**
- Hardcoded item transfer (`payload.transferType === "item"`)
- Knowledge transfer (`payload.transferType === "information"` + `informationContent`)
- Auto-generated actor event memory
- Auto-generated mirror memory for target
- `getItemActionContext()` character_interaction branch (lines 107-118) — remove, since `transferType`/`itemId` no longer exist on payload

**character_interaction post-execution — modified logic:**
- Memory writes: if `action.stateMemories` exists, write those directly (keyed by characterId) instead of auto-generating. Other handlers without `stateMemories` use existing auto-generation unchanged.

**character_interaction post-execution — preserved logic:**
- `updateRelationshipViaLLM()` — relationship scoring
- Discovery system (evidence + NPC knowledge discovery). Note: discovery runs AFTER the handler returns. If the handler moved the target away, `discoverNpcKnowledge()` will find the target absent — this is correct behavior (you can't discover someone's secrets after driving them away).
- Impact propagation

### nodeHelpers.ts Changes

`buildOutcome()` (line 20-28) has a `character_interaction` branch that reads `transferType`, `itemId`, and `informationContent` from the payload. After the payload simplification, this branch must be removed. For character_interaction nodes, `buildOutcome()` is only used on failure paths (the success path uses `actorChanges.memory` as outcome instead).

Update: remove the `character_interaction` payload branch from `buildOutcome()`. The failure-path calls to `buildOutcome()` (location_mismatch, target_absent, skill_roll_failed) still work — they use `opts.reason` or `opts.rollDetail`, not the payload.

### Handler Description + Example Node Update

```typescript
description:
  "Interact with another character (NPC or player). " +
  "Supports any form of interaction: conversation, item exchange, " +
  "persuasion, intimidation, physical contact, leading/escorting, " +
  "or forcing someone to leave. " +
  "An LLM resolver determines all state changes (HP, SAN, items, " +
  "position, conditions, appearance) for both characters based on " +
  "the action description and skill roll result.",

exampleNode: {
  nodeId: "ci1",
  startTime: "10:00",
  endTime: "10:05",
  type: "character_interaction",
  action: "Convince Dr. Morgan to follow me to the library",
  location: "hospital_lobby",
  targetCharacterId: "npc_dr_morgan",
  impact: 2,
  skill: "Persuade",
},
```

### npcPlanningTemplates.ts Update

Character interaction description in DEFAULT_DETAILED_NODE_TYPE_REF:
```
- **"character_interaction"**: Interact with a specific character. Requires targetCharacterId.
  Use for: conversation, persuasion, intimidation, item exchange, physical interaction,
  leading/escorting someone, or forcing someone to leave.
  The engine resolves all state changes (items, position, HP, SAN, conditions)
  automatically based on your action description and skill roll.
```

Remove the old `characterInteractionPayload` documentation (transferType, informationContent, etc.) from the prompt template.

## File Changes

| File | Change |
|------|--------|
| `engine/types.ts` | `execute` returns `CharacterAction \| Promise<CharacterAction>` |
| `dynamicBasicAgent/npcPlanning/types.ts` | Add `CharacterStateDelta`, `InteractionStateDelta`; add `stateMemories?` to `CharacterAction`; simplify `CharacterInteractionPayload` to only `targetCharacterIds?` |
| `engine/handlers/characterInteractionHandler.ts` | Rewrite execute as async; call LLM resolver + applyCharacterDelta |
| **New:** `engine/handlers/interactionStateResolver.ts` | LLM prompt template, `resolveInteractionState()`, `applyCharacterDelta()` |
| `dynamicBasicAgent/npcPlanning/tickProcessor.ts` | `await` handler execute; remove hardcoded item/knowledge transfer and `getItemActionContext()` character_interaction branch; read `stateMemories` for memory writes |
| `dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts` | Update character_interaction description; remove old payload documentation |
| `engine/shared/nodeHelpers.ts` | Remove `character_interaction` payload branch from `buildOutcome()` |

## Non-Goals

- Other handler types (routine, movement, object_interaction, scene_interaction) are unchanged.
- Impact propagation to bystander NPCs uses existing mechanism unchanged.
- Game time is not affected by this resolver (managed by TickProcessor bucket system).
- Relationship scoring remains a separate `updateRelationshipViaLLM()` call in post-execution.
- `DynamicNPCProfile.status.hp/sanity` is not synced — `npcStats` is the sole runtime authority for HP/SAN.
