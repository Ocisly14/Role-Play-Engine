export interface BuildRagQueryTemplateInput {
  question: string;
  sceneName?: string | null;
  sceneLocation?: string | null;
  npcNames?: string[];
  language?: "en" | "zh";
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
}: BuildRagQueryTemplateInput): string {
  const dedupedNpcNames = Array.from(
    new Set(
      npcNames
        .map((name) => (typeof name === "string" ? name.trim() : ""))
        .filter((name) => name.length > 0)
    )
  ).slice(0, 20);

  const outputLang = language === "en" ? "English" : "Chinese";

  return `You rewrite player questions for retrieval.

Rules:
1. Keep intent unchanged.
2. Inject relevant scene/NPC names when useful.
3. Do NOT invent entities not listed below.
4. Return STRICT JSON only.
5. Do NOT answer the question.
6. Output ragQuery in ${outputLang}.

Question:
${question}

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
