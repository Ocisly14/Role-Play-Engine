// src/engine/resolution/strictSchemaFallback.ts
//
// The one thing the staged runner is allowed to change about a request when
// the provider refuses it (plan Fixed Design Decision 8).
//
// A strict tool is compiled into a grammar BEFORE any token is generated, and
// the compiler can refuse: the grammar is too large, or too many optional
// parameters are declared across the request's strict tools. That refusal is
// deterministic — the same schema asked of the same model refuses again, every
// tick, forever — so retrying it is pure waste, and retrying it with a
// different tool is the only thing that can work. Every OTHER failure is
// transient, semantic, or ours: a rate limit, an outage, a timeout, a model
// that answered with nothing, a payload the validator rejected. None of them
// says anything about the schema, and downgrading on one of them would quietly
// give up the grammar for the rest of the process over a blip.
//
// So this module holds three small things and nothing else: the classifier
// (does this error text say "I could not compile your schema"?), the
// process-wide memo of the schemas a provider has already refused, and the
// provider/model pair the memo is keyed by. It reads error text and env; it
// makes no call, and it decides nothing about the world.
//
// The fallback changes STRUCTURE ENFORCEMENT only. A non-strict answer goes
// through exactly the same phase validator as a strict one — what is lost is
// the guarantee that the shape arrives right, not any check on what it says.

import { getModelSettings } from "../../models/generator.js";
import { ModelClass, ModelProviderName } from "../../models/types.js";

/**
 * The phrases Anthropic actually answers with, measured live on
 * claude-sonnet-5 and recorded in `scripts/probe-strict-schema.ts`:
 *
 *   400 invalid_request_error — "The compiled grammar is too large, which
 *   would cause performance issues. Simplify your tool schemas or reduce the
 *   number of strict tools."
 *
 *   400 invalid_request_error — "... too many optional parameters (80) ..."
 *
 * Matched as case-insensitive substrings because the message travels wrapped:
 * `runWithPolicy` rethrows every failure as `Failed to generate after 3
 * attempts with anthropic: <original message>`, and the SDK's own message
 * already carries the status code and the JSON body around the sentence.
 */
const COMPILATION_PHRASES = [
  "the compiled grammar is too large",
  "too many optional parameters",
];

/**
 * The generic pairing, for a vendor that words it differently or a phrasing
 * that changes under us: the message has to be about a GRAMMAR and about
 * compiling one or its size. Deliberately narrow — "grammar" alone would
 * catch a sentence about the model's prose, and "too large" alone would catch
 * a context-length error, which is not a schema problem and must not downgrade
 * anything.
 */
function looksLikeGrammarCompilation(text: string): boolean {
  return (
    text.includes("grammar") &&
    (text.includes("too large") || text.includes("compile"))
  );
}

/**
 * The text to classify. Only an `Error`'s message and a thrown string are
 * read: the policy layer (`generator.ts`, `toErrorMessage`) turns everything a
 * provider throws into one of those two before the engine ever sees it, and
 * stringifying an arbitrary value would invent text nobody sent.
 */
function errorText(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") return error;
  return "";
}

/**
 * True ONLY for a provider-side grammar/schema compilation rejection — the one
 * error class a non-strict retry can answer.
 *
 * False for everything else, on purpose: a generic 400, an authentication
 * failure, a rate limit or overload, a timeout or a reset socket, a model that
 * returned no tool call, and any validator text. Pure; keeps nothing.
 */
export function isStrictSchemaRejection(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  if (text.length === 0) return false;
  if (COMPILATION_PHRASES.some((phrase) => text.includes(phrase))) return true;
  return looksLikeGrammarCompilation(text);
}

/**
 * The provider and model the Engine's MEDIUM call will actually resolve to,
 * derived the same way `runWithPolicy` derives them: the environment's
 * `MODEL_PROVIDER`, defaulting to OpenAI, and that provider's MEDIUM model
 * name. "unknown" when the provider has no settings at all — the pair only has
 * to identify the request, and an unconfigured provider is going to fail for a
 * reason that has nothing to do with grammars anyway.
 *
 * Read per call rather than once: the env var is process-wide but a test (and
 * a long-lived server) may change it, and a memo keyed on a stale vendor would
 * downgrade a schema the current one compiles fine.
 */
export function engineModelIdentity(): { provider: string; model: string } {
  const provider = process.env.MODEL_PROVIDER || ModelProviderName.OPENAI;
  const model =
    getModelSettings(provider as ModelProviderName, ModelClass.MEDIUM)?.name ??
    "unknown";
  return { provider, model };
}

/**
 * The schemas this process has seen refused, by `schemaFingerprint` — which is
 * vendor + model + tool name + the schema itself, and deliberately blind to
 * the `strict` flag, so the strict tool and its non-strict copy share one key.
 *
 * In process only, and that is the whole intent: the memo saves the SECOND and
 * every later tick a rejected round trip over the full world context, and a
 * restart (a new deploy, an edited schema, a changed model) asks the question
 * again rather than inheriting an answer that may no longer be true.
 */
const DOWNGRADED = new Map<string, { toolName: string; reason: string }>();

export function isStrictDowngraded(fingerprint: string): boolean {
  return DOWNGRADED.has(fingerprint);
}

/**
 * Remember a refusal. `detail` is the memo's own record of WHY a fingerprint
 * is downgraded — which tool it was and what the provider said — so that a
 * process whose engine is quietly running unstrict can be asked, in a debugger
 * or a test, what refused it. The runner reads only `isStrictDowngraded`.
 */
export function rememberStrictDowngrade(
  fingerprint: string,
  detail: { toolName: string; reason: string }
): void {
  // First refusal wins: the reason kept is the one that caused the downgrade,
  // not whatever the provider said the last time it was asked.
  if (DOWNGRADED.has(fingerprint)) return;
  DOWNGRADED.set(fingerprint, detail);
}

/** Test hook. Nothing in the runtime clears the memo — a refusal stands for
 *  the life of the process. */
export function resetStrictDowngrades(): void {
  DOWNGRADED.clear();
}
