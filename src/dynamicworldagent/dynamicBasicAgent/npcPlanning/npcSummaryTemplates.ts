import type { PromptParts } from "./npcPlanningTemplates.js";

function contentLanguageName(language: string): string {
  return language?.startsWith("zh") ? "Chinese" : "English";
}

// ===================== Day Memory Summarization =====================

export interface SummarizeDayMemoryParams {
  npcName: string;
  npcProfile: string;
  gameDay: number;
  eventLog: string;
  /** Formatted list of NPC's existing knowledge (from information/secret memories) */
  existingKnowledge: string;
  /** Formatted list of NPC's current beliefs */
  existingBeliefs: string;
  language: string;
}

export function buildSummarizeDayMemoryPrompt(
  params: SummarizeDayMemoryParams
): PromptParts {
  const lang = contentLanguageName(params.language);

  const systemPrompt = `You are an NPC character in a Call of Cthulhu tabletop RPG.

## Task
It's the end of the day. Review what you experienced and witnessed today and produce:
1. **Diary memories**: Short diary-style paragraphs capturing the day's key moments.
2. **New knowledge**: Any facts or secrets you learned today that you didn't already know.
3. **Updated knowledge**: Corrections or updates to your existing knowledge based on today's events.
4. **Updated beliefs**: Changes to your beliefs — reinforced, weakened, or disproven by today's events.

## Instructions

### Diary Memories
- Write each memory as a short first-person diary paragraph (2-3 sentences).
- Include your feelings, reactions, and impressions — this is your private diary.
- Group related events into one entry; separate distinct themes into different entries.
- **importance** (1-5): 1 = minor detail, 2 = routine but worth noting, 3 = significant event, 4 = major turning point, 5 = critical/life-threatening
- Focus on: important events, relationship changes, emotional moments, threats or opportunities.
- Drop routine actions unless something notable happened during them.

### New Knowledge
- Review today's events for new information you learned.
- For things others told you or you observed/deduced, create an entry.
- Do NOT include knowledge you already have (check "Your Existing Knowledge").
- **category**: "knowledge" for facts and information, "secret" for things you want to keep hidden from others.
- **difficulty**: How hard it would be for someone to extract this from you — "automatic" (you'd share freely), "regular", "hard", "extreme" (you'd never willingly reveal).

### Updated Knowledge
- Review your existing knowledge against today's events.
- If any existing knowledge is now **wrong**, **outdated**, or needs **correction**, include an update.
- Reference the existing knowledge by its **id** (from "Your Existing Knowledge").
- Provide the corrected text, or set **action** to "remove" to mark it as invalid.
- Only include entries that actually need changing. Omit this array if nothing changed.

### Updated Beliefs
- Review your current beliefs against today's events.
- If a belief is **reinforced**, increase its confidence (max 1.0).
- If a belief is **weakened** or **disproven**, decrease its confidence (min 0.0, where 0.0 = completely disproven).
- Reference the belief by its **id** (from "Your Current Beliefs").
- Provide a brief **reason** explaining your reasoning for the confidence change.
- Only include beliefs that actually changed. Omit this array if nothing changed.

## Output
Return a JSON object. No extra text. JSON keys must be in English. Write all text content in ${lang}.

\`\`\`json
{
  "memories": [
    { "content": "A short diary paragraph. 2-3 sentences.", "importance": 3 }
  ],
  "newKnowledge": [
    { "id": "learned_day1_1", "text": "what you learned", "category": "knowledge", "difficulty": "regular" }
  ],
  "updatedKnowledge": [
    { "id": "existing_knowledge_id", "text": "corrected content", "action": "update" }
  ],
  "updatedBeliefs": [
    { "id": "existing_belief_id", "confidence": 0.3, "reason": "why it changed" }
  ]
}
\`\`\``;

  const userPrompt = `## Day ${params.gameDay}

## Who You Are
${params.npcProfile}

## Your Existing Knowledge
${params.existingKnowledge || "(none)"}

## Your Current Beliefs
${params.existingBeliefs || "(none)"}

## Today's Events
${params.eventLog}`;

  return { systemPrompt, userPrompt };
}
