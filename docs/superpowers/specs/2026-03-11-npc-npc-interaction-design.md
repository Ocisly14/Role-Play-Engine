# NPC-NPC Interaction Design (v2 — Simplified)

## Problem

The current system has three gaps in NPC-to-NPC interaction:

1. **One-sided memory** — When NPC A interacts with NPC B, only A gets a memory record. B has no recollection of the interaction.
2. **No proactive socializing** — NPCs lack relationship context during planning, so they never autonomously decide to seek out conversations.
3. **No information propagation** — There is no mechanism for NPCs to share information with each other, with personality-driven distortion as information passes between characters.

## Design

No new node types. All changes build on the existing `character_interaction` node.

### 1. Unified Information Transfer (Merge `clue` into `information`)

Currently `CharacterInteractionPayload` has three transfer types: `item`, `clue`, `information`. Clue transfer is fundamentally an information flow — the physical evidence (documents, photos, objects) should be transferred as `item`, while the knowledge content of a clue should flow as `information`.

#### Type Change

Merge `clue` into `information`. Remove `clue` as a transfer type:

```typescript
export interface CharacterInteractionPayload {
  transferType: "item" | "information";  // CHANGED: removed "clue"
  itemId?: string;
  informationContent?: string;
  targetCharacterIds?: string[];         // NEW: for multi-target information delivery
  relatedClueIds?: string[];             // NEW: clue IDs to formally transfer to recipients
}
```

