// src/roleSim/userPromptBuilder.ts
//
// Builds the per-tick user prompt for LLMRoleSimAgent. Conditional sections
// are omitted when their data is absent (no empty headers). Profile, memory,
// and perception are delegated to focused formatter helpers. Language line
// at the end mirrors the old planner's `contentLanguageName` convention.

import type { PromptSegment } from "../models/types.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import { formatForPrompt } from "../state/gameClock.js";
import { resolveLocationById } from "../state/perceivedLocation.js";
import type { RoleSimContext } from "./agent.js";
import { formatMemories } from "./memoryFormatter.js";
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
 *  2. **situation** — time, scene, perceptions, goal, current action,
 *     memories. Frozen for the whole tick, so a breakpoint at its end (which
 *     caches the system prompt and the identity block along with it) is read
 *     by every later iteration of the same decide() loop.
 *  3. **volatile** — rejection feedback (retry passes only) and the decide
 *     instruction. No breakpoint: it is the tail of the prompt.
 */
export function buildUserPromptSegments(
  ctx: RoleSimContext,
  opts: BuildUserPromptOptions
): PromptSegment[] {
  const identity: string[] = [];
  const situation: string[] = [];
  const volatile: string[] = [];

  identity.push(`# You are ${ctx.npcProfile.name}`);

  identity.push(`## Who you are\n${formatProfile(ctx.npcProfile, opts.dgsm)}`);

  const sections = situation;

  // Every perception is stamped with when and where it reached the character,
  // so there is no separate "right now" block — the current perception below
  // IS the present minute and the present place.
  if (ctx.recentPerceptions && ctx.recentPerceptions.length > 0) {
    const block = ctx.recentPerceptions
      .map(
        (p) =>
          `${stamp(p.gameDateTime, p.location, opts.dgsm)}\n${p.narrative}`
      )
      .join("\n\n");
    sections.push(
      `## What you have perceived so far (oldest first)
${block}`
    );
  }

  if (ctx.perception?.narrative) {
    const where = ctx.perception.location ?? ctx.currentScene;
    sections.push(
      `## What you perceive now\n${stamp(ctx.currentTime, where, opts.dgsm)}\n${ctx.perception.narrative}`
    );
  }

  if (ctx.longTermIntent?.trim()) {
    sections.push(`## Your long-term goal\n${ctx.longTermIntent}`);
  }

  if (ctx.currentAction) {
    const bits: string[] = [];
    if (ctx.currentAction.startedAt) {
      bits.push(`started ${formatForPrompt(ctx.currentAction.startedAt)}`);
    }
    if (typeof ctx.currentAction.progressMinutes === "number") {
      bits.push(`~${ctx.currentAction.progressMinutes} min in`);
    }
    if (typeof ctx.currentAction.resolvedDurationTicks === "number") {
      bits.push(
        `expected ~${ctx.currentAction.resolvedDurationTicks} min total`
      );
    }
    const suffix = bits.length > 0 ? `\n(${bits.join(", ")})` : "";
    sections.push(
      `## Currently doing\n"${ctx.currentAction.description}"${suffix}`
    );
  }

  if (ctx.memories.length > 0) {
    sections.push(
      `## What you remember\n${formatMemories(ctx.memories)}`
    );
  }

  if (ctx.rejectionFeedback) {
    volatile.push(
      `## Your previous action was REJECTED
The engine did not accept your last \`act\` call:
${ctx.rejectionFeedback}

This is factual feedback, not something that happened in the world. Decide
again: fix the rejected field (a tag copied exactly from what you perceive,
a positive tick count, a real skill name) or choose a different action.`
    );
  }

  const langName = opts.language?.startsWith("zh") ? "Chinese" : "English";
  // `act` output is structured fields — prose goes in `description`, ids in
  // `objectRefs`. The envelope itself is enforced by the API (a tool call is
  // required), so this doesn't have to describe JSON.
  volatile.push(
    `## Decide
Everything above is INPUT you have read — the world describing itself TO
you. The bracketed tags in what you perceive — \`[stranger_a]\`,
\`[ITEM_7]\`, \`[SCN_LIBRARY]\` — are the ONLY ids you may put in
\`objectRefs\`; copy one exactly, without its brackets. Something you
perceive with no tag is something you cannot act on this minute. Your
in-character prose goes in \`description\` (and the exact words you speak
in \`utterance\`) — never the tags.

Call one tool now — \`act\` or \`continue\`, plus any \`writeMemory\`
worth keeping from what you just perceived. Write content in ${langName}.`
  );

  // Drop empty groups before joining so the separator layout matches a plain
  // `sections.join("\n\n")` over the same non-empty sections. The trailing
  // separator rides on the end of each non-final segment, keeping the
  // concatenation separator-free.
  // NOTE: no breakpoint is currently enabled here. Now that `writeMemory`
  // rides along with the terminal call, a well-formed decide() is ONE
  // request — a second iteration only happens when the model failed to
  // terminate — so a breakpoint would pay the 1.25x write premium on every
  // call and essentially never be read. Enabling it needs the mutable status
  // line (HP / SAN / fatigue) to move out of the identity group into
  // `situation`, which would make identity stable across ticks and worth a
  // session-lived breakpoint.
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

/** `--- 1923-04-02 09:15 · Miskatonic Library ---`: when and where this
 *  reached the character. The scene id is shown only if the module has no
 *  name for it — this line is read as prose, not cited as an id. */
function stamp(
  gameDateTime: string,
  sceneId: string | undefined,
  dgsm: DynamicGameStateManager
): string {
  const place = sceneId
    ? (resolveLocationById(sceneId, dgsm)?.name ?? sceneId)
    : undefined;
  return `--- ${formatForPrompt(gameDateTime)}${place ? ` · ${place}` : ""} ---`;
}

export function buildUserPrompt(
  ctx: RoleSimContext,
  opts: BuildUserPromptOptions
): string {
  return buildUserPromptSegments(ctx, opts)
    .map((segment) => segment.text)
    .join("");
}
