// src/roleSim/memoryConsolidator.ts
//
// The character consolidates their own memories.
//
// `## What you remember` is injected whole on every decision and has no
// ceiling of its own: `writeMemory` is capped per decision, not in total,
// `DecayEngine` scores and never deletes, and the only guard is the 2000-row
// `take` in the controller, which drops the OLDEST rows without a word once
// it bites — a character's earliest map and relationship memories.
//
// So it gets the same ceiling the perception stream has, and the same
// answer: when the block passes MEMORY_BUDGET_TOKENS the character is handed
// their own prompt back — profile, memories, day, present minute, everything
// but `act`/`continue` — and asked to bring the memories down to what they
// can carry, with `writeMemory` as the only tool. No curator: what is still
// worth knowing is the judgement of the person whose memories they are.
//
// Unlike a perception summary, memories cannot be replaced by one paragraph.
// Each row has a handle the character cites, a type, and (for `relationship`)
// a side effect on the relationship graph. So the answer is a batch of
// `writeMemory` operations, applied one by one through the ordinary
// dispatcher, which already enforces the two rules that matter: a `ref` may
// only name a line that was in this prompt, and a relationship row is written
// together with its graph edge.
//
// The pass is incremental. A call with a bad handle or a missing field fails
// alone; every other call lands. A pass that leaves the block still over
// budget is not retried inside the call — the ceiling is checked again next
// decision, and the next pass starts from the shorter list.

import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import { ModelClass, generateToolCalls } from "../models/index.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import { formatForPrompt } from "../state/gameClock.js";
import type { RoleSimContext } from "./agent.js";
import { formatMemories } from "./memoryFormatter.js";
import { estimateTokens } from "./promptBudget.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import {
  type DispatcherDeps,
  dispatchInstantTool,
  isDispatchError,
} from "./toolDispatcher.js";
import { writeMemoryTool } from "./tools/schemas.js";
import { buildUserPromptSegments } from "./userPromptBuilder.js";

/** Same ceiling as the perception stream: 40% of a 200k prompt. A character
 *  reaches it only after writing a great deal down, so ordinary play never
 *  sees a consolidation and nothing about it changes. */
export const MEMORY_BUDGET_TOKENS = 80_000;

/** What the character is asked to aim for. Not enforced, and well under the
 *  ceiling so that one pass buys a long stretch before the next. */
export const MEMORY_TARGET_TOKENS = 50_000;

/** Newest rows, by stamp, that the pass is told to leave alone. The block
 *  answers "what do I know"; these answer "what am I in the middle of", and
 *  folding them would fold the present. */
export const KEEP_RECENT_MEMORIES = 20;

/** `writeMemory` calls one pass may make. Replaces the per-decision cap of 3
 *  for this call only; a pass over 80k tokens of memories needs the room. */
export const CONSOLIDATION_WRITE_CAP = 80;

type MemoryRow = RoleSimContext["memories"][number];

/** Roughly what the block costs as `userPromptBuilder` renders it — the
 *  formatter is the cheap part, so measure the real text rather than guess. */
export function memoryBlockTokens(rows: ReadonlyArray<MemoryRow>): number {
  if (rows.length === 0) return 0;
  return estimateTokens(formatMemories(rows));
}

export function needsConsolidation(rows: ReadonlyArray<MemoryRow>): boolean {
  // Nothing to gain while there is nothing to fold.
  if (rows.length <= KEEP_RECENT_MEMORIES) return false;
  return memoryBlockTokens(rows) > MEMORY_BUDGET_TOKENS;
}

/** The stamp from which memories are too recent to touch: the oldest of the
 *  KEEP_RECENT_MEMORIES newest rows, in the order the formatter renders them
 *  so the boundary is a line the character can find. */
export function protectedFromStamp(rows: ReadonlyArray<MemoryRow>): string {
  const ordered = [...rows].sort(
    (a, b) =>
      a.gameDateTime.localeCompare(b.gameDateTime) ||
      a.content.localeCompare(b.content)
  );
  const boundary = ordered[Math.max(0, ordered.length - KEEP_RECENT_MEMORIES)];
  return formatForPrompt(boundary.gameDateTime);
}

