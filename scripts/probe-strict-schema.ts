#!/usr/bin/env tsx
//
// scripts/probe-strict-schema.ts
//
// Which shape of the Engine's submission tool will Anthropic compile?
//
// `submit_resolution` is `strict: false` (worldDeltaSchema.ts) because a live
// Sonnet 5 run got back, before any generation:
//
//   400 invalid_request_error — "The compiled grammar is too large, which
//   would cause performance issues. Simplify your tool schemas or reduce the
//   number of strict tools."
//
// and without a grammar the model hands `starting` back as a JSON string —
// measured at 7/55 submissions across the stored Claude traces, and 3/3 in the
// 2026-09-03 grayhaven run. There are two published ceilings and one that is
// not published:
//
//   * at most 20 strict tools per request                     (documented)
//   * at most 24 OPTIONAL parameters across every strict tool (documented; the
//     400 reports the offending count, e.g. "too many optional parameters (80)")
//   * compiled grammar size                                   (NO number given)
//
// The rejection happens at request validation, before a single output token,
// so probing costs input tokens and nothing else. This script sends one
// minimal request per variant and reports which ceiling each one hits — and,
// when the API names a number, what that number was.
//
// Both questions it was written for are answered, and the answers are recorded
// in schemaAgreement.test.ts beside the assertions they justify:
//   1. A non-strict tool counts toward neither ceiling — it is compiled into no
//      grammar at all. That is what makes the production pairing legal.
//   2. `starting` + `ending` alone compiles; the effect lists do not, at any
//      arrangement tried. What is bounded is total grammar mass rather than
//      branch count, and the budget runs out at roughly "the action half plus
//      one small thing".
//
// `--sweep` walks a union from 1 to 7 branches beside the action half;
// `--sweep-occ` does the same with `occurrences` also strict, which is where
// the ceiling bites (5 branches fit, 6 do not). Re-run either when the model
// changes — every number here was taken on claude-sonnet-5.
//
// Usage:
//   pnpm tsx scripts/probe-strict-schema.ts
//   pnpm tsx scripts/probe-strict-schema.ts --only split-actions-strict
//   pnpm tsx scripts/probe-strict-schema.ts --model claude-opus-5
//
// No tick is run, no resolution is generated, no session is touched.

import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";

import {
  CHARACTER_OPS,
  CODE_TOOL_SPECS,
  SCENE_OPS,
  SUBMIT_TOOLS,
  opSchema,
  submitActionsTool,
  submitEffectsTool,
} from "../src/engine/resolution/worldDeltaSchema.js";
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
// Schema surgery
// =========================================================================

type Schema = Record<string, unknown>;

/** The six lists as one object again — the shape that existed before the
 *  split, so the probe can still ask what the API makes of it. */
const SUBMIT = {
  type: "object",
  properties: {
    ...(submitActionsTool.inputSchema as { properties: Record<string, Schema> })
      .properties,
    ...(submitEffectsTool.inputSchema as { properties: Record<string, Schema> })
      .properties,
  },
  required: [
    ...((submitActionsTool.inputSchema as { required: string[] }).required ??
      []),
    ...((submitEffectsTool.inputSchema as { required: string[] }).required ??
      []),
  ],
  additionalProperties: false as const,
};

/** One tool carrying exactly the named top-level fields of the submission. */
function partition(name: string, fields: string[], strict: boolean): ToolSpec {
  const properties: Record<string, Schema> = {};
  for (const f of fields) {
    if (!SUBMIT.properties[f]) throw new Error(`no such field: ${f}`);
    properties[f] = SUBMIT.properties[f];
  }
  return {
    name,
    description: `Probe partition carrying ${fields.join(", ")}.`,
    inputSchema: {
      type: "object",
      properties,
      // Same contract as today: every list required, empty domains send `[]`.
      required: fields,
      additionalProperties: false,
    },
    strict,
  };
}

/** The pre-split tool: all six lists in one schema, `strict` forced either
 *  way. Kept so the rejection that motivated the split stays reproducible. */
function whole(strict: boolean): ToolSpec {
  return {
    name: "submit_resolution",
    description: "The pre-split single-tool submission.",
    inputSchema: SUBMIT,
    strict,
  };
}

