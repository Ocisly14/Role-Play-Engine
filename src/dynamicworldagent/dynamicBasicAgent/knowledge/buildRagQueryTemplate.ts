export interface RecentTurnContext {
  turnNumber: number;
  playerInput: string;
  keeperNarrative: string;
}

export interface BuildRagQueryTemplateInput {
  question: string;
  sceneName?: string | null;
  sceneLocation?: string | null;
  npcNames?: string[];
  language?: "en" | "zh";
  recentTurns?: RecentTurnContext[];
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
          .map((t) => `[Turn ${t.turnNumber}]\nPlayer: ${t.playerInput}\nKeeper: ${t.keeperNarrative}`)
          .join("\n")
      : "(none)";

  return `You rewrite player questions for retrieval.

Rules:
1. Keep intent unchanged.
2. Use Recent Turns to understand conversational context and resolve pronouns or references.
3. Inject relevant scene/NPC names when useful.
4. Do NOT invent entities not listed below.
5. Return STRICT JSON only.
6. Do NOT answer the question.
7. Output ragQuery in ${outputLang}.

Question:
${question}

Recent Turns (for context only):
${recentTurnsBlock}

Known Scene:
- sceneName: ${sceneName || ""}
- sceneLocation: ${sceneLocation || ""}

Known NPCs:
${dedupedNpcNames.length > 0 ? dedupedNpcNames.map((name) => `- ${name}`).join("\n") : "- (none)"}

Return JSON schema:
{
  "ragQuery": "string",
  "keywords": ["string"],
  "entities": {
    "sceneNames": ["string"],
    "npcNames": ["string"]
  }
}`;
}
