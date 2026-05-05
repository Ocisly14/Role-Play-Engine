// src/roleSim/dailySummarization.ts
//
// Standalone daily summarization. Replaces the legacy
// NPCPlanningAgent.summarizeAllNpcDayMemory + summarizeDayMemory. Slimmed per
// Decision 25: summary-only output, ISO YYYY-MM-DD prefix when
// ModuleSetup.startDate is set, "[Day N]" fallback otherwise. No imports from
// src/planning/ — that module is being deleted.

import { parseJsonResponse } from "../engine/shared/jsonParse.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import { ModelClass, generateText } from "../models/index.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";

/**
 * Resolve in-world calendar date for a given gameDay.
 * Returns "[YYYY-MM-DD]" when ModuleSetup.startDate is a valid ISO 8601 date,
 * "[Day N]" otherwise.
 */
export function formatDayPrefix(gameDay: number, startDate?: string): string {
  if (!startDate) {
    console.warn(
      `[dailySummarization] ModuleSetup.startDate not set; falling back to "[Day ${gameDay}]" prefix. ` +
        `Add a startDate field to enable ISO calendar dating.`
    );
    return `[Day ${gameDay}]`;
  }
  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) {
    console.warn(
      `[dailySummarization] startDate "${startDate}" is not a valid ISO 8601 date ` +
        `(expected YYYY-MM-DD); falling back to "[Day ${gameDay}]"`
    );
    return `[Day ${gameDay}]`;
  }
  const result = new Date(start);
  result.setUTCDate(result.getUTCDate() + (gameDay - 1));
  return `[${result.toISOString().slice(0, 10)}]`;
}

interface SummaryItem {
  content: string;
  importance: number;
}

function buildSummaryPrompt(params: {
  npcName: string;
  npcProfile: string;
  gameDay: number;
  dayPrefix: string;
  eventLog: string;
  language: string;
}): { systemPrompt: string; userPrompt: string } {
  const lang = params.language?.startsWith("zh") ? "Chinese" : "English";

  const systemPrompt = `You are an NPC reflecting on the day at bedtime. Write 1-4 short
diary-style memories in first person summarizing today's significant events and
your reactions to them. Each memory must start with "${params.dayPrefix} " so
future-you can date it. Drop routine actions; focus on important events,
relationship changes, emotional moments. Each memory is 2-3 sentences.

importance: 1=minor, 2=routine, 3=significant, 4=major turning point, 5=critical.

Return JSON only. Write content in ${lang}.

\`\`\`json
{
  "memories": [
    { "content": "${params.dayPrefix} ...", "importance": 3 }
  ]
}
\`\`\``;

  const userPrompt = `## You are ${params.npcName}
${params.npcProfile}

## Today's Events (Day ${params.gameDay})
${params.eventLog}`;

  return { systemPrompt, userPrompt };
}

export async function summarizeDayMemory(params: {
  dgsm: DynamicGameStateManager;
  memoryManager: NpcMemoryManager;
  sessionId: string;
  moduleId: string;
  npcId: string;
  gameDay: number;
  language: string;
  startDate?: string;
}): Promise<void> {
  if (!params.dgsm.isNpcAlive(params.npcId)) return;

  const events = await params.memoryManager.getForDayByTypes(
    params.npcId,
    params.sessionId,
    params.gameDay,
    ["event", "witness"]
  );
  if (events.length === 0) return;

  const npc = params.dgsm
    .getState()
    .npcCharacters.find((n) => n.id === params.npcId);
  if (!npc) return;

  const dayPrefix = formatDayPrefix(params.gameDay, params.startDate);
  const eventLog = events
    .map((e) => `- [${e.gameTime}] (${e.type}) ${e.content}`)
    .join("\n");

  const profileBits: string[] = [npc.name];
  if (npc.occupation) profileBits.push(npc.occupation);
  if (npc.age != null) profileBits.push(`age ${npc.age}`);

  const { systemPrompt, userPrompt } = buildSummaryPrompt({
    npcName: npc.name,
    npcProfile: profileBits.join(", "),
    gameDay: params.gameDay,
    dayPrefix,
    eventLog,
    language: params.language,
  });

  console.log(`[dailySummarization] 📝 Day ${params.gameDay} for ${npc.name}`);
  const response = await generateText({
    customSystemPrompt: systemPrompt,
    context: userPrompt,
    modelClass: ModelClass.MEDIUM,
    operation: "daily-summarization",
  });

  let parsed: { memories: SummaryItem[] };
  try {
    parsed = parseJsonResponse<{ memories: SummaryItem[] }>(response);
  } catch (err) {
    console.warn(
      `[dailySummarization] ${npc.name}: JSON parse failed, skipping summary:`,
      err instanceof Error ? err.message : err
    );
    return;
  }

  await Promise.all(
    parsed.memories.map((m) =>
      params.memoryManager.add({
        npcId: params.npcId,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        type: "summary",
        content: m.content,
        gameDay: params.gameDay,
        gameTime: "23:59",
        metadata: { importance: m.importance },
      })
    )
  );
}

export async function summarizeAllNpcDayMemory(params: {
  dgsm: DynamicGameStateManager;
  memoryManager: NpcMemoryManager;
  sessionId: string;
  moduleId: string;
  gameDay: number;
  language: string;
}): Promise<void> {
  const startDate = params.dgsm.getState().moduleSetup?.startDate as
    | string
    | undefined;
  const npcs = params.dgsm.getSimulatedNpcs();
  // TODO(post-Phase-F): rate-limit when npcs.length is large. Promise.all
  // fires N concurrent LLM calls — risk of hitting Anthropic RPM limits on
  // sessions with many NPCs. Acceptable for MVP (matches legacy behavior in
  // NPCPlanningAgent.summarizeAllNpcDayMemory). Per-NPC failures are
  // already isolated by summarizeDayMemory's try/catch.
  await Promise.all(
    npcs.map((npc) =>
      summarizeDayMemory({
        ...params,
        npcId: npc.id,
        startDate,
      })
    )
  );
}
