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
import {
  formatCondition,
  formatProfile,
  formatSkills,
} from "./profileFormatter.js";

export interface BuildUserPromptOptions {
  language: string;
  dgsm: DynamicGameStateManager;
  /**
   * What the prompt asks for at the end. Everything above it is identical
   * either way, which is the point: the character who compacts their own
   * stream is the same character, reading the same profile, memories and
   * present minute they read when they act. Only the closing instruction
   * differs, so the two cannot drift apart.
   *
   * `compact` also needs the cutoff — the stamp of the last paragraph that
   * gets folded into the summary. Everything after it stays verbatim.
   *
   * `consolidate` names the other end: the timestamp from which memories are
   * too recent to touch. Everything stamped there or later stays as it is.
   */
  closing?:
    | { kind: "decide" }
    | { kind: "compact"; coversThrough: string; targetTokens: number }
    | { kind: "consolidate"; protectedFrom: string; targetTokens: number };
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
 *  1. **frozen** — name, profile, and skill values. These do not move during
 *     a session, so the one breakpoint sits here.
 *  2. **growing** — memory and what the character has perceived. Its
 *     prefix is stable but its end moves every tick, so it gets no breakpoint
 *     of its own; it rides at full price behind the cached block.
 *  3. **volatile** — vitals, the action in progress, this minute's
 *     perception, rejection feedback, the decide instruction.
 *
 * Reading order is: who you are -> what you remember -> how you are now ->
 * what you sense -> decide.
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
  frozen.push(`## What you can do\n${formatSkills(ctx.npcProfile)}`);

  // The standing over memory, said once where the memories are.
  //
  // The second sentence is the one that was paid for. Two characters in two
  // runs walked into the same wall: each held several memories that were all
  // CORRECT, and joined two of them into a way that does not exist — the lane
  // to Denny's house continued as the path to the trailhead; the gap in the
  // back fence became a shortcut to the far end of Main Street. Told only
  // that their action "did not go on", both read it as their own head going
  // vague and re-stated the same impossible route, more carefully. Telling
  // them their memory might be wrong would be a lie in both cases and would
  // point them at the wrong doubt: the memories were right, the joining was
  // invented.
  if (ctx.memories.length > 0) {
    growing.push(
      `## What you remember
This is your own record, in your own words — not the world's. It can be out
of date, and it is about places you are not standing in; where it disagrees
with what you perceive right now, what you perceive is what is true.

And two things you remember separately do not join into one way just because
you remember both. You know that one place leads to another only if you
remember it leading there, or you can see that it does. A way you assembled
out of two true memories is not a way you know.

${formatMemories(ctx.memories)}`
    );
  }

