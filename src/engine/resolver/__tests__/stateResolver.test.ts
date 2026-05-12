/// <reference types="vitest/globals" />
import type { ActionDefinition, OutputSchemaConfig } from "../../types.js";
import {
  buildResolverPrompt,
  parseStateResolution,
  validateResolution,
} from "../stateResolver.js";

const makeDef = (
  guidance: string,
  outputSchema?: OutputSchemaConfig
): ActionDefinition => ({
  id: "test",
  engine: "llm",
  title: "Test",
  description: "Test definition",
  content: guidance,
  guidanceBody: guidance,
  outputSchema,
});

// ─── buildResolverPrompt ──────────────────────────────────────────────────────

describe("buildResolverPrompt", () => {
  it("includes action description in the prompt", () => {
    const prompt = buildResolverPrompt({
      action: "Search the study",
      definition: makeDef("### On Success\n#### item\n- Discover hidden items"),
      outcomeSection: "Discover hidden items",
      stateContext: {
        actorSection: "## Actor\nID: npc_1\nName: Investigator",
        sceneSection: "## Scene\nID: scene_study",
      },
    });

    expect(prompt).toContain("Search the study");
  });

  it("includes definition guidance body", () => {
    const prompt = buildResolverPrompt({
      action: "Search the study",
      definition: makeDef(
        "# Search Guidance\n\nDiscover hidden items in the scene"
      ),
      outcomeSection: "Discover hidden items",
      stateContext: {},
    });

    expect(prompt).toContain("Discover hidden items in the scene");
  });

  it("includes actor state from stateContext", () => {
    const prompt = buildResolverPrompt({
      action: "Search the study",
      definition: makeDef("On Success: find clues"),
      outcomeSection: "find clues",
      stateContext: {
        actorSection: "## Actor\nID: npc_1\nName: Alice",
      },
    });

    expect(prompt).toContain("npc_1");
    expect(prompt).toContain("Alice");
  });

  it("includes skill check result when provided", () => {
    const prompt = buildResolverPrompt({
      action: "Attempt to persuade",
      definition: makeDef("On Failure: target becomes hostile"),
      outcomeSection: "target becomes hostile",
      stateContext: {},
      skillCheckResult: {
        done: true,
        status: "failed",
        outcomeDescription: "The dice rolled poorly",
        successLevel: "fail",
      },
    });

    expect(prompt).toContain("fail");
    expect(prompt).toContain("The dice rolled poorly");
  });

  it("includes world state from stateContext", () => {
    const prompt = buildResolverPrompt({
      action: "Look around",
      definition: makeDef("On Success: observe the room"),
      outcomeSection: "observe the room",
      stateContext: {
        worldStateSection: "Heavy rain outside. Visibility reduced.",
      },
    });

    expect(prompt).toContain("Heavy rain outside");
  });

  it("respects the language parameter", () => {
    const prompt = buildResolverPrompt({
      action: "Search",
      definition: makeDef("On Success: find clue"),
      outcomeSection: "find clue",
      stateContext: {},
      language: "zh",
    });

    expect(prompt).toContain("zh");
  });

  it("includes target sections when provided", () => {
    const prompt = buildResolverPrompt({
      action: "Talk to the captain",
      definition: makeDef("Social guidance"),
      outcomeSection: "social result",
      stateContext: {
        actorSection: "## Actor\nID: npc_1",
        targetSections:
          "## Target: Captain\nID: captain_wang\nOccupation: Ship Captain",
      },
    });

    expect(prompt).toContain("captain_wang");
    expect(prompt).toContain("Ship Captain");
  });

  it("includes item section when provided", () => {
    const prompt = buildResolverPrompt({
      action: "Pick up the key",
      definition: makeDef("Item guidance"),
      outcomeSection: "item result",
      stateContext: {
        itemSection: "### Scene Items\n- **Rusty Key** (id: key_001)",
      },
    });

    expect(prompt).toContain("key_001");
    expect(prompt).toContain("Rusty Key");
  });

  it("includes feature notes when provided", () => {
    const prompt = buildResolverPrompt({
      action: "Cast ritual",
      definition: makeDef("Ritual guidance"),
      outcomeSection: "ritual result",
      stateContext: {},
      featureNotes: ["Ritual circle activated", "Sanity pressure building"],
    });

    expect(prompt).toContain("Ritual circle activated");
    expect(prompt).toContain("Sanity pressure building");
  });

  it("includes output schema section when definition has outputSchema", () => {
    const prompt = buildResolverPrompt({
      action: "Search the study",
      definition: makeDef("Guidance", {
        presets: ["default"],
        use: ["character.hp"],
      }),
      outcomeSection: "find clues",
      stateContext: {},
    });

    expect(prompt).toContain("## Output Format");
    expect(prompt).toContain("character.hp");
    expect(prompt).toContain("memory.event");
    expect(prompt).toContain("character.fatigue");
    expect(prompt).toContain("scene.condition");
    expect(prompt).not.toContain('"additionalProperties"');
    expect(prompt).not.toContain('"required"');
  });
});

