#!/usr/bin/env tsx
//
// scripts/probe-strict-schema.ts
//
// Which shape of the Engine's submission will Anthropic compile a grammar for?
//
// A resolution is submitted in SIX phases, one tool per phase
// (`worldResolutionStageSchemas.ts`): endings → starts → characterChanges →
// itemChanges → sceneChanges → occurrences. Each request offers exactly ONE of
// them — plus the non-strict `damageRoll` in the endings phase — each tool takes
// one required top-level array and nothing else, and every one of them asks for
// `strict: true`. This script measures whether the API actually grants that.
//
// Three ceilings are in play:
//
//   * at most 20 strict tools per request                     (documented)
//   * at most 24 OPTIONAL parameters across every strict tool (documented; the
//     400 reports the offending count, e.g. "too many optional parameters (80)")
//   * compiled grammar size                                   (NO number given)
//
// The rejection happens at request validation, before a single output token, so
// probing costs input tokens and nothing else. This script sends one minimal
// request per variant and reports which ceiling each one hits — and, when the
// API names a number, what that number was.
//
// What the table measures:
//
//   (a) each of the six phase tools ALONE, strict — the per-phase question, one
//       row each. This is the shape the runner sends for five of six phases.
//   (b) all six together, strict — a request the Engine never sends, but it
//       bounds the total and says whether the staging is what buys the grammar.
//   (c) `submit_endings` strict beside the non-strict `damageRoll` — the
//       endings-phase request exactly as the runner sends it.
//
// Plus one control: all six NON-strict, which must be accepted. If it is not,
// the probe itself is malformed and nothing below it means anything.
//
// ─── History: the pre-phase measurements (2026-09-03, claude-sonnet-5) ───
//
// Before the staged rewrite, a resolution was submitted by two terminal tools
// called together in one turn: `submit_actions` (`starting` + `ending`) and
// `submit_effects` (`occurrences` + the three `*Changes` lists). Neither tool
// exists any more; these are the numbers that were measured against them, and
// they are the reason the phase split was made:
//
//   the whole submission, one strict tool   23 optional / 19 branches  REJECTED
//   `submit_effects` alone, strict          17 optional / 19 branches  REJECTED
//   both unions merged, one strict tool     29 optional / 16 branches  REJECTED
//                                           (died on the optional count first,
//                                            so 16 branches was never measured)
//   `submit_actions` alone, strict           6 optional /  0 branches  ACCEPTED
//
// The rejection was always the same 400, and always before any generation:
//
//   400 invalid_request_error — "The compiled grammar is too large, which
//   would cause performance issues. Simplify your tool schemas or reduce the
//   number of strict tools."
//
// A branch sweep beside the accepted action half put the unpublished ceiling at
// roughly "the action half plus one small union" — 5 branches fit, 6 did not —
// so what is bounded is total grammar mass rather than branch count. The other
// settled question: a NON-strict tool counts toward neither ceiling; it is
// compiled into no grammar at all, which is what made a mixed request legal.
// Those measurements are why `submit_effects` shipped unconstrained, and an
// unconstrained submission is why the model serialized `starting` into a JSON
// string re-wrapping its own array — 7 of 55 stored Claude submissions, each
// costing a full-world correction round.
//
// `--sweep` still walks a union from 1 to 7 branches to put a number on the
// ceiling a single phase tool may grow into; `--sweep-endings` does the same
// with the real endings request also on the wire. Re-run either when the model
// changes — every number here was taken on claude-sonnet-5.
//
// Usage:
//   pnpm tsx scripts/probe-strict-schema.ts
//   pnpm tsx scripts/probe-strict-schema.ts --only endings-request
//   pnpm tsx scripts/probe-strict-schema.ts --model claude-opus-5
//   pnpm tsx scripts/probe-strict-schema.ts --sweep
//
// No tick is run, no resolution is generated, no session is touched.

import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";

import {
  CHARACTER_CHANGES_LIST,
  CHARACTER_OPS,
  CODE_TOOL_SPECS,
  opSchema,
} from "../src/engine/resolution/worldDeltaSchema.js";
import {
  PHASE_TOOL_NAMES,
  PHASE_TOOLS,
  PHASE_TOOLS_NON_STRICT,
  RESOLUTION_PHASES,
} from "../src/engine/resolution/worldResolutionStageSchemas.js";
import type { ToolSpec } from "../src/models/providers/types.js";

// =========================================================================
// CLI
// =========================================================================

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(`--${name}`);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : undefined;
};

