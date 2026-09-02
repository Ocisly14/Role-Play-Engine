// src/roleSim/perceptionCompactor.ts
//
// The character condenses their own stream.
//
// `What you have lived through so far` is append-only and injected whole, at
// full price, on every decision — the one block in the prompt that grows
// without bound. Measured: ~250 tokens per paragraph, and a character in
// conversation writes one per tick.
//
// So it gets a ceiling. When the block passes PERCEPTION_BUDGET_TOKENS the
// character is handed their own prompt back — the same profile, the same
// memories, the same present minute, everything but the tools — and asked to
// rewrite the early part of it as the account they could still give. The
// summary replaces the paragraphs it covers; the most recent KEEP_RECENT stay
// verbatim, because the last few minutes are what the next decision is
// actually continuing from.
//
// Why the character and not a summarizer prompt: what is worth keeping out of
// a day is a judgement, and this codebase gives that judgement to the person
// whose day it was, everywhere else it comes up (`writeMemory` has no curator
// either). A neutral summarizer would keep what looks important; this keeps
// what THEY would still know.

import { ModelClass, generateText } from "../models/index.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { RoleSimContext } from "./agent.js";
import { estimateTokens } from "./promptBudget.js";
import { stripUncitableTags, uncitableTags } from "./renderer/llmRenderer.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { buildUserPromptSegments, stamp } from "./userPromptBuilder.js";

export interface PerceptionEntry {
  gameDateTime: string;
  location: string;
  narrative: string;
}

/** 40% of a 200k prompt budget. A ceiling, not a working size: at ~250 tokens
 *  a paragraph this is some 320 decisions, so ordinary scenes never reach it
 *  and nothing about them changes. */
export const PERCEPTION_BUDGET_TOKENS = 80_000;

/** Paragraphs that survive compaction untouched. The summary answers "what
 *  came of the day"; these answer "what am I in the middle of", and no summary
 *  substitutes for that. */
export const KEEP_RECENT = 10;

/** What the character is asked to aim for. Not enforced — a hard cut would
 *  end the account mid-sentence, and an account that runs long is a smaller
 *  problem than one that stops halfway. */
export const SUMMARY_TARGET_TOKENS = 5_000;

/** What the provider will actually let them write. */
export const SUMMARY_MAX_OUTPUT_TOKENS = 8_000;

/** `--- 04-02 09:15 · Miskatonic Library ---` and its blank line, near enough.
 *  A ceiling does not need the exact byte count, and charging a flat rate for
 *  the stamps keeps this off the clock and the place formatter. */
const STAMP_TOKENS = 14;

/** Roughly what the block costs as `userPromptBuilder` renders it. */
export function perceptionBlockTokens(
  entries: ReadonlyArray<{ narrative: string }>
): number {
  let total = 0;
  for (const p of entries) total += estimateTokens(p.narrative) + STAMP_TOKENS;
  return total;
}

export function needsCompaction(
  entries: ReadonlyArray<{ narrative: string }>
): boolean {
  // Nothing to gain while there is nothing to fold: below the keep-window the
  // summary would replace an empty set and cost a call to do it.
  if (entries.length <= KEEP_RECENT) return false;
  return perceptionBlockTokens(entries) > PERCEPTION_BUDGET_TOKENS;
}

export interface CompactionResult {
  /** The character's own account of everything through `coversThrough`. */
  summary: string;
  /** Stamp of the last entry folded in — the cutoff named in the prompt. */
  coversThrough: string;
  /** `gameDateTime` of that same entry: what the reload path compares against
   *  to know which paragraphs the summary already speaks for. */
  coversThroughGameDateTime: string;
  /** The replacement stream: the summary, then the untouched recent tail. */
  entries: PerceptionEntry[];
}

export interface CompactPerceptionsParams {
  /** Context carrying the FULL stream — this call is what shortens it. */
  ctx: RoleSimContext;
  dgsm: DynamicGameStateManager;
  language: string;
}

/**
 * Ask the character to condense their own stream. Returns null when the call
 * produced nothing usable, in which case the caller keeps the long stream and
 * this simply happens again next decision — the same shape as a failed render,
 * which costs a tick of quality and nothing else.
 */
