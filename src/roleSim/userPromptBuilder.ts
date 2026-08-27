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
import { formatCondition, formatProfile } from "./profileFormatter.js";

export interface BuildUserPromptOptions {
  language: string;
  dgsm: DynamicGameStateManager;
}

/**
 * Segmented form of {@link buildUserPrompt}. Concatenating the segment texts
 * reproduces `buildUserPrompt`'s output byte for byte.
 *
 * The order is chosen for the prompt cache, which matches a prefix from the
 * very first byte of the request. Two rules, and the second one cost a full
 * measured run to learn:
 *
 *  1. Anything that changes every tick, placed early, invalidates everything
 *     behind it however stable that is.
 *  2. A breakpoint must sit after content that does not MOVE, not merely
 *     after content that only grows at its tail.
 *
 * Rule 2 is the counter-intuitive one. An append-only block looks ideal —
 * the prefix is intact, so surely the cache reads it? It does, and then it
 * writes the now-longer prefix as a new entry, and the provider charges a
 * cache WRITE for the whole thing, not for the increment. Measured over 37
 * calls with the breakpoint at the end of the growing block: 343k tokens read
 * against 655k written, an effective 1.35x on content that costs 1.0x
 * uncached. A breakpoint that moves every tick is worse than no breakpoint.
 *
 * So the three groups are cut by whether they MOVE, not by topic:
 *
 *  1. **frozen** — name, profile, and the `context` memories: the world as the
 *     character already knew it walking in. Written once at session bootstrap
 *     and never touched again — `writeMemory` refuses to change them, which
 *     is exactly the property that makes them cacheable. The one breakpoint
 *     sits here, is written once, and is read by every later tick.
 *  2. **growing** — what the character has written and perceived since. Its
 *     prefix is stable but its end moves every tick, so it gets no breakpoint
 *     of its own; it rides at full price behind the cached block.
 *  3. **volatile** — vitals, the action in progress, this minute's
 *     perception, rejection feedback, the decide instruction.
 *
 * Reading order survives: who you are -> what you already knew -> what you
 * have learned since -> how you are now -> what you sense -> decide.
 */
export function buildUserPromptSegments(
  ctx: RoleSimContext,
  opts: BuildUserPromptOptions
): PromptSegment[] {
  const frozen: string[] = [];
  const growing: string[] = [];
  const volatile: string[] = [];

  frozen.push(`# You are ${ctx.npcProfile.name}`);
  frozen.push(`## Who you are\n${formatProfile(ctx.npcProfile)}`);

  // `context` is the one memory type written FOR the character — the geography
  // seeded at session start — and correspondingly the one type they may not
  // rewrite. That makes it the only part of their memory that is genuinely
  // frozen, so it is what the breakpoint gets to sit behind.
  const knownAlready = ctx.memories.filter((m) => m.type === "context");
  const learnedSince = ctx.memories.filter((m) => m.type !== "context");

  if (knownAlready.length > 0) {
    frozen.push(
      `## What you already knew before today\n${formatMemories(knownAlready)}`
    );
  }

  if (learnedSince.length > 0) {
    growing.push(`## What you remember\n${formatMemories(learnedSince)}`);
  }

  // Every perception is stamped with when and where it reached the character,
  // so there is no separate "right now" block — the current perception below
  // IS the present minute and the present place.
  if (ctx.recentPerceptions && ctx.recentPerceptions.length > 0) {
    const block = ctx.recentPerceptions
      .map(
        (p) => `${stamp(p.gameDateTime, p.location, opts.dgsm)}\n${p.narrative}`
      )
      .join("\n\n");
    growing.push(
      `## What you have perceived so far (oldest first)
${block}`
    );
  }

  // ---- everything below is expected to differ from last tick --------------

  volatile.push(
    `## How you are right now\n${formatCondition(ctx.npcProfile, opts.dgsm)}`
  );

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
    volatile.push(
      `## Currently doing\n"${ctx.currentAction.description}"${suffix}`
    );
  }

  if (ctx.perception?.narrative) {
    const where = ctx.perception.location ?? ctx.currentScene;
    volatile.push(
      `## What you perceive now\n${stamp(ctx.currentTime, where, opts.dgsm)}\n${ctx.perception.narrative}`
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
  const groups = [
    { text: frozen.join("\n\n"), cache: true },
    { text: growing.join("\n\n"), cache: false },
    { text: volatile.join("\n\n"), cache: false },
  ].filter((group) => group.text.length > 0);

  return groups.map((group, i) => ({
    text: i < groups.length - 1 ? `${group.text}\n\n` : group.text,
    // A breakpoint on the LAST segment would cache a prefix nothing ever
    // reads again — the tail is what changes. Only interior boundaries get
    // one.
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
