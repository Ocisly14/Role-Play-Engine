import { describe, expect, it } from "vitest";
import {
  CODE_TOOL_SPECS,
  submitActionsTool,
  submitEffectsTool,
} from "../../../engine/resolution/worldDeltaSchema.js";
import { TOOL_CAPS, VALID_TOOLS } from "../../../roleSim/toolDispatcher.js";
import { AGENT_TOOLS } from "../../../roleSim/tools/schemas.js";
import {
  canBeStrict,
  toDeepSeekStrictSchema,
} from "../deepseekStrictSchema.js";
import { allPropertiesRequired } from "../openai.js";
import type { ToolSpec } from "../types.js";

/**
 * `strict: true` is only expressible when every property is also required —
 * OpenAI rejects a strict schema with an optional field. These checks catch
 * a schema that would 400 at request time.
 */
function assertStrictIsExpressible(tool: ToolSpec) {
  if (!tool.strict) return;
  const schema = tool.inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const properties = Object.keys(schema.properties ?? {});
  expect(new Set(schema.required ?? [])).toEqual(new Set(properties));
}

describe("agent tool schemas", () => {
  it("covers exactly the dispatcher's tool whitelist", () => {
    // A tool the model can call but the dispatcher rejects (or vice versa)
    // silently wastes a turn.
    expect(new Set(AGENT_TOOLS.map((t) => t.name))).toEqual(VALID_TOOLS);
  });

  it("names every capped tool", () => {
    for (const capped of Object.keys(TOOL_CAPS)) {
      expect(AGENT_TOOLS.map((t) => t.name)).toContain(capped);
    }
  });

  it("declares object schemas that close additionalProperties", () => {
    for (const tool of AGENT_TOOLS) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it("only marks strict where every property is required", () => {
    for (const tool of AGENT_TOOLS) assertStrictIsExpressible(tool);
  });

  it("keeps a stable order — tools render ahead of the cached system prompt", () => {
    // Reordering tool definitions changes the bytes at position 0 and
    // invalidates the prompt cache for every agent call.
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([
      "act",
      "continue",
      "writeMemory",
    ]);
  });

  it("requires exactly the intent fields on act — never authoritative ones", () => {
    const act = AGENT_TOOLS.find((t) => t.name === "act");
    const schema = act?.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toEqual([
      "description",
      "objectRefs",
      "proposedDurationTicks",
    ]);
    const props = Object.keys(schema.properties ?? {});
    expect(props.sort()).toEqual(
      [
        "description",
        "objectRefs",
        "proposedDurationTicks",
        "skillId",
        // Which tongue, for the one domain that has no single value.
        "language",
        "utterance",
      ].sort()
    );
    // No authoritative fields: skill values, difficulty, rolls, outcomes,
    // resolved durations.
    for (const forbidden of [
      "skillValue",
      "difficulty",
      "checkType",
      "roll",
      "success",
      "resolvedDurationTicks",
    ]) {
      expect(props).not.toContain(forbidden);
    }
  });
});

describe("strict across providers", () => {
  // `strict` means Anthropic semantics (optional fields allowed). OpenAI's
  // strict mode also demands every property be required, so its adapter
  // forwards the flag only where `allPropertiesRequired` holds.
  it("agent tools that ask for strict satisfy OpenAI's stricter rule", () => {
    for (const tool of AGENT_TOOLS) {
      if (tool.strict)
        expect(allPropertiesRequired(tool.inputSchema)).toBe(true);
    }
  });

  it("keeps the strict flag on the half that compiles, and off the other", () => {
    // The action half asks for a grammar: no `anyOf`, six optionals. The
    // effect half carries all 19 operation branches, which Anthropic refuses
    // to compile, so it stays unstrict and is held to its contract in code.
    expect(submitActionsTool.strict).toBe(true);
    expect(submitEffectsTool.strict).toBe(false);
  });

  // The DeepSeek adapter sends EVERY tool strict, ignoring the flag, so this
  // guard covers every tool rather than the ones that opted in. It is the only
  // thing standing between a schema edit and a 400 on a live tick: one request
  // is all-or-nothing there, so a single underivable tool kills the whole
  // resolution rather than degrading itself.
  //
  // Four rules, all of them learned from a rejection: every property required,
  // every object closed, no size keywords, and every node declaring a type —
  // that last one is UNDOCUMENTED (a bare `{const: "hp"}` is what kept
  // submit_effects out of strict mode, with an error that read like Anthropic's
  // grammar-size refusal and was nothing of the kind).
  // The engine's session is what actually goes strict on DeepSeek: both
  // submission halves and the one code tool. The agent tools opt out — see
  // the `noGrammar` block below — so holding them to a grammar's rules would
  // be a false alarm on a schema nobody compiles.
  const TOOLS_SENT_STRICT = [
    submitActionsTool,
    submitEffectsTool,
    ...CODE_TOOL_SPECS,
  ];

  it("derives a DeepSeek-strict variant of every tool it will send strict", () => {
    for (const tool of TOOLS_SENT_STRICT) {
      const derived = toDeepSeekStrictSchema(tool.inputSchema);
      expect(canBeStrict(derived)).toBe(true);
      expect(allPropertiesRequired(derived)).toBe(true);
      expect(everyObjectClosed(derived)).toBe(true);
      expect(JSON.stringify(derived)).not.toMatch(
        /"(?:minLength|maxLength|minItems|maxItems)"/
      );
      expect(everyNodeTyped(derived)).toEqual([]);
    }
  });

  it("keeps every agent tool out of any provider's grammar", () => {
    // Measured, not assumed: constraining these put a junk `""` into 22 of 24
    // `act` calls, against 0 in both unconstrained runs of the same module,
    // and bought nothing — their schemas are three optional strings deep and
    // have never produced a structural failure.
    for (const tool of AGENT_TOOLS) expect(tool.noGrammar).toBe(true);
    // And the engine's tools must NOT carry it, or the half that most needs a
    // closed union goes back to being the unconstrained one.
    for (const tool of TOOLS_SENT_STRICT)
      expect(tool.noGrammar).toBeUndefined();
  });

  it("changes nothing about the schema the other two providers are sent", () => {
    // The derivation is a pure function of the shared table. If it ever
    // mutated in place, Anthropic would start receiving DeepSeek's shape.
    const before = JSON.stringify(submitActionsTool.inputSchema);
    toDeepSeekStrictSchema(submitActionsTool.inputSchema);
    expect(JSON.stringify(submitActionsTool.inputSchema)).toBe(before);
  });

  it("sends neither half strict to OpenAI, which demands every field required", () => {
    // OpenAI's strict mode is narrower than Anthropic's. `submit_actions`
    // asks for strict, but its optional nested fields mean the OpenAI adapter
    // must drop the flag rather than 400 the request.
    expect(allPropertiesRequired(submitActionsTool.inputSchema)).toBe(false);
    expect(allPropertiesRequired(submitEffectsTool.inputSchema)).toBe(false);
  });

  it("allPropertiesRequired looks into nested objects and arrays", () => {
    expect(
      allPropertiesRequired({
        type: "object",
        properties: {
          a: { type: "string" },
          b: {
            type: "array",
            items: {
              type: "object",
              properties: { c: { type: "string" } },
              required: ["c"],
            },
          },
        },
        required: ["a", "b"],
      })
    ).toBe(true);
    expect(
      allPropertiesRequired({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        required: ["a"],
      })
    ).toBe(false);
  });
});

/** DeepSeek's second rule: every object with a property map closes it. */
function everyObjectClosed(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.every(everyObjectClosed);
  if (!schema || typeof schema !== "object") return true;
  const o = schema as Record<string, unknown>;
  if (o.properties && typeof o.properties === "object") {
    if (o.additionalProperties !== false) return false;
  }
  return Object.values(o).every(everyObjectClosed);
}

/** DeepSeek's undocumented rule: every schema node declares one of `type`,
 *  `anyOf` or `$ref`. Returns the offending paths so a failure names them. */
function everyNodeTyped(schema: unknown, path = "$"): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item, i) => everyNodeTyped(item, `${path}[${i}]`));
  }
  if (!schema || typeof schema !== "object") return [];
  const o = schema as Record<string, unknown>;
  const found: string[] = [];
  // Only nodes that actually describe a value: `properties` is a map of names
  // to schemas, not a schema, and neither is the root of `$defs`.
  const isSchemaNode =
    "type" in o || "anyOf" in o || "$ref" in o || "const" in o || "enum" in o;
  if (isSchemaNode && !("type" in o || "anyOf" in o || "$ref" in o)) {
    found.push(path);
  }
  for (const [key, value] of Object.entries(o)) {
    if (key === "description") continue;
    found.push(...everyNodeTyped(value, `${path}.${key}`));
  }
  return found;
}
