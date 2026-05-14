import { ModelProviderName } from "../../../src/models/types.js";
import { EmbeddingClient } from "../../../src/rag/embedding.js";
import {
  type LocalEmbeddingLanguage,
  LocalEmbeddingManager,
} from "../../../src/rag/localEmbeddingManager.js";
import {
  getSkillDescription,
  getSkillDescriptionZh,
  getSkillNameZh,
} from "./skillDescriptions.js";

type SkillEntry = { name: string; value: number };
export type SuggestedSkill = {
  name: string;
  value: number;
  score: number;
  displayNameZh?: string;
};
type SkillDescriptor = { name: string; description?: string };

const provider =
  (process.env.MODEL_PROVIDER as ModelProviderName) || ModelProviderName.OPENAI;
const embedder = new EmbeddingClient(provider);
const localEmbedder = LocalEmbeddingManager.getInstance();

const skillEmbeddingCacheEn = new Map<string, number[]>();
const skillEmbeddingCacheZh = new Map<string, number[]>();
let warmupPromise: Promise<void> | null = null;

const getCachedEmbeddingDim = (cache: Map<string, number[]>): number | null => {
  for (const embedding of cache.values()) {
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

const truncateInput = (value: string, max = 80): string =>
  value.length <= max ? value : `${value.slice(0, max)}...`;

const buildSkillTextEn = (
  name: string,
  descriptionOverride?: string
): string => {
  const description = descriptionOverride?.trim() || getSkillDescription(name);
  if (!description || description === name) return name;
  return `${name}. ${description}`;
};

const buildSkillTextZh = (
  name: string,
  _descriptionOverride?: string
): string => {
  const zhName = getSkillNameZh(name);
  const description = getSkillDescriptionZh(name);
  if (!description || description === zhName) return zhName;
  return `${zhName}. ${description}`;
};

const embedText = async (
  language: LocalEmbeddingLanguage,
  text: string
): Promise<number[]> => {
  try {
    return await localEmbedder.embed(text, language);
  } catch (error) {
    console.warn(
      `[SkillSuggest] Local ${language} embedding failed, falling back to remote provider`,
      error
    );
  }

  try {
    return await embedder.embed(text, { skipLocal: true });
  } catch (error) {
    console.warn(
      `[SkillSuggest] Remote embedding failed for ${language}.`,
      error
    );
  }

  return [];
};

const embedAndCache = async (
  entries: SkillDescriptor[],
  cache: Map<string, number[]>,
  buildText: (name: string, descriptionOverride?: string) => string,
  language: LocalEmbeddingLanguage
): Promise<void> => {
  const missing = entries.filter((entry) => !cache.has(entry.name));
  if (missing.length === 0) return;

  const batchSize = 4;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (skill) => {
        const text = buildText(skill.name, skill.description);
        const embedding = await embedText(language, text);
        return { name: skill.name, embedding };
      })
    );

    for (const result of results) {
      if (result.embedding.length > 0) {
        cache.set(result.name, result.embedding);
      }
    }
  }
};

const ensureSkillEmbeddings = async (
  skills: SkillEntry[],
  cache: Map<string, number[]>,
  buildText: (name: string, descriptionOverride?: string) => string,
  language: LocalEmbeddingLanguage
): Promise<void> => {
  await embedAndCache(
    skills.map((skill) => ({ name: skill.name })),
    cache,
    buildText,
    language
  );
};

export const warmupSkillEmbeddings = async (
  entries: SkillDescriptor[]
): Promise<void> => {
  if (warmupPromise) return warmupPromise;
  warmupPromise = Promise.all([
    embedAndCache(entries, skillEmbeddingCacheEn, buildSkillTextEn, "en"),
    embedAndCache(entries, skillEmbeddingCacheZh, buildSkillTextZh, "zh"),
  ])
    .then(() => undefined)
    .finally(() => {
      warmupPromise = null;
    });
  return warmupPromise;
};

type LanguageKey = "en" | "zh";
export type SuggestSkillsResult = {
  language: LanguageKey;
  suggestions: SuggestedSkill[];
};

/**
 * Score skills using semantic vector similarity only
 * @param skills - List of character skills
 * @param cache - Embedding cache
 * @param queryEmbedding - Query vector embedding
 */
