# NPC Memory Framework Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scattered NPC memory (NpcMemoryLog, NpcMemorySummary, NpcLongTermIntent, npcDiscoveredClues) with a unified NpcMemory table, NpcMemoryManager facade with per-type handlers, Ebbinghaus decay, hybrid tag+embedding retrieval, and LLM belief reasoning.

**Architecture:** Single `NpcMemory` PostgreSQL table with `type` discriminator. `NpcMemoryManager` facade dispatches to 9 type-specific handlers (event, witness, clue, conversation, belief, emotion, relationship, plan, secret). Three-stage retrieval: tag filter → embedding rank → decay-adjusted score fusion.

**Tech Stack:** TypeScript, Prisma (PostgreSQL), LangChain/LangGraph, fastembed (local embeddings), Vitest

**Spec:** `docs/superpowers/specs/2026-03-11-npc-memory-framework-design.md`

---

## Chunk 1: Prisma Schema + TypeScript Types

### Task 1: Add NpcMemory model and NpcMemoryType enum to Prisma schema

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add NpcMemoryType enum after existing enums**

Add after the last enum in the schema (find the enum section):

```prisma
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

- [ ] **Step 2: Add NpcMemory model after NpcMemorySummary model**

Add after the `NpcMemorySummary` model (around line 956):

```prisma
model NpcMemory {
  id              String        @id @default(uuid()) @db.Uuid
  sessionId       String        @map("session_id")
  moduleId        String        @map("module_id") @db.Uuid
  npcId           String        @map("npc_id")
  type            NpcMemoryType

  content         String
  metadata        Json?
  tags            String[]

  gameDay         Int           @map("game_day")
  gameTime        String        @map("game_time")
  location        String?

  importance      Float         @default(1.0)
  baseImportance  Float         @default(1.0) @map("base_importance")
  accessCount     Int           @default(0)   @map("access_count")
  lastAccessedAt  DateTime      @default(now()) @map("last_accessed_at")

  embedding       Bytes?

  createdAt       DateTime      @default(now()) @map("created_at")
  updatedAt       DateTime      @updatedAt      @map("updated_at")

  session         Session       @relation(fields: [sessionId], references: [sessionId], onDelete: Cascade)
  module          Module        @relation(fields: [moduleId], references: [moduleId], onDelete: Cascade)

  @@index([sessionId, npcId])
  @@index([sessionId, npcId, type])
  @@index([sessionId, npcId, gameDay])
  @@map("npc_memories")
}
```

- [ ] **Step 3: Add inverse relation to Session model**

Find the `Session` model and add inside it:

```prisma
npcMemories     NpcMemory[]
```

- [ ] **Step 4: Add inverse relation to Module model**

Find the `Module` model and add inside it:

```prisma
npcMemories     NpcMemory[]
```

- [ ] **Step 5: Push schema to database**

Run: `pnpm prisma db push`
Expected: Schema applied successfully, `npc_memories` table created.

- [ ] **Step 6: Generate Prisma client**

Run: `pnpm prisma generate`
Expected: Prisma client regenerated with NpcMemory types.

---

### Task 2: Create TypeScript types for NPC memory framework

**Files:**
- Create: `src/dynamicworldagent/memory/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
import type { NpcMemory as PrismaNpcMemory, NpcMemoryType } from "@prisma/client";

// Re-export Prisma types
export type { NpcMemoryType } from "@prisma/client";
export type NpcMemory = PrismaNpcMemory;

// ===== Metadata Types (per memory type) =====

export interface EventMetadata {
  outcome?: string;
}

export interface WitnessMetadata {
  sourceCharacterId: string;
  sourceAction: string;
  impact: number;
}

export interface ClueMetadata {
  clueId: string;
  category: "knowledge" | "observation" | "rumor" | "secret";
  difficulty?: string;
  relatedTo?: string[];
}

export interface ConversationMetadata {
  withCharacterId: string;
  withCharacterName: string;
  topic?: string;
}

export interface BeliefMetadata {
  confidence: number;
  reasoningChain: string;
}

export interface EmotionMetadata {
  emotionType: string;
  intensity: number;
  trigger?: string;
  decayRate?: number;
}

export interface RelationshipMetadata {
  targetId: string;
  targetName: string;
  scoreDelta: number;
  newScore: number;
}

export interface PlanMetadata {
  planType: "long_term" | "daily" | "immediate";
  priority?: number;
}

export interface SecretMetadata {
  knownBy?: string[];
  revealCondition?: string;
}

export type MemoryMetadata =
  | EventMetadata
  | WitnessMetadata
  | ClueMetadata
  | ConversationMetadata
  | BeliefMetadata
  | EmotionMetadata
  | RelationshipMetadata
  | PlanMetadata
  | SecretMetadata;

// ===== Query & Retrieval Types =====

export interface ScoredMemory extends PrismaNpcMemory {
  similarityScore: number;
  finalScore: number;
}

export type ContextPurpose = "scheduling" | "conversation" | "reaction" | "reasoning";

export type ReasoningTrigger =
  | "day_transition"
  | "high_impact"
  | "player_question"
  | "clue_discovered"
  | "witness_major";

// ===== Manager API Parameter Types =====

export interface AddMemoryParams {
  npcId: string;
  sessionId: string;
  moduleId: string;
  type: NpcMemoryType;
  content: string;
  gameDay: number;
  gameTime: string;
  location?: string;
  metadata?: Record<string, any>;
  baseImportanceOverride?: number; // Override handler default (e.g., 3.0 for summaries)
  tagsOverride?: string[];        // Override auto-generated tags
}

export interface QueryMemoryParams {
  npcId: string;
  sessionId: string;
  query: string;
  filters?: {
    types?: NpcMemoryType[];
    gameDay?: number;
    location?: string;
    tags?: string[];
    minImportance?: number;
  };
  limit?: number;
}

export interface GetContextParams {
  npcId: string;
  sessionId: string;
  purpose: ContextPurpose;
  query?: string;
}

export interface TriggerReasoningParams {
  npcId: string;
  sessionId: string;
  moduleId: string;
  trigger: ReasoningTrigger;
  context?: string;
  gameDay: number;
  gameTime: string;
}

// ===== Belief Reasoning Output =====

export interface BeliefOutput {
  belief: string;
  confidence: number;
  reasoningChain: string;
}

export interface BeliefUpdateOutput {
  originalBelief: string;
  newConfidence: number;
  reason: string;
}

export interface ReasoningResult {
  newBeliefs: BeliefOutput[];
  updatedBeliefs: BeliefUpdateOutput[];
}

// ===== Context Profiles =====

export interface ContextProfile {
  defaultTypes: NpcMemoryType[];
  defaultLimit: number;
}

