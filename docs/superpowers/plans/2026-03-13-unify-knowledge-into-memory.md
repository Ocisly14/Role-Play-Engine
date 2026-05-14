# Unify NPC Knowledge & Secrets into Memory System

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `knowledge[]` and `secrets[]` from NPC profiles and `DynamicGameState`, so all NPC knowledge lives in the `NpcMemory` system. NPC JSON files will be updated separately by the user — no bootstrap function needed.

**Architecture:** Delete `bootstrapSecrets`. Remove `knowledge`/`secrets` from `DynamicNPCProfile` type. Remove `npcDiscoveredKnowledge` from GameState. Rewrite `discoverNpcKnowledge()` to query target NPC's memories. Knowledge transfer writes `information` memory. Day-end summary writes new knowledge as memory instead of profile mutation.

**Tech Stack:** TypeScript, Prisma, NpcMemory system

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Delete | `src/dynamicworldagent/memory/bootstrapSecrets.ts` | No longer needed — user seeds data via JSON |
| Modify | `src/dynamicworldagent/memory/types.ts` | Add `revealed` to `InformationMetadata` and `SecretMetadata` |
| Modify | `src/dynamicworldagent/memory/handlers/SecretHandler.ts` | Add `difficulty` tag for discovery filtering |
| Modify | `src/dynamicworldagent/state/types.ts` | Remove `knowledge` and `secrets` from `DynamicNPCProfile` |
| Modify | `src/dynamicworldagent/state/DynamicGameState.ts` | Remove `npcDiscoveredKnowledge`, `transferKnowledge()`, `addNpcKnowledge()`, `markNpcKnowledgeRevealed()` |
| Modify | `src/dynamicworldagent/state/DynamicGameStateLoader.ts` | Remove bootstrap call, remove `npcDiscoveredKnowledge` init, remove knowledge mapping |
| Modify | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | Rewrite `discoverNpcKnowledge()` to query memory; update knowledge transfer writes |
| Modify | `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts` | Remove `dgsm.transferKnowledge()` call |
| Modify | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts` | Rewrite `summarizeDayMemory()` to write memory instead of mutating profile |
| Modify | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts` | Simplify day summary prompt; remove `relatedKnowledgeIds` from node prompt |
| Modify | `src/dynamicworldagent/simulation/characterInjection.ts` | Remove `npcDiscoveredKnowledge` references |

---

## Chunk 1: Type Changes & Cleanup

### Task 1: Extend memory metadata types

**Files:**
- Modify: `src/dynamicworldagent/memory/types.ts:22-61`

- [ ] **Step 1: Add `revealed` and `difficulty` to `InformationMetadata` and `SecretMetadata`**

```typescript
export interface InformationMetadata {
  knowledgeId: string;
  category: "knowledge" | "observation" | "rumor" | "secret";
  difficulty?: string;
  relatedTo?: string[];
  revealed?: boolean;    // NEW
}

export interface SecretMetadata {
  knownBy?: string[];
  revealCondition?: string;
  difficulty?: string;   // NEW
  revealed?: boolean;    // NEW
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/memory/types.ts
git commit -m "feat(memory): add revealed and difficulty fields to InformationMetadata and SecretMetadata"
```

### Task 2: Update SecretHandler to tag difficulty

**Files:**
- Modify: `src/dynamicworldagent/memory/handlers/SecretHandler.ts`

- [ ] **Step 1: Add difficulty to tags in prepare()**

```typescript
prepare(
  _content: string,
  metadata?: Record<string, any>,
  location?: string
): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
  const tags: string[] = ["secret"];
  if (location) tags.push(location);
  const difficulty = (metadata?.difficulty as string) ?? "hard";
  tags.push(`difficulty:${difficulty}`);
  const knowledgeId = metadata?.knowledgeId as string | undefined;
  if (knowledgeId) tags.push(knowledgeId);
  return {
    tags,
    baseImportance: 3.0,
    metadata: metadata ?? {},
  };
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/memory/handlers/SecretHandler.ts
git commit -m "feat(memory): add difficulty tag to SecretHandler"
```

### Task 3: Remove `knowledge` and `secrets` from DynamicNPCProfile + delete bootstrapSecrets

**Files:**
- Modify: `src/dynamicworldagent/state/types.ts:173-198`
- Modify: `src/dynamicworldagent/state/DynamicGameStateLoader.ts:398-419,493-496,567-590`
- Delete: `src/dynamicworldagent/memory/bootstrapSecrets.ts`

