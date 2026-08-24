import { describe, expect, it } from "vitest";
import { buildInterpreterPrompt } from "../interpreter/gameInterpreter.js";
import type { ActionDefinition } from "../types.js";

// `interpretAction` passes `cacheSystemPrompt: true`, which is only correct
// while this prompt is byte-identical across calls. Anything per-request
// interpolated in here (a timestamp, an NPC name, a shuffled definition
// order) silently turns every call into a fresh cache write that is never
// read — no error, just a 1.25x bill. These tests pin the invariant.
const defs = [
  {
    id: "action",
    description: "General no-skill action",
    content: "",
  },
  {
    id: "perception",
    description: "Spot hidden things",
    content: "",
    skillCheck: {
      difficulty: "regular",
      type: "single",
      failBehavior: "abort",
    },
  },
  {
    id: "persuade",
    description: "Talk someone around",
    content: "",
    skillCheck: {
      difficulty: "regular",
      type: "opposed",
      failBehavior: "partial",
    },
  },
] as unknown as ActionDefinition[];

describe("buildInterpreterPrompt — cacheability invariant", () => {
  it("returns byte-identical output for the same definitions", () => {
    expect(buildInterpreterPrompt(defs)).toBe(buildInterpreterPrompt(defs));
  });

  it("does not depend on wall-clock time", () => {
    const before = buildInterpreterPrompt(defs);
    const year = String(new Date().getFullYear());
    // A date interpolated into the prefix is the classic silent invalidator.
    expect(before).not.toContain(year);
    expect(before).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("changes when the definition set changes", () => {
    // Sanity check that the comparison above is meaningful.
    expect(buildInterpreterPrompt(defs)).not.toBe(
      buildInterpreterPrompt(defs.slice(0, 1))
    );
  });
});