// ─── parseStateResolution ─────────────────────────────────────────────────────

describe("parseStateResolution", () => {
  it("parses valid JSON with state changes", () => {
    const raw = JSON.stringify({
      "character.fatigue": [{ characterId: "npc_1", fatigue: 1 }],
    });

    const result = parseStateResolution(raw);

    expect(result["character.fatigue"]).toHaveLength(1);
    expect(result["character.fatigue"][0].characterId).toBe("npc_1");
  });

  it("parses JSON wrapped in markdown fences", () => {
    const raw = `Here is the resolution:\n\`\`\`json\n${JSON.stringify({
      "character.hp": [{ characterId: "npc_alice", hp: -2 }],
    })}\n\`\`\``;

    const result = parseStateResolution(raw);

    expect(result["character.hp"]).toHaveLength(1);
    expect(result["character.hp"][0].hp).toBe(-2);
  });

  it("returns empty object on invalid JSON", () => {
    const result = parseStateResolution("garbage input not json");

    expect(result).toEqual({});
  });

  it("preserves multiple state change types", () => {
    const raw = JSON.stringify({
      "character.hp": [{ characterId: "npc_1", hp: -3 }],
      "memory.event": [
        { characterId: "npc_1", type: "event", content: "Hurt badly" },
      ],
    });

    const result = parseStateResolution(raw);

    expect(result["character.hp"]).toHaveLength(1);
    expect(result["memory.event"]).toHaveLength(1);
    expect(result["memory.event"][0].content).toBe("Hurt badly");
  });

  it("preserves custom fields", () => {
    const raw = JSON.stringify({
      "character.hp": [{ characterId: "npc_1", hp: -1 }],
      ritualProgress: "stage_2",
    });

    const result = parseStateResolution(raw);

    expect(result["character.hp"]).toHaveLength(1);
    expect(result.ritualProgress).toBe("stage_2");
  });
});

// ─── validateResolution ─────────────────────────────────────────────────────

describe("validateResolution", () => {
  it("returns true for valid resolution matching schema", () => {
    const result = validateResolution(
      {
        "character.hp": [{ characterId: "npc_1", hp: -2 }],
        "memory.event": [
          { characterId: "npc_1", type: "event", content: "Hurt" },
        ],
      },
      { use: ["character.hp", "memory.event"] }
    );

    expect(result).toBe(true);
  });

  it("returns true for empty arrays", () => {
    const result = validateResolution(
      {
        "character.hp": [],
        "memory.event": [],
      },
      { use: ["character.hp", "memory.event"] }
    );

    expect(result).toBe(true);
  });

  it("returns false when resolution has undeclared types", () => {
    const result = validateResolution(
      {
        "character.hp": [{ characterId: "npc_1", hp: -2 }],
        "scene.condition": [{ sceneId: "s1", addConditions: ["dark"] }],
      },
      { use: ["character.hp"] }
    );

    expect(result).toBe(false);
  });

  it("returns true for empty resolution", () => {
    const result = validateResolution({}, { use: ["character.hp"] });

    expect(result).toBe(true);
  });

  it("returns true when custom fields are declared and present", () => {
    const result = validateResolution(
      {
        "character.hp": [{ characterId: "npc_1", hp: -1 }],
        ritualProgress: "stage_2",
      },
      {
        use: ["character.hp"],
        custom: {
          ritualProgress: { type: "string", description: "Ritual stage" },
        },
      }
    );

    expect(result).toBe(true);
  });

  it("accepts preset-derived fields during validation", () => {
    const result = validateResolution(
      {
        "memory.event": [{ characterId: "npc_1", content: "I searched." }],
        "character.fatigue": [{ characterId: "npc_1", delta: 1 }],
      },
      { presets: ["default"] }
    );

    expect(result).toBe(true);
  });

  it("accepts elapsedMinutes as a universally-allowed meta field", () => {
    const result = validateResolution(
      {
        "memory.event": [{ characterId: "npc_1", content: "Searched 5 min." }],
        elapsedMinutes: 5,
      },
      { use: ["memory.event"] }
    );

    expect(result).toBe(true);
  });
});