- [ ] **Step 1: Remove fields from DynamicNPCProfile interface**

In `types.ts`, remove `secrets` and `knowledge` from the interface. Keep `NPCKnowledge` interface definition (may be useful as a shared type):

```typescript
export interface DynamicNPCProfile {
  id: string;
  name: string;
  attributes: CharacterAttributes;
  status: CharacterStatus;
  inventory: InventoryItem[];
  skills: Record<string, number>;

  occupation?: string;
  age?: number;
  gender?: string;
  appearance?: string;
  personality?: string;
  background?: string;
  backstory?: string;
  residence?: string;

  longTermIntent: string;
  relationships: NPCRelationship[];

  isPlayerInjected?: boolean;
}
```

- [ ] **Step 2: Remove knowledge mapping from DynamicGameStateLoader**

In `DynamicGameStateLoader.ts` lines 398-419, remove the `knowledge` mapping from the NPC loading:

```typescript
const npcCharacters: DynamicNPCProfile[] = allNPCs.map((npc: any) => {
  const normalizedId = normalizeIdToModuleScope(npc.id, scopedModuleId);
  return {
    ...npc,
    id: normalizedId,
    longTermIntent: npc.longTermIntent ?? npc.background ?? "",
    relationships: Array.isArray(npc.relationships)
      ? npc.relationships.map((rel: any) => ({
          ...rel,
          targetId: rel.targetId
            ? normalizeIdToModuleScope(rel.targetId, scopedModuleId)
            : rel.targetId,
        }))
      : [],
  } as DynamicNPCProfile;
});
```

- [ ] **Step 3: Delete bootstrapSecrets.ts and remove its call from DynamicGameStateLoader**

Delete: `src/dynamicworldagent/memory/bootstrapSecrets.ts`

In `DynamicGameStateLoader.ts`, remove the import and the entire bootstrap block (lines 567-590):

```typescript
// DELETE import:
import { bootstrapNpcSecrets } from "../memory/bootstrapSecrets.js";

// DELETE block (lines 567-590):
if (npcCharacters.length > 0 && scopedModuleId) {
  try {
    const embedClient = new EmbeddingClient(...);
    await bootstrapNpcSecrets({ ... });
  } catch (error) { ... }
}
```

- [ ] **Step 4: Remove npcDiscoveredKnowledge init from DynamicGameStateLoader**

Delete lines 493-496:
```typescript
if (!completeState.npcDiscoveredKnowledge[npc.id]) {
  completeState.npcDiscoveredKnowledge[npc.id] = [];
}
```

- [ ] **Step 5: Commit (WIP — broken build expected)**

```bash
git add -A
git commit -m "refactor(state): remove knowledge/secrets from DynamicNPCProfile, delete bootstrapSecrets (WIP)"
```

---

## Chunk 2: Remove GameState Knowledge Methods

### Task 4: Remove knowledge-related methods and state from DynamicGameState

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameState.ts:48,63,111,625-676`
- Modify: `src/dynamicworldagent/simulation/characterInjection.ts:83,105,126,146`

- [ ] **Step 1: Remove from DynamicGameState interface and defaults**

Remove from the `DynamicGameState` interface:
- `npcDiscoveredKnowledge: Record<string, string[]>`

Remove from `createEmptyDynamicGameState()`:
- `npcDiscoveredKnowledge: {}`

Remove from `fromSerializable()`:
- `npcDiscoveredKnowledge: data.npcDiscoveredKnowledge ?? {}`

- [ ] **Step 2: Remove methods from DynamicGameStateManager**

Delete entirely:
- `transferKnowledge()` (lines 625-636)
- `addNpcKnowledge()` (lines 660-669)
- `markNpcKnowledgeRevealed()` (lines 671-676)

Keep `addDiscoveredKnowledge()` — global discovery ledger, separate concern.

- [ ] **Step 3: Clean up characterInjection.ts**

Remove all `npcDiscoveredKnowledge` references:
- Line 83: remove from type cast
- Line 105: remove `state.npcDiscoveredKnowledge[profile.id] = [];`
- Line 126: remove from type cast
- Line 146: remove `delete state.npcDiscoveredKnowledge[characterId];`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(state): remove npcDiscoveredKnowledge, transferKnowledge, addNpcKnowledge, markNpcKnowledgeRevealed"
```

---

## Chunk 3: Rewrite Discovery & Transfer Logic

