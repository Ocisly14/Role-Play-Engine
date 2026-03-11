# NPC Systematic Memory Framework Design

## Overview

Replace the current scattered NPC memory system (NpcMemoryLog, NpcMemorySummary, NpcLongTermIntent, npcDiscoveredClues, npcRelationshipGraph) with a unified memory framework. Introduces a single `NpcMemory` table, a `NpcMemoryManager` facade with per-type handlers, Ebbinghaus-style forgetting with retrieval reinforcement, hybrid tag+embedding retrieval, and an LLM-powered belief reasoning pipeline.

## Goals

1. **Unify** all NPC memory behind a single `NpcMemoryManager` API
2. **Expand** NPC knowledge with 9 memory categories including beliefs, emotions, and conversations
3. **Enable active reasoning** where NPCs form beliefs/suspicions by combining clues and memories
4. **Scale** to 15+ concurrent active NPCs with efficient retrieval and cost control

## Non-Goals

- Token budget management in retrieval (use small models instead)
- Multiplayer-specific memory (future work)
- External vector database (reuse existing PostgreSQL + RAG infrastructure)

---

## Section 1: Core Data Model

### NpcMemory Unified Table (Prisma Schema)

```prisma
model NpcMemory {
  id              String        @id @default(uuid()) @db.Uuid
  sessionId       String        @map("session_id")
  moduleId        String        @map("module_id") @db.Uuid
  npcId           String        @map("npc_id")
  type            NpcMemoryType

  // Content
  content         String        // Main text content
  metadata        Json?         // Type-specific extension fields
  tags            String[]      // Auto-generated retrieval tags

  // Temporal
  gameDay         Int           @map("game_day")
  gameTime        String        @map("game_time")    // "HH:MM"
  location        String?       // sceneId

  // Importance & Decay
  importance      Float         @default(1.0)   // Cached effective importance
  baseImportance  Float         @default(1.0)   @map("base_importance")
  accessCount     Int           @default(0)     @map("access_count")
  lastAccessedAt  DateTime      @default(now()) @map("last_accessed_at")

  // Embedding
  embedding       Bytes?        // Vector, reuses existing RAG infrastructure

  createdAt       DateTime      @default(now()) @map("created_at")
  updatedAt       DateTime      @updatedAt      @map("updated_at")

  // Relations
  session         Session       @relation(fields: [sessionId], references: [sessionId], onDelete: Cascade)
  module          Module        @relation(fields: [moduleId], references: [moduleId], onDelete: Cascade)

  @@index([sessionId, npcId])
  @@index([sessionId, npcId, type])
  @@index([sessionId, npcId, gameDay])
  @@map("npc_memories")
}

enum NpcMemoryType {
  event
  witness
  clue
  conversation
  belief
  emotion
  relationship
  plan
  secret
}
```

**Note:** Follows existing Prisma conventions — `@db.Uuid` on IDs, `@map()` for snake_case columns, Session/Module relations with `onDelete: Cascade` for cascading deletes, `@@map()` for table name, `references: [sessionId]`/`[moduleId]` matching the actual PK field names. `updatedAt` tracks belief revisions and metadata mutations. Inverse relation fields (`npcMemories NpcMemory[]`) must be added to the `Session` and `Module` models.

### Memory Categories

| Type | Description | baseImportance | Decay Rate |
|------|-------------|---------------|------------|
| event | NPC's own action outcomes | 1.0 | standard |
| witness | Witnessing another character's action | 2.0 | standard |
| clue | Factual knowledge from discovered clues | 3.0 | slow (x0.5) |
| conversation | Social exchange content | 1.5 | standard |
| belief | LLM-inferred conclusions with reasoning chain | 2.5 | slow (x0.5) |
| emotion | Emotional state changes | 2.0 | fast (x2.0) |
| relationship | Relationship changes | 2.0 | slow (x0.5) |
| plan | Intent/goal memory | 1.5 | fast (x1.5) |
| secret | Information the NPC is hiding | 3.0 | slowest (x0.3) |

### Type-Specific Metadata Structures