export async function compactPerceptions(
  params: CompactPerceptionsParams
): Promise<CompactionResult | null> {
  const { ctx, dgsm, language } = params;
  const all = [...(ctx.recentPerceptions ?? [])];
  if (all.length <= KEEP_RECENT) return null;

  const normalize = (p: {
    gameDateTime: string;
    location?: string;
    narrative: string;
  }): PerceptionEntry => ({
    gameDateTime: p.gameDateTime,
    location: p.location ?? "",
    narrative: p.narrative,
  });
  const fold = all.slice(0, all.length - KEEP_RECENT).map(normalize);
  const keep = all.slice(all.length - KEEP_RECENT).map(normalize);
  const last = fold[fold.length - 1];
  const coversThrough = stamp(last.gameDateTime, last.location, dgsm);

  const segments = buildUserPromptSegments(ctx, {
    language,
    dgsm,
    closing: {
      kind: "compact",
      coversThrough,
      targetTokens: SUMMARY_TARGET_TOKENS,
    },
  });

  let summary: string;
  try {
    summary = (
      await generateText({
        // Byte-identical to the prompt this character decides under, so the
        // compaction call reads the cached prefix instead of writing a second
        // one. The `## Tools` section inside it describes tools this call does
        // not offer; the closing instruction directly below the block settles
        // what to do, and keeping the bytes identical is worth more than
        // tidying that.
        customSystemPrompt: SYSTEM_PROMPT,
        cacheSystemPrompt: true,
        contextSegments: segments.map((s) => ({
          text: s.text,
          cache: s.cache,
        })),
        context: segments.map((s) => s.text).join(""),
        modelClass: ModelClass.MEDIUM,
        operation: "perception-compact",
        maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      })
    ).trim();
  } catch (err) {
    console.warn(
      `[perceptionCompactor] ${ctx.npcId}: compaction call failed; keeping the full stream:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }

  if (summary.length === 0) {
    console.warn(
      `[perceptionCompactor] ${ctx.npcId}: empty summary; keeping the full stream`
    );
    return null;
  }

  const summaryTokens = estimateTokens(summary);
  if (summaryTokens > SUMMARY_TARGET_TOKENS) {
    // Worth knowing, not worth another call: it is still an order of magnitude
    // below what it replaced.
    console.warn(
      `[perceptionCompactor] ${ctx.npcId}: summary ran to ~${summaryTokens} tokens (asked for ${SUMMARY_TARGET_TOKENS})`
    );
  }

  summary = await policeTags(summary, fold, ctx.npcId);
  if (summary.length === 0) {
    console.warn(
      `[perceptionCompactor] ${ctx.npcId}: summary was empty after tag repair; keeping the full stream`
    );
    return null;
  }

  return {
    summary,
    coversThrough,
    coversThroughGameDateTime: last.gameDateTime,
    entries: [
      {
        gameDateTime: last.gameDateTime,
        location: last.location,
        narrative: summary,
      },
      ...keep,
    ],
  };
}

// ==================== Handles survive the rewrite ====================

/** What the repair call may spend. It answers with a handful of `a => b`
 *  lines and nothing else. */
const TAG_FIX_MAX_OUTPUT_TOKENS = 1_000;

const NO_TAGS: ReadonlySet<string> = new Set();

/**
 * Every bracketed handle the character actually read in the paragraphs being
 * folded.
 *
 * That — not what they can see right now — is the right allowed set for a
 * summary. A handle read an hour ago still resolves, because every id space is
 * stable and the trust boundary asks only whether a citation names something
 * real; reachability is the Engine's question. Policing the account against
 * the CURRENT perceivable directory would therefore strip exactly the handles
 * the compaction instruction exists to preserve — the brass key they put down
 * two rooms ago is the one they most need to still be able to name.
 *
 * Collected with the renderer's own scanner: an empty allowed-set makes
 * `uncitableTags` return every tag it finds, so the two paths cannot drift
 * apart on what counts as a tag.
 */
function tagsRead(entries: ReadonlyArray<PerceptionEntry>): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    for (const tag of uncitableTags(entry.narrative, NO_TAGS)) out.add(tag);
  }
  return out;
}

/**
 * Keep the account's handles honest.
 *
 * An invented handle is worse here than in a rendered paragraph: it does not
 * die at the trust boundary a turn later, it sits in the character's own
 * record until the next compaction and gets re-read on every decision in
 * between. So invented ones are repaired, and whatever survives repair is
 * stripped.
 *
 * The repair is incremental by design. The account can run to 8,000 tokens and
 * the prompt that produced it to eighty thousand; asking for the whole thing
 * again to fix three brackets would cost more than the compaction it is part
 * of. This call sees only the bad handles and the real ones, and answers with
 * the corrections.
 */
async function policeTags(
  summary: string,
  fold: ReadonlyArray<PerceptionEntry>,
  npcId: string
): Promise<string> {
  const allowed = tagsRead(fold);
  const invented = uncitableTags(summary, allowed);
  let text = summary;

  if (invented.length > 0) {
    console.warn(
      `[perceptionCompactor] ${npcId}: account invented ${invented
        .map((t) => `"${t}"`)
        .join(", ")} — asking for the real handles`
    );
    for (const [wrong, right] of await requestTagFixes(
      invented,
      allowed,
      npcId
    )) {
      // Plain replacement, not a rewrite: the account keeps every word the
      // character wrote and only the bracket changes. A handle the repair
      // could not place is left alone on purpose — the strip below removes it
      // along with the space in front of it, which a substitution here would
      // leave stranded before the full stop.
      if (right === null) continue;
      text = text.split(`[${wrong}]`).join(`[${right}]`);
    }
  }

  // The net. Anything still unaccounted for loses its bracket and keeps its
  // words — the same trade the renderer makes.
  return stripUncitableTags(text, allowed, npcId);
}

/** `invented handle -> the real one, or null when nothing matches`. */
async function requestTagFixes(
  invented: ReadonlyArray<string>,
  allowed: ReadonlySet<string>,
  npcId: string
): Promise<Array<[string, string | null]>> {
  const prompt = [
    "A written account carries bracketed handles that do not exist. Each",
    "handle listed below was invented: it appears in the account but was",
    "never in the source the account was written from.",
    "",
    "Invented handles:",
    ...invented.map((t) => `- ${t}`),
    "",
    "The only real handles are:",
    ...(allowed.size > 0 ? [...allowed].map((t) => `- ${t}`) : ["- (none)"]),
    "",
    "For each invented handle answer with exactly one line:",
    "  <invented> => <the real handle it was meant to be>",
    "or, when none of the real handles is that thing:",
    "  <invented> => none",
    "",
    "A handle is copied exactly, without its brackets. Answer with those",
    "lines and nothing else — no prose, no brackets, no explanation.",
  ].join("\n");

  let answer: string;
  try {
    answer = await generateText({
      context: prompt,
      modelClass: ModelClass.MEDIUM,
      operation: "perception-compact-tag-fix",
      maxOutputTokens: TAG_FIX_MAX_OUTPUT_TOKENS,
    });
  } catch (err) {
    // Not fatal: every invented handle simply falls through to the strip.
    console.warn(
      `[perceptionCompactor] ${npcId}: handle repair call failed; stripping instead:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }

  const wanted = new Set(invented);
  const fixes: Array<[string, string | null]> = [];
  for (const line of answer.split("\n")) {
    const parts = line.split("=>");
    if (parts.length !== 2) continue;
    const wrong = parts[0].trim().replace(/^[-*\s[]+|[\]\s]+$/g, "");
    const right = parts[1].trim().replace(/^\[|\]$/g, "");
    if (!wanted.has(wrong)) continue;
    if (right.toLowerCase() === "none" || right.length === 0) {
      fixes.push([wrong, null]);
    } else if (allowed.has(right)) {
      fixes.push([wrong, right]);
    }
    // A replacement that is not itself a real handle is ignored — the strip
    // below removes the bracket anyway, and trusting it would only launder
    // one invention into another.
  }
  return fixes;
}