### Task 5: Remove knowledge transfer from characterInteractionHandler

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts:140-156`

- [ ] **Step 1: Remove the `transferKnowledge` branch**

Replace the `else if` for information transfer + relatedKnowledgeIds with a comment:

```typescript
if (payload.transferType === "item" && payload.itemId) {
  const item = dgsm.removeItemFromNpc(node.characterId, payload.itemId);
  if (!item) {
    return makeAction(
      node,
      "failed",
      buildOutcome(node, "failed", {
        reason: `item ${payload.itemId} not in inventory`,
      }),
      { difficulty, failureReason: "object_not_found" }
    );
  }
  dgsm.addItemToNpc(node.targetCharacterId, item);
}
// Information transfer memory writes handled by tickProcessor post-execution
```

- [ ] **Step 2: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts
git commit -m "refactor(handler): remove transferKnowledge from characterInteractionHandler"
```

### Task 6: Rewrite discoverNpcKnowledge in tickProcessor

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

- [ ] **Step 1: Rewrite discoverNpcKnowledge to query memory**

Replace the function (lines 152-221) with:

```typescript
async function discoverNpcKnowledge(
  node: PlanNode,
  successLevel: SuccessLevel,
  dgsm: DynamicGameStateManager,
  language: string,
  memoryManager: NpcMemoryManager
): Promise<DiscoveryEntry[]> {
  if (node.type !== "character_interaction" || !node.targetCharacterId)
    return [];

  let maxRank: number;
  if (node.actionType && DISCOVERY_ACTION_TYPES.has(node.actionType)) {
    maxRank = SUCCESS_TO_MAX_RANK[successLevel] ?? 0;
  } else {
    const rel = dgsm.getRelationship(node.characterId, node.targetCharacterId);
    const score = rel?.score ?? 0;
    if (score >= 80) maxRank = 3;
    else if (score >= 70) maxRank = 2;
    else if (score >= 60) maxRank = 1;
    else maxRank = 0;
  }

  const targetId = node.targetCharacterId;
  const state = dgsm.getState();
  const targetNpc = state.npcCharacters.find((n) => n.id === targetId);
  if (!targetNpc) return [];

  // Query target NPC's unrevealed information and secret memories
  const targetMemories = await memoryManager.query({
    npcId: targetId,
    sessionId: state.sessionId,
    query: node.action,
    filters: { types: ["information", "secret"] },
    limit: 50,
  });

  const candidates: DiscoveryCandidate[] = [];

  for (const mem of targetMemories) {
    const meta = mem.metadata as Record<string, any> | null;
    if (meta?.revealed) continue;

    const difficulty =
      (meta?.difficulty as string) ??
      (mem.type === "secret" ? "hard" : "regular");
    const rank = DIFFICULTY_RANK[difficulty] ?? 1;
    if (rank > maxRank) continue;

    candidates.push({
      id: (meta?.knowledgeId as string) ?? mem.id,
      text: mem.content,
      difficulty,
      source: "npc",
      sourceId: targetNpc.id,
      sourceName: targetNpc.name,
    });
  }

  return matchCandidates(candidates, node, language);
}
```

- [ ] **Step 2: Add markMemoryRevealed helper**

```typescript
async function markMemoryRevealed(
  memoryManager: NpcMemoryManager,
  targetNpcId: string,
  sessionId: string,
  knowledgeIdOrMemoryId: string
): Promise<void> {
  const candidates = await memoryManager.query({
    npcId: targetNpcId,
    sessionId,
    query: "",
    filters: { types: ["information", "secret"] },
    limit: 100,
  });
  for (const mem of candidates) {
    const meta = mem.metadata as Record<string, any> | null;
    const kid = (meta?.knowledgeId as string) ?? mem.id;
    if (kid === knowledgeIdOrMemoryId) {
      await memoryManager.updateBeliefConfidence(
        mem.id,
        meta?.confidence ?? 1,
        "revealed via discovery",
        { ...meta, revealed: true }
      );
      break;
    }
  }
}
```

- [ ] **Step 3: Update discovery call sites in executeSingleTick**

Replace `dgsm.markNpcKnowledgeRevealed` with `markMemoryRevealed`:

```typescript
if (entry.source === "npc" && memoryManager) {
  await markMemoryRevealed(memoryManager, entry.sourceId, sessionId, entry.id);
}
```

Update `discoverNpcKnowledge` call to pass `memoryManager`:

```typescript
const npcKnowledge = memoryManager
  ? await discoverNpcKnowledge(node, effectiveSuccess, dgsm, language, memoryManager)
  : [];
```