  // The character's day as they lived it, not a sensor log: this is the whole
  // uncurated stream, against which `## What you remember` is the part they
  // chose to keep. Every entry is stamped with when and where it reached them,
  // so the order needs no annotation and there is no separate "right now"
  // block — the current perception below IS the present minute and place.
  if (ctx.recentPerceptions && ctx.recentPerceptions.length > 0) {
    const block = ctx.recentPerceptions
      .map(
        (p) => `${stamp(p.gameDateTime, p.location, opts.dgsm)}\n${p.narrative}`
      )
      .join("\n\n");
    growing.push(
      `## What you have lived through so far
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
  const closing = opts.closing ?? { kind: "decide" };

  if (closing.kind === "compact") {
    // No tools on this call: the answer is the paragraph itself. What the
    // character keeps is their judgement, made from their own standpoint —
    // the same standpoint every other line of this prompt establishes.
    volatile.push(
      `## Condense what you have lived through
Your own record of what you have lived through has grown too long to carry
whole. Rewrite the
early part of it, in your own voice, as the account you would still be able
to give of it.

Everything in **What you have lived through so far** up to and including
\`${closing.coversThrough}\` is what you are condensing. The entries after
that stamp stay exactly as they are — do not summarize, repeat or mention
them.

Keep what you would still know: who you dealt with and how it stands
between you, what you learned, what you promised or were promised, what you
carried, what changed and what it cost. Drop the minute-by-minute — the
walking, the waiting, the weather that mattered to nobody. Where a thing
matters because of when or where it happened, keep the when and the where.

Anything in square brackets — \`[item.clinic_upstairs.gramophone]\`,
\`[stranger_a]\`, \`[SCN_clinic_waiting]\` — is a handle, not a word. Carry every one you keep
through into your account EXACTLY as it appears, brackets included, attached
to the same thing it was attached to above. A handle is how you reach for a
thing later: drop a thing and its handle goes with it, but keep the thing
and lose the handle and you will remember the brass key with no way left to
reach for it. Never write a bracket you did not read above, and never put
one on something that had none.

Write it as one continuous first-person account, past tense, in
${langName}. No headings, no bullet list, no commentary about the act of
summarizing. Aim for about ${closing.targetTokens} tokens; shorter is fine
if there was little worth keeping. Write the account now — nothing else.`
    );
  } else if (closing.kind === "consolidate") {
    // One tool on this call, `writeMemory`, and nothing terminal: the answer
    // is the batch of corrections itself. The character is the only one who
    // knows which of these lines still say something — the same standpoint
    // the compact closing takes over the perception stream.
    volatile.push(
      `## Bring what you remember down to what you can carry
Your own record has grown too long to carry whole. Using \`writeMemory\`,
bring **What you remember** down to about ${closing.targetTokens} tokens:
\`replace\` to fold several lines about one thing into one line that says
it all; \`delete\` for what no longer matters; \`add\` only for a merged
line that stands in for several you are deleting.

Lines stamped \`[${closing.protectedFrom}]\` or later are what you are in
the middle of — leave every one of them exactly as it is.

How to judge each kind:
- \`relationship\`: one line per person, saying how it stands between you
  now. Fold the history of a person into that line; do not keep a trail.
- \`plan\`: a plan that is done, or that events have overtaken, is deleted.
- \`map\`: lines about one area may be folded together, but **never lose a
  place name** — a place you no longer have a line for is a place you no
  longer know how to reach.
- \`secret\`: keep each one on its own; never fold a secret into another
  line.
- \`long_term_intent\`: the newest one stays. Older ones may go.
- \`general\`: keep what you would still know a week from now — who you
  dealt with and what it came to, what you learned, what you promised.
  Drop the minute-by-minute.

\`ref\` is the \`#M…\` tag at the head of the line, copied exactly. Never
cite a tag you did not read above. A tag you get wrong is one line left as
it was — the rest of your calls still land.

Make every call now, in this one turn, and nothing else. Write content in
${langName}.`
    );
  } else {
    // `act` output is structured fields — prose goes in `description`, ids in
    // `objectRefs`. The envelope itself is enforced by the API (a tool call is
    // required), so this doesn't have to describe JSON.
    volatile.push(
      `## Decide
Everything above is INPUT you have read — the world describing itself TO
you. The bracketed tags in what you perceive — \`[stranger_a]\`,
\`[item.clinic_upstairs.gramophone]\`, \`[SCN_clinic_waiting]\` — are the
ONLY ids you may put in
\`objectRefs\`; copy one exactly, without its brackets. Something you
perceive with no tag is something you cannot act on this minute. Your
in-character prose goes in \`description\` (and the exact words you speak
in \`utterance\`) — never the tags.

Call one tool now — \`act\` or \`continue\`, plus any \`writeMemory\`
worth keeping from what you just perceived. Write content in ${langName}.`
    );
  }

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
 *  name for it — this line is read as prose, not cited as an id.
 *
 *  Exported because compaction names its cutoff with one: the instruction
 *  points at a line the character can actually find in the block above it,
 *  rather than asking them to count entries from the end. */
export function stamp(
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