/** SCENE_OPS with the three connection kinds folded into one and the two
 *  environment kinds into one — the "merge the unions" proposal. Branches
 *  8 -> 5; every field that was required in its own kind becomes optional. */
const MERGED_SCENE_OPS = [
  ...SCENE_OPS.filter(
    (o) =>
      !o.kinds[0].startsWith("connection") &&
      !o.kinds[0].startsWith("environment")
  ),
  {
    kinds: ["connection"],
    fields: "",
    schema: {
      properties: {
        connectionId: { type: "string" },
        blocked: { type: "boolean" },
        reason: { type: "string" },
        hidden: { type: "boolean" },
        characterIds: { type: "array", items: { type: "string" } },
      },
      required: ["connectionId"],
    },
  },
  {
    kinds: ["environment"],
    fields: "",
    schema: {
      properties: {
        quantity: {
          type: "string",
          enum: ["temperature", "illumination", "oxygen", "noise"],
        },
        value: { type: "number" },
        add: { type: "array", items: { type: "string" } },
        remove: { type: "array", items: { type: "string" } },
      },
      required: [],
    },
  },
];

/** Just the three change lists, with the merged scene union swapped in and
 *  `strict` on. Optionals land at 19 — under the 24 ceiling — so the grammar
 *  check actually runs. The whole-tool merged variant never got that far: it
 *  died on the optional count (29) first, which is why 16 branches has never
 *  been measured. */
function mergedChangesOnly(): ToolSpec {
  const scene = structuredClone(SUBMIT.properties.sceneChanges) as {
    items: { properties: { operation: unknown } };
  };
  scene.items.properties.operation = opSchema(MERGED_SCENE_OPS as never);
  return {
    name: "submit_changes",
    description: "The three change lists, operation unions merged.",
    strict: true,
    inputSchema: {
      type: "object",
      properties: {
        characterChanges: SUBMIT.properties.characterChanges,
        sceneChanges: scene,
        itemChanges: SUBMIT.properties.itemChanges,
      },
      required: ["characterChanges", "sceneChanges", "itemChanges"],
      additionalProperties: false,
    },
  };
}

/** The whole tool with the merged scene union swapped in, strict. */
function mergedUnions(): ToolSpec {
  const scene = structuredClone(SUBMIT.properties.sceneChanges) as {
    items: { properties: { operation: unknown } };
  };
  scene.items.properties.operation = opSchema(MERGED_SCENE_OPS as never);
  return {
    name: "submit_resolution",
    description: "The pre-split single-tool submission, unions merged.",
    strict: true,
    inputSchema: {
      ...SUBMIT,
      properties: { ...SUBMIT.properties, sceneChanges: scene },
    },
  };
}

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

const ACTION_FIELDS = ["starting", "ending"];
const EFFECT_FIELDS = [
  "occurrences",
  "characterChanges",
  "sceneChanges",
  "itemChanges",
];

interface Variant {
  name: string;
  what: string;
  tools: ToolSpec[];
}