- [ ] **Step 4: Update knowledge transfer to write `information` memory**

Replace the knowledge transfer section (lines 540-604) — change receiver's memory type from `event` to `information`:

```typescript
if (
  memoryManager &&
  action.status === "completed" &&
  node.type === "character_interaction" &&
  node.characterInteractionPayload?.transferType === "information" &&
  node.characterInteractionPayload.informationContent
) {
  const payload = node.characterInteractionPayload;
  const informationContent = payload.informationContent!;
  const targets =
    payload.targetCharacterIds ??
    (node.targetCharacterId ? [node.targetCharacterId] : []);
  const filteredTargets = targets.filter((id) => id !== node.characterId);

  const senderChar = state.npcCharacters.find(
    (n) => n.id === node.characterId
  );
  const senderName = senderChar?.name ?? node.characterName;

  const presentTargets = filteredTargets.filter((id) => {
    const loc = dgsm.getNpcLocation(id);
    return loc === node.location;
  });

  for (const targetId of presentTargets) {
    await memoryManager.add({
      npcId: targetId,
      sessionId,
      moduleId,
      type: "information",
      content: `${senderName} told me: ${informationContent}`,
      gameDay,
      gameTime: action.gameTime,
      location: action.location,
      metadata: {
        knowledgeId: `transfer_${node.nodeId}_${targetId}`,
        category: "knowledge" as const,
        difficulty: "automatic",
      },
    });
  }

  // Sender event memory (recording the act of sharing)
  const targetNames = presentTargets
    .map((id) => {
      const npc = state.npcCharacters.find((n) => n.id === id);
      return npc?.name ?? id;
    })
    .join(", ");
  if (targetNames) {
    await memoryManager.add({
      npcId: node.characterId,
      sessionId,
      moduleId,
      type: "event",
      content: `Shared information with ${targetNames}: ${informationContent}`,
      gameDay,
      gameTime: action.gameTime,
      location: action.location,
      metadata: { outcome: action.outcome },
    });
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "feat(discovery): rewrite discoverNpcKnowledge to use memory; knowledge transfer writes information memory"
```

---

## Chunk 4: Update Day Summary & Planning Prompts

### Task 7: Rewrite summarizeDayMemory in NPCPlanningAgent

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts:860-978`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts:11-99`

- [ ] **Step 1: Simplify SummarizeDayMemoryParams and prompt**

In `npcPlanningTemplates.ts`, remove `receivedKnowledge` and `existingKnowledgeIds`:

```typescript
export interface SummarizeDayMemoryParams {
  npcName: string;
  npcProfile: string;
  gameDay: number;
  eventLog: string;
  language: string;
}

export function buildSummarizeDayMemoryPrompt(
  params: SummarizeDayMemoryParams
): PromptParts {
  const systemPrompt = `You are an NPC character in a tabletop horror RPG tabletop RPG.

## Task
It's the end of the day. Review everything that happened today and produce two outputs:
1. **Long-term memory**: The key moments worth remembering — what matters to you going forward.
2. **New knowledge**: Any facts, secrets, or observations you learned today that you didn't know before.

## Instructions

### Long-term Memory
- Write each memory as a separate entry with an importance score
- **importance** (1-5): 1 = minor detail, 2 = routine but worth noting, 3 = significant event, 4 = major turning point, 5 = critical/life-threatening
- Focus on: important events, relationship changes, emotional moments, threats or opportunities
- Drop routine actions unless something notable happened during them
- Write from your perspective, one concise sentence per entry

### New Knowledge
- Review today's events for new information you learned
- For things others told you or you observed/deduced, create an entry
- **category**: "knowledge" for facts and information, "secret" for things you want to keep hidden from others
- **difficulty**: How hard it would be for someone to extract this from you — "automatic" (you'd share freely), "regular", "hard", "extreme" (you'd never willingly reveal)

## Output
Return a JSON object. No extra text. Always write in English.