/** The class the World Action Engine actually runs on. */
const MODEL =
  flag("model") ?? process.env.MEDIUM_ANTHROPIC_MODEL ?? "claude-sonnet-5";
const ONLY = flag("only");

// =========================================================================
// The two limits, counted locally, so the API's number can be checked
// =========================================================================

function countOptionals(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const v of node) countOptionals(v, out);
    return out;
  }
  const o = node as Record<string, unknown>;
  if (o.type === "object" && o.properties) {
    const required = new Set((o.required as string[] | undefined) ?? []);
    for (const k of Object.keys(o.properties as Record<string, unknown>)) {
      if (!required.has(k)) out.push(k);
    }
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === "enum" || k === "required" || k === "const") continue;
    countOptionals(v, out);
  }
  return out;
}

function countBranches(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  if (Array.isArray(node)) {
    return node.reduce<number>((n, v) => n + countBranches(v), 0);
  }
  const o = node as Record<string, unknown>;
  let n = Array.isArray(o.anyOf) ? (o.anyOf as unknown[]).length : 0;
  for (const [k, v] of Object.entries(o)) {
    if (k === "enum" || k === "required" || k === "const") continue;
    n += countBranches(v);
  }
  return n;
}

// =========================================================================
// Variants
// =========================================================================

interface Variant {
  name: string;
  what: string;
  tools: ToolSpec[];
}

/** (a) One phase tool, strict, alone — five of the six phases send exactly
 *  this, and the sixth (endings) sends it plus `damageRoll`. */
const ALONE: Variant[] = RESOLUTION_PHASES.map((phase) => ({
  name: `alone-${phase}`,
  what: `${PHASE_TOOL_NAMES[phase]} alone, strict — the ${phase} phase's request`,
  tools: [PHASE_TOOLS[phase]],
}));

const VARIANTS: Variant[] = [
  {
    name: "baseline-all-six-nonstrict",
    what: "CONTROL: all six phase tools, none strict — must be accepted, or the probe itself is malformed",
    tools: [...CODE_TOOL_SPECS, ...RESOLUTION_PHASES.map((p) => PHASE_TOOLS_NON_STRICT[p])],
  },
  // (c) The one request in the whole runner that carries two tools.
  {
    name: "endings-request",
    what: "PRODUCTION: submit_endings strict beside the non-strict damageRoll — the endings phase exactly as sent",
    tools: [...CODE_TOOL_SPECS, PHASE_TOOLS.endings],
  },
  ...ALONE,
  // (b) Never sent. It bounds the total, and it says whether staging is what
  //     buys the grammar or whether the schemas would have compiled together.
  {
    name: "all-six-strict",
    what: "all six phase tools strict in ONE request — never sent; bounds the total",
    tools: RESOLUTION_PHASES.map((p) => PHASE_TOOLS[p]),
  },
];

// =========================================================================
// Branch sweep: the ceiling itself
// =========================================================================

/**
 * A change list whose operation union has been truncated to exactly N branches,
 * sent strict and alone (or beside the real endings request). Walking N up from
 * 1 puts a number on the ceiling nobody publishes — the schema is not a real
 * one, it is a ruler, and what it measures is how far a single phase tool could
 * grow before the grammar compiler refuses it.
 */
function sweepVariant(branches: number, withEndings = false): Variant {
  const ops = CHARACTER_OPS.flatMap((op) =>
    op.kinds.map((kind) => ({ ...op, kinds: [kind] }))
  ).slice(0, branches);
  const changes = structuredClone(CHARACTER_CHANGES_LIST) as unknown as {
    items: { properties: { operation: unknown } };
  };
  changes.items.properties.operation = opSchema(ops as never);
  return {
    name: `sweep${withEndings ? "+endings" : ""}-${branches}br`,
    what: `${withEndings ? "the endings request + " : ""}a change list whose operation union has exactly ${branches} branch(es)`,
    tools: [
      ...(withEndings ? [...CODE_TOOL_SPECS, PHASE_TOOLS.endings] : []),
      {
        name: "submit_changes",
        description: `Ruler: ${branches} branch(es).`,
        strict: true,
        inputSchema: {
          type: "object",
          properties: { characterChanges: changes },
          required: ["characterChanges"],
          additionalProperties: false,
        },
      },
    ],
  };
}

// =========================================================================
// Probe
// =========================================================================

