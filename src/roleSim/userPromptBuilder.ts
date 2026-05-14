// src/roleSim/userPromptBuilder.ts
//
// Builds the per-tick user prompt for LLMRoleSimAgent. Conditional sections
// are omitted when their data is absent (no empty headers). Profile, memory,
// and perception are delegated to focused formatter helpers. Language line
// at the end mirrors the old planner's `contentLanguageName` convention.

import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import { formatForPrompt } from "../state/gameClock.js";
import type { RoleSimContext } from "./agent.js";
import { formatTodayMemories } from "./memoryFormatter.js";
import { formatProfile } from "./profileFormatter.js";

export interface BuildUserPromptOptions {
  language: string;
  dgsm: DynamicGameStateManager;
}

export function buildUserPrompt(
  ctx: RoleSimContext,
  transcript: string[],
  opts: BuildUserPromptOptions
): string {
  const sections: string[] = [];

  sections.push(`# You are ${ctx.npcProfile.name}`);

  sections.push(`## Who you are\n${formatProfile(ctx.npcProfile, opts.dgsm)}`);

  sections.push(
    `## Right now\nToday: ${formatForPrompt(ctx.currentTime)}\nScene: ${ctx.currentScene}`
  );

  if (ctx.recentPerceptions && ctx.recentPerceptions.length > 0) {
    const block = ctx.recentPerceptions
      .map((p) => `--- ${formatForPrompt(p.gameDateTime)} ---\n${p.narrative}`)
      .join("\n\n");
    sections.push(
      `## Recently (short-term memory — last ${ctx.recentPerceptions.length} tick(s))\n${block}`
    );
  }

  if (ctx.perception?.narrative) {
    sections.push(`## What you perceive\n${ctx.perception.narrative}`);
  }

  if (ctx.longTermIntent?.trim()) {
    sections.push(`## Your long-term goal\n${ctx.longTermIntent}`);
  }

  if (ctx.currentAction) {
    sections.push(`## Currently doing\n"${ctx.currentAction.actionText}"`);
  }

  if (ctx.recentMemory.length > 0) {
    sections.push(
      `## Today's memories\n${formatTodayMemories(ctx.recentMemory)}`
    );
  }

  if (transcript.length > 0) {
    sections.push(
      `## Tool calls so far this decision\n${transcript.join("\n")}`
    );
  }

  const langName = opts.language?.startsWith("zh") ? "Chinese" : "English";
  sections.push(
    `## Decide\nOutput a single JSON object using a tool from the system prompt.\nWrite content in ${langName}.`
  );

  return sections.join("\n\n");
}