\`\`\`json
{
  "memories": [
    { "content": "One concise sentence about what happened.", "importance": 3 }
  ],
  "newKnowledge": [
    { "text": "what you learned", "category": "knowledge", "difficulty": "regular" }
  ]
}
\`\`\``;

  const userPrompt = `## Day ${params.gameDay}

## Who You Are
${params.npcProfile}

## Today's Events
${params.eventLog}`;

  return { systemPrompt, userPrompt };
}
```

- [ ] **Step 2: Rewrite summarizeDayMemory in NPCPlanningAgent**

Remove the `receivedKnowledge` resolution and profile mutation. Write new knowledge as memory:

```typescript
async summarizeDayMemory(
  dgsm: DynamicGameStateManager,
  sessionId: string,
  npcId: string,
  gameDay: number,
  language: string
): Promise<void> {
  if (!this.memoryManager) return;

  const dayMemories = await this.memoryManager.getAllForDay(npcId, sessionId, gameDay);
  if (dayMemories.length === 0) return;

  const { getAllHandlers } = await import("../../memory/handlers/index.js");
  const handlers = getAllHandlers();
  const state = dgsm.getState();

  const eventLog = dayMemories
    .map((m) => handlers[m.type].format(m))
    .join("\n");

  const npc = state.npcCharacters.find((n) => n.id === npcId);
  if (!npc) return;

  const { systemPrompt, userPrompt } = buildSummarizeDayMemoryPrompt({
    npcName: npc.name,
    npcProfile: this.formatNpcProfile(npc),
    gameDay,
    eventLog,
    language,
  });

  const response = await generateText({
    runtime: this.runtime,
    context: userPrompt,
    customSystemPrompt: systemPrompt,
    modelClass: ModelClass.SMALL,
  });

  const parsed = parseJsonResponse<{
    memories: Array<{ content: string; importance: number }>;
    newKnowledge?: Array<{
      text: string;
      category?: string;
      difficulty?: string;
    }>;
  }>(response);

  const moduleId = (await this.resolveModuleId(sessionId)) ?? "";

  // Write summary memories
  await Promise.all(
    parsed.memories.map((m) =>
      this.memoryManager!.add({
        npcId,
        sessionId,
        moduleId,
        type: "summary",
        content: m.content,
        gameDay,
        gameTime: "23:59",
        metadata: { gameDay, importance: m.importance },
      })
    )
  );

  // Write new knowledge as information/secret memories
  if (parsed.newKnowledge?.length) {
    for (const k of parsed.newKnowledge) {
      const isSecret = k.category === "secret";
      await this.memoryManager!.add({
        npcId,
        sessionId,
        moduleId,
        type: isSecret ? "secret" : "information",
        content: k.text,
        gameDay,
        gameTime: "23:59",
        metadata: isSecret
          ? {
              knownBy: [npcId],
              difficulty: k.difficulty ?? "hard",
              revealed: false,
            }
          : {
              knowledgeId: `learned_day${gameDay}_${Date.now()}`,
              category: "knowledge" as const,
              difficulty: k.difficulty ?? "automatic",
              revealed: false,
            },
      });
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts
git commit -m "feat(planning): rewrite summarizeDayMemory to write knowledge as memory"
```

### Task 8: Remove relatedKnowledgeIds from detailed node prompt

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts:206-213,294`

- [ ] **Step 1: Simplify character_interaction payload in prompts**

In `DEFAULT_DETAILED_NODE_TYPE_REF`, simplify:

```
- **"character_interaction"**: Interact with a specific character. Requires targetCharacterId.
  - For sharing information or knowledge with one or more characters, include characterInteractionPayload:
    { "transferType": "information", "informationContent": "what you want to tell them", "targetCharacterIds": ["id1", "id2"] }
  - informationContent should reflect YOUR perspective — what you believe and how you'd say it.
  - targetCharacterIds is optional (defaults to targetCharacterId).
```

In `DEFAULT_DETAILED_OUTPUT_SCHEMA`:

```
- **character_interaction**: `"targetCharacterId"`, optional `"characterInteractionPayload"` with `transferType` ("item" or "information"), `informationContent`, `targetCharacterIds`
```

- [ ] **Step 2: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts
git commit -m "refactor(templates): remove relatedKnowledgeIds from node prompt"
```

---

## Chunk 5: Final Verification

### Task 9: Build, test, lint

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 2: Run tests**

Run: `pnpm test`

- [ ] **Step 3: Lint/format**

Run: `pnpm check`

- [ ] **Step 4: Update README.md**

In `src/dynamicworldagent/state/README.md`, remove `npcDiscoveredKnowledge` line.

- [ ] **Step 5: Update CLAUDE.md**

Remove references to `npc.knowledge[]`, `npc.secrets[]`, `npcDiscoveredKnowledge`, `NPCKnowledge` on profile, `bootstrapSecrets`. Update Discovery System section to describe memory-based approach.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: update README and CLAUDE.md to reflect knowledge-in-memory architecture"
```
