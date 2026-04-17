import { loadActionDefinitions } from "../../tool_definitions/loader.js";
import type { ActionDefinition } from "../../types.js";
import {
  buildInterpreterPrompt,
  parseInterpretedResult,
} from "../gameInterpreter.js";

const mockDefinitions: ActionDefinition[] = [
  {
    id: "movement",
    title: "Movement",
    description: "Move to a different location",
    content: "",
    guidanceBody: "",
  },
  {
    id: "combat",
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
        title: "Action",
        description: "General actions",
        content: "",
        guidanceBody: "",
        impactHint: { default: 0, range: "0-2" },
      },
      {
        id: "perception",
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

    expect(prompt).toContain("basic item use or manipulation");
    expect(prompt).toContain("Artistic skills, craftsmanship");
    expect(prompt).toContain("Scientific knowledge of chemicals, reactions");
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
