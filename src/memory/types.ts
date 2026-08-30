import type {
  NpcMemoryType,
  NpcMemory as PrismaNpcMemory,
} from "@prisma/client";

// Re-export Prisma types
export type { NpcMemoryType } from "@prisma/client";
export type NpcMemory = PrismaNpcMemory;

/**
 * NPC profile JSON now uses the canonical runtime vocabulary. Keep this map
 * at the ingestion boundary solely for already-published modules that still
 * carry the old information/event/belief vocabulary; raw passthrough would
 * reach `getHandler` as `undefined` and fail on `.prepare`.
 */
const LEGACY_MEMORY_TYPE_TO_CANONICAL: Readonly<Record<string, NpcMemoryType>> =
  {
    context: "map",
    information: "general",
    event: "general",
    // A belief is about someone often enough that `relationship` is tempting,
    // but module entries carry no target id, so that conversion would invent
    // a subject. `general` keeps the content and loses nothing real.
    belief: "general",
    knowledge: "general",
    witness: "general",
  };

const CANONICAL_MEMORY_TYPES: ReadonlySet<string> = new Set<NpcMemoryType>([
  "general",
  "plan",
  "secret",
  "relationship",
  "map",
  "long_term_intent",
]);

/** Fold an authored memory type onto the runtime enum. Anything unrecognized
 *  keeps its content as `general` and says so — dropping module-authored
 *  material silently is worse than filing it under the default. */
export function canonicalMemoryType(
  raw: string,
  context?: string
): NpcMemoryType {
  const trimmed = raw?.trim() ?? "";
  if (CANONICAL_MEMORY_TYPES.has(trimmed)) return trimmed as NpcMemoryType;
  const mapped = LEGACY_MEMORY_TYPE_TO_CANONICAL[trimmed.toLowerCase()];
  if (mapped) return mapped;
  console.warn(
    `[memory] unknown memory type "${raw}"${context ? ` (${context})` : ""} — stored as "general"`
  );
  return "general";
}

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

/** A map memory's standing knowledge of a place. */
export interface MapMetadata {
  /** Scene/road id the knowledge is about, when it is about one place. */
  locationId?: string;
}

export type MemoryMetadata = RelationshipMetadata | MapMetadata;

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
    defaultTypes: ["general", "plan", "secret", "relationship", "map"],
    defaultLimit: 20,
    typeLimits: { general: 0, plan: 0, relationship: 0 },
  },
  reaction: {
    defaultTypes: ["general", "plan", "secret", "relationship"],
    defaultLimit: 5,
    typeLimits: { general: 0 },
  },
  detailing: {
    defaultTypes: ["general", "plan", "secret", "relationship", "map"],
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