```typescript
// Event
{ outcome?: string }

// Witness
{ sourceCharacterId: string, sourceAction: string, impact: number }

// Clue
{ clueId: string, category: "knowledge"|"observation"|"rumor"|"secret", difficulty?: string, relatedTo?: string[] }

// Conversation
{ withCharacterId: string, withCharacterName: string, topic?: string }

// Belief
{ confidence: number, reasoningChain: string }
// confidence = 0 → automatically treated as disproven, baseImportance drops to 0.5

// Emotion
{ emotionType: string, intensity: number, trigger?: string, decayRate?: number }

// Relationship
{ targetId: string, targetName: string, scoreDelta: number, newScore: number }

// Plan
{ planType: "long_term"|"daily"|"immediate", priority?: number }

// Secret
{ knownBy?: string[], revealCondition?: string }
```

### Tag Auto-Generation

Tags are generated automatically from structured data at write time. No LLM calls.

```typescript
function autoGenerateTags(type: NpcMemoryType, content: string, metadata: any, location?: string): string[] {
  const tags: string[] = [type];
  if (location) tags.push(location);
  if (metadata.withCharacterId) tags.push(metadata.withCharacterId);
  if (metadata.sourceCharacterId) tags.push(metadata.sourceCharacterId);
  if (metadata.targetId) tags.push(metadata.targetId);
  if (metadata.clueId) tags.push(metadata.clueId);
  return tags;
}
```

Tags are used only for explicit hard-filtering (`filters.tags`). Natural language queries rely entirely on embedding semantic search.

### Forgetting-Reinforcement Algorithm (Ebbinghaus-inspired)

```typescript
function computeEffectiveImportance(memory: NpcMemory, currentTime: DateTime): number {
  const hoursSinceAccess = diffHours(currentTime, memory.lastAccessedAt);
  const customDecayRate = handlers[memory.type].customDecayRate?.() ?? 1.0;
  const decayFactor = Math.exp(-hoursSinceAccess / (DECAY_HALF_LIFE * customDecayRate));
  const reinforcementBonus = Math.log2(1 + memory.accessCount) * REINFORCEMENT_WEIGHT;
  return memory.baseImportance * decayFactor + reinforcementBonus;
}

// Called on every retrieval hit
function reinforceMemory(memoryId: string) {
  // increment accessCount, update lastAccessedAt, recalculate cached importance
}
```

- Memories naturally decay over time
- Each retrieval hit reinforces the memory (increases accessCount, resets lastAccessedAt)
- Different memory types have different decay rates (emotions fade fast, secrets almost never)

---

## Section 2: NpcMemoryManager Facade + Handler Pattern

### Architecture

```
NpcMemoryManager (facade)
│
├── MemoryStore          ← Unified storage layer (Prisma CRUD + embedding)
├── MemoryRetriever      ← Unified retrieval layer (tag filter → embedding rank → decay score)
├── DecayEngine          ← Forgetting-reinforcement algorithm
│
└── Handlers (per-type logic)
    ├── EventHandler
    ├── WitnessHandler
    ├── ClueHandler
    ├── ConversationHandler
    ├── BeliefHandler      ← Contains reasoning chain generation
    ├── EmotionHandler     ← Contains intensity decay
    ├── RelationshipHandler
    ├── PlanHandler
    └── SecretHandler
```

### NpcMemoryManager API

```typescript
class NpcMemoryManager {
  // ===== Write =====

  // Universal write, dispatches to corresponding handler
  async add(params: {
    npcId: string;
    sessionId: string;
    type: NpcMemoryType;
    content: string;
    gameDay: number;
    gameTime: string;
    location?: string;
    metadata?: Record<string, any>;
  }): Promise<NpcMemory>

  // ===== Retrieve =====

  // Core query: tag filter → embedding rank → decay-adjusted score
  async query(params: {
    npcId: string;
    sessionId: string;
    query: string;              // Semantic query text
    filters?: {
      types?: NpcMemoryType[];
      gameDay?: number;
      location?: string;
      tags?: string[];          // Hard filter
      minImportance?: number;
    };
    limit?: number;             // Default 20
  }): Promise<ScoredMemory[]>

  // ===== Context Building =====

  // Build formatted memory context for prompts
  async getContext(params: {
    npcId: string;
    sessionId: string;
    purpose: ContextPurpose;    // "scheduling"|"conversation"|"reaction"|"reasoning"
    query?: string;
  }): Promise<string>

  // ===== Decay & Reinforcement =====

  async decayAll(sessionId: string): Promise<void>
  async reinforce(memoryId: string): Promise<void>

  // ===== Reasoning =====

  async triggerReasoning(params: {
    npcId: string;
    sessionId: string;
    trigger: ReasoningTrigger;
    context?: string;
  }): Promise<NpcMemory[]>     // Newly generated belief memories
}
```

