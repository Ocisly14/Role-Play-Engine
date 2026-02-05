import { EmbeddingClient } from "../../../src/rag/embedding.js";
import { ModelProviderName } from "../../../src/models/types.js";
import { LocalEmbeddingManager, type LocalEmbeddingLanguage } from "../../../src/rag/localEmbeddingManager.js";
import {
  getSkillDescription,
  getSkillDescriptionZh,
  getSkillNameZh,
} from "./skillDescriptions.js";

type SkillEntry = { name: string; value: number };
export type SuggestedSkill = { name: string; value: number; score: number; displayNameZh?: string };
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

/**
 * Simple BM25 scoring for skill matching
 * @param query - User input query
 * @param document - Skill text (name + description)
 * @param avgDocLength - Average document length in corpus
 * @param k1 - Term frequency saturation parameter (default: 1.5)
 * @param b - Length normalization parameter (default: 0.75)
 */
const bm25Score = (
  query: string,
  document: string,
  avgDocLength: number,
  k1 = 1.5,
  b = 0.75
): number => {
  const queryTokens = tokenize(query);
  const docTokens = tokenize(document);
  const docLength = docTokens.length;

  if (docLength === 0 || queryTokens.length === 0) return 0;

  const docTermFreq = new Map<string, number>();
  for (const token of docTokens) {
    docTermFreq.set(token, (docTermFreq.get(token) || 0) + 1);
  }

  let score = 0;
  for (const queryToken of queryTokens) {
    const termFreq = docTermFreq.get(queryToken) || 0;
    if (termFreq === 0) continue;

    // Simplified BM25 (without IDF since we're scoring against individual documents)
    const numerator = termFreq * (k1 + 1);
    const denominator = termFreq + k1 * (1 - b + b * (docLength / avgDocLength));
    score += numerator / denominator;
  }

  return score;
};

/**
 * Tokenize text for BM25 (simple whitespace + punctuation split)
 * Handles both English and Chinese
 */
const tokenize = (text: string): string[] => {
  const normalized = text.toLowerCase().trim();

  // For Chinese text, split into characters
  const cjkCount = countMatches(normalized, /[\u4E00-\u9FFF]/g);
  if (cjkCount > 0) {
    // Mixed or Chinese text - split Chinese into characters, keep English words
    const tokens: string[] = [];
    let currentWord = '';

    for (const char of normalized) {
      if (/[\u4E00-\u9FFF]/.test(char)) {
        // Chinese character
        if (currentWord) {
          tokens.push(currentWord);
          currentWord = '';
        }
        tokens.push(char);
      } else if (/[a-z0-9]/.test(char)) {
        // English letter or number
        currentWord += char;
      } else {
        // Punctuation or space
        if (currentWord) {
          tokens.push(currentWord);
          currentWord = '';
        }
      }
    }

    if (currentWord) {
      tokens.push(currentWord);
    }

    return tokens.filter(t => t.length > 0);
  }

  // Pure English text - split by whitespace and punctuation
  return normalized
    .split(/[\s\p{P}]+/u)
    .filter(token => token.length > 0);
};

const formatSuggestionList = (items: SuggestedSkill[]): string =>
  items
    .map((item) => `${item.name} (${item.score.toFixed(3)})`)
    .join(", ");

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
    console.warn(`[SkillSuggest] Local ${language} embedding failed, falling back to remote provider`, error);
  }

  try {
    return await embedder.embed(text, { skipLocal: true });
  } catch (error) {
    console.warn(`[SkillSuggest] Remote embedding failed for ${language}.`, error);
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
export type SuggestSkillsResult = { language: LanguageKey; suggestions: SuggestedSkill[] };
const CJK_RATIO_THRESHOLD = 0.3;
const LATIN_RATIO_THRESHOLD = 0.7;
const MIN_CJK_COUNT = 1;
const MIN_LATIN_COUNT = 3;

/**
 * Score skills using hybrid BM25 + Vector search
 * @param skills - List of character skills
 * @param cache - Embedding cache
 * @param queryEmbedding - Query vector embedding
 * @param query - Raw query string (for BM25)
 * @param buildText - Function to build skill text for BM25
 * @param alpha - BM25 weight (0 = pure vector, 1 = pure BM25)
 */
const scoreSkills = (
  skills: SkillEntry[],
  cache: Map<string, number[]>,
  queryEmbedding: number[],
  query: string,
  buildText: (name: string, descriptionOverride?: string) => string,
  alpha = 0.3
): SuggestedSkill[] => {
  // Calculate average document length for BM25
  const skillTexts = skills.map(skill => buildText(skill.name));
  const avgDocLength = skillTexts.reduce(
    (sum, text) => sum + tokenize(text).length,
    0
  ) / Math.max(skillTexts.length, 1);

  const scored: SuggestedSkill[] = [];

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    const embedding = cache.get(skill.name);
    if (!embedding || embedding.length !== queryEmbedding.length) continue;

    // Vector similarity (0-1 range, normalized from cosine similarity -1 to 1)
    const vectorSimilarity = cosineSimilarity(queryEmbedding, embedding);
    const vectorScore = (vectorSimilarity + 1) / 2; // Normalize to 0-1

    // BM25 score
    const skillText = skillTexts[i];
    const bm25Raw = bm25Score(query, skillText, avgDocLength);

    // Normalize BM25 scores (will be done after collecting all scores)
    scored.push({
      ...skill,
      score: 0, // Will be calculated after normalization
      vectorScore,
      bm25Raw
    } as SuggestedSkill & { vectorScore: number; bm25Raw: number });
  }

  // Normalize BM25 scores to 0-1 range
  const maxBM25 = Math.max(...scored.map((s: any) => s.bm25Raw), 1e-10);
  const minBM25 = Math.min(...scored.map((s: any) => s.bm25Raw), 0);
  const bm25Range = maxBM25 - minBM25 || 1;

  // Calculate hybrid scores
  for (const item of scored as any[]) {
    const normalizedBM25 = (item.bm25Raw - minBM25) / bm25Range;
    item.bm25Score = normalizedBM25;

    // Hybrid fusion: alpha * BM25 + (1 - alpha) * Vector
    item.score = alpha * normalizedBM25 + (1 - alpha) * item.vectorScore;
  }

  return scored;
};

