import type { NpcMemory } from "@prisma/client";
import type { ScoredMemory, ReasoningTrigger } from "../types.js";
import { getAllHandlers } from "../handlers/index.js";

export interface ReasoningPromptParams {
  npcName: string;
  npcProfile: string;
  memories: ScoredMemory[];
  existingBeliefs: NpcMemory[];
  trigger: ReasoningTrigger;
  triggerContext?: string;
  language?: string;
}

export function buildReasoningPrompt(params: ReasoningPromptParams): string {
  const handlers = getAllHandlers();
  const lang = params.language ?? "en";

  // Format existing beliefs
  const beliefsSection =
    params.existingBeliefs.length > 0
      ? params.existingBeliefs
          .map((b) => {
            const meta = b.metadata as Record<string, any> | null;
            const confidence = meta?.confidence ?? 0;
            const reasoning = meta?.reasoningChain ?? "";
            return `- ${b.content} (confidence: ${confidence})\n  Reasoning: ${reasoning}`;
          })
          .join("\n")
      : "None yet.";

  // Format relevant memories
  const memoriesSection =
    params.memories.length > 0
      ? params.memories.map((m) => `- ${handlers[m.type].format(m)}`).join("\n")
      : "No relevant memories.";

  // Trigger context description
  const triggerMap: Record<ReasoningTrigger, string> = {
    day_transition: "End of day review — reflecting on today's events",
    high_impact: "High-impact event just occurred",
    player_question: "Player provided new information",
    information_discovered: "New information discovered",
    witness_major: "Witnessed a major event",
  };
  const triggerDesc = params.triggerContext ?? triggerMap[params.trigger];

  const instruction =
    lang === "zh"
      ? `基于你的人设、已有认知和记忆，判断：
1. 是否能形成新的推论/怀疑？
2. 已有的 belief 是否需要修正（提高/降低 confidence）？

输出 JSON（如果没有新推论也无需修正，返回空数组）：`
      : `Based on your persona, existing beliefs, and memories:
1. Can you form new conclusions/suspicions?
2. Do existing beliefs need revision (raise/lower confidence)?

Output JSON (return empty arrays if no new conclusions and no revisions needed):`;

  return `## You are ${params.npcName}
${params.npcProfile}

## Your existing beliefs
${beliefsSection}

## Relevant memories
${memoriesSection}

## Trigger context
${triggerDesc}

## Task
${instruction}
{
  "newBeliefs": [
    {
      "belief": "Specific conclusion",
      "confidence": 0.0~1.0,
      "reasoningChain": "Because A, combined with B, I believe C"
    }
  ],
  "updatedBeliefs": [
    {
      "originalBelief": "Original belief content",
      "newConfidence": 0.0~1.0,
      "reason": "Why revised"
    }
  ]
}`;
}

export function parseReasoningOutput(raw: string): {
  newBeliefs: Array<{
    belief: string;
    confidence: number;
    reasoningChain: string;
  }>;
  updatedBeliefs: Array<{
    originalBelief: string;
    newConfidence: number;
    reason: string;
  }>;
} {
  // Strip markdown fences if present
  const cleaned = raw
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      newBeliefs: Array.isArray(parsed.newBeliefs) ? parsed.newBeliefs : [],
      updatedBeliefs: Array.isArray(parsed.updatedBeliefs)
        ? parsed.updatedBeliefs
        : [],
    };
  } catch {
    return { newBeliefs: [], updatedBeliefs: [] };
  }
}
