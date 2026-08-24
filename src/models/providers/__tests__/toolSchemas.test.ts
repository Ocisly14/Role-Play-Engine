import { describe, expect, it } from "vitest";
import { INTERPRET_ACTION_TOOL } from "../../../engine/interpreter/gameInterpreter.js";
import { TOOL_CAPS, VALID_TOOLS } from "../../../roleSim/toolDispatcher.js";
import { AGENT_TOOLS } from "../../../roleSim/tools/schemas.js";
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
      "recallMemory",
      "getMapSnapshot",
    ]);
  });

  it("requires actionText on act", () => {
    const act = AGENT_TOOLS.find((t) => t.name === "act");
    const schema = act?.inputSchema as { required?: string[] };
    expect(schema.required).toEqual(["actionText"]);
  });
});

describe("interpreter tool schema", () => {
  it("requires steps, each with a definitionId and impact", () => {
    const schema = INTERPRET_ACTION_TOOL.inputSchema as {
      required?: string[];
      properties?: { steps?: { items?: { required?: string[] } } };
    };
    expect(schema.required).toEqual(["steps"]);
    expect(schema.properties?.steps?.items?.required).toEqual([
      "definitionId",
      "impact",
    ]);
  });

  it("is not strict — destination applies to movement steps only", () => {
    expect(INTERPRET_ACTION_TOOL.strict).toBeFalsy();
    assertStrictIsExpressible(INTERPRET_ACTION_TOOL);
  });

  it("bounds impact to the 0-5 perceptibility scale", () => {
    const schema = INTERPRET_ACTION_TOOL.inputSchema as {
      properties?: {
        steps?: {
          items?: { properties?: { impact?: Record<string, number> } };
        };
      };
    };
    const impact = schema.properties?.steps?.items?.properties?.impact;
    expect(impact?.minimum).toBe(0);
    expect(impact?.maximum).toBe(5);
  });
});
