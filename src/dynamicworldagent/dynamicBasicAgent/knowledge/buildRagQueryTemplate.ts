export interface RecentTurnContext {
  turnNumber: number;
  playerInput: string;
  keeperNarrative: string;
}

export interface SceneContext {
  name: string;
  description: string;
}

export interface BuildRagQueryTemplateInput {
  question: string;
  sceneName?: string | null;
  sceneLocation?: string | null;
  npcNames?: string[];
  language?: "en" | "zh";
  recentTurns?: RecentTurnContext[];
  allScenes?: SceneContext[];
}

/**
 * Build a strict JSON prompt for RAG query rewrite.
 * This prompt is intentionally compact because it runs on SMALL model class.
 */
export function buildRagQueryTemplate({
  question,
  sceneName,
  sceneLocation,
  npcNames = [],
  language = "zh",
  recentTurns = [],
  allScenes = [],
}: BuildRagQueryTemplateInput): string {
  const dedupedNpcNames = Array.from(
    new Set(
      npcNames
        .map((name) => (typeof name === "string" ? name.trim() : ""))
        .filter((name) => name.length > 0)
    )
  ).slice(0, 20);

  const outputLang = language === "en" ? "English" : "Chinese";

  const recentTurnsBlock =
    recentTurns.length > 0
      ? recentTurns
          .map(
            (t) =>
              `[Turn ${t.turnNumber}]\nPlayer: ${t.playerInput}\nKeeper: ${t.keeperNarrative}`
          )
          .join("\n")
      : "(none)";

  const allScenesBlock =
    allScenes.length > 0
      ? allScenes.map((s) => `- ${s.name}: ${s.description}`).join("\n")
      : "- (none)";

  return `You are a query rewriting assistant for a Call of Cthulhu RPG session memory retrieval system.

Your task: rewrite the player's question into a standalone, retrieval-optimized search query.

Rules:
1. Preserve the original intent exactly — do NOT answer or interpret the question.
2. Resolve all pronouns and ambiguous references using Recent Turns (e.g. "he" → NPC name, "there" → location name).
3. Make the query self-contained — it must be understandable without any conversation context.
4. Inject specific entity names (scene, NPC, location) from the context below when they are clearly relevant.
5. Only use entities listed in the context. Do NOT invent names or facts.
6. Prefer concrete nouns and key phrases over vague terms.
7. Output ragQuery in ${outputLang}.
8. Return STRICT JSON only — no explanation, no markdown.

Player Question:
${question}

Recent Turns (use to resolve context and pronouns):
${recentTurnsBlock}

Current Scene:
- Name: ${sceneName || "(unknown)"}
- Location: ${sceneLocation || "(unknown)"}

All Known Scenes:
${allScenesBlock}

Known NPCs:
${dedupedNpcNames.length > 0 ? dedupedNpcNames.map((name) => `- ${name}`).join("\n") : "- (none)"}

Return JSON:
{"ragQuery": "string"}`;
}