### Handler Interface

```typescript
interface MemoryHandler {
  type: NpcMemoryType;

  // Pre-write: validate metadata, auto-generate tags, set baseImportance
  prepare(content: string, metadata?: any): {
    tags: string[];
    baseImportance: number;
    metadata: Record<string, any>;
  };

  // Format memory as prompt text
  format(memory: NpcMemory): string;

  // Optional: type-specific decay rate multiplier
  customDecayRate?(): number;
}
```

### ContextPurpose Profiles

```typescript
const CONTEXT_PROFILES: Record<ContextPurpose, {
  defaultTypes: NpcMemoryType[];
  defaultLimit: number;
}> = {
  scheduling: {
    defaultTypes: ["plan", "event", "clue", "belief"],
    defaultLimit: 15,
  },
  conversation: {
    defaultTypes: ["conversation", "clue", "belief", "relationship", "secret", "emotion"],
    defaultLimit: 20,
  },
  reaction: {
    defaultTypes: ["witness", "emotion", "relationship", "belief"],
    defaultLimit: 10,
  },
  reasoning: {
    defaultTypes: ["clue", "witness", "event", "conversation", "belief"],
    defaultLimit: 25,
  },
};
```

### getContext Implementation

```typescript
async getContext(params: { npcId, sessionId, purpose, query? }): Promise<string> {
  const profile = CONTEXT_PROFILES[params.purpose];

  const memories = await this.query({
    npcId: params.npcId,
    sessionId: params.sessionId,
    query: params.query ?? "",
    filters: { types: profile.defaultTypes },
    limit: profile.defaultLimit,
  });

  return memories.map(m => this.handlers[m.type].format(m)).join("\n");
}
```

**Empty query fallback:** When `query` is empty (no semantic search needed), skip the embedding stage entirely. Retrieve candidates via tag/type filter only, rank by `importanceScore + recencyBonus`, and return top-K. This avoids meaningless embedding similarity scores from an empty string.

```typescript
// Inside query(): if query is empty, skip embedding rank
if (!params.query) {
  return candidates
    .map(m => ({ ...m, finalScore: 0.3 * importanceScore(m) + 0.2 * recencyScore(m) }))
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, limit);
}
```

---

## Section 3: Memory Retrieval Pipeline

### Three-Stage Retrieval

```
Query → Stage 1: Tag Filter (DB) → Stage 2: Embedding Rank → Stage 3: Score Fusion → Top-K
```

### Stage 1: Tag Filter (DB Level)

Narrows candidate set using structured filters only (type, gameDay, location, explicit tags). Natural language queries do NOT extract tags for filtering — semantic matching is handled entirely by embeddings.

```typescript
const candidates = await prisma.npcMemory.findMany({
  where: {
    sessionId,
    npcId,
    ...(filters.types && { type: { in: filters.types } }),
    ...(filters.gameDay && { gameDay: filters.gameDay }),
    ...(filters.location && { location: filters.location }),
    ...(filters.tags && { tags: { hasSome: filters.tags } }),
  },
});
```

### Stage 2: Embedding Rank

```typescript
const queryEmbedding = await embed(query);  // Reuses existing src/rag/ infrastructure
const withSimilarity = candidates.map(m => ({
  ...m,
  similarity: cosineSimilarity(queryEmbedding, m.embedding),
}));
```

### Stage 3: Score Fusion