const VARIANTS: Variant[] = [
  {
    name: "production",
    what: "the tool set the Engine actually sends, exactly as exported",
    tools: [...CODE_TOOL_SPECS, ...SUBMIT_TOOLS],
  },
  {
    name: "baseline-nonstrict",
    what: "today's request, unchanged — proves the probe itself is well-formed",
    tools: [...CODE_TOOL_SPECS, whole(false)],
  },
  {
    name: "whole-strict",
    what: "one tool, strict — the shape that was rejected on 2026-09-03",
    tools: [...CODE_TOOL_SPECS, whole(true)],
  },
  {
    name: "merged-unions-strict",
    what: "one tool, strict, connection×3→1 and environment×2→1",
    tools: [...CODE_TOOL_SPECS, mergedUnions()],
  },
  {
    name: "split-actions-strict",
    what: "THE PROPOSAL: starting+ending strict, the rest non-strict",
    tools: [
      ...CODE_TOOL_SPECS,
      partition("submit_actions", ACTION_FIELDS, true),
      partition("submit_effects", EFFECT_FIELDS, false),
    ],
  },
  {
    name: "split-both-strict",
    what: "both halves strict — does the grammar bill just move?",
    tools: [
      ...CODE_TOOL_SPECS,
      partition("submit_actions", ACTION_FIELDS, true),
      partition("submit_effects", EFFECT_FIELDS, true),
    ],
  },
  {
    name: "actions-strict-alone",
    what: "starting+ending strict, no second tool — isolates the cheap half",
    tools: [
      ...CODE_TOOL_SPECS,
      partition("submit_actions", ACTION_FIELDS, true),
    ],
  },
  // ─── Bisecting the grammar ceiling. Nobody has published a number, and
  //     the earlier merged-union probe never reached the grammar check: the
  //     optional count (29) rejected it first. These four walk the branch
  //     count up with the optional budget kept legal throughout.
  {
    name: "bisect-0br-occurrences",
    what: "occurrences alone, strict — 4 optional, 0 branches (control)",
    tools: [
      ...CODE_TOOL_SPECS,
      partition("submit_actions", ACTION_FIELDS, true),
      partition("submit_occurrences", ["occurrences"], true),
    ],
  },
  {
    name: "bisect-7br-occ-char",
    what: "THE CANDIDATE: occurrences + characterChanges strict — 7 branches, 0 extra optionals",
    tools: [
      ...CODE_TOOL_SPECS,
      partition("submit_actions", ACTION_FIELDS, true),
      partition("submit_effects", ["occurrences", "characterChanges"], true),
      partition("submit_world", ["sceneChanges", "itemChanges"], false),
    ],
  },
  {
    name: "bisect-11br-plus-item",
    what: "…plus itemChanges — 11 branches, 12 optionals",
    tools: [
      ...CODE_TOOL_SPECS,
      partition("submit_actions", ACTION_FIELDS, true),
      partition(
        "submit_effects",
        ["occurrences", "characterChanges", "itemChanges"],
        true
      ),
      partition("submit_world", ["sceneChanges"], false),
    ],
  },
  {
    name: "bisect-16br-merged-changes",
    what: "the three change lists with merged unions — 16 branches, 19 optionals",
    tools: [...CODE_TOOL_SPECS, mergedChangesOnly()],
  },
  {
    name: "effects-strict-alone",
    what: "the three unions strict, no action tool — isolates the 19 branches",
    tools: [
      ...CODE_TOOL_SPECS,
      partition("submit_effects", EFFECT_FIELDS, true),
    ],
  },
];

// =========================================================================
// Branch sweep: the ceiling itself
// =========================================================================

/**
 * `submit_actions` (0 branches, accepted) plus a change list whose operation
 * union has been truncated to exactly N branches. Walking N up from 1 puts a
 * number on the ceiling nobody publishes — the schema is not a real one, it is
 * a ruler.
 */
function sweepVariant(branches: number, withOccurrences = false): Variant {
  const ops = CHARACTER_OPS.flatMap((op) =>
    op.kinds.map((kind) => ({ ...op, kinds: [kind] }))
  ).slice(0, branches);
  const changes = structuredClone(
    SUBMIT.properties.characterChanges
  ) as { items: { properties: { operation: unknown } } };
  changes.items.properties.operation = opSchema(ops as never);
  return {
    name: `sweep${withOccurrences ? "+occ" : ""}-${branches}br`,
    what: `${withOccurrences ? "actions + occurrences + " : "actions + "}a change list whose operation union has exactly ${branches} branch(es)`,
    tools: [
      ...CODE_TOOL_SPECS,
      partition("submit_actions", ACTION_FIELDS, true),
      ...(withOccurrences
        ? [partition("submit_occurrences", ["occurrences"], true)]
        : []),
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
  const chosen = has("sweep-occ")
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

  // The two questions this script exists to settle.
  const proposal = results.find(
    (r) => r.variant.name === "split-actions-strict"
  );
  const bothStrict = results.find(
    (r) => r.variant.name === "split-both-strict"
  );
  if (proposal) {
    console.log(
      proposal.verdict === "compiled"
        ? "→ 拆分方案可编译：starting+ending 可以拿到 strict 保证。"
        : "→ 拆分方案仍被拒；上面那条 400 说明卡在哪个上限。"
    );
  }
  if (proposal && bothStrict) {
    console.log(
      proposal.verdict === "compiled" && bothStrict.verdict === "rejected"
        ? "→ 非 strict 的 tool 不进语法/optional 的账（两者只差 submit_effects 的 strict 标志）。"
        : "→ 关于非 strict tool 是否计入，这两个变体没有分出差别，见上面各自的 400。"
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
