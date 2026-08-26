// src/roleSim/userPromptBuilder.ts
//
// Builds the per-tick user prompt for LLMRoleSimAgent. Conditional sections
// are omitted when their data is absent (no empty headers). Profile, memory,
// and perception are delegated to focused formatter helpers. Language line
// at the end mirrors the old planner's `contentLanguageName` convention.

import type { PromptSegment } from "../models/types.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import { formatForPrompt } from "../state/gameClock.js";
import type { RoleSimContext } from "./agent.js";
import { formatTodayMemories } from "./memoryFormatter.js";
import { formatProfile } from "./profileFormatter.js";

export interface BuildUserPromptOptions {
  language: string;
  dgsm: DynamicGameStateManager;
}

/**
 * Segmented form of {@link buildUserPrompt}, split at the two points where
 * prompt stability changes. Concatenating the segment texts reproduces
 * `buildUserPrompt`'s output byte for byte.
 *
 * The groups, outermost-lived first:
 *  1. **identity** — name + profile. NOT currently breakpointed: `formatProfile`
 *     embeds the live status line (HP / SAN / fatigue / conditions) plus
 *     inventory and relationships, and the stamina subsystem moves fatigue on
 *     most ticks — so these bytes change nearly every tick and a breakpoint
 *     here would pay the write premium without ever being read. Kept as its
 *     own segment so that if the mutable status is ever lifted out of the
 *     profile block, enabling a session-lived breakpoint is a one-flag change.
 *  2. **situation** — time, scene, perceptions, goal, current action, today's
 *     memories. Frozen for the whole tick, so a breakpoint at its end (which
 *     caches the system prompt and the identity block along with it) is read
 *     by every later iteration of the same decide() loop.
 *  3. **volatile** — the tool-call transcript (grows every iteration) and the
 *     decide instruction. The instruction sits *after* the transcript, so one
 *     iteration's prompt is never a prefix of the next: no breakpoint.
 */
export function buildUserPromptSegments(
  ctx: RoleSimContext,
  transcript: string[],
  opts: BuildUserPromptOptions
): PromptSegment[] {
  const identity: string[] = [];
  const situation: string[] = [];
  const volatile: string[] = [];

  identity.push(`# You are ${ctx.npcProfile.name}`);

  identity.push(`## Who you are\n${formatProfile(ctx.npcProfile, opts.dgsm)}`);

  const sections = situation;

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
    volatile.push(
      `## Tool calls so far this decision\n${transcript.join("\n")}`
    );
  }

  if (ctx.formatErrorFeedback) {
    volatile.push(
      `## Your previous action was REJECTED (format error)
The engine could not parse the actionText of your last \`act\` call:
${ctx.formatErrorFeedback}

Re-issue the SAME intended action with valid formatting: \`[narrative]\` on
its own line, real line breaks (never a literal backslash-n), and one
\`[references]\` line for every [N] cited.`
    );
  }

  const langName = opts.language?.startsWith("zh") ? "Chinese" : "English";
  // The perception sections above are rendered as `[narrative]` /
  // `[references]` blocks, which is also the shape of `act`'s actionText.
  // Naming that explicitly still matters: the model has to put the narrative
  // INSIDE the tool argument rather than answering in that shape. The
  // envelope itself is now enforced by the API (a tool call is required), so
  // this no longer has to describe JSON.
  volatile.push(
    `## Decide
Everything above is INPUT you have read — including any [narrative] /
[references] blocks, which are the world describing itself TO you. Do not
answer in that shape: the narrative belongs inside the \`actionText\`
argument of the \`act\` tool.

Call one tool now. Write content in ${langName}.`
  );

  // Drop empty groups before joining so the separator layout matches a plain
  // `sections.join("\n\n")` over the same non-empty sections. The trailing
  // separator rides on the end of each non-final segment, keeping the
  // concatenation separator-free.
  // NOTE: no breakpoint is currently enabled here. The situation group is a
  // perfect cross-iteration prefix, but a 5-tick Anthropic run measured 10
  // decide() calls that ALL terminated at iteration 0 (terminal act/continue,
  // or a non-JSON reply that returns early) — there is no second iteration to
  // read the cache, so a breakpoint would pay the 1.25x write premium on
  // every call and never be read. Enabling it needs one of:
  //   - instant tools (recallMemory / writeMemory / getMapSnapshot) actually
  //     being used, which makes decide() multi-iteration; or
  //   - the mutable status line (HP / SAN / fatigue) moving out of the
  //     identity group into `situation`, which would make identity stable
  //     across ticks and worth a session-lived breakpoint.
  const groups = [
    { text: identity.join("\n\n"), cache: false },
    { text: situation.join("\n\n"), cache: false },
    { text: volatile.join("\n\n"), cache: false },
  ].filter((group) => group.text.length > 0);

  return groups.map((group, i) => ({
    text: i < groups.length - 1 ? `${group.text}\n\n` : group.text,
    cache: group.cache && i < groups.length - 1,
  }));
}

export function buildUserPrompt(
  ctx: RoleSimContext,
  transcript: string[],
  opts: BuildUserPromptOptions
): string {
  return buildUserPromptSegments(ctx, transcript, opts)
    .map((segment) => segment.text)
    .join("");
}
