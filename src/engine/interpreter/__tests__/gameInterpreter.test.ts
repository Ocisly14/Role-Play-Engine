import { describe, expect, it } from "vitest";
import { loadActionDefinitions } from "../../tool_definitions/loader.js";
import type { ActionDefinition } from "../../types.js";
import {
  CitationResolutionError,
  buildInterpreterPrompt,
  parseCitations,
  parseInterpretedResult,
} from "../gameInterpreter.js";
import type { PerceivableDirectory } from "../../../state/perceivableDirectory.js";

function dir(opts: {
  characters?: Record<string, string>;
  items?: Record<string, string>;
  scenes?: Record<string, string>;
}): PerceivableDirectory {
  return {
    characters: new Map(Object.entries(opts.characters ?? {})),
    items: new Map(Object.entries(opts.items ?? {})),
    scenes: new Map(Object.entries(opts.scenes ?? {})),
  };
}

const mockDefinitions: ActionDefinition[] = [
  {
    id: "movement",
    engine: "llm",
    title: "Movement",
    description: "Move to a different location",
    content: "",
    guidanceBody: "",
  },
  {
    id: "combat",
    engine: "llm",
    title: "Combat",
    description: "Physical combat between characters",
    content: "",
    guidanceBody: "",
    skillCheck: {
      skill: "Fighting (Brawl)",
      difficulty: "regular",
      type: "opposed",
      opposedDefense: ["Dodge"],
      failBehavior: "abort",
    },
  },
  {
    id: "social",
    engine: "llm",
    title: "Social Interaction",
    description: "Social interaction with characters",
    content: "",
    guidanceBody: "",
    skillCheck: {
      skill: "Persuade",
      difficulty: "regular",
      type: "opposed",
      opposedDefense: ["Psychology"],
      failBehavior: "abort",
    },
  },
  {
    id: "generic",
    engine: "llm",
    title: "Generic Action",
    description: "Fallback for unmatched actions",
    content: "",
    guidanceBody: "",
  },
];

describe("buildInterpreterPrompt", () => {
  it("includes all definition IDs and descriptions", () => {
    const prompt = buildInterpreterPrompt(mockDefinitions);
    expect(prompt).toContain("movement");
    expect(prompt).toContain("combat");
    expect(prompt).toContain("social");
    expect(prompt).toContain("generic");
    expect(prompt).toContain("Move to a different location");
  });

  it("includes all definition IDs grouped by category", () => {
    const defs: ActionDefinition[] = [
      {
        id: "action",
        engine: "llm",
        title: "Action",
        description: "General actions",
        content: "",
        guidanceBody: "",
        impactHint: { default: 0, range: "0-2" },
      },
      {
        id: "perception",
        engine: "llm",
        title: "Perception",
        description: "Finding hidden objects",
        content: "",
        guidanceBody: "",
        skillCheck: {
          skill: "Perception",
          difficulty: "regular",
          type: "single",
          failBehavior: "partial",
        },
        interpreter: { examples: ["搜查房间"] },
      },
      {
        id: "brawling",
        engine: "llm",
        title: "Brawling",
        description: "Hand-to-hand combat",
        content: "",
        guidanceBody: "",
        skillCheck: {
          skill: "Brawling",
          difficulty: "regular",
          type: "opposed",
          opposedDefense: ["Dodge"],
          failBehavior: "abort",
        },
        interpreter: { examples: ["挥拳攻击"] },
      },
    ];

    const prompt = buildInterpreterPrompt(defs);

    expect(prompt).toContain("action");
    expect(prompt).toContain("General actions");
    expect(prompt).toContain("perception");
    expect(prompt).toContain("Finding hidden objects");
    expect(prompt).toContain("brawling");
    expect(prompt).toContain("Hand-to-hand combat");
    expect(prompt).toContain("General Actions (no skill check)");
    expect(prompt).toContain("Opposed Skills");
    expect(prompt).toContain("Single Skills");
    // Includes interpreter examples
    expect(prompt).toContain("搜查房间");
    expect(prompt).toContain("挥拳攻击");
  });

  it("reflects item actions through action and related skills, not removed root item definitions", () => {
    const prompt = buildInterpreterPrompt(loadActionDefinitions());

    expect(prompt).toContain("picking up an item");
    expect(prompt).not.toContain("**item_modify**");
    expect(prompt).not.toContain("**item_assemble**");
    expect(prompt).not.toContain("**item_disassemble**");
  });
});