```typescript
function computeFinalScore(memory: NpcMemory, similarity: number, now: DateTime): number {
  const semanticScore = similarity;

  const hoursSinceAccess = diffHours(now, memory.lastAccessedAt);
  const customDecayRate = handlers[memory.type].customDecayRate?.() ?? 1.0;
  const decayFactor = Math.exp(-hoursSinceAccess / (DECAY_HALF_LIFE * customDecayRate));
  const reinforcement = Math.log2(1 + memory.accessCount) * REINFORCEMENT_WEIGHT;
  const importanceScore = normalize(memory.baseImportance * decayFactor + reinforcement);

  return 0.5 * semanticScore         // Semantic relevance (dominant)
       + 0.3 * importanceScore       // Importance with decay
       + 0.2 * decayFactor;          // Recency bonus
}
```

Results sorted by finalScore descending, top-K returned. All returned memories are reinforced (accessCount++, lastAccessedAt updated).

### Performance Optimizations (15+ NPCs)

- **Embedding cache**: Computed and stored at write time, zero cost at retrieval
- **Batch decay**: `decayAll()` runs at day_transition, not per-query
- **Candidate cap**: If tag filter returns > 200 candidates, truncate by `importance DESC` before embedding ranking

---

## Section 4: Belief Reasoning Pipeline

### Trigger Points

| Trigger | Condition | Call Site |
|---------|-----------|-----------|
| day_transition | All NPCs | `onNewDay()` after `summarizeDayMemory()` |
| high_impact | impact >= 3, NPC at location | `tickProcessor` after impact gate |
| clue_discovered | NPC receives new clue | `tickProcessor.discoverClues()` |
| witness_major | impact >= 4, NPC at location | `tickProcessor` witness flow |
| player_question | semantic search < 0.3 | `characterAgent` during social interaction |

### player_question Gate

Uses semantic search to determine if player is providing new information the NPC doesn't know:

```typescript
async function shouldTriggerReasoningOnConversation(
  npcId: string,
  sessionId: string,
  playerUtterance: string
): Promise<boolean> {
  const results = await memoryManager.query({
    npcId,
    sessionId,
    query: playerUtterance,
    limit: 5,
  });

  const maxSimilarity = results.length > 0 ? results[0].similarityScore : 0;
  return maxSimilarity < 0.3;  // Very low threshold — only truly novel info triggers
}
```

### BeliefHandler.reason() Flow

```typescript
async reason(params: {
  npcProfile: NPCProfile;
  memories: ScoredMemory[];
  existingBeliefs: NpcMemory[];
  trigger: ReasoningTrigger;
  triggerContext?: string;
}): Promise<BeliefOutput[]> {
  const prompt = buildReasoningPrompt(params);
  const result = await generateText({
    runtime,
    context: prompt,
    modelClass: ModelClass.SMALL,
  });
  return parseBeliefOutput(result);
}
```

### Reasoning Prompt Structure

```markdown
## You are {npcName}
{npcProfile brief}

## Your existing beliefs
- [belief] John may be involved in the ritual (confidence: 0.6)
  Reasoning: Saw John near artifact room + ritual requires silver dagger
- [belief] The museum dagger is a key artifact (confidence: 0.8)
  Reasoning: Multiple sources mention the dagger in connection with the ritual

## Relevant memories
- [clue] The ritual requires a silver dagger
- [witness] Saw John near the artifact room late at night
- [conversation] Player mentioned the library has related records
- [event] Searched the library for ritual documents today

## Trigger context
{triggerContext — e.g. "End of day review" / "Player revealed new info: the librarian is missing"}

## Task
Based on your persona, existing beliefs, and memories:
1. Can you form new conclusions/suspicions?
2. Do existing beliefs need revision (raise/lower confidence)?

Output JSON:
{
  "newBeliefs": [
    {
      "belief": "Specific conclusion",
      "confidence": 0.0~1.0,
      "reasoningChain": "Because A, combined with B, I believe C"
    }
  ],
  "updatedBeliefs": [
    {
      "originalBelief": "Original belief content",
      "newConfidence": 0.0~1.0,
      "reason": "Why revised"
    }
  ]
}
Return empty arrays if no new conclusions and no revisions needed.
```

### Belief Lifecycle

