// The classifier, the memo and the identity behind the one fallback the
// staged runner is allowed: a provider that refuses to COMPILE a strict
// tool's grammar is answered once, unstrict. Everything else must not
// downgrade anything — the whole value of the rule is that it is narrow.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getModelSettings } from "../../../models/generator.js";
import { ModelClass, ModelProviderName } from "../../../models/types.js";
import {
  engineModelIdentity,
  isStrictDowngraded,
  isStrictSchemaRejection,
  rememberStrictDowngrade,
  resetStrictDowngrades,
} from "../strictSchemaFallback.js";

/**
 * The two sentences Anthropic actually answers with. The first is quoted
 * verbatim from the live 400 recorded in `scripts/probe-strict-schema.ts`; of
 * the second only the phrase and the reported count are measured — the words
 * around it here are fixture, which is exactly why the classifier matches on
 * the phrase rather than on a whole message.
 */
const GRAMMAR_TOO_LARGE =
  "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.";
const TOO_MANY_OPTIONALS =
  "tools: too many optional parameters (80) — at most 24 are allowed";

/**
 * How the message reaches the engine. `runWithPolicy` retries every failure
 * three times and rethrows the last one inside its own envelope, and the SDK
 * has already wrapped the sentence in a status line and a JSON body — so the
 * classifier never sees the bare text and must not depend on seeing it.
 */
const wrapped = (message: string) =>
  new Error(
    `Failed to generate after 3 attempts with anthropic: 400 {"type":"error","error":{"type":"invalid_request_error","message":"${message}"}}`
  );

describe("isStrictSchemaRejection — only a grammar that would not compile", () => {
  it("classifies the compiled-grammar refusal, bare and wrapped", () => {
    expect(isStrictSchemaRejection(new Error(GRAMMAR_TOO_LARGE))).toBe(true);
    expect(isStrictSchemaRejection(wrapped(GRAMMAR_TOO_LARGE))).toBe(true);
  });

  it("classifies the optional-parameter ceiling, bare and wrapped", () => {
    expect(isStrictSchemaRejection(new Error(TOO_MANY_OPTIONALS))).toBe(true);
    expect(isStrictSchemaRejection(wrapped(TOO_MANY_OPTIONALS))).toBe(true);
  });

  it("is case-insensitive, since the phrase travels inside vendor JSON", () => {
    expect(
      isStrictSchemaRejection(new Error(GRAMMAR_TOO_LARGE.toUpperCase()))
    ).toBe(true);
  });

  it("classifies a differently worded refusal that is still about compiling a grammar", () => {
    // The generic pairing, for a vendor that words it its own way.
    expect(
      isStrictSchemaRejection(
        new Error("could not compile the tool grammar for submit_starts")
      )
    ).toBe(true);
  });

  it.each([
    // A 400 that is about the request rather than about the schema.
    "400 invalid_request_error: messages.0.content.0: field required",
    "401 authentication_error: invalid x-api-key",
    "429 rate_limit_error: number of requests has exceeded your rate limit",
    "529 overloaded_error: Overloaded",
    "Request timed out after 600000ms (ETIMEDOUT)",
    "read ECONNRESET",
    // Ours, not the provider's.
    "Model returned no tool call",
    'itemChange:0 — unknown item operation kind "teleport"',
    // "too large" WITHOUT a grammar is a context-length problem, and a tick
    // that downgraded its schema over one would give up the grammar for good
    // and still be too large.
    "413 request_too_large: prompt is too large for this model",
  ])("does not classify %s", (message) => {
    expect(isStrictSchemaRejection(new Error(message))).toBe(false);
    expect(isStrictSchemaRejection(wrapped(message))).toBe(false);
  });

  it("does not classify a value that is neither an Error nor a string", () => {
    // The policy layer turns everything into one of those two before the
    // engine sees it; stringifying anything else would invent text nobody
    // sent, and text nobody sent must never downgrade a schema.
    expect(
      isStrictSchemaRejection({ message: GRAMMAR_TOO_LARGE, status: 400 })
    ).toBe(false);
    expect(isStrictSchemaRejection(null)).toBe(false);
    expect(isStrictSchemaRejection(undefined)).toBe(false);
    expect(isStrictSchemaRejection(400)).toBe(false);
  });
});

describe("the downgrade memo", () => {
  beforeEach(() => resetStrictDowngrades());

  it("knows nothing until something is remembered", () => {
    expect(isStrictDowngraded("fp_scene")).toBe(false);
  });

  it("remembers one fingerprint without touching another", () => {
    rememberStrictDowngrade("fp_scene", {
      toolName: "submit_scene_changes",
      reason: GRAMMAR_TOO_LARGE,
    });
    expect(isStrictDowngraded("fp_scene")).toBe(true);
    expect(isStrictDowngraded("fp_items")).toBe(false);
  });

  it("is idempotent — a second refusal of the same schema changes nothing", () => {
    rememberStrictDowngrade("fp_scene", { toolName: "a", reason: "first" });
    rememberStrictDowngrade("fp_scene", { toolName: "a", reason: "second" });
    expect(isStrictDowngraded("fp_scene")).toBe(true);
  });

  it("is cleared only by the test hook", () => {
    rememberStrictDowngrade("fp_scene", { toolName: "a", reason: "r" });
    resetStrictDowngrades();
    expect(isStrictDowngraded("fp_scene")).toBe(false);
  });
});

describe("engineModelIdentity — the pair a fingerprint is keyed by", () => {
  const saved = process.env.MODEL_PROVIDER;
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"; only delete unsets it
    if (saved === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = saved;
  });

  it("reads the vendor off MODEL_PROVIDER and takes that vendor's MEDIUM model", () => {
    // The Engine's calls are MEDIUM (`callPhaseModel`), so that is the model
    // whose grammar was refused.
    process.env.MODEL_PROVIDER = "anthropic";
    expect(engineModelIdentity()).toEqual({
      provider: "anthropic",
      model: getModelSettings(ModelProviderName.ANTHROPIC, ModelClass.MEDIUM)
        ?.name,
    });
  });

  it("defaults to OpenAI when the variable is unset, exactly as runWithPolicy does", () => {
    // biome-ignore lint/performance/noDelete: see afterEach — process.env cannot be unset by assignment
    delete process.env.MODEL_PROVIDER;
    expect(engineModelIdentity()).toEqual({
      provider: "openai",
      model: getModelSettings(ModelProviderName.OPENAI, ModelClass.MEDIUM)
        ?.name,
    });
  });

  it("says the model is unknown for a vendor with no settings, rather than throwing", () => {
    // A misconfigured vendor is going to fail for a reason that has nothing
    // to do with grammars; the identity only has to name the request.
    process.env.MODEL_PROVIDER = "nonesuch";
    expect(engineModelIdentity()).toEqual({
      provider: "nonesuch",
      model: "unknown",
    });
  });
});
