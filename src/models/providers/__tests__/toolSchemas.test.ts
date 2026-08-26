import { describe, expect, it } from "vitest";
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
      ["description", "objectRefs", "proposedDurationTicks", "skillId", "utterance"].sort()
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
