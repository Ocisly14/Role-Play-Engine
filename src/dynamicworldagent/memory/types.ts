import type {
  NpcMemoryType,
  NpcMemory as PrismaNpcMemory,
} from "@prisma/client";
import type {
  DynamicScene,
  KnownMapSeed,
  ScenarioOutline,
  TransportEdge,
} from "../state/types.js";
import type { JunctionNode, RoadNode } from "../state/topologyTypes.js";

// Re-export Prisma types
export type { NpcMemoryType } from "@prisma/client";
export type NpcMemory = PrismaNpcMemory;

// ===== Metadata Types (per memory type) =====

export interface EventMetadata {
  outcome?: string;
  itemId?: string;
  itemName?: string;
  targetItemId?: string;
  targetItemName?: string;
}

export interface WitnessMetadata {
  sourceCharacterId: string;
  sourceAction: string;
  impact: number;
}

export interface KnowledgeMetadata {
  knowledgeId: string;
  difficulty?: string;
  revealed?: boolean;
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

export interface KnownMapIds {
  sceneIds: string[];
  junctionIds: string[];
  roadIds: string[];
  scenarioOutlineIds: string[];
}

export interface KnownMapScene extends DynamicScene {
  detailLevel?: "full" | "name_only";
}

export interface KnownMapSnapshot {
  schemaVersion: number;
  updatedAt: string;
  knownIds: KnownMapIds;
  revealedHiddenConnections: string[];
  scenes: Record<string, KnownMapScene>;
  junctions: Record<string, JunctionNode>;
  roads: Record<string, RoadNode>;
  scenarioOutlines: ScenarioOutline[];
  transportEdges: TransportEdge[];
  blockedConnections: Record<string, string>;
}

export interface MapMetadata {
  snapshot: KnownMapSnapshot;
}

export type MemoryMetadata =
  | EventMetadata
  | WitnessMetadata
  | KnowledgeMetadata
  | BeliefMetadata
  | EmotionMetadata
  | RelationshipMetadata
  | PlanMetadata
  | MapMetadata;

export interface EnsureMapSnapshotParams {
  npcId: string;
  sessionId: string;
  moduleId: string;
  gameDay: number;
  gameTime: string;
  location?: string;
  dgsm: import("../state/DynamicGameState.js").DynamicGameStateManager;
  seed?: KnownMapSeed;
}

export interface RefreshMapSnapshotParams {
  npcId: string;
  sessionId: string;
  moduleId: string;
  gameDay: number;
  gameTime: string;
  location?: string;
  dgsm: import("../state/DynamicGameState.js").DynamicGameStateManager;
}
// ===== Query & Retrieval Types =====

export interface ScoredMemory extends PrismaNpcMemory {
  similarityScore: number;
  finalScore: number;
}

export type ContextPurpose = "scheduling" | "reaction" | "detailing";

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
    /** When set, ephemeral types (event/witness/plan) are restricted to this day only. */
    currentGameDay?: number;
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
  /** Current game day — ephemeral memories (event/witness/plan) are restricted to this day. */
  currentGameDay?: number;
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
  /** Per-type limit overrides. 0 = fetch all (up to 500). Types not listed use defaultLimit. */
  typeLimits?: Partial<Record<NpcMemoryType, number>>;
}

export const CONTEXT_PROFILES: Record<ContextPurpose, ContextProfile> = {
  scheduling: {
    defaultTypes: [
      "event",
      "witness",
      "information",
      "belief",
      "secret",
      "summary",
    ],
    defaultLimit: 20,
    typeLimits: {
      event: 0,
      witness: 0,
      summary: 10,
      information: 0,
      belief: 0,
      secret: 10,
    },
  },
  reaction: {
    defaultTypes: ["event", "witness", "belief", "secret", "information"],
    defaultLimit: 5,
    typeLimits: { event: 0, witness: 0 },
  },
  detailing: {
    defaultTypes: ["event", "witness", "belief", "secret", "information"],
    defaultLimit: 5,
    typeLimits: { event: 0, witness: 0 },
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