interface Result {
  variant: Variant;
  strictOptionals: number;
  strictBranches: number;
  verdict: "compiled" | "rejected" | "error";
  detail: string;
}

async function probe(client: Anthropic, variant: Variant): Promise<Result> {
  const strictTools = variant.tools.filter((t) => t.strict);
  const strictOptionals = strictTools.reduce(
    (n, t) => n + countOptionals(t.inputSchema).length,
    0
  );
  const strictBranches = strictTools.reduce(
    (n, t) => n + countBranches(t.inputSchema),
    0
  );

  try {
    await client.messages.create({
      model: MODEL,
      // The grammar is compiled at request validation. Nothing needs to be
      // generated for the answer this script wants, so ask for almost nothing.
      max_tokens: 16,
      tools: variant.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
        ...(t.strict ? { strict: true } : {}),
      })) as Anthropic.Messages.ToolUnion[],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: "ok" }],
    });
    return {
      variant,
      strictOptionals,
      strictBranches,
      verdict: "compiled",
      detail: "accepted",
    };
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError) {
      const message =
        (err.error as { error?: { message?: string } } | undefined)?.error
          ?.message ?? err.message;
      return {
        variant,
        strictOptionals,
        strictBranches,
        verdict: "rejected",
        detail: message,
      };
    }
    return {
      variant,
      strictOptionals,
      strictBranches,
      verdict: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const client = new Anthropic();
  const chosen = has("sweep-endings")
    ? [1, 2, 3, 4, 5, 6, 7].map((n) => sweepVariant(n, true))
    : has("sweep")
      ? [1, 2, 3, 4, 5, 6, 7].map((n) => sweepVariant(n))
      : ONLY
        ? VARIANTS.filter((v) => v.name === ONLY)
        : VARIANTS;
  if (chosen.length === 0) {
    throw new Error(
      `no variant named ${ONLY}. Known: ${VARIANTS.map((v) => v.name).join(", ")}`
    );
  }

  console.log(`model: ${MODEL}`);
  console.log(
    "documented ceilings: 20 strict tools · 24 optional parameters across them · grammar size (no number published)\n"
  );

  const results: Result[] = [];
  for (const variant of chosen) {
    process.stdout.write(`… ${variant.name}`);
    const result = await probe(client, variant);
    results.push(result);
    process.stdout.write(
      `\r${result.verdict === "compiled" ? "✅" : "❌"} ${variant.name}\n`
    );
  }

  console.log("");
  const pad = Math.max(...results.map((r) => r.variant.name.length));
  for (const r of results) {
    const strictNames = r.variant.tools
      .filter((t) => t.strict)
      .map((t) => t.name);
    console.log(
      `${r.verdict === "compiled" ? "✅" : "❌"} ${r.variant.name.padEnd(pad)}  ` +
        `strict=[${strictNames.join(", ") || "none"}]  ` +
        `optional=${r.strictOptionals}/24  anyOf=${r.strictBranches}`
    );
    console.log(`   ${r.variant.what}`);
    if (r.verdict !== "compiled") console.log(`   → ${r.detail}`);
    console.log("");
  }

  // The three questions this script exists to settle.
  const byName = (name: string): Result | undefined =>
    results.find((r) => r.variant.name === name);

  const alone = ALONE.map((v) => byName(v.name)).filter(
    (r): r is Result => r !== undefined
  );
  if (alone.length > 0) {
    const failed = alone.filter((r) => r.verdict !== "compiled");
    console.log(
      failed.length === 0
        ? `→ every phase tool probed (${alone.length}/6) compiles alone: each phase gets its strict grammar.`
        : `→ these phase tools do NOT compile alone: ${failed
            .map((r) => r.variant.tools.filter((t) => t.strict)[0]?.name)
            .join(", ")} — the 400 above says which ceiling. They must fall back to non-strict.`
    );
  }

  const endings = byName("endings-request");
  if (endings) {
    console.log(
      endings.verdict === "compiled"
        ? "→ the production endings request compiles: a non-strict tool (damageRoll) beside a strict one costs the grammar nothing."
        : "→ the production endings request was REJECTED — the endings phase cannot run strict as sent; see its 400 above."
    );
  }

  const together = byName("all-six-strict");
  if (together) {
    console.log(
      together.verdict === "compiled"
        ? "→ all six together also compile, so the staging is not what buys the grammar — one request per phase is bought by the prompt design, not by this ceiling."
        : "→ all six together are rejected, so staging IS what buys the grammar: the schemas only compile when a request carries one phase at a time."
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