- **confidence = 0** → automatically treated as disproven, `baseImportance` drops to 0.5 to accelerate forgetting
- Updated beliefs retain the same memory record with modified metadata
- Existing beliefs are passed into reasoning prompts to avoid duplicate inference

### Cost Control (15+ NPCs)

- **day_transition**: All NPCs reason, but uses small model + concurrent batch
- **high_impact / witness_major / clue_discovered**: Only affected NPCs (typically 1-3)
- **player_question**: At most 1 NPC (the one in conversation), gated by similarity < 0.3
- **Early return**: If relevant memories < 3, skip reasoning (insufficient information)

---

## Section 5: Migration Strategy

### Direct Migration (No Dual-Write)

```
Phase 1: Create NpcMemory table + NpcMemoryManager + all Handlers
Phase 2: Replace all read/write integration points, delete old code and old tables
```

### Data Migration Map

| Old Source | → NpcMemory type | Migration Logic |
|-----------|-----------------|-----------------|
| NpcMemoryLog | event / witness | Split by `[witness]` marker in content |
| NpcMemorySummary | event (compressed) | Each summary → high baseImportance event |
| NpcLongTermIntent | plan | intent text as content, `metadata: { planType: "long_term" }` |
| NpcDailyPlan | **Keep original table** | Structure too different (nodes/schedule complex JSON) |
| npcDiscoveredClues (state) | clue | Resolve clueId to full clue content |
| npcRelationshipGraph (state) | relationship | Each change → memory entry; current values stay in state as snapshot |

**NpcDailyPlan stays as its own table** — its schedule + PlanNode structure is a separate planning system. NpcMemoryManager writes intent-level plan memories ("plan to investigate the library today"), while detailed nodes remain managed by NPCPlanningAgent.

### Write Integration Points

| Location | Event | Memory Write |
|----------|-------|-------------|
| tickProcessor.ts | Action completed | `add(type: "event")` |
| tickProcessor.ts | Witness gate passed | `add(type: "witness")` |
| tickProcessor.ts | Clue discovered | `add(type: "clue")` |
| characterInteractionHandler.ts | Clue transferred (NPC→NPC) | `add(type: "clue")` for receiver + `add(type: "event")` for sender |
| tickProcessor.ts | Relationship changed | `add(type: "relationship")` |
| tickProcessor.ts | impact >= 3 | `triggerReasoning()` |
| NPCPlanningAgent.ts | onNewDay() | `triggerReasoning("day_transition")` |
| NPCPlanningAgent.ts | Plan generated | `add(type: "plan")` |
| characterAgent.ts | NPC dialogue | `add(type: "conversation")` |
| tickProcessor.ts | Post-action emotional impact | `add(type: "emotion")` |
| characterAgent.ts | Player question | `shouldTriggerReasoning()` check |

### Read Integration Points

| Location | Old Code | New Code |
|----------|---------|---------|
| NPCPlanningAgent.generateDailySchedule() | getLongTermIntent + getDaySummaries + getMemoryLog | `memoryManager.getContext("scheduling")` |
| NPCPlanningAgent.generateDetailedNodes() | getLongTermIntent + getMemoryLog | `memoryManager.getContext("scheduling")` |
| characterAgent (NPC reply) | Hardcoded context building | `memoryManager.getContext("conversation")` |
| characterAgent (NPC reaction) | Hardcoded context building | `memoryManager.getContext("reaction")` |

### Code to Delete After Migration

| Deprecated | Replaced By |
|-----------|------------|
| `appendMemoryLog()` | `memoryManager.add()` |
| `getMemoryLog()` | `memoryManager.query()` |
| `getDaySummaries()` | `memoryManager.getContext()` |
| `getLongTermIntent()` | `memoryManager.query({ types: ["plan"] })` |
| `buildSummarizeDayMemoryPrompt()` | Keep — logic unchanged, output writes to NpcMemory |
| NpcMemoryLog table | NpcMemory table |
| NpcMemorySummary table | NpcMemory table |
| NpcLongTermIntent table | NpcMemory table |

---

## Additional Specifications

### Relationship Graph Synchronization