When `transferType === "information"`:
- `informationContent` (required for memory write) contains what the NPC wants to communicate (written by the planning LLM from the NPC's personality/perspective — distortion is implicit)
- `targetCharacterIds` lists all recipients. When present, it is authoritative — `node.targetCharacterId` is ignored for memory distribution. Falls back to `[node.targetCharacterId]` only if `targetCharacterIds` is absent.
- Self-targeting (sender ID in `targetCharacterIds`) is filtered out before processing.
- `relatedClueIds` (optional): when present, these clue IDs are formally transferred to each recipient via `dgsm.transferClue()`, same as the current `clue` transfer path. This makes the recipient "officially know" the clue (added to their clues list), not just have a memory of hearing about it.

#### Handler Change

In `characterInteractionHandler.ts`:

1. Remove the existing `clue` branch (`payload.transferType === "clue"`)
2. Replace the `information` no-op with clue transfer logic:

```
if (payload.transferType === "information") {
  const targets = payload.targetCharacterIds ??
    (node.targetCharacterId ? [node.targetCharacterId] : []);

  // Formal clue transfer (if any clue IDs specified)
  if (payload.relatedClueIds?.length) {
    for (const clueId of payload.relatedClueIds) {
      for (const targetId of targets) {
        dgsm.transferClue(node.characterId, targetId, clueId);
      }
    }
  }

  // Memory writing happens in tickProcessor post-execution, not here.
}
```

The handler handles mechanical state changes (clue ID transfer to recipient profiles). Memory writing happens in tickProcessor post-execution.

**Partial delivery**: If some targets are absent from the location, the node still succeeds — memory is written for present targets only. The outcome text notes which targets were unreachable. This mirrors real life: you tell a group something, but whoever isn't there doesn't hear it.

**Bidirectional sharing**: If A plans to tell B something and B plans to tell A something in the same tick, both nodes execute independently. These are not duplicates — they represent different information flowing in different directions.

#### Memory Write (in tickProcessor)

On successful `information` transfer, for each target NPC:

```
// Receiver gets a conversation memory
await memoryManager.add({
  npcId: targetId,
  type: "conversation",
  content: `${senderName} told me: ${informationContent}`,
  metadata: {
    withCharacterId: node.characterId,
    withCharacterName: senderName,
  },
});

// If clue IDs were transferred, also write clue memories for each
for (const clueId of relatedClueIds) {
  await memoryManager.add({
    npcId: targetId,
    type: "clue",
    content: `Learned from ${senderName}: ${clueText}`,
    metadata: { clueId, category: "knowledge", sourceCharacterId: node.characterId, sourceCharacterName: senderName },
  });
}
```

The sender also gets an event memory:

```
await memoryManager.add({
  npcId: node.characterId,
  type: "event",
  content: `Shared information with ${targetNames}: ${informationContent}`,
  metadata: { outcome: action.outcome },
});
```

This replaces the existing clue-transfer memory write block in tickProcessor (lines 516-554), which is removed.

#### Information Distortion (Gossip)

Distortion happens at planning time, not execution time. When the planning LLM generates `informationContent`, it already runs through the NPC's personality and biases:

- NPC A (paranoid) recalls "Tom carried a box at midnight"
- Planning LLM generates: `informationContent: "Tom was secretly smuggling suspicious cargo at the dock"`

No additional LLM call needed at execution. The distortion is implicit in what the planning agent chose to write.

### 2. Bilateral Memory (Mirror Write)

For all NPC-to-NPC `character_interaction` nodes (not player-involved), the passive side now also receives memory on success. This includes nodes injected by `scanUnplannedEncounters`.

#### Why This Is Needed

Currently `dgsm.updateRelationship()` writes bidirectionally to the in-memory relationship graph (both sides get the score update). But the `relationship` type *memory record* (used for retrieval/reasoning) is only written for the initiating side (A). The passive side (B) gets a graph score change but no searchable memory entry. Mirror write fills this gap.

#### Mirror Write Rules

When NPC A performs a `character_interaction` on NPC B (both are NPCs, not players):

Guard: `!node.isPlayer && node.targetCharacterId !== state.playerCharacter?.id && action.status === "completed"`

- **A side**: Existing logic unchanged (already writes event + relationship memory)
- **B side**: New mirror write in tickProcessor post-execution, placed after the relationship update block (after ~line 461) and before the existing player conversation block (~line 487):
  - `conversation` memory: "A [action] me, result was [outcome]" with `withCharacterId` pointing to A
  - `relationship` memory (only if relationship was updated): uses the same `scoreDelta` and `newScore` from A's relationship update

Mirror write is a direct copy with perspective flip — no LLM call needed.

Player-involved interactions already have their own memory write path (tickProcessor lines 487-513) and are not affected.

### 3. Proactive Socializing via Planning

#### Prompt Injection

The scheduling context profile update (Section 4) adds `conversation` and `relationship` to the memory types retrieved by `memoryManager.getContext({ purpose: "scheduling" })`. This means the unified `memoryContext` string already passed to `buildDailySchedulePrompt` and `buildDetailedNodesPrompt` will now include recent social interactions and relationship changes.

Additionally, `formatRelationships()` (already called in `generateSingleNpcSchedule`) provides relationship scores and notes from `npcRelationshipGraph`. No changes needed to `formatRelationships()` — the combination of graph data + memory context gives the LLM enough social awareness.

With this context, the planning LLM can naturally generate `character_interaction` nodes with `transferType: "information"` to share what it knows — driven entirely by personality and memory.

#### Planning Prompt Addition

Update the `character_interaction` documentation in the detailed nodes prompt to explain multi-target information transfer:

```
- **"character_interaction"**: Interact with a specific character. Requires targetCharacterId.
  - For sharing information or clues with one or more characters, set:
    characterInteractionPayload: {
      transferType: "information",
      informationContent: "what you want to tell them",
      targetCharacterIds: ["npc_id_1", "npc_id_2"],  // optional, for multiple recipients
      relatedClueIds: ["clue_id"]                     // optional, formally transfers these clues
    }
  - The informationContent should reflect YOUR perspective — what you believe and how you'd say it.
  - Use relatedClueIds when you want to formally share a specific clue you possess.
```

#### Scheduling Prompt

Add a social interaction hint in `buildDailySchedulePrompt`:

```
## Social Interactions
If you want to share information with or talk to another character,
plan a visit to their location. The detailed planning step will
handle the specifics of what you say.
```

### 4. Scheduling Context Enhancement

Add `conversation` and `relationship` to the `scheduling` context profile so NPCs have social context when planning their day:

```typescript
scheduling: {
  defaultTypes: ["plan", "event", "clue", "belief", "summary", "conversation", "relationship"],
  defaultLimit: 20,
},
```

## Files to Modify

### No New Files

### Modified Files
- `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts` — Remove `"clue"` from `transferType` union; add `targetCharacterIds?: string[]` and `relatedClueIds?: string[]` to `CharacterInteractionPayload`; remove `clueId?: string`
- `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts` — Remove `clue` branch; add multi-target clue transfer in `information` branch
- `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` — Replace clue-transfer memory block (lines 516-554) with unified information transfer memory writes; add mirror write for passive NPC in all `character_interaction` completions
- `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts` — Update `character_interaction` docs with unified information transfer format; add social interaction hint to daily schedule prompt
- `src/dynamicworldagent/memory/types.ts` — Add `conversation` and `relationship` to scheduling context profile; increase limit to 20