const scoreSkills = (
  skills: SkillEntry[],
  cache: Map<string, number[]>,
  queryEmbedding: number[]
): SuggestedSkill[] => {
  const scored: SuggestedSkill[] = [];

  for (const skill of skills) {
    const embedding = cache.get(skill.name);
    if (!embedding || embedding.length !== queryEmbedding.length) continue;

    // Vector similarity (0-1 range, normalized from cosine similarity -1 to 1)
    const vectorSimilarity = cosineSimilarity(queryEmbedding, embedding);
    const vectorScore = (vectorSimilarity + 1) / 2; // Normalize to 0-1

    scored.push({
      ...skill,
      score: vectorScore,
    });
  }

  return scored;
};

const sortScored = (scored: SuggestedSkill[]): SuggestedSkill[] =>
  scored.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.value !== a.value) return b.value - a.value;
    return a.name.localeCompare(b.name);
  });

export async function suggestSkillsFromInput(options: {
  input: string;
  skills: SkillEntry[];
  max?: number;
  language: LanguageKey;
}): Promise<SuggestSkillsResult> {
  const trimmed = options.input.trim();
  if (!trimmed) return { language: options.language, suggestions: [] };

  const max = Math.min(Math.max(options.max ?? 3, 1), 3);
  const skills = options.skills.slice();
  if (skills.length === 0)
    return { language: options.language, suggestions: [] };

  const logPrefix = `[SkillSuggest] input="${truncateInput(trimmed)}"`;
  const selectedLanguage = options.language;
  console.log(`${logPrefix} using selected language: ${selectedLanguage}`);

  const queryEmbedding = await embedText(selectedLanguage, trimmed);
  if (queryEmbedding.length === 0) {
    return { language: selectedLanguage, suggestions: [] };
  }

  const embedResult = await Promise.allSettled([
    selectedLanguage === "en"
      ? ensureSkillEmbeddings(
          skills,
          skillEmbeddingCacheEn,
          buildSkillTextEn,
          "en"
        )
      : ensureSkillEmbeddings(
          skills,
          skillEmbeddingCacheZh,
          buildSkillTextZh,
          "zh"
        ),
  ]);
  if (embedResult[0].status === "rejected") {
    console.warn(
      `[SkillSuggest] Failed to embed ${selectedLanguage} skills.`,
      embedResult[0].reason
    );
    return { language: selectedLanguage, suggestions: [] };
  }

  const scoreWithCache = async (
    language: LanguageKey,
    cache: Map<string, number[]>,
    buildText: (name: string, descriptionOverride?: string) => string,
    queryEmbedding: number[]
  ): Promise<SuggestedSkill[]> => {
    if (queryEmbedding.length === 0) return [];

    let scored = scoreSkills(skills, cache, queryEmbedding);
    if (scored.length > 0) return scored;

    const cachedDim = getCachedEmbeddingDim(cache);
    if (cachedDim && cachedDim !== queryEmbedding.length) {
      console.warn(
        `[SkillSuggest] ${language} embedding dimension mismatch (query=${queryEmbedding.length}, cache=${cachedDim}). Refreshing cache.`
      );
      cache.clear();
      try {
        await ensureSkillEmbeddings(skills, cache, buildText, language);
        scored = scoreSkills(skills, cache, queryEmbedding);
      } catch (error) {
        console.warn(
          `[SkillSuggest] Failed to refresh ${language} embeddings.`,
          error
        );
      }
    }
    return scored;
  };

  const scored =
    selectedLanguage === "en"
      ? await scoreWithCache(
          "en",
          skillEmbeddingCacheEn,
          buildSkillTextEn,
          queryEmbedding
        )
      : await scoreWithCache(
          "zh",
          skillEmbeddingCacheZh,
          buildSkillTextZh,
          queryEmbedding
        );

  if (scored.length === 0) {
    return { language: selectedLanguage, suggestions: [] };
  }

  const sorted = sortScored(scored);
  const picked = sorted.slice(0, Math.min(max, sorted.length));

  // Log semantic scores for debugging
  console.log(
    `${logPrefix} lang=${selectedLanguage} semantic-only → Top ${picked.length}: ${picked
      .map((s) => `${s.name}(score=${s.score.toFixed(3)})`)
      .join(", ")}`
  );

  return { language: selectedLanguage, suggestions: picked };
}
