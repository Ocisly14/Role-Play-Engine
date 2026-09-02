// src/models/trace.ts
//
// Optional on-disk trace of every model call: what was sent, what came back.
//
// Inert unless `LLM_TRACE_DIR` is set — no allocation, no stringify, no file
// handle on the normal path. It exists because the interesting surface of
// this system is the prompt: the agent, the renderer and the World Action
// Engine each get one, they are assembled from a dozen formatters, and a run
// that "looks fine" tells you nothing about what the model actually read.
//
// One JSON file per call, numbered in call order and named by operation, so a
// run reads top to bottom: 0001-phase-g-perception-render, 0002-role-sim-agent,
// 0003-world-action-engine, …

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Next file index. Starts from what is already in the directory: a resumed
 *  run traces into the same directory as the run it resumes, and a counter
 *  that restarted at 1 overwrote the first run's files from 0001 upward. */
let sequence = 0;

/** The highest `NNNN-` prefix already in `dir`, or 0 for an empty one. */
export function highestTraceIndex(dir: string): number {
  let max = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const m = /^(\d+)-/.exec(name);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max;
}
/** `undefined` = not resolved yet, `null` = tracing off. */
let resolvedDir: string | null | undefined;

function traceDir(): string | null {
  if (resolvedDir === undefined) {
    const raw = process.env.LLM_TRACE_DIR?.trim();
    if (raw) {
      mkdirSync(raw, { recursive: true });
      resolvedDir = raw;
      sequence = highestTraceIndex(raw);
    } else {
      resolvedDir = null;
    }
  }
  return resolvedDir;
}

export interface ModelCallTrace {
  operation?: string;
  provider?: string;
  modelClass?: string;
  modelName?: string;
  /** System prompt blocks, verbatim. */
  system?: unknown;
  /** Everything sent as the conversation, verbatim. */
  request: unknown;
  /** What the model returned. */
  response: unknown;
  /** Provider-reported usage for this call. Recorded so a trace is
   *  self-contained: the per-block budget report needs a real token total to
   *  scale its estimate against, and pairing files back to console lines by
   *  order is fragile the moment anything runs concurrently. */
  usage?: unknown;
  /** Tool schemas sent with the call. They render ahead of the system prompt
   *  and are billed like any other input, so a budget report that omits them
   *  is wrong by exactly their size. */
  tools?: unknown;
}

export function traceModelCall(entry: ModelCallTrace): void {
  const dir = traceDir();
  if (!dir) return;

  const index = ++sequence;
  const label = (entry.operation ?? "call").replace(/[^\w.-]+/g, "_");
  const file = path.join(
    dir,
    `${String(index).padStart(4, "0")}-${label}.json`
  );
  try {
    writeFileSync(file, JSON.stringify(entry, null, 2));
  } catch (error) {
    // Tracing must never take a run down with it.
    console.warn(`[trace] failed to write ${file}: ${String(error)}`);
  }
}
