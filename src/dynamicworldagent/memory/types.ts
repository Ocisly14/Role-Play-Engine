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

export interface InformationMetadata {
  knowledgeId: string;
  category: "knowledge" | "observation" | "rumor" | "secret";
  difficulty?: string;
  relatedTo?: string[];
}

/**
 * @deprecated Use InformationMetadata instead
 */
export type ClueMetadata = InformationMetadata;

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
  | InformationMetadata
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
  | "information_discovered"
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
  baseImportanceOverride?: number;
  tagsOverride?: string[];
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
    defaultTypes: ["plan", "event", "information", "belief", "summary", "relationship"],
    defaultLimit: 20,
  },
  conversation: {
    defaultTypes: ["event", "information", "belief", "relationship", "secret", "emotion", "summary"],
    defaultLimit: 20,
  },
  reaction: {
    defaultTypes: ["witness", "emotion", "relationship", "belief"],
    defaultLimit: 10,
  },
  reasoning: {
    defaultTypes: ["information", "witness", "event", "belief", "summary"],
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

export const DECAY_HALF_LIFE = 48;
export const REINFORCEMENT_WEIGHT = 0.3;
export const SEMANTIC_WEIGHT = 0.5;
export const IMPORTANCE_WEIGHT = 0.3;
export const RECENCY_WEIGHT = 0.2;
export const CANDIDATE_CAP = 200;
export const NEW_INFO_THRESHOLD = 0.3;
export const MIN_MEMORIES_FOR_REASONING = 3;