The in-memory `npcRelationshipGraph` remains the authoritative source for current relationship scores (consumed by `formatRelationships()`, `scanUnplannedEncounters()`, `discoverClues()`). The `relationship` type memory records the *history* of changes.

- **On relationship change:** Update `npcRelationshipGraph` as before, AND write a `relationship` memory for both NPCs (A→B and B→A, as existing `updateRelationship()` does bidirectionally).
- **On checkpoint restore:** `npcRelationshipGraph` is restored from the checkpoint's DynamicGameState snapshot — no need to rebuild from memories.
- **Memory purpose:** Relationship memories feed into the retrieval pipeline for reasoning ("why do I distrust John?"), not as source of truth for scores.

### Day Summarization Behavior

At day transition, `summarizeDayMemory()` continues to run as before. The output is written as a single high-`baseImportance` (3.0) `event` memory with tag `["summary", "day_{N}"]`. After the summary is written, the raw event/witness memories from that day are **not deleted** — they naturally decay via the forgetting algorithm and will drop out of retrieval results over time, while the summary persists due to higher baseImportance.

### Emotion Memory Creation

Emotion memories are created in `tickProcessor.ts` during post-action processing, piggy-backing on the existing impact gate flow. When the impact gate LLM evaluates an NPC's reaction, the prompt is extended to also output an optional emotion change. This avoids a separate LLM call. Format:

```typescript
// Extended impact gate output
{
  shouldRevise: boolean,
  witnessEntry?: string,
  emotionChange?: { emotionType: string, intensity: number, trigger: string }
}
```

If `emotionChange` is present, write `add(type: "emotion")`. Emotion memories have fast decay (x2.0) so they naturally fade unless reinforced.

### Checkpoint / Save-Load Interaction

`NpcMemory` records are persisted in PostgreSQL independently of checkpoints. On checkpoint restore:

- **Delete post-checkpoint memories:** `DELETE FROM npc_memories WHERE session_id = ? AND created_at > checkpoint.createdAt`
- **Delete mutated memories:** `DELETE FROM npc_memories WHERE session_id = ? AND created_at <= checkpoint.createdAt AND updated_at > checkpoint.createdAt` — beliefs revised after the checkpoint are deleted rather than reverted. The next reasoning cycle will regenerate them (acceptable non-determinism since LLM reasoning is inherently non-deterministic).
- **Preserve everything else:** Pre-checkpoint, unmutated memories are valid historical records.

### Secret Bootstrapping

NPC secrets from their profile (`npc.secrets: string[]`) are **eagerly loaded** as `secret` type memories during session initialization (when NPCs are first loaded into the game). Each secret string becomes one NpcMemory with `type: "secret"`, `baseImportance: 3.0`, and `metadata: { knownBy: [npcId] }`. This happens in the same initialization flow where NPC profiles are loaded into DynamicGameState.

### Embedding Cost at Day Transition

Day transition triggers reasoning for all NPCs. Expected embedding cost:
- 15 NPCs × ~2 new beliefs average = ~30 embedding calls
- Using local `fastembed` model (already in `src/rag/`), this is negligible (<1 second total)
- If remote embedding provider is used, batch the embedding calls (embed multiple texts in a single API call)

---

## File Structure

```
src/dynamicworldagent/memory/
├── NpcMemoryManager.ts          # Facade: add, query, getContext, triggerReasoning, decayAll
├── MemoryStore.ts               # Prisma CRUD + embedding storage
├── MemoryRetriever.ts           # Three-stage retrieval pipeline
├── DecayEngine.ts               # Ebbinghaus forgetting + reinforcement
├── types.ts                     # NpcMemoryType, ScoredMemory, ContextPurpose, etc.
├── handlers/
│   ├── MemoryHandler.ts         # Handler interface
│   ├── EventHandler.ts
│   ├── WitnessHandler.ts
│   ├── ClueHandler.ts
│   ├── ConversationHandler.ts
│   ├── BeliefHandler.ts         # Includes reasoning prompt + parsing
│   ├── EmotionHandler.ts
│   ├── RelationshipHandler.ts
│   ├── PlanHandler.ts
│   └── SecretHandler.ts
└── prompts/
    └── reasoningPrompt.ts       # Belief reasoning prompt template
```
