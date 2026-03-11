# NPC-NPC Interaction Design (v2 — Simplified)

## Problem

The current system has three gaps in NPC-to-NPC interaction:

1. **One-sided memory** — When NPC A interacts with NPC B, only A gets a memory record. B has no recollection of the interaction.
2. **No proactive socializing** — NPCs lack relationship context during planning, so they never autonomously decide to seek out conversations.
3. **No information propagation** — There is no mechanism for NPCs to share information with each other, with personality-driven distortion as information passes between characters.

## Design

No new node types. All changes build on the existing `character_interaction` node and its `information` transfer type.

### 1. Multi-Target Information Transfer

Currently `CharacterInteractionPayload` supports `transferType: "information"` with `informationContent?: string`, but the handler does nothing with it (line 150: "no mechanical side effect").

#### Type Extension

Add `targetCharacterIds` to the payload for multi-target information delivery:

```typescript
export interface CharacterInteractionPayload {
  transferType: "item" | "clue" | "information";
  itemId?: string;
  clueId?: string;
  informationContent?: string;
  targetCharacterIds?: string[];  // NEW: for information transfer to multiple recipients
}
```

When `transferType === "information"`:
- `informationContent` contains what the NPC wants to communicate (written by the planning LLM from the NPC's personality/perspective — distortion is implicit)
- `targetCharacterIds` lists all recipients. Falls back to `[node.targetCharacterId]` if not provided.

#### Handler Change

In `characterInteractionHandler.ts`, the `information` branch (currently a no-op comment) becomes:

```
if (payload.transferType === "information" && payload.informationContent) {
  const targets = payload.targetCharacterIds ??
    (node.targetCharacterId ? [node.targetCharacterId] : []);
  // Memory writing happens in tickProcessor post-execution, not here.
  // Handler just validates targets are present.
}
```

The handler itself stays focused on mechanical resolution (location check, skill roll, success/failure). Memory writing for information transfer happens in tickProcessor post-execution, same as existing clue transfer memory writes.

#### Memory Write (in tickProcessor)

On successful `information` transfer, for each target NPC:

```
await memoryManager.add({
  npcId: targetId,
  type: "conversation",
  content: `${senderName} told me: ${informationContent}`,
  metadata: {
    withCharacterId: node.characterId,
    withCharacterName: senderName,
  },
});
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

#### Information Distortion (Gossip)

Distortion happens at planning time, not execution time. When the planning LLM generates `informationContent`, it already runs through the NPC's personality and biases:

- NPC A (paranoid) recalls "Tom carried a box at midnight"
- Planning LLM generates: `informationContent: "Tom was secretly smuggling suspicious cargo at the dock"`

No additional LLM call needed at execution. The distortion is implicit in what the planning agent chose to write.

### 2. Bilateral Memory (Mirror Write)

For all NPC-to-NPC `character_interaction` nodes (not player-involved), the passive side now also receives memory on success.

#### Mirror Write Rules

When NPC A performs a `character_interaction` on NPC B (both are NPCs, not players):

- **A side**: Existing logic unchanged (already writes event + relationship memory)
- **B side**: New mirror write in tickProcessor post-execution:
  - `conversation` memory: "A [action] me, result was [outcome]" with `withCharacterId` pointing to A
  - `relationship` memory: same `scoreDelta` as A's record

Mirror write is a direct copy with perspective flip — no LLM call needed.

Player-involved interactions already have their own memory write path (tickProcessor lines 487-513) and are not affected.

### 3. Proactive Socializing via Planning

#### Prompt Injection

Inject into `generateDailySchedule()` and `generateDetailedNodes()` prompts:

1. **Relationship summary** — From `npcRelationshipGraph`: each related NPC's name, score, and most recent relationship memory summary
2. **Recent social memories** — Last 5 `conversation` type memories for this NPC

With this context, the planning LLM can naturally generate `character_interaction` nodes with `transferType: "information"` to share what it knows — driven entirely by personality and memory.

#### Planning Prompt Addition

Update the `character_interaction` documentation in the detailed nodes prompt to explain multi-target information transfer:

```
- **"character_interaction"**: Interact with a specific character. Requires targetCharacterId.
  - For sharing information with one or more characters, set:
    characterInteractionPayload: {
      transferType: "information",
      informationContent: "what you want to tell them",
      targetCharacterIds: ["npc_id_1", "npc_id_2"]  // optional, for multiple recipients
    }
  - The informationContent should reflect YOUR perspective — what you believe and how you'd say it.
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
- `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts` — Add `targetCharacterIds?: string[]` to `CharacterInteractionPayload`
- `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts` — Validate multi-target presence for information transfers
- `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` — Add information transfer memory writes; add mirror write for passive NPC in all `character_interaction` completions
- `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts` — Update `character_interaction` docs with information transfer format; add social interaction hint to daily schedule prompt
- `src/dynamicworldagent/memory/types.ts` — Add `conversation` and `relationship` to scheduling context profile; increase limit to 20
