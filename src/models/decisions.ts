// src/models/decisions.ts
//
// OpenAI Decisions API client: give it the state and a set of closed
// questions, get back a typed answer with probabilities per question — no
// prose. Used for the judgements that are a pick from a closed set (design:
// docs/superpowers/specs/2026-11-13-decisions-api-fast-paths-design.md §6.0).
//
// Every failure — no key, timeout, rate limit, transport error, an answer
// missing from the response — comes back as `{ ok: false }`. Callers treat
// that as "not sure" and take their LLM / conservative path; a Decisions
// call never takes a tick down.
//
// The wire shape follows the public guide (developers.openai.com, "Decisions"):
// POST /v1/decisions with `model`, `input`, `questions`; answers come back in
// `answers[]` keyed by question `name`. Kept to `toWire` / `fromWire` so a
// change on OpenAI's side is a change in two functions.

import { recordTokenUsage } from "./tokenUsage.js";
import { traceModelCall } from "./trace.js";
import { ModelClass, ModelProviderName } from "./types.js";

export type DecisionQuestion =
  | {
      type: "predicate";
      name: string;
      instructions: string;
    }
  | {
      type: "choice";
      name: string;
      instructions: string;
      choices: Array<{ value: string; description: string }>;
    };

export interface DecisionAnswer {
  name: string;
  type: "predicate" | "choice";
  /** predicate: P(true). */
  probability?: number;
  /** choice: the most probable value. */
  choice?: string;
  /** choice: P(value) per value. */
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface DecisionRequest {
  /** Usage / trace label, e.g. `decisions:wake-gate`. */
  operation: string;
  /** Stable content first (cacheable), then this minute's. */
  input: { text?: string[]; json?: unknown };
  questions: DecisionQuestion[];
  /** Groups requests that share a prefix, for the provider's cache. */
  cacheKey?: string;
}

export type DecisionResult =
  | { ok: true; answers: Map<string, DecisionAnswer> }
  | {
      ok: false;
      reason: "no_key" | "timeout" | "rate_limited" | "error" | "incomplete";
      detail?: string;
    };

/** OpenAI caps one request at 400 questions. */
export const MAX_QUESTIONS_PER_REQUEST = 400;

const DEFAULT_MODEL = "gpt-6-luna";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CONCURRENCY = 8;

function intEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

// ── A small in-process limiter: rate limits are not published. ──
let inFlight = 0;
const waiting: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (inFlight < intEnv("DECISIONS_CONCURRENCY", DEFAULT_CONCURRENCY)) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight += 1;
}
function release(): void {
  inFlight -= 1;
  waiting.shift()?.();
}

/** Test seam: replace the network call. */
export type DecisionsTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  signal: AbortSignal
) => Promise<{ status: number; json: () => Promise<unknown> }>;

let transport: DecisionsTransport = async (url, init, signal) => {
  const res = await fetch(url, { ...init, signal });
  return { status: res.status, json: () => res.json() };
};
export function setDecisionsTransport(t: DecisionsTransport | null): void {
  transport =
    t ??
    (async (url, init, signal) => {
      const res = await fetch(url, { ...init, signal });
      return { status: res.status, json: () => res.json() };
    });
}

function toWire(req: DecisionRequest, model: string): unknown {
  const content: unknown[] = [
    ...(req.input.text ?? []).map((text) => ({ type: "input_text", text })),
    ...(req.input.json !== undefined
      ? [{ type: "input_json", data: req.input.json }]
      : []),
  ];
  return {
    model,
    input: [{ role: "user", content }],
    questions: req.questions.map((q) =>
      q.type === "choice"
        ? {
            type: "choice",
            name: q.name,
            instructions: q.instructions,
            choices: q.choices,
          }
        : { type: "predicate", name: q.name, instructions: q.instructions }
    ),
    ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
  };
}