export interface ConsolidationResult {
  /** `writeMemory` calls that landed. */
  applied: number;
  /** Calls the dispatcher rejected — a handle not in the prompt, a missing
   *  field — each left alone while the rest went through. */
  skipped: number;
  /** The dispatcher's reason for each skip, for the log. */
  errors: string[];
}

export interface ConsolidateMemoriesParams {
  /** Context carrying the FULL memory list — this call is what shortens it. */
  ctx: RoleSimContext;
  dgsm: DynamicGameStateManager;
  memory: NpcMemoryManager;
  sessionId: string;
  moduleId: string;
  language: string;
}

/**
 * Ask the character to consolidate their own memories. Returns null when the
 * model call produced nothing usable, in which case the caller keeps the long
 * block and this simply happens again next decision — the same shape as a
 * failed perception compaction, which costs a tick of prompt size and
 * nothing else.
 */
export async function consolidateMemories(
  params: ConsolidateMemoriesParams
): Promise<ConsolidationResult | null> {
  const { ctx, dgsm, memory, sessionId, moduleId, language } = params;
  if (ctx.memories.length <= KEEP_RECENT_MEMORIES) return null;

  const segments = buildUserPromptSegments(ctx, {
    language,
    dgsm,
    closing: {
      kind: "consolidate",
      protectedFrom: protectedFromStamp(ctx.memories),
      targetTokens: MEMORY_TARGET_TOKENS,
    },
  });

  let toolCalls: Awaited<ReturnType<typeof generateToolCalls>>["toolCalls"];
  try {
    ({ toolCalls } = await generateToolCalls({
      // Byte-identical to the prompt this character decides under, so the
      // call reads the cached prefix instead of writing a second one.
      customSystemPrompt: SYSTEM_PROMPT,
      cacheSystemPrompt: true,
      messages: [
        {
          role: "user",
          content: segments.map((s) => ({
            kind: "text" as const,
            text: s.text,
            cacheControl: s.cache,
          })),
        },
      ],
      // Only `writeMemory`. Nothing terminal: this is not a decision, it
      // consumes no tick, and the controller never sees an action from it.
      tools: [writeMemoryTool],
      toolChoice: "any",
      allowParallelCalls: true,
      modelClass: ModelClass.MEDIUM,
      operation: "memory-consolidate",
    }));
  } catch (err) {
    console.warn(
      `[memoryConsolidator] ${ctx.npcId}: consolidation call failed; keeping the full list:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }

  const deps: DispatcherDeps = {
    memory,
    dgsm,
    npcId: ctx.npcId,
    memories: ctx.memories,
    sessionId,
    moduleId,
    gameDateTime: ctx.currentTime,
    ...(ctx.currentScene ? { location: ctx.currentScene } : {}),
  };
  const caps = { writeMemory: CONSOLIDATION_WRITE_CAP };

  const result: ConsolidationResult = { applied: 0, skipped: 0, errors: [] };
  for (const call of toolCalls) {
    if (call.name !== "writeMemory") {
      result.skipped += 1;
      result.errors.push(`unknown tool "${call.name}"`);
      continue;
    }
    const dispatched = await dispatchInstantTool(
      "writeMemory",
      call.args,
      caps,
      deps
    );
    if (isDispatchError(dispatched.result)) {
      result.skipped += 1;
      result.errors.push(dispatched.result);
    } else {
      result.applied += 1;
    }
  }

  if (result.applied === 0) {
    console.warn(
      `[memoryConsolidator] ${ctx.npcId}: nothing landed (${result.skipped} rejected); keeping the full list`
    );
    return null;
  }
  for (const e of result.errors) {
    console.warn(`[memoryConsolidator] ${ctx.npcId}: skipped — ${e}`);
  }
  return result;
}