export const CONTEXT_PROFILES: Record<ContextPurpose, ContextProfile> = {
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

// ===== Handler Interface =====

export interface MemoryHandler {
  type: NpcMemoryType;

  prepare(
    content: string,
    metadata?: Record<string, any>,
    location?: string,
  ): {
    tags: string[];
    baseImportance: number;
    metadata: Record<string, any>;
  };

  format(memory: PrismaNpcMemory): string;

  customDecayRate?(): number;
}

// ===== Decay Constants =====

export const DECAY_HALF_LIFE = 48; // hours (in-game time)
export const REINFORCEMENT_WEIGHT = 0.3;
export const SEMANTIC_WEIGHT = 0.5;
export const IMPORTANCE_WEIGHT = 0.3;
export const RECENCY_WEIGHT = 0.2;
export const CANDIDATE_CAP = 200;
export const NEW_INFO_THRESHOLD = 0.3;
export const MIN_MEMORIES_FOR_REASONING = 3;
```

- [ ] **Step 2: Verify no import errors**

Run: `npx tsc --noEmit src/dynamicworldagent/memory/types.ts` or `pnpm build`
Expected: No type errors.


---

## Chunk 2: Handlers + DecayEngine

### Task 3: Create DecayEngine

**Files:**
- Create: `src/dynamicworldagent/memory/DecayEngine.ts`
- Create: `src/dynamicworldagent/memory/__tests__/DecayEngine.test.ts`

- [ ] **Step 1: Write DecayEngine tests**

```typescript
import { describe, it, expect } from "vitest";
import { DecayEngine } from "../DecayEngine.js";

describe("DecayEngine", () => {
  const engine = new DecayEngine();

  describe("computeEffectiveImportance", () => {
    it("returns baseImportance when just created (0 hours elapsed)", () => {
      const now = new Date();
      const result = engine.computeEffectiveImportance({
        baseImportance: 2.0,
        accessCount: 0,
        lastAccessedAt: now,
        decayRateMultiplier: 1.0,
      }, now);
      expect(result).toBeCloseTo(2.0, 1);
    });

    it("decays over time", () => {
      const now = new Date();
      const hoursSinceAccess = 48; // one half-life
      const lastAccessed = new Date(now.getTime() - hoursSinceAccess * 3600 * 1000);
      const result = engine.computeEffectiveImportance({
        baseImportance: 2.0,
        accessCount: 0,
        lastAccessedAt: lastAccessed,
        decayRateMultiplier: 1.0,
      }, now);
      // After one half-life: 2.0 * e^(-1) ≈ 0.736
      expect(result).toBeLessThan(2.0);
      expect(result).toBeGreaterThan(0.5);
    });

    it("slow decay rate preserves importance longer", () => {
      const now = new Date();
      const hoursSinceAccess = 48;
      const lastAccessed = new Date(now.getTime() - hoursSinceAccess * 3600 * 1000);
      const standard = engine.computeEffectiveImportance({
        baseImportance: 2.0, accessCount: 0,
        lastAccessedAt: lastAccessed, decayRateMultiplier: 1.0,
      }, now);
      const slow = engine.computeEffectiveImportance({
        baseImportance: 2.0, accessCount: 0,
        lastAccessedAt: lastAccessed, decayRateMultiplier: 0.5,
      }, now);
      expect(slow).toBeGreaterThan(standard);
    });

    it("reinforcement bonus increases with access count", () => {
      const now = new Date();
      const noAccess = engine.computeEffectiveImportance({
        baseImportance: 1.0, accessCount: 0,
        lastAccessedAt: now, decayRateMultiplier: 1.0,
      }, now);
      const manyAccess = engine.computeEffectiveImportance({
        baseImportance: 1.0, accessCount: 10,
        lastAccessedAt: now, decayRateMultiplier: 1.0,
      }, now);
      expect(manyAccess).toBeGreaterThan(noAccess);
    });
  });

  describe("computeFinalScore", () => {
    it("combines semantic, importance, and recency scores", () => {
      const now = new Date();
      const score = engine.computeFinalScore({
        similarity: 0.8,
        baseImportance: 2.0,
        accessCount: 3,
        lastAccessedAt: now,
        decayRateMultiplier: 1.0,
      }, now);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    it("higher similarity yields higher score", () => {
      const now = new Date();
      const params = {
        baseImportance: 1.0, accessCount: 0,
        lastAccessedAt: now, decayRateMultiplier: 1.0,
      };
      const low = engine.computeFinalScore({ ...params, similarity: 0.2 }, now);
      const high = engine.computeFinalScore({ ...params, similarity: 0.9 }, now);
      expect(high).toBeGreaterThan(low);
    });
  });

  describe("computeFinalScoreWithoutSemantic", () => {
    it("uses only importance and recency when no query", () => {
      const now = new Date();
      const score = engine.computeFinalScoreWithoutSemantic({
        baseImportance: 2.0,
        accessCount: 5,
        lastAccessedAt: now,
        decayRateMultiplier: 1.0,
      }, now);
      expect(score).toBeGreaterThan(0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/dynamicworldagent/memory/__tests__/DecayEngine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DecayEngine**

```typescript
import {
  DECAY_HALF_LIFE,
  REINFORCEMENT_WEIGHT,
  SEMANTIC_WEIGHT,
  IMPORTANCE_WEIGHT,
  RECENCY_WEIGHT,
} from "./types.js";

interface DecayInput {
  baseImportance: number;
  accessCount: number;
  lastAccessedAt: Date;
  decayRateMultiplier: number;
}

interface ScoreInput extends DecayInput {
  similarity: number;
}

export class DecayEngine {
  computeEffectiveImportance(input: DecayInput, now: Date): number {
    const hoursSinceAccess =
      (now.getTime() - input.lastAccessedAt.getTime()) / (1000 * 3600);
    const decayFactor = Math.exp(
      -hoursSinceAccess / (DECAY_HALF_LIFE * input.decayRateMultiplier),
    );
    const reinforcementBonus =
      Math.log2(1 + input.accessCount) * REINFORCEMENT_WEIGHT;
    return input.baseImportance * decayFactor + reinforcementBonus;
  }

  computeFinalScore(input: ScoreInput, now: Date): number {
    const hoursSinceAccess =
      (now.getTime() - input.lastAccessedAt.getTime()) / (1000 * 3600);
    const decayFactor = Math.exp(
      -hoursSinceAccess / (DECAY_HALF_LIFE * input.decayRateMultiplier),
    );
    const reinforcementBonus =
      Math.log2(1 + input.accessCount) * REINFORCEMENT_WEIGHT;
    const importanceScore = this.normalize(
      input.baseImportance * decayFactor + reinforcementBonus,
    );

    return (
      SEMANTIC_WEIGHT * input.similarity +
      IMPORTANCE_WEIGHT * importanceScore +
      RECENCY_WEIGHT * decayFactor
    );
  }

  computeFinalScoreWithoutSemantic(input: DecayInput, now: Date): number {
    const hoursSinceAccess =
      (now.getTime() - input.lastAccessedAt.getTime()) / (1000 * 3600);
    const decayFactor = Math.exp(
      -hoursSinceAccess / (DECAY_HALF_LIFE * input.decayRateMultiplier),
    );
    const reinforcementBonus =
      Math.log2(1 + input.accessCount) * REINFORCEMENT_WEIGHT;
    const importanceScore = this.normalize(
      input.baseImportance * decayFactor + reinforcementBonus,
    );

    // Renormalize weights without semantic: importance 0.6, recency 0.4
    return 0.6 * importanceScore + 0.4 * decayFactor;
  }

  private normalize(value: number): number {
    // Normalize to 0-1 range. Max possible ~= 5 (secret baseImportance 3.0 + reinforcement)
    return Math.min(1.0, value / 5.0);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/dynamicworldagent/memory/__tests__/DecayEngine.test.ts`
Expected: All tests PASS.


---

### Task 4: Create all 9 memory handlers

**Files:**
- Create: `src/dynamicworldagent/memory/handlers/EventHandler.ts`
- Create: `src/dynamicworldagent/memory/handlers/WitnessHandler.ts`
- Create: `src/dynamicworldagent/memory/handlers/ClueHandler.ts`
- Create: `src/dynamicworldagent/memory/handlers/ConversationHandler.ts`
- Create: `src/dynamicworldagent/memory/handlers/BeliefHandler.ts`
- Create: `src/dynamicworldagent/memory/handlers/EmotionHandler.ts`
- Create: `src/dynamicworldagent/memory/handlers/RelationshipHandler.ts`
- Create: `src/dynamicworldagent/memory/handlers/PlanHandler.ts`
- Create: `src/dynamicworldagent/memory/handlers/SecretHandler.ts`
- Create: `src/dynamicworldagent/memory/handlers/index.ts`
- Create: `src/dynamicworldagent/memory/__tests__/handlers.test.ts`

- [ ] **Step 1: Write handler tests**

```typescript
import { describe, it, expect } from "vitest";
import { getHandler, getAllHandlers } from "../handlers/index.js";
import type { NpcMemory } from "@prisma/client";

const makeMemory = (overrides: Partial<NpcMemory>): NpcMemory => ({
  id: "test-id",
  sessionId: "session-1",
  moduleId: "module-1",
  npcId: "npc-1",
  type: "event",
  content: "Searched the library",
  metadata: null,
  tags: [],
  gameDay: 1,
  gameTime: "10:00",
  location: "library",
  importance: 1.0,
  baseImportance: 1.0,
  accessCount: 0,
  lastAccessedAt: new Date(),
  embedding: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("Handlers", () => {
  it("getAllHandlers returns 9 handlers", () => {
    const handlers = getAllHandlers();
    expect(Object.keys(handlers)).toHaveLength(9);
  });

  describe("EventHandler", () => {
    const handler = getHandler("event");

    it("prepares with baseImportance 1.0", () => {
      const result = handler.prepare("Searched the library", {}, "library");
      expect(result.baseImportance).toBe(1.0);
      expect(result.tags).toContain("event");
      expect(result.tags).toContain("library");
    });

    it("formats as [event] prefix", () => {
      const mem = makeMemory({ content: "Found a book", gameTime: "10:00" });
      expect(handler.format(mem)).toContain("[event]");
      expect(handler.format(mem)).toContain("Found a book");
    });
  });

  describe("WitnessHandler", () => {
    const handler = getHandler("witness");

    it("prepares with baseImportance 2.0 and source tag", () => {
      const result = handler.prepare("Saw John steal", { sourceCharacterId: "john-1" });
      expect(result.baseImportance).toBe(2.0);
      expect(result.tags).toContain("john-1");
    });
  });

  describe("ClueHandler", () => {
    const handler = getHandler("clue");

    it("prepares with baseImportance 3.0 and slow decay", () => {
      const result = handler.prepare("Ritual requires dagger", { clueId: "clue-1" });
      expect(result.baseImportance).toBe(3.0);
      expect(result.tags).toContain("clue-1");
      expect(handler.customDecayRate!()).toBe(0.5);
    });
  });

  describe("BeliefHandler", () => {
    const handler = getHandler("belief");

    it("formats with confidence", () => {
      const mem = makeMemory({
        type: "belief",
        content: "John is suspicious",
        metadata: { confidence: 0.7, reasoningChain: "because X" },
      });
      const formatted = handler.format(mem);
      expect(formatted).toContain("[belief]");
      expect(formatted).toContain("0.7");
    });
  });

  describe("SecretHandler", () => {
    const handler = getHandler("secret");

    it("has slowest decay rate 0.3", () => {
      expect(handler.customDecayRate!()).toBe(0.3);
    });

    it("prepares with baseImportance 3.0", () => {
      const result = handler.prepare("I killed the professor");
      expect(result.baseImportance).toBe(3.0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/dynamicworldagent/memory/__tests__/handlers.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create EventHandler**

```typescript
import type { NpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class EventHandler implements MemoryHandler {
  type = "event" as const;

  prepare(content: string, metadata?: Record<string, any>, location?: string) {
    const tags: string[] = ["event"];
    if (location) tags.push(location);
    return {
      tags,
      baseImportance: 1.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: NpcMemory): string {
    return `[event] Day${memory.gameDay} ${memory.gameTime} - ${memory.content}`;
  }
}
```

- [ ] **Step 4: Create WitnessHandler**

```typescript
import type { NpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class WitnessHandler implements MemoryHandler {
  type = "witness" as const;

  prepare(content: string, metadata?: Record<string, any>, location?: string) {
    const tags: string[] = ["witness"];
    if (location) tags.push(location);
    if (metadata?.sourceCharacterId) tags.push(metadata.sourceCharacterId);
    return {
      tags,
      baseImportance: 2.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: NpcMemory): string {
    return `[witness] Day${memory.gameDay} ${memory.gameTime} - ${memory.content}`;
  }
}
```

- [ ] **Step 5: Create ClueHandler**

```typescript
import type { NpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class ClueHandler implements MemoryHandler {
  type = "clue" as const;

  prepare(content: string, metadata?: Record<string, any>, location?: string) {
    const tags: string[] = ["clue"];
    if (location) tags.push(location);
    if (metadata?.clueId) tags.push(metadata.clueId);
    return {
      tags,
      baseImportance: 3.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: NpcMemory): string {
    return `[clue] ${memory.content}`;
  }

  customDecayRate(): number {
    return 0.5; // slow decay
  }
}
```

- [ ] **Step 6: Create ConversationHandler**

```typescript
import type { NpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class ConversationHandler implements MemoryHandler {
  type = "conversation" as const;

  prepare(content: string, metadata?: Record<string, any>, location?: string) {
    const tags: string[] = ["conversation"];
    if (location) tags.push(location);
    if (metadata?.withCharacterId) tags.push(metadata.withCharacterId);
    return {
      tags,
      baseImportance: 1.5,
      metadata: metadata ?? {},
    };
  }

  format(memory: NpcMemory): string {
    const meta = memory.metadata as Record<string, any> | null;
    const withName = meta?.withCharacterName ?? "someone";
    return `[conversation] with ${withName}: ${memory.content}`;
  }
}
```

- [ ] **Step 7: Create BeliefHandler**

```typescript
import type { NpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class BeliefHandler implements MemoryHandler {
  type = "belief" as const;

  prepare(content: string, metadata?: Record<string, any>, location?: string) {
    const tags: string[] = ["belief"];
    if (location) tags.push(location);
    return {
      tags,
      baseImportance: 2.5,
      metadata: metadata ?? { confidence: 0.5, reasoningChain: "" },
    };
  }

  format(memory: NpcMemory): string {
    const meta = memory.metadata as Record<string, any> | null;
    const confidence = meta?.confidence ?? 0;
    const reasoning = meta?.reasoningChain ?? "";
    return `[belief] ${memory.content} (confidence: ${confidence})\n  Reasoning: ${reasoning}`;
  }

  customDecayRate(): number {
    return 0.5; // slow decay
  }
}
```

- [ ] **Step 8: Create EmotionHandler**

```typescript
import type { NpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class EmotionHandler implements MemoryHandler {
  type = "emotion" as const;

  prepare(content: string, metadata?: Record<string, any>, location?: string) {
    const tags: string[] = ["emotion"];
    if (location) tags.push(location);
    return {
      tags,
      baseImportance: 2.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: NpcMemory): string {
    const meta = memory.metadata as Record<string, any> | null;
    const emotionType = meta?.emotionType ?? "unknown";
    const intensity = meta?.intensity ?? 0;
    return `[emotion] ${emotionType} (intensity: ${intensity}): ${memory.content}`;
  }

  customDecayRate(): number {
    return 2.0; // fast decay
  }
}
```

- [ ] **Step 9: Create RelationshipHandler**

```typescript
import type { NpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class RelationshipHandler implements MemoryHandler {
  type = "relationship" as const;

  prepare(content: string, metadata?: Record<string, any>, location?: string) {
    const tags: string[] = ["relationship"];
    if (location) tags.push(location);
    if (metadata?.targetId) tags.push(metadata.targetId);
    return {
      tags,
      baseImportance: 2.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: NpcMemory): string {
    const meta = memory.metadata as Record<string, any> | null;
    const targetName = meta?.targetName ?? "someone";
    const delta = meta?.scoreDelta ?? 0;
    const sign = delta >= 0 ? "+" : "";
    return `[relationship] ${targetName} ${sign}${delta}: ${memory.content}`;
  }

  customDecayRate(): number {
    return 0.5; // slow decay
  }
}
```

- [ ] **Step 10: Create PlanHandler**

```typescript
import type { NpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class PlanHandler implements MemoryHandler {
  type = "plan" as const;

  prepare(content: string, metadata?: Record<string, any>, location?: string) {
    const tags: string[] = ["plan"];
    if (location) tags.push(location);
    return {
      tags,
      baseImportance: 1.5,
      metadata: metadata ?? { planType: "immediate" },
    };
  }

  format(memory: NpcMemory): string {
    const meta = memory.metadata as Record<string, any> | null;
    const planType = meta?.planType ?? "immediate";
    return `[plan:${planType}] ${memory.content}`;
  }

  customDecayRate(): number {
    return 1.5; // fast decay
  }
}
```

- [ ] **Step 11: Create SecretHandler**

```typescript
import type { NpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class SecretHandler implements MemoryHandler {
  type = "secret" as const;

  prepare(content: string, metadata?: Record<string, any>, location?: string) {
    const tags: string[] = ["secret"];
    if (location) tags.push(location);
    return {
      tags,
      baseImportance: 3.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: NpcMemory): string {
    return `[secret] ${memory.content}`;
  }

  customDecayRate(): number {
    return 0.3; // slowest decay
  }
}
```

- [ ] **Step 12: Create handlers index**

```typescript
import type { NpcMemoryType } from "@prisma/client";
import type { MemoryHandler } from "../types.js";
import { EventHandler } from "./EventHandler.js";
import { WitnessHandler } from "./WitnessHandler.js";
import { ClueHandler } from "./ClueHandler.js";
import { ConversationHandler } from "./ConversationHandler.js";
import { BeliefHandler } from "./BeliefHandler.js";
import { EmotionHandler } from "./EmotionHandler.js";
import { RelationshipHandler } from "./RelationshipHandler.js";
import { PlanHandler } from "./PlanHandler.js";
import { SecretHandler } from "./SecretHandler.js";

const HANDLERS: Record<NpcMemoryType, MemoryHandler> = {
  event: new EventHandler(),
  witness: new WitnessHandler(),
  clue: new ClueHandler(),
  conversation: new ConversationHandler(),
  belief: new BeliefHandler(),
  emotion: new EmotionHandler(),
  relationship: new RelationshipHandler(),
  plan: new PlanHandler(),
  secret: new SecretHandler(),
};

export function getHandler(type: NpcMemoryType): MemoryHandler {
  return HANDLERS[type];
}

export function getAllHandlers(): Record<NpcMemoryType, MemoryHandler> {
  return HANDLERS;
}
```

- [ ] **Step 13: Run tests to verify they pass**

Run: `pnpm vitest run src/dynamicworldagent/memory/__tests__/handlers.test.ts`
Expected: All tests PASS.


---

## Chunk 3: MemoryStore + MemoryRetriever

### Task 5: Create MemoryStore (Prisma CRUD + embedding)

**Files:**
- Create: `src/dynamicworldagent/memory/MemoryStore.ts`

- [ ] **Step 1: Implement MemoryStore**

```typescript
import type { PrismaClient, NpcMemory, NpcMemoryType } from "@prisma/client";
import { EmbeddingClient } from "../../rag/embedding.js";
import { getHandler } from "./handlers/index.js";
import type { AddMemoryParams } from "./types.js";

export class MemoryStore {
  private prisma: PrismaClient;
  private embedClient: EmbeddingClient;

  constructor(prisma: PrismaClient, embedClient: EmbeddingClient) {
    this.prisma = prisma;
    this.embedClient = embedClient;
  }

  async create(params: AddMemoryParams): Promise<NpcMemory> {
    const handler = getHandler(params.type);
    const prepared = handler.prepare(
      params.content,
      params.metadata,
      params.location,
    );

    const baseImportance = params.baseImportanceOverride ?? prepared.baseImportance;
    const tags = params.tagsOverride ?? prepared.tags;

    // Generate embedding
    let embeddingBuffer: Buffer | null = null;
    try {
      const vector = await this.embedClient.embed(params.content);
      embeddingBuffer = Buffer.from(new Float32Array(vector).buffer);
    } catch {
      // Embedding failure is non-fatal — memory still stored without it
    }

    return this.prisma.npcMemory.create({
      data: {
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        npcId: params.npcId,
        type: params.type,
        content: params.content,
        metadata: prepared.metadata,
        tags,
        gameDay: params.gameDay,
        gameTime: params.gameTime,
        location: params.location ?? null,
        baseImportance,
        importance: baseImportance,
        embedding: embeddingBuffer,
      },
    });
  }

  async findCandidates(params: {
    sessionId: string;
    npcId: string;
    filters?: {
      types?: NpcMemoryType[];
      gameDay?: number;
      location?: string;
      tags?: string[];
      minImportance?: number;
    };
    limit?: number;
  }): Promise<NpcMemory[]> {
    const { filters, limit } = params;

    const candidates = await this.prisma.npcMemory.findMany({
      where: {
        sessionId: params.sessionId,
        npcId: params.npcId,
        ...(filters?.types && { type: { in: filters.types } }),
        ...(filters?.gameDay !== undefined && { gameDay: filters.gameDay }),
        ...(filters?.location && { location: filters.location }),
        ...(filters?.tags && { tags: { hasSome: filters.tags } }),
        ...(filters?.minImportance !== undefined && {
          importance: { gte: filters.minImportance },
        }),
      },
      orderBy: { importance: "desc" },
      take: limit ?? 200,
    });

    return candidates;
  }

  async reinforce(memoryId: string, newImportance: number): Promise<void> {
    await this.prisma.npcMemory.update({
      where: { id: memoryId },
      data: {
        accessCount: { increment: 1 },
        lastAccessedAt: new Date(),
        importance: newImportance,
      },
    });
  }

  async updateMetadata(
    memoryId: string,
    metadata: Record<string, any>,
    extraFields?: { baseImportance?: number },
  ): Promise<void> {
    await this.prisma.npcMemory.update({
      where: { id: memoryId },
      data: {
        metadata,
        ...(extraFields?.baseImportance !== undefined && {
          baseImportance: extraFields.baseImportance,
        }),
      },
    });
  }

  async batchUpdateImportance(
    sessionId: string,
    updates: Array<{ id: string; importance: number }>,
  ): Promise<void> {
    // Use transaction for batch updates
    await this.prisma.$transaction(
      updates.map((u) =>
        this.prisma.npcMemory.update({
          where: { id: u.id },
          data: { importance: u.importance },
        }),
      ),
    );
  }

  async deletePostCheckpoint(
    sessionId: string,
    checkpointCreatedAt: Date,
  ): Promise<void> {
    // Delete memories created after checkpoint
    await this.prisma.npcMemory.deleteMany({
      where: {
        sessionId,
        createdAt: { gt: checkpointCreatedAt },
      },
    });
    // Delete memories mutated after checkpoint
    await this.prisma.npcMemory.deleteMany({
      where: {
        sessionId,
        createdAt: { lte: checkpointCreatedAt },
        updatedAt: { gt: checkpointCreatedAt },
      },
    });
  }

  async embedQuery(query: string): Promise<number[]> {
    return this.embedClient.embed(query);
  }
}
```

- [ ] **Step 2: Verify no type errors**

Run: `pnpm build`
Expected: No type errors related to MemoryStore.


---

### Task 6: Create MemoryRetriever (three-stage pipeline)

**Files:**
- Create: `src/dynamicworldagent/memory/MemoryRetriever.ts`

- [ ] **Step 1: Implement MemoryRetriever**

```typescript
import type { NpcMemory, NpcMemoryType } from "@prisma/client";
import { MemoryStore } from "./MemoryStore.js";
import { DecayEngine } from "./DecayEngine.js";
import { getHandler } from "./handlers/index.js";
import type { ScoredMemory, QueryMemoryParams } from "./types.js";
import { CANDIDATE_CAP } from "./types.js";

export class MemoryRetriever {
  private store: MemoryStore;
  private decayEngine: DecayEngine;

  constructor(store: MemoryStore, decayEngine: DecayEngine) {
    this.store = store;
    this.decayEngine = decayEngine;
  }

  async query(params: QueryMemoryParams): Promise<ScoredMemory[]> {
    const now = new Date();
    const limit = params.limit ?? 20;

    // Stage 1: Tag filter (DB level)
    const candidates = await this.store.findCandidates({
      sessionId: params.sessionId,
      npcId: params.npcId,
      filters: params.filters,
      limit: CANDIDATE_CAP,
    });

    if (candidates.length === 0) return [];

    // Empty query: skip embedding, rank by importance + recency only
    if (!params.query) {
      return this.rankWithoutSemantic(candidates, now, limit);
    }

    // Stage 2: Embedding rank
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.store.embedQuery(params.query);
    } catch {
      // If embedding fails, fall back to non-semantic ranking
      return this.rankWithoutSemantic(candidates, now, limit);
    }

    // Stage 3: Score fusion
    const scored = candidates.map((memory) => {
      const similarity = memory.embedding
        ? this.cosineSimilarity(
            queryEmbedding,
            this.bytesToFloatArray(memory.embedding),
          )
        : 0;

      const handler = getHandler(memory.type);
      const decayRateMultiplier = handler.customDecayRate?.() ?? 1.0;

      const finalScore = this.decayEngine.computeFinalScore(
        {
          similarity,
          baseImportance: memory.baseImportance,
          accessCount: memory.accessCount,
          lastAccessedAt: memory.lastAccessedAt,
          decayRateMultiplier,
        },
        now,
      );

      return {
        ...memory,
        similarityScore: similarity,
        finalScore,
      } as ScoredMemory;
    });

    // Sort and take top-K
    scored.sort((a, b) => b.finalScore - a.finalScore);
    const results = scored.slice(0, limit);

    // Reinforce retrieved memories (fire-and-forget)
    this.reinforceResults(results, now);

    return results;
  }

  private rankWithoutSemantic(
    candidates: NpcMemory[],
    now: Date,
    limit: number,
  ): ScoredMemory[] {
    const scored = candidates.map((memory) => {
      const handler = getHandler(memory.type);
      const decayRateMultiplier = handler.customDecayRate?.() ?? 1.0;

      const finalScore = this.decayEngine.computeFinalScoreWithoutSemantic(
        {
          baseImportance: memory.baseImportance,
          accessCount: memory.accessCount,
          lastAccessedAt: memory.lastAccessedAt,
          decayRateMultiplier,
        },
        now,
      );

      return {
        ...memory,
        similarityScore: 0,
        finalScore,
      } as ScoredMemory;
    });

    scored.sort((a, b) => b.finalScore - a.finalScore);
    const results = scored.slice(0, limit);
    this.reinforceResults(results, now);
    return results;
  }

  private async reinforceResults(
    results: ScoredMemory[],
    now: Date,
  ): Promise<void> {
    for (const r of results) {
      const handler = getHandler(r.type);
      const decayRateMultiplier = handler.customDecayRate?.() ?? 1.0;
      const newImportance = this.decayEngine.computeEffectiveImportance(
        {
          baseImportance: r.baseImportance,
          accessCount: r.accessCount + 1,
          lastAccessedAt: now,
          decayRateMultiplier,
        },
        now,
      );
      this.store.reinforce(r.id, newImportance).catch(() => {
        // Non-fatal: reinforcement failure doesn't break retrieval
      });
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private bytesToFloatArray(buffer: Buffer): number[] {
    const float32 = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength / 4,
    );
    return Array.from(float32);
  }
}
```

- [ ] **Step 2: Verify no type errors**

Run: `pnpm build`
Expected: No type errors.


---

## Chunk 4: NpcMemoryManager Facade

### Task 7: Create NpcMemoryManager

**Files:**
- Create: `src/dynamicworldagent/memory/NpcMemoryManager.ts`

- [ ] **Step 1: Implement NpcMemoryManager**

```typescript
import type { PrismaClient, NpcMemory } from "@prisma/client";
import { EmbeddingClient } from "../../rag/embedding.js";
import { MemoryStore } from "./MemoryStore.js";
import { MemoryRetriever } from "./MemoryRetriever.js";
import { DecayEngine } from "./DecayEngine.js";
import { getHandler, getAllHandlers } from "./handlers/index.js";
import {
  CONTEXT_PROFILES,
  type AddMemoryParams,
  type QueryMemoryParams,
  type GetContextParams,
  type ScoredMemory,
} from "./types.js";

export class NpcMemoryManager {
  private store: MemoryStore;
  private retriever: MemoryRetriever;
  private decayEngine: DecayEngine;

  constructor(prisma: PrismaClient, embedClient: EmbeddingClient) {
    this.store = new MemoryStore(prisma, embedClient);
    this.decayEngine = new DecayEngine();
    this.retriever = new MemoryRetriever(this.store, this.decayEngine);
  }

  // ===== Write =====

  async add(params: AddMemoryParams): Promise<NpcMemory> {
    return this.store.create(params);
  }

  // ===== Retrieve =====

  async query(params: QueryMemoryParams): Promise<ScoredMemory[]> {
    return this.retriever.query(params);
  }

  // ===== Context Building =====

  async getContext(params: GetContextParams): Promise<string> {
    const profile = CONTEXT_PROFILES[params.purpose];
    const memories = await this.retriever.query({
      npcId: params.npcId,
      sessionId: params.sessionId,
      query: params.query ?? "",
      filters: { types: profile.defaultTypes },
      limit: profile.defaultLimit,
    });

    const handlers = getAllHandlers();
    return memories.map((m) => handlers[m.type].format(m)).join("\n");
  }

  // ===== Decay & Reinforcement =====

  async decayAll(sessionId: string): Promise<void> {
    const now = new Date();
    const memories = await this.store.findAllForSession(sessionId);

    const updates = memories.map((m) => {
      const handler = getHandler(m.type);
      const decayRateMultiplier = handler.customDecayRate?.() ?? 1.0;
      const newImportance = this.decayEngine.computeEffectiveImportance(
        {
          baseImportance: m.baseImportance,
          accessCount: m.accessCount,
          lastAccessedAt: m.lastAccessedAt,
          decayRateMultiplier,
        },
        now,
      );
      return { id: m.id, importance: newImportance };
    });

    if (updates.length > 0) {
      await this.store.batchUpdateImportance(sessionId, updates);
    }
  }

  // ===== Checkpoint =====

  async deletePostCheckpoint(
    sessionId: string,
    checkpointCreatedAt: Date,
  ): Promise<void> {
    await this.store.deletePostCheckpoint(sessionId, checkpointCreatedAt);
  }

  // ===== Belief Update =====

  async updateBeliefConfidence(
    memoryId: string,
    newConfidence: number,
    reason: string,
    currentMetadata: Record<string, any>,
  ): Promise<void> {
    const updatedMetadata = {
      ...currentMetadata,
      confidence: newConfidence,
      reasoningChain: reason,
    };
    await this.store.updateMetadata(memoryId, updatedMetadata, {
      // confidence = 0 → disproven → accelerate forgetting
      ...(newConfidence === 0 && { baseImportance: 0.5 }),
    });
  }
}
```

- [ ] **Step 2: Add findAllForSession to MemoryStore**

In `src/dynamicworldagent/memory/MemoryStore.ts`, add this method:

```typescript
async findAllForSession(sessionId: string): Promise<NpcMemory[]> {
  return this.prisma.npcMemory.findMany({
    where: { sessionId },
  });
}
```

- [ ] **Step 3: Verify no type errors**

Run: `pnpm build`
Expected: No type errors.


---

## Chunk 5: Belief Reasoning Pipeline

### Task 8: Create reasoning prompt template

**Files:**
- Create: `src/dynamicworldagent/memory/prompts/reasoningPrompt.ts`

- [ ] **Step 1: Implement reasoning prompt builder**

Reference the existing prompt template style in `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts` (e.g., `buildImpactGatePrompt()` around line 389).

```typescript
import type { NpcMemory } from "@prisma/client";
import type { ScoredMemory, ReasoningTrigger } from "../types.js";
import { getHandler, getAllHandlers } from "../handlers/index.js";

export interface ReasoningPromptParams {
  npcName: string;
  npcProfile: string;
  memories: ScoredMemory[];
  existingBeliefs: NpcMemory[];
  trigger: ReasoningTrigger;
  triggerContext?: string;
  language?: string;
}

export function buildReasoningPrompt(params: ReasoningPromptParams): string {
  const handlers = getAllHandlers();
  const lang = params.language ?? "en";

  // Format existing beliefs
  const beliefsSection =
    params.existingBeliefs.length > 0
      ? params.existingBeliefs
          .map((b) => {
            const meta = b.metadata as Record<string, any> | null;
            const confidence = meta?.confidence ?? 0;
            const reasoning = meta?.reasoningChain ?? "";
            return `- ${b.content} (confidence: ${confidence})\n  Reasoning: ${reasoning}`;
          })
          .join("\n")
      : "None yet.";

  // Format relevant memories
  const memoriesSection =
    params.memories.length > 0
      ? params.memories.map((m) => `- ${handlers[m.type].format(m)}`).join("\n")
      : "No relevant memories.";

  // Trigger context description
  const triggerMap: Record<ReasoningTrigger, string> = {
    day_transition: "End of day review — reflecting on today's events",
    high_impact: "High-impact event just occurred",
    player_question: "Player provided new information",
    clue_discovered: "New clue discovered",
    witness_major: "Witnessed a major event",
  };
  const triggerDesc = params.triggerContext ?? triggerMap[params.trigger];

  const instruction =
    lang === "zh"
      ? `基于你的人设、已有认知和记忆，判断：
1. 是否能形成新的推论/怀疑？
2. 已有的 belief 是否需要修正（提高/降低 confidence）？

输出 JSON（如果没有新推论也无需修正，返回空数组）：`
      : `Based on your persona, existing beliefs, and memories:
1. Can you form new conclusions/suspicions?
2. Do existing beliefs need revision (raise/lower confidence)?

Output JSON (return empty arrays if no new conclusions and no revisions needed):`;

  return `## You are ${params.npcName}
${params.npcProfile}

## Your existing beliefs
${beliefsSection}

## Relevant memories
${memoriesSection}

## Trigger context
${triggerDesc}

## Task
${instruction}
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
}`;
}

export function parseReasoningOutput(raw: string): {
  newBeliefs: Array<{
    belief: string;
    confidence: number;
    reasoningChain: string;
  }>;
  updatedBeliefs: Array<{
    originalBelief: string;
    newConfidence: number;
    reason: string;
  }>;
} {
  // Strip markdown fences if present
  const cleaned = raw
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      newBeliefs: Array.isArray(parsed.newBeliefs) ? parsed.newBeliefs : [],
      updatedBeliefs: Array.isArray(parsed.updatedBeliefs)
        ? parsed.updatedBeliefs
        : [],
    };
  } catch {
    return { newBeliefs: [], updatedBeliefs: [] };
  }
}
```


---

### Task 9: Add triggerReasoning to NpcMemoryManager

**Files:**
- Modify: `src/dynamicworldagent/memory/NpcMemoryManager.ts`

- [ ] **Step 1: Add triggerReasoning method**

Add the following imports and method to `NpcMemoryManager`:

New imports at top:
```typescript
import {
  buildReasoningPrompt,
  parseReasoningOutput,
} from "./prompts/reasoningPrompt.js";
import type { TriggerReasoningParams } from "./types.js";
import { MIN_MEMORIES_FOR_REASONING } from "./types.js";
```

New method in the class:
```typescript
  async triggerReasoning(
    params: TriggerReasoningParams,
    npcName: string,
    npcProfile: string,
    generateTextFn: (prompt: string) => Promise<string>,
    language?: string,
  ): Promise<NpcMemory[]> {
    // Fetch relevant memories for reasoning
    const memories = await this.retriever.query({
      npcId: params.npcId,
      sessionId: params.sessionId,
      query: params.context ?? "",
      filters: {
        types: ["clue", "witness", "event", "conversation", "belief"],
      },
      limit: 25,
    });

    // Early return if insufficient information
    if (memories.length < MIN_MEMORIES_FOR_REASONING) {
      return [];
    }

    // Fetch existing active beliefs
    const existingBeliefs = await this.retriever.query({
      npcId: params.npcId,
      sessionId: params.sessionId,
      query: "",
      filters: { types: ["belief"] },
      limit: 20,
    });
    // Filter out disproven beliefs (confidence = 0)
    const activeBeliefs = existingBeliefs.filter((b) => {
      const meta = b.metadata as Record<string, any> | null;
      return (meta?.confidence ?? 0) > 0;
    });

    // Build and execute reasoning prompt
    const prompt = buildReasoningPrompt({
      npcName,
      npcProfile,
      memories,
      existingBeliefs: activeBeliefs,
      trigger: params.trigger,
      triggerContext: params.context,
      language,
    });

    const rawResult = await generateTextFn(prompt);
    const result = parseReasoningOutput(rawResult);

    const newMemories: NpcMemory[] = [];

    // Create new belief memories
    for (const belief of result.newBeliefs) {
      const memory = await this.add({
        npcId: params.npcId,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        type: "belief",
        content: belief.belief,
        gameDay: params.gameDay,
        gameTime: params.gameTime,
        metadata: {
          confidence: belief.confidence,
          reasoningChain: belief.reasoningChain,
        },
      });
      newMemories.push(memory);
    }

    // Update existing beliefs
    for (const update of result.updatedBeliefs) {
      const existing = activeBeliefs.find(
        (b) => b.content === update.originalBelief,
      );
      if (!existing) continue;

      await this.updateBeliefConfidence(
        existing.id,
        update.newConfidence,
        update.reason,
        (existing.metadata as Record<string, any>) ?? {},
      );
    }

    return newMemories;
  }

  async shouldTriggerReasoningOnConversation(
    npcId: string,
    sessionId: string,
    playerUtterance: string,
  ): Promise<boolean> {
    const results = await this.retriever.query({
      npcId,
      sessionId,
      query: playerUtterance,
      limit: 5,
    });

    const maxSimilarity =
      results.length > 0 ? results[0].similarityScore : 0;
    return maxSimilarity < 0.3;
  }
```

- [ ] **Step 2: Verify no type errors**

Run: `pnpm build`
Expected: No type errors.


---

### Task 10: Create module index file

**Files:**
- Create: `src/dynamicworldagent/memory/index.ts`

- [ ] **Step 1: Create barrel export**

```typescript
export { NpcMemoryManager } from "./NpcMemoryManager.js";
export { MemoryStore } from "./MemoryStore.js";
export { MemoryRetriever } from "./MemoryRetriever.js";
export { DecayEngine } from "./DecayEngine.js";
export { getHandler, getAllHandlers } from "./handlers/index.js";
export * from "./types.js";
```


---

## Chunk 6: Write Integration Points

### Task 11: Replace appendMemoryLog in tickProcessor

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts`

**Context:** `appendMemoryLog()` is called at two locations in tickProcessor:
1. Line ~440: After NPC action completes → becomes `memoryManager.add(type: "event")`
2. Line ~587: After witness impact gate → becomes `memoryManager.add(type: "witness")`

Also at these locations add new memory writes:
- After relationship update → `add(type: "relationship")`
- After clue discovery → `add(type: "clue")`
- After impact gate emotion output → `add(type: "emotion")`
- After impact >= 3 → `triggerReasoning()`

- [ ] **Step 1: Add NpcMemoryManager as a dependency and thread moduleId**

The tickProcessor receives its dependencies through `NPCPlanningAgent`. Add `NpcMemoryManager` to `NPCPlanningAgent`'s constructor:

In `NPCPlanningAgent.ts`, add to constructor params:
```typescript
private memoryManager: NpcMemoryManager
```

Import at top:
```typescript
import { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
```

**Critical:** `moduleId` is NOT available in `executeSingleTick()`. It is only resolved in `runPlayerAction()` at line ~762 via `npcPlanningAgent.resolveModuleId(sessionId)`. You must:
1. Add `moduleId` to the `SingleTickParams` interface in tickProcessor
2. Resolve `moduleId` once at the start of `runPlayerAction()` and pass it through to all `executeSingleTick()` calls

**Also:** Create a `generateTextFn` adapter for `triggerReasoning`:
```typescript
// In tickProcessor, create this adapter where runtime is in scope:
const generateTextFn = (prompt: string) =>
  generateText({ runtime, context: prompt, modelClass: ModelClass.SMALL });
```

To get `npcProfile` for reasoning, extract from DGSM:
```typescript
const npcProfile = dgsm.getState().npcCharacters.find(n => n.id === npcId)?.profile ?? "";
```

- [ ] **Step 2: Replace action-completed appendMemoryLog**

Find the `appendMemoryLog` call at ~line 440 in tickProcessor (after action completes). Replace:

```typescript
// OLD:
await npcPlanningAgent.appendMemoryLog(sessionId, node.characterId, logEntry, gameDay, action.gameTime, action.location);

// NEW:
await memoryManager.add({
  npcId: node.characterId,
  sessionId,
  moduleId,
  type: "event",
  content: logEntry,
  gameDay,
  gameTime: action.gameTime,
  location: action.location,
  metadata: { outcome: action.outcome },
});
```

- [ ] **Step 3: Replace witness appendMemoryLog**

Find the witness `appendMemoryLog` call at ~line 587. Replace:

```typescript
// OLD:
await npcPlanningAgent.appendMemoryLog(sessionId, npcId, witnessLogEntry, gameDay, tickTime, npcLoc);

// NEW:
await memoryManager.add({
  npcId,
  sessionId,
  moduleId,
  type: "witness",
  content: witnessEntry,
  gameDay,
  gameTime: tickTime,
  location: npcLoc,
  metadata: {
    sourceCharacterId: originatingCharacterId,
    sourceAction: triggeringAction,
    impact: impactScore,
  },
});
```

- [ ] **Step 4: Add relationship memory write**

After the existing `updateRelationshipViaLLM` call (~line 429), add:

```typescript
if (relationshipChange) {
  await memoryManager.add({
    npcId: node.characterId,
    sessionId,
    moduleId,
    type: "relationship",
    content: relationshipChange.note,
    gameDay,
    gameTime: action.gameTime,
    location: action.location,
    metadata: {
      targetId: node.targetCharacterId,
      targetName: node.targetCharacterName,
      scoreDelta: relationshipChange.scoreDelta,
      newScore: relationshipChange.newScore,
    },
  });
}
```

- [ ] **Step 5: Add clue discovery memory write**

In the clue discovery section (where `markNpcClueRevealed` or `addDiscoveredClue` is called), add:

```typescript
// For each clue discovered by NPC
await memoryManager.add({
  npcId,
  sessionId,
  moduleId,
  type: "clue",
  content: clue.clueText,
  gameDay,
  gameTime: action.gameTime,
  location: action.location,
  metadata: {
    clueId: clue.id,
    category: clue.category ?? "knowledge",
    difficulty: clue.difficulty,
    relatedTo: clue.relatedTo,
  },
});
```

- [ ] **Step 6: Extend impact gate prompt for emotion output**

Modify `buildImpactGatePrompt` in `npcPlanningTemplates.ts` to add emotion output:

Add to the JSON output schema in the prompt:
```
"emotionChange": { "emotionType": "fear|anger|trust|suspicion|etc", "intensity": 1-5, "trigger": "what caused it" } // optional
```

Then after parsing impact gate result, add emotion memory:

```typescript
if (impactResult.emotionChange) {
  await memoryManager.add({
    npcId,
    sessionId,
    moduleId,
    type: "emotion",
    content: `Feeling ${impactResult.emotionChange.emotionType} due to ${impactResult.emotionChange.trigger}`,
    gameDay,
    gameTime: tickTime,
    location: npcLoc,
    metadata: impactResult.emotionChange,
  });
}
```

- [ ] **Step 7: Add reasoning trigger after high-impact events**

After impact gate processing (impact >= 3), add:

```typescript
if (impactScore >= 3) {
  await memoryManager.triggerReasoning(
    {
      npcId,
      sessionId,
      moduleId,
      trigger: "high_impact",
      context: triggeringActionDescription,
      gameDay,
      gameTime: tickTime,
    },
    npcName,
    npcProfile,
    generateTextFn, // Pass through the existing LLM call function
    language,
  );
}
```

- [ ] **Step 8: Verify build**

Run: `pnpm build`
Expected: No type errors.


---

### Task 12: Add conversation + clue transfer memory writes

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts` (actual path — NOT in `character/`)
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` (conversation writes happen here, not in characterAgent which is a utility class)

- [ ] **Step 1: Add conversation memory writes**

Where NPC dialogue/response is generated, add:

```typescript
await memoryManager.add({
  npcId,
  sessionId,
  moduleId,
  type: "conversation",
  content: conversationSummary, // Summary of what was discussed
  gameDay,
  gameTime,
  location,
  metadata: {
    withCharacterId: playerCharacterId,
    withCharacterName: playerCharacterName,
    topic: conversationTopic,
  },
});
```

- [ ] **Step 2: Add clue transfer memory writes**

At the `transferClue()` call site in `characterInteractionHandler.ts` (~line 148), the actual code is:
```typescript
dgsm.transferClue(node.characterId, node.targetCharacterId, payload.clueId)
```

Add memory writes after this call. You'll need to resolve the clue text from DGSM state:
```typescript
// Resolve clue content from NPC's clue list
const clue = dgsm.getNpcClue(node.targetCharacterId, payload.clueId);
const clueText = clue?.clueText ?? payload.clueId;
const targetName = dgsm.getState().npcCharacters.find(n => n.id === node.targetCharacterId)?.name ?? "";

// Receiver gets a clue memory
await memoryManager.add({
  npcId: node.targetCharacterId,
  sessionId,
  moduleId,
  type: "clue",
  content: clueText,
  gameDay,
  gameTime: action.gameTime,
  location: action.location,
  metadata: { clueId: payload.clueId, category: "knowledge" },
});

// Sender gets an event memory
await memoryManager.add({
  npcId: node.characterId,
  sessionId,
  moduleId,
  type: "event",
  content: `Shared information about "${clueText}" with ${targetName}`,
  gameDay,
  gameTime: action.gameTime,
  location: action.location,
});
```

- [ ] **Step 3: Add player_question reasoning trigger**

Where the character agent processes player social interaction, add:

```typescript
const shouldReason = await memoryManager.shouldTriggerReasoningOnConversation(
  npcId,
  sessionId,
  playerUtterance,
);
if (shouldReason) {
  await memoryManager.triggerReasoning(
    {
      npcId, sessionId, moduleId,
      trigger: "player_question",
      context: playerUtterance,
      gameDay, gameTime,
    },
    npcName, npcProfile, generateTextFn, language,
  );
}
```


---

### Task 13: Add day transition reasoning + plan memory writes

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts`

- [ ] **Step 1: Add reasoning trigger in onNewDay**

In `onNewDay()` method (~line 636), after `summarizeDayMemory()` calls complete, add:

```typescript
// After summarization, trigger reasoning for all NPCs
const reasoningPromises = allNpcIds.map((npcId) =>
  this.memoryManager.triggerReasoning(
    {
      npcId,
      sessionId,
      moduleId,
      trigger: "day_transition",
      context: "End of day review",
      gameDay: previousDay,
      gameTime: "23:59",
    },
    npcName,
    npcProfile,
    generateTextFn,
    language,
  ),
);
await Promise.all(reasoningPromises);
```

- [ ] **Step 2: Write summary as high-importance event memory**

In `summarizeDayMemory()` (~line 669), after creating `NpcMemorySummary`, also write to unified memory:

```typescript
await this.memoryManager.add({
  npcId,
  sessionId,
  moduleId,
  type: "event",
  content: summary,
  gameDay,
  gameTime: "23:59",
  metadata: { outcome: "daily_summary" },
  baseImportanceOverride: 3.0,
  tagsOverride: ["event", "summary", `day_${gameDay}`],
});
```

- [ ] **Step 3: Write plan intent memories when daily schedule generated**

In `generateSingleNpcSchedule()` (~line 123), after schedule is created, add:

```typescript
// Write intent-level plan memory for the day
const scheduleDescription = schedule
  .map((s) => `${s.time}: ${s.activity} at ${s.location}`)
  .join("; ");
await this.memoryManager.add({
  npcId,
  sessionId,
  moduleId,
  type: "plan",
  content: `Today's plan: ${scheduleDescription}`,
  gameDay,
  gameTime: schedule[0]?.time ?? "08:00",
  metadata: { planType: "daily" },
});
```

- [ ] **Step 4: Write long-term intent as plan memory**

In `generateLongTermIntents()` (~line 40), after upsert to NpcLongTermIntent, also write:

```typescript
await this.memoryManager.add({
  npcId: npc.id,
  sessionId,
  moduleId,
  type: "plan",
  content: intent,
  gameDay: 1,
  gameTime: "00:00",
  metadata: { planType: "long_term" },
});
```


---

## Chunk 7: Read Integration + Secret Bootstrap + Cleanup

### Task 14: Replace memory reads in NPCPlanningAgent

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts`

- [ ] **Step 1: Replace getLongTermIntent + getDaySummaries + getMemoryLog in generateSingleNpcSchedule**

In `generateSingleNpcSchedule()` (~line 123), replace the three separate data fetches:

```typescript
// OLD:
const longTermIntent = await this.getLongTermIntent(sessionId, npcId);
const daySummaries = await this.getDaySummaries(sessionId, npcId);
const todayLog = await this.getMemoryLog(sessionId, npcId, gameDay);

// NEW:
const memoryContext = await this.memoryManager.getContext({
  npcId,
  sessionId,
  purpose: "scheduling",
});
```

Then update `buildDailySchedulePrompt()` to accept the unified `memoryContext` string instead of three separate parameters.

- [ ] **Step 2: Replace memory reads in generateDetailedNodes**

In `generateDetailedNodes()` (~line 216), replace:

```typescript
// OLD:
const longTermIntent = await this.getLongTermIntent(sessionId, npcId);
const memoryLog = await this.getMemoryLog(sessionId, npcId, gameDay);

// NEW:
const memoryContext = await this.memoryManager.getContext({
  npcId,
  sessionId,
  purpose: "scheduling",
  query: entry.activity, // Use the schedule entry's activity as semantic query
});
```

- [ ] **Step 3: Update prompt templates to accept unified memory context**

In `npcPlanningTemplates.ts`, update `buildDailySchedulePrompt()` and `buildDetailedNodesPrompt()`:

Replace separate `memorySummary`, `todayLog`, `longTermIntent` template variables with a single `memoryContext` section:

```typescript
// In the prompt template, replace:
// ## Your Goal\n{longTermIntent}\n## What You Remember\n{memorySummary}\n## What Happened Today\n{todayLog}
// With:
// ## Your Memory\n{memoryContext}
```


---

### Task 15: Inject memory context into NPC response generation

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

**Note:** `characterAgent.ts` is a utility class for data extraction (scene data, NPC matching) — it does NOT build NPC conversation/response prompts. NPC response generation happens in tickProcessor via prompt templates.

- [ ] **Step 1: Add memory context to NPC response prompts**

In tickProcessor, where NPC character_interaction outcomes are generated, add memory context:

```typescript
const conversationContext = await memoryManager.getContext({
  npcId,
  sessionId,
  purpose: "conversation",
  query: playerMessage,
});
```

Pass `conversationContext` as a template variable to the relevant prompt builder (e.g., `buildDetailedNodesPrompt` or the interaction outcome prompt).

- [ ] **Step 2: Add memory context to impact gate reaction prompts**

In `buildImpactGatePrompt`, add a `## Relevant Memories` section so NPCs react based on what they know:

```typescript
const reactionContext = await memoryManager.getContext({
  npcId,
  sessionId,
  purpose: "reaction",
  query: triggeringActionDescription,
});
```


---

### Task 16: Secret bootstrapping at session init

**Files:**
- Modify: Session initialization code (where NPC profiles are loaded into DynamicGameState)

- [ ] **Step 1: Find NPC initialization point**

Locate where NPCs are first loaded into the game state during session creation. This is typically in the game init flow.

- [ ] **Step 2: Add secret memory bootstrapping**

After NPC profiles are loaded, iterate secrets and write to memory:

```typescript
for (const npc of allNpcs) {
  if (npc.secrets && npc.secrets.length > 0) {
    for (const secret of npc.secrets) {
      await memoryManager.add({
        npcId: npc.id,
        sessionId,
        moduleId,
        type: "secret",
        content: secret,
        gameDay: 1,
        gameTime: "00:00",
        metadata: { knownBy: [npc.id] },
      });
    }
  }
}
```


---

### Task 17: Checkpoint restore integration

**Files:**
- Modify: `client/server/checkpoint/controller.ts`

- [ ] **Step 1: Add memory cleanup on checkpoint restore**

In the checkpoint restore flow (~line 401), after deserializing game state, add:

```typescript
import { NpcMemoryManager } from "../../../src/dynamicworldagent/memory/NpcMemoryManager.js";

// After checkpoint is loaded and new session created:
await memoryManager.deletePostCheckpoint(sessionId, checkpoint.createdAt);
```

This deletes:
- All memories created after the checkpoint
- All memories mutated after the checkpoint (revised beliefs)


---

### Task 18: Delete old memory code and tables

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts` (delete old methods)
- Modify: `prisma/schema.prisma` (remove old tables)

- [ ] **Step 1: Update NpcPlanningCapability interface**

In `src/dynamicworldagent/engine/types.ts`, the `NpcPlanningCapability` interface (~line 70) defines `appendMemoryLog`, `getMemoryLog`, and `getLongTermIntent` as required methods. Remove these from the interface and update all 5 test files that mock this interface:
- `fireFeature.test.ts`
- `sanityFeature.test.ts`
- `lightingFeature.test.ts`
- `weatherFeature.test.ts`
- `staminaFeature.test.ts`

Remove the mock implementations for deleted methods in each test.

- [ ] **Step 2: Delete old methods from NPCPlanningAgent**

Remove these methods:
- `appendMemoryLog()` (~line 536-554)
- `getMemoryLog()` (~line 556-565)
- `getDaySummaries()` (~line 722-728)
- `getLongTermIntent()` (~line 582-590)

Also migrate any remaining reads in `reviseSchedule()` (~line 365) and `revisePlans()` (which receive memory data as params from tickProcessor). Update tickProcessor's revision callers to use `memoryManager.getContext("reaction")` instead of fetching `getLongTermIntent` + `getMemoryLog` directly.

- [ ] **Step 3: Remove old Prisma models**

In `prisma/schema.prisma`, remove:
- `NpcMemoryLog` model (~line 927-941)
- `NpcMemorySummary` model (~line 943-956)
- `NpcLongTermIntent` model (~line 891-906)

Also remove their inverse relation fields from `Session` model.

**Keep:** `NpcDailyPlan` — it remains as the planning system's own table.

- [ ] **Step 4: Push schema changes**

Run: `pnpm prisma db push`
Expected: Old tables dropped, schema applied.

Run: `pnpm prisma generate`
Expected: Client regenerated without old models.

- [ ] **Step 5: Fix any remaining references**

Run: `pnpm build`
Expected: Fix any compilation errors from deleted types/methods. Search for:
- `NpcMemoryLog`
- `NpcMemorySummary`
- `NpcLongTermIntent`
- `appendMemoryLog`
- `getMemoryLog`
- `getDaySummaries`


---

### Task 19: Final verification

- [ ] **Step 1: Run full build**

Run: `pnpm build`
Expected: Clean build, no errors.

- [ ] **Step 2: Run all tests**

Run: `pnpm vitest run`
Expected: All memory framework tests pass.

- [ ] **Step 3: Manual smoke test**

Run: `pnpm chat:dev`

Verify:
1. Game starts without errors
2. NPC actions produce event memories (check `npc_memories` table)
3. Day transition creates summaries and triggers reasoning
4. NPC conversations create conversation memories
5. Witness events create witness memories with emotion data

- [ ] **Step 4: Final commit**

```bash
git add .
git commit -m "feat(memory): complete NPC systematic memory framework migration"
```