function fromWire(body: unknown): Map<string, DecisionAnswer> {
  const out = new Map<string, DecisionAnswer>();
  const answers = (body as { answers?: unknown[] })?.answers;
  if (!Array.isArray(answers)) return out;
  for (const raw of answers) {
    const a = raw as Record<string, unknown>;
    if (typeof a.name !== "string") continue;
    if (a.type === "refusal") continue;
    const answer: DecisionAnswer = {
      name: a.name,
      type: a.type === "choice" ? "choice" : "predicate",
    };
    if (typeof a.probability === "number") answer.probability = a.probability;
    if (typeof a.choice === "string") answer.choice = a.choice;
    if (typeof a.confidence === "number") answer.confidence = a.confidence;
    if (Array.isArray(a.probabilities)) {
      answer.probabilities = {};
      for (const p of a.probabilities as Array<Record<string, unknown>>) {
        if (typeof p.value === "string" && typeof p.probability === "number") {
          answer.probabilities[p.value] = p.probability;
        }
      }
    }
    out.set(a.name, answer);
  }
  return out;
}

export async function decide(req: DecisionRequest): Promise<DecisionResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, reason: "no_key" };
  if (req.questions.length === 0) return { ok: true, answers: new Map() };
  if (req.questions.length > MAX_QUESTIONS_PER_REQUEST) {
    return {
      ok: false,
      reason: "error",
      detail: `${req.questions.length} questions exceeds ${MAX_QUESTIONS_PER_REQUEST}`,
    };
  }
  const model = process.env.DECISIONS_OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const base = (
    process.env.DECISIONS_OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const wire = toWire(req, model);

  await acquire();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    intEnv("DECISIONS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)
  );
  try {
    const res = await transport(
      `${base}/decisions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(wire),
      },
      controller.signal
    );
    if (res.status === 429) {
      console.warn(`[decisions] ${req.operation}: rate limited`);
      return { ok: false, reason: "rate_limited" };
    }
    const body = await res.json();
    traceModelCall({
      operation: req.operation,
      provider: "openai",
      modelName: model,
      request: wire,
      response: body,
      usage: (body as { usage?: unknown })?.usage,
    });
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        reason: "error",
        detail: `HTTP ${res.status}`,
      };
    }
    const usage = (body as { usage?: Record<string, unknown> })?.usage;
    if (usage) {
      const input = Number(usage.input_tokens ?? 0);
      const cached = Number(
        (usage.input_tokens_details as Record<string, unknown> | undefined)
          ?.cached_tokens ?? 0
      );
      recordTokenUsage({
        provider: ModelProviderName.OPENAI,
        modelClass: ModelClass.SMALL,
        modelName: model,
        operation: req.operation,
        input_tokens: input,
        output_tokens: 0,
        total_tokens: input,
        cache_read_tokens: cached,
      });
    }
    const answers = fromWire(body);
    if (req.questions.some((q) => !answers.has(q.name))) {
      return { ok: false, reason: "incomplete" };
    }
    return { ok: true, answers };
  } catch (err) {
    const aborted = controller.signal.aborted;
    if (!aborted) {
      console.warn(
        `[decisions] ${req.operation} failed:`,
        err instanceof Error ? err.message : err
      );
    }
    return {
      ok: false,
      reason: aborted ? "timeout" : "error",
      ...(err instanceof Error ? { detail: err.message } : {}),
    };
  } finally {
    clearTimeout(timer);
    release();
  }
}

// ── Reading answers ──

/** The choice with the highest probability and its probability, or null. */
export function topChoice(
  answer: DecisionAnswer | undefined
): { value: string; probability: number } | null {
  if (!answer) return null;
  const probs = answer.probabilities ?? {};
  let best: { value: string; probability: number } | null = null;
  for (const [value, probability] of Object.entries(probs)) {
    if (!best || probability > best.probability) best = { value, probability };
  }
  if (best) return best;
  if (answer.choice !== undefined) {
    return { value: answer.choice, probability: answer.confidence ?? 0 };
  }
  return null;
}

/** A float from the environment, or the default. */
export function thresholdEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : fallback;
}
