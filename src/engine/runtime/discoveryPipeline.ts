import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import { ModelProviderName } from "../../models/types.js";
import type {
  DiscoveryEntry,
  PlanNode,
  SuccessLevel,
} from "../../planning/types.js";
import { EmbeddingClient } from "../../rag/embedding.js";
import { SessionRagService } from "../../rag/session/sessionRagService.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { resolveTargets } from "../handlers/interactionStateResolver.js";

const DIFFICULTY_RANK: Record<string, number> = {
  automatic: 0,
  regular: 1,
  hard: 2,
  extreme: 3,
};

const SUCCESS_TO_MAX_RANK: Record<SuccessLevel, number> = {
  critical: 3,
  hard: 2,
  regular: 1,
  fail: 0,
  fumble: -1,
};

const DISCOVERY_SIMILARITY_THRESHOLD = 0.7;

let embeddingClient: EmbeddingClient | null = null;

function getEmbeddingClient(): EmbeddingClient {
  if (!embeddingClient) {
    const provider =
      (process.env.MODEL_PROVIDER as ModelProviderName) ||
      ModelProviderName.OPENAI;
    embeddingClient = new EmbeddingClient(provider);
  }
  return embeddingClient;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
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

interface DiscoveryCandidate {
  id: string;
  text: string;
  difficulty: string;
  source: "evidence" | "npc";
  sourceId: string;
  sourceName: string;
}

export async function discoverEvidence(
  node: PlanNode,
  successLevel: SuccessLevel,
  dgsm: DynamicGameStateManager,
  language: string,
  sceneId: string
): Promise<DiscoveryEntry[]> {
  const scene = dgsm.getScene(sceneId);
  if (!scene?.items) return [];
  if (
    node.type !== "action" &&
    node.type !== "object_interaction"
  ) {
    return [];
  }

  const maxRank = node.skill ? (SUCCESS_TO_MAX_RANK[successLevel] ?? 0) : 0;
  const candidates: DiscoveryCandidate[] = [];
  for (const item of scene.items) {
    if (item.category !== "evidence" || item.damaged) continue;
    const difficulty = item.discoveryMethod ? "regular" : "automatic";
    const rank = DIFFICULTY_RANK[difficulty] ?? 1;
    if (rank > maxRank) continue;
    candidates.push({
      id: item.id,
      text: item.description || item.name,
      difficulty,
      source: "evidence",
      sourceId: scene.id,
      sourceName: scene.name,
    });
  }

  return matchCandidates(candidates, node, language);
}

export async function discoverNpcKnowledge(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  memoryManager: NpcMemoryManager
): Promise<DiscoveryEntry[]> {
  if (node.type !== "character_interaction") return [];

  const state = dgsm.getState();
  const targetIds = resolveTargets(node);
  const discoveries: DiscoveryEntry[] = [];

  for (const targetId of targetIds) {
    const targetNpc = state.npcCharacters.find((n) => n.id === targetId);
    if (!targetNpc) continue;

    const targetMemories = await memoryManager.getAllByTypes(
      targetId,
      state.sessionId,
      ["information", "secret"]
    );

    for (const mem of targetMemories) {
      const meta = mem.metadata as Record<string, unknown> | null;
      discoveries.push({
        id: (meta?.knowledgeId as string) ?? mem.id,
        text: mem.content,
        difficulty: ((meta?.difficulty as string) ??
          (mem.type === "secret"
            ? "hard"
            : "regular")) as DiscoveryEntry["difficulty"],
        source: "npc",
        sourceId: targetNpc.id,
        sourceName: targetNpc.name,
        similarity: 1,
      });
    }
  }

  return discoveries;
}

async function matchCandidates(
  candidates: DiscoveryCandidate[],
  node: PlanNode,
  language: string
): Promise<DiscoveryEntry[]> {
  if (candidates.length === 0) return [];

  const automaticCandidates: DiscoveryCandidate[] = [];
  const semanticCandidates: DiscoveryCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.difficulty === "automatic") {
      automaticCandidates.push(candidate);
    } else {
      semanticCandidates.push(candidate);
    }
  }

  const automaticResults: DiscoveryEntry[] = automaticCandidates
    .slice(0, 1)
    .map((candidate) => ({
      id: candidate.id,
      text: candidate.text,
      source: candidate.source,
      sourceId: candidate.sourceId,
      sourceName: candidate.sourceName,
      difficulty: "automatic",
      similarity: 0,
    }));

  const allSemanticCandidates = [...automaticCandidates, ...semanticCandidates];
  if (allSemanticCandidates.length === 0) return [];

  try {
    const embedClient = getEmbeddingClient();
    const lang = (language?.startsWith("zh") ? "zh" : "en") as "zh" | "en";
    const actionEmbedding = await embedClient.embed(node.action, {
      language: lang,
    });
    if (!actionEmbedding.length) return [];

    allSemanticCandidates.sort(
      (a, b) =>
        (DIFFICULTY_RANK[b.difficulty] ?? 0) -
        (DIFFICULTY_RANK[a.difficulty] ?? 0)
    );

    const matched: DiscoveryEntry[] = [];
    for (const candidate of allSemanticCandidates) {
      const candidateEmbedding = await embedClient.embed(candidate.text, {
        language: lang,
      });
      if (!candidateEmbedding.length) continue;

      const sim = cosineSimilarity(actionEmbedding, candidateEmbedding);
      if (sim >= DISCOVERY_SIMILARITY_THRESHOLD) {
        matched.push({
          id: candidate.id,
          text: candidate.text,
          source: candidate.source,
          sourceId: candidate.sourceId,
          sourceName: candidate.sourceName,
          difficulty: candidate.difficulty as DiscoveryEntry["difficulty"],
          similarity: sim,
        });
      }
    }

    matched.sort((a, b) => {
      const diffDelta =
        (DIFFICULTY_RANK[b.difficulty] ?? 0) -
        (DIFFICULTY_RANK[a.difficulty] ?? 0);
      if (diffDelta !== 0) return diffDelta;
      return b.similarity - a.similarity;
    });

    let automaticCount = 0;
    const results: DiscoveryEntry[] = [];
    for (const entry of matched) {
      if (entry.difficulty === "automatic") {
        if (automaticCount >= 1) continue;
        automaticCount++;
      }
      results.push(entry);
    }

    return results;
  } catch (error) {
    console.warn("[TickProcessor] Discovery embedding failed:", error);
    return automaticResults;
  }
}

export function embedDiscoveries(
  discoveries: DiscoveryEntry[],
  dgsm: DynamicGameStateManager,
  language: "en" | "zh"
): void {
  if (discoveries.length === 0) return;
  const ragService = new SessionRagService();
  const state = dgsm.getState();
  const ragChunks = discoveries.map((entry) => ({
    sessionId: state.sessionId,
    chunkType: "discovery" as const,
    content: [
      "Discovery",
      `Type: ${entry.source}`,
      `Source: ${entry.sourceName}`,
      `Content: ${entry.text}`,
    ].join("\n"),
    metadata: {
      discoveryType: entry.source,
      sourceName: entry.sourceName,
      discoveredAt: `Day ${state.gameDay}, ${state.timeOfDay}`,
    },
    sourceKey: `discovery:${entry.id}`,
    language,
  }));
  void ragService
    .upsertChunks(ragChunks)
    .catch((err) =>
      console.error("[TickProcessor] Failed to embed discovery:", err)
    );
}
