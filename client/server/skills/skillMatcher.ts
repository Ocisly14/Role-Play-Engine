import { EmbeddingClient } from "../../../src/rag/embedding.js";
import { ModelProviderName } from "../../../src/models/types.js";
import { getSkillDescription } from "./skillDescriptions.js";

type SkillEntry = { name: string; value: number };
export type SuggestedSkill = { name: string; value: number; score: number };
type SkillDescriptor = { name: string; description?: string };

const provider =
  (process.env.MODEL_PROVIDER as ModelProviderName) || ModelProviderName.OPENAI;
const embedder = new EmbeddingClient(provider);

const skillEmbeddingCache = new Map<string, number[]>();
let warmupPromise: Promise<void> | null = null;

const getCachedEmbeddingDim = (): number | null => {
  for (const embedding of skillEmbeddingCache.values()) {
    if (embedding.length > 0) return embedding.length;
  }
  return null;
};

const cosineSimilarity = (a: number[], b: number[]): number => {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
};

const formatSuggestionList = (items: SuggestedSkill[]): string =>
  items
    .map((item) => `${item.name} (${item.score.toFixed(3)})`)
    .join(", ");

const truncateInput = (value: string, max = 80): string =>
  value.length <= max ? value : `${value.slice(0, max)}...`;

const buildSkillText = (name: string, descriptionOverride?: string): string => {
  const description = descriptionOverride?.trim() || getSkillDescription(name);
  if (!description || description === name) return name;
  return `${name}. ${description}`;
};

const embedAndCache = async (entries: SkillDescriptor[]): Promise<void> => {
  const missing = entries.filter((entry) => !skillEmbeddingCache.has(entry.name));
  if (missing.length === 0) return;

  const batchSize = 4;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (skill) => {
        const text = buildSkillText(skill.name, skill.description);
        const embedding = await embedder.embed(text);
        return { name: skill.name, embedding };
      })
    );

    for (const result of results) {
      if (result.embedding.length > 0) {
        skillEmbeddingCache.set(result.name, result.embedding);
      }
    }
  }
};

const ensureSkillEmbeddings = async (skills: SkillEntry[]): Promise<void> => {
  await embedAndCache(skills.map((skill) => ({ name: skill.name })));
};

export const warmupSkillEmbeddings = async (
  entries: SkillDescriptor[]
): Promise<void> => {
  if (warmupPromise) return warmupPromise;
  warmupPromise = embedAndCache(entries).finally(() => {
    warmupPromise = null;
  });
  return warmupPromise;
};

export async function suggestSkillsFromInput(options: {
  input: string;
  skills: SkillEntry[];
  max?: number;
}): Promise<SuggestedSkill[]> {
  const trimmed = options.input.trim();
  if (!trimmed) return [];

  const max = Math.min(Math.max(options.max ?? 3, 1), 3);
  const skills = options.skills.slice();
  if (skills.length === 0) return [];

  const logPrefix = `[SkillSuggest] input="${truncateInput(trimmed)}"`;

  let queryEmbedding: number[] = [];
  try {
    queryEmbedding = await embedder.embed(trimmed);
  } catch (error) {
    console.warn("[SkillSuggest] Failed to embed query.", error);
    console.log(`${logPrefix} source=none reason=query_embed_failed`);
    return [];
  }

  if (queryEmbedding.length === 0) {
    console.log(`${logPrefix} source=none reason=query_embedding_empty`);
    return [];
  }

  try {
    await ensureSkillEmbeddings(skills);
  } catch (error) {
    console.warn("[SkillSuggest] Failed to embed skills.", error);
    console.log(`${logPrefix} source=none reason=skill_embed_failed`);
    return [];
  }

  const scored: SuggestedSkill[] = [];
  for (const skill of skills) {
    const embedding = skillEmbeddingCache.get(skill.name);
    if (!embedding || embedding.length !== queryEmbedding.length) continue;
    const score = cosineSimilarity(queryEmbedding, embedding);
    scored.push({ ...skill, score });
  }

  if (scored.length === 0) {
    const cachedDim = getCachedEmbeddingDim();
    if (cachedDim && cachedDim !== queryEmbedding.length) {
      console.warn(
        `[SkillSuggest] Embedding dimension mismatch (query=${queryEmbedding.length}, cache=${cachedDim}). Refreshing cache.`
      );
      skillEmbeddingCache.clear();
      try {
        await ensureSkillEmbeddings(skills);
        for (const skill of skills) {
          const embedding = skillEmbeddingCache.get(skill.name);
          if (!embedding || embedding.length !== queryEmbedding.length) continue;
          const score = cosineSimilarity(queryEmbedding, embedding);
          scored.push({ ...skill, score });
        }
      } catch (error) {
        console.warn("[SkillSuggest] Failed to refresh embeddings.", error);
      }
    }
  }

  if (scored.length === 0) {
    console.log(`${logPrefix} source=none reason=no_scored_matches`);
    return [];
  }

  const sorted = scored
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.value !== a.value) return b.value - a.value;
      return a.name.localeCompare(b.name);
    });
  const picked = sorted.slice(0, Math.min(max, sorted.length));
  console.log(`${logPrefix} source=semantic suggestions=${formatSuggestionList(picked)}`);
  return picked;
}