describe("parseInterpretedResult", () => {
  it("parses valid JSON result with impact", () => {
    const raw = JSON.stringify({
      steps: [
        { definitionId: "movement", impact: 0 },
        { definitionId: "social", impact: 1 },
      ],
    });
    const result = parseInterpretedResult(raw);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].definitionId).toBe("movement");
    expect(result.steps[0].impact).toBe(0);
    expect(result.steps[1].impact).toBe(1);
  });

  it("defaults impact to 0 when missing", () => {
    const raw = JSON.stringify({
      steps: [{ definitionId: "action" }],
    });
    const result = parseInterpretedResult(raw);
    expect(result.steps[0].impact).toBe(0);
  });

  it("clamps impact to 0-5", () => {
    const raw = JSON.stringify({
      steps: [{ definitionId: "action", impact: 8 }],
    });
    const result = parseInterpretedResult(raw);
    expect(result.steps[0].impact).toBe(5);
  });

  it("falls back to generic on invalid JSON", () => {
    const result = parseInterpretedResult("not json");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].definitionId).toBe("generic");
    expect(result.steps[0].impact).toBe(0);
  });

  it("falls back to generic on empty steps", () => {
    const result = parseInterpretedResult('{"steps": []}');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].definitionId).toBe("generic");
  });

  it("extracts JSON from markdown code blocks", () => {
    const raw =
      '```json\n{"steps": [{"definitionId": "search", "impact": 2}]}\n```';
    const result = parseInterpretedResult(raw);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].definitionId).toBe("search");
    expect(result.steps[0].impact).toBe(2);
  });
});

describe("parseCitations", () => {
  it("returns empty array when no [Name] markers present", () => {
    const result = parseCitations("just walking down the street", dir({}));
    expect(result).toEqual([]);
  });

  it("resolves a single [character] citation", () => {
    const d = dir({ characters: { Smith: "smith42" } });
    const result = parseCitations("greet [Smith]", d);
    expect(result).toEqual([{ id: "smith42", kind: "character" }]);
  });

  it("resolves [item] and [character] in the same actionText", () => {
    const d = dir({
      characters: { Smith: "smith42" },
      items: { "the bound ledger": "ledger7" },
    });
    const result = parseCitations("hand [the bound ledger] to [Smith]", d);
    expect(result).toEqual([
      { id: "ledger7", kind: "item" },
      { id: "smith42", kind: "character" },
    ]);
  });

  it("resolves [scene] citations", () => {
    const d = dir({ scenes: { Harbor: "harbor_scene" } });
    const result = parseCitations("head to [Harbor]", d);
    expect(result).toEqual([{ id: "harbor_scene", kind: "scene" }]);
  });

  it("dedupes repeated citations of the same name", () => {
    const d = dir({ characters: { Smith: "smith42" } });
    const result = parseCitations(
      "[Smith] turns; I face [Smith] again",
      d
    );
    expect(result).toEqual([{ id: "smith42", kind: "character" }]);
  });

  it("checks character → item → scene order on lookup", () => {
    const d = dir({
      characters: { Tower: "char_named_tower" },
      items: { Tower: "item_tower" },
      scenes: { Tower: "scene_tower" },
    });
    const result = parseCitations("approach [Tower]", d);
    expect(result).toEqual([{ id: "char_named_tower", kind: "character" }]);
  });

  it("throws CitationResolutionError on unresolved citation (OQ3)", () => {
    const d = dir({ characters: {} });
    expect(() => parseCitations("approach [Mxy]", d)).toThrow(
      CitationResolutionError
    );
  });

  it("CitationResolutionError carries the unresolved name and full actionText", () => {
    const d = dir({});
    try {
      parseCitations("greet [Mxy] near [Tower]", d);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CitationResolutionError);
      expect((err as CitationResolutionError).citation).toBe("Mxy");
      expect((err as CitationResolutionError).actionText).toBe(
        "greet [Mxy] near [Tower]"
      );
    }
  });

  it("tolerates actionText with no brackets at all (OQ2 fallback)", () => {
    const d = dir({ characters: { Smith: "smith42" } });
    // No brackets present → no citations parsed; returns []. Existing
    // natural-language identification path in interpretAction continues.
    const result = parseCitations("greet Smith", d);
    expect(result).toEqual([]);
  });
});
