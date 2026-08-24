import { describe, expect, it } from "vitest";
import { parseJsonResponse } from "../jsonParse.js";

describe("parseJsonResponse", () => {
  it("parses a bare JSON object", () => {
    expect(parseJsonResponse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses a fenced JSON object", () => {
    expect(parseJsonResponse<{ a: number }>('```json\n{"a":1}\n```')).toEqual({
      a: 1,
    });
  });

  it("extracts JSON that follows a prose preamble", () => {
    // Observed live from claude-sonnet-5 in the roleSim agent loop: the model
    // reasons in prose, then emits a perfectly valid tool call. Dropping the
    // whole reply because of the preamble silently degraded the NPC's
    // decision to a no-op `continue`.
    const raw =
      "Lux Lynch问了这个问题很多次了，我应该谨慎回应。\n\n" +
      '{ "tool": "act", "actionText": "[narrative]\\n我盯着他。" }';
    expect(parseJsonResponse<{ tool: string }>(raw)).toMatchObject({
      tool: "act",
    });
  });

  it("extracts JSON followed by a trailing comment", () => {
    const raw = '{"tool":"continue"}\n\nI stay where I am for now.';
    expect(parseJsonResponse<{ tool: string }>(raw)).toMatchObject({
      tool: "continue",
    });
  });

  it("ignores braces inside string values when finding the object", () => {
    const raw =
      'Here you go:\n{"tool":"act","actionText":"he said {not json} loudly"}';
    expect(parseJsonResponse<{ actionText: string }>(raw)).toMatchObject({
      actionText: "he said {not json} loudly",
    });
  });

  it("still repairs a truncated object", () => {
    expect(
      parseJsonResponse<{ tool: string }>('{"tool":"act","actionText":"hi"')
    ).toMatchObject({ tool: "act" });
  });

  it("throws when there is no JSON object at all", () => {
    // The raw-[narrative] failure shape must keep throwing — it carries no
    // tool call, so silently inventing one would be worse than failing.
    expect(() => parseJsonResponse("[narrative]\n我走近他。")).toThrow();
  });
});