const sortScored = (scored: SuggestedSkill[]): SuggestedSkill[] =>
  scored
    .slice()
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.value !== a.value) return b.value - a.value;
      return a.name.localeCompare(b.name);
    });

const countMatches = (value: string, regex: RegExp): number => {
  const matches = value.match(regex);
  return matches ? matches.length : 0;
};

const detectLanguage = (input: string): { language: LanguageKey; cjk: number; latin: number; ratio: number } => {
  const cjk = countMatches(input, /[\u4E00-\u9FFF]/g);
  const latin = countMatches(input, /[A-Za-z]/g);
  const total = cjk + latin;
  const ratio = total > 0 ? cjk / total : 0;

  if (cjk >= MIN_CJK_COUNT && ratio >= CJK_RATIO_THRESHOLD) {
    return { language: "zh", cjk, latin, ratio };
  }
  if (latin >= MIN_LATIN_COUNT && (1 - ratio) >= LATIN_RATIO_THRESHOLD) {
    return { language: "en", cjk, latin, ratio };
  }
  if (cjk > latin) return { language: "zh", cjk, latin, ratio };
  return { language: "en", cjk, latin, ratio };
};

export async function suggestSkillsFromInput(options: {
  input: string;
  skills: SkillEntry[];
  max?: number;
  preferredLanguage?: 'en' | 'zh'; // Use session language if available
}): Promise<SuggestSkillsResult> {
  const trimmed = options.input.trim();
  if (!trimmed) return { language: "en", suggestions: [] };

  const max = Math.min(Math.max(options.max ?? 3, 1), 3);
  const skills = options.skills.slice();
  if (skills.length === 0) return { language: "en", suggestions: [] };

  const logPrefix = `[SkillSuggest] input="${truncateInput(trimmed)}"`;

  // Use preferred language from session if available, otherwise auto-detect
  const detected = options.preferredLanguage
    ? { language: options.preferredLanguage, cjk: 0, latin: 0, ratio: 0 }
    : detectLanguage(trimmed);

  if (options.preferredLanguage) {
    console.log(`${logPrefix} using session language: ${options.preferredLanguage}`);
  } else {
    console.log(`${logPrefix} auto-detected language: ${detected.language} (CJK=${detected.cjk}, Latin=${detected.latin})`);
  }

  const queryEmbedding = await embedText(detected.language, trimmed);
  if (queryEmbedding.length === 0) {
    return { language: detected.language, suggestions: [] };
  }

  const embedResult = await Promise.allSettled([
    detected.language === "en"
      ? ensureSkillEmbeddings(skills, skillEmbeddingCacheEn, buildSkillTextEn, "en")
      : ensureSkillEmbeddings(skills, skillEmbeddingCacheZh, buildSkillTextZh, "zh"),
  ]);
  if (embedResult[0].status === "rejected") {
    console.warn(`[SkillSuggest] Failed to embed ${detected.language} skills.`, embedResult[0].reason);
    return { language: detected.language, suggestions: [] };
  }

  // Set alpha based on language: English 0.3, Chinese 0.1 (lower for Chinese)
  const alpha = detected.language === "zh" ? 0.1 : 0.3;

  const scoreWithCache = async (
    language: LanguageKey,
    cache: Map<string, number[]>,
    buildText: (name: string, descriptionOverride?: string) => string,
    queryEmbedding: number[],
    alpha: number
  ): Promise<SuggestedSkill[]> => {
    if (queryEmbedding.length === 0) return [];

    let scored = scoreSkills(skills, cache, queryEmbedding, trimmed, buildText, alpha);
    if (scored.length > 0) return scored;

    const cachedDim = getCachedEmbeddingDim(cache);
    if (cachedDim && cachedDim !== queryEmbedding.length) {
      console.warn(
        `[SkillSuggest] ${language} embedding dimension mismatch (query=${queryEmbedding.length}, cache=${cachedDim}). Refreshing cache.`
      );
      cache.clear();
      try {
        await ensureSkillEmbeddings(skills, cache, buildText, language);
        scored = scoreSkills(skills, cache, queryEmbedding, trimmed, buildText, alpha);
      } catch (error) {
        console.warn(`[SkillSuggest] Failed to refresh ${language} embeddings.`, error);
      }
    }
    return scored;
  };

  const scored = detected.language === "en"
    ? await scoreWithCache("en", skillEmbeddingCacheEn, buildSkillTextEn, queryEmbedding, alpha)
    : await scoreWithCache("zh", skillEmbeddingCacheZh, buildSkillTextZh, queryEmbedding, alpha);

  if (scored.length === 0) {
    return { language: detected.language, suggestions: [] };
  }

  const sorted = sortScored(scored);
  const picked = sorted.slice(0, Math.min(max, sorted.length));

  // Log hybrid scores for debugging
  console.log(
    `${logPrefix} lang=${detected.language} α=${alpha.toFixed(2)} → Top ${picked.length}: ` +
    picked.map((s: any) =>
      `${s.name}(hybrid=${s.score.toFixed(3)}, vec=${s.vectorScore?.toFixed(3) || 'N/A'}, bm25=${s.bm25Score?.toFixed(3) || 'N/A'})`
    ).join(', ')
  );

  return { language: detected.language, suggestions: picked };
}
