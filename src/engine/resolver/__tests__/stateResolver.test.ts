import type { ActionDefinition } from "../../types.js";
import { buildResolverPrompt, parseStateResolution } from "../stateResolver.js";

const makeDef = (guidance: string): ActionDefinition => ({
  id: "test",
  title: "Test",
  description: "Test definition",
  content: guidance,
  guidanceBody: guidance,
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
});

// ─── parseStateResolution ─────────────────────────────────────────────────────

describe("parseStateResolution", () => {
  it("parses valid JSON with a narrative", () => {
    const raw = JSON.stringify({
      characterChanges: [{ characterId: "npc_1", fatigue: 1 }],
      narrative: "The investigator found nothing.",
    });

    const result = parseStateResolution(raw);

    expect(result.narrative).toBe("The investigator found nothing.");
    expect(result.characterChanges).toHaveLength(1);
    expect(result.characterChanges?.[0].characterId).toBe("npc_1");
  });

  it("parses JSON wrapped in markdown fences", () => {
    const raw = `Here is the resolution:\n\`\`\`json\n${JSON.stringify({
      narrative: "Alice was hurt.",
      characterChanges: [{ characterId: "npc_alice", hp: -2 }],
    })}\n\`\`\``;

    const result = parseStateResolution(raw);

    expect(result.narrative).toBe("Alice was hurt.");
    expect(result.characterChanges?.[0].hp).toBe(-2);
  });

  it("returns a minimal resolution on invalid JSON", () => {
    const result = parseStateResolution("garbage input not json");

    expect(result.narrative).toBeTruthy();
    expect(typeof result.narrative).toBe("string");
  });

  it("returns a minimal resolution when the JSON is empty object", () => {
    const result = parseStateResolution("{}");

    expect(result.narrative).toBeTruthy();
  });

  it("preserves sceneChanges", () => {
    const raw = JSON.stringify({
      sceneChanges: [
        { sceneId: "scene_hall", addConditions: ["lights are off"] },
      ],
      narrative: "The lights went out.",
    });

    const result = parseStateResolution(raw);

    expect(result.sceneChanges).toHaveLength(1);
    expect(result.sceneChanges?.[0].addConditions).toContain("lights are off");
  });

  it("preserves itemChanges", () => {
    const raw = JSON.stringify({
      itemChanges: [
        {
          itemId: "lantern",
          action: "move",
          from: "npc_1",
          to: "scene:scene_hall",
        },
      ],
      narrative: "The lantern was placed down.",
    });

    const result = parseStateResolution(raw);

    expect(result.itemChanges).toHaveLength(1);
    expect(result.itemChanges?.[0].action).toBe("move");
  });

  it("preserves memories", () => {
    const raw = JSON.stringify({
      memories: [
        { characterId: "npc_1", type: "event", content: "I found a clue." },
      ],
      narrative: "A clue was found.",
    });

    const result = parseStateResolution(raw);

    expect(result.memories).toHaveLength(1);
    expect(result.memories?.[0].content).toBe("I found a clue.");
  });

  it("preserves legacy items/newItems output", () => {
    const raw = JSON.stringify({
      items: [{ itemId: "clock_01", location: "destroyed" }],
      newItems: [
        {
          id: "gear_01",
          name: "Gear",
          location: "scene",
          sourceItemId: "clock_01",
        },
      ],
      outcome: "The clock was broken apart.",
    });

    const result = parseStateResolution(raw);

    expect(result.items).toHaveLength(1);
    expect(result.newItems).toHaveLength(1);
    expect(result.narrative).toBe("The clock was broken apart.");
  });
});
