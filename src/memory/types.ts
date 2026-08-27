import type {
  NpcMemoryType,
  NpcMemory as PrismaNpcMemory,
} from "@prisma/client";
import type { KnownMapSeed } from "../state/types.js";

// Re-export Prisma types
export type { NpcMemoryType } from "@prisma/client";
export type NpcMemory = PrismaNpcMemory;

// ===== Metadata Types (per memory type) =====

/** `relationship` memories scope to one person so retrieval can answer
 *  "what do I remember about X". Written by the character, so the score
 *  fields are optional — a memory may be purely qualitative. */
export interface RelationshipMetadata {
  targetId: string;
  targetName?: string;
  scoreDelta?: number;
  newScore?: number;
}


export interface KnownMapIds {
  sceneIds: string[];
  junctionIds: string[];
  roadIds: string[];
  scenarioOutlineIds: string[];
}

/** `context` memories are the character's standing knowledge of a place —
 *  which one, and at what altitude. See contextMemory.ts. */
export interface ContextMetadata {
  scope: "macro" | "interior" | "topology";
  /** Outline id for `macro`, scene id for `interior`, absent for `topology`. */
  locationId?: string;
}

export type MemoryMetadata = RelationshipMetadata | ContextMetadata;

export interface EnsureContextMemoriesParams {
  npcId: string;
  sessionId: string;
  moduleId: string;
  gameDateTime: string;
  dgsm: import("../state/DynamicGameState.js").DynamicGameStateManager;
  /** Absent means the character knows the whole map. */
  seed?: KnownMapSeed;
  /** Module language ("en" | "zh") — drives the glue between descriptions. */
  language?: string;
}

// ===== Query & Retrieval Types =====

export interface ScoredMemory extends PrismaNpcMemory {
  similarityScore: number;
  finalScore: number;
}

export type ContextPurpose = "scheduling" | "reaction" | "detailing";

// ===== Manager API Parameter Types =====

export interface AddMemoryParams {
  npcId: string;
  sessionId: string;
  moduleId: string;
  type: NpcMemoryType;
  content: string;
  gameDateTime: string;
  location?: string;
  metadata?: Record<string, any>;
  baseImportanceOverride?: number;
  tagsOverride?: string[];
}

export interface QueryMemoryParams {
  npcId: string;
  sessionId: string;
  query: string;
  filters?: {
    types?: NpcMemoryType[];
    /** Single ISO date "YYYY-MM-DD" matches that day; array matches any of the listed days (OR-set). */
    gameDate?: string | string[];
    /** When set, ephemeral types are restricted to this day only. */
    currentGameDate?: string;
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
  /** Current game date — ephemeral memories are restricted to this date. */
  currentGameDate?: string;
}

// ===== Context Profiles =====

export interface ContextProfile {
  defaultTypes: NpcMemoryType[];
  defaultLimit: number;
  /** Per-type limit overrides. 0 = fetch all (up to 500). Types not listed use defaultLimit. */
  typeLimits?: Partial<Record<NpcMemoryType, number>>;
}

export const CONTEXT_PROFILES: Record<ContextPurpose, ContextProfile> = {
  scheduling: {
    defaultTypes: [
      "general",
      "plan",
      "secret",
      "relationship",
      "map",
      "context",
      "summary",
    ],
    defaultLimit: 20,
    typeLimits: { summary: 10, general: 0, plan: 0, relationship: 0 },
  },
  reaction: {
    defaultTypes: ["general", "plan", "secret", "relationship"],
    defaultLimit: 5,
    typeLimits: { general: 0 },
  },
  detailing: {
    defaultTypes: ["general", "plan", "secret", "relationship", "map", "context"],
    defaultLimit: 5,
    typeLimits: { general: 0 },
  },
};

// ===== Handler Interface =====

export interface MemoryHandler {
  type: NpcMemoryType;

  prepare(
    content: string,
    metadata?: Record<string, any>,
    location?: string
  ): {
    tags: string[];
    baseImportance: number;
    metadata: Record<string, any>;
  };

  format(memory: PrismaNpcMemory): string;

  customDecayRate?(): number;
}

// ===== Decay Constants =====

export const DECAY_HALF_LIFE = 48;
export const REINFORCEMENT_WEIGHT = 0.3;
export const SEMANTIC_WEIGHT = 0.5;
export const IMPORTANCE_WEIGHT = 0.3;
export const RECENCY_WEIGHT = 0.2;
export const CANDIDATE_CAP = 200;
export const NEW_INFO_THRESHOLD = 0.3;
export const MIN_MEMORIES_FOR_REASONING = 3;
