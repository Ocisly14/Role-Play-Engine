import { buildResolverPrompt, parseStateResolution } from "../stateResolver.js";

// ─── buildResolverPrompt ──────────────────────────────────────────────────────

describe("buildResolverPrompt", () => {
  it("includes action description in the prompt", () => {
    const prompt = buildResolverPrompt({
      action: "Search the study",
      definitionContent: "### On Success\n#### item\n- Discover hidden items",
      actorState: { id: "npc_1", name: "Investigator" },
      sceneState: { id: "scene_study", conditions: [] },
    });

    expect(prompt).toContain("Search the study");
  });

  it("includes definition guidance content", () => {
    const prompt = buildResolverPrompt({
      action: "Search the study",
      definitionContent: "### On Success\n#### item\n- Discover hidden items",
      actorState: { id: "npc_1", name: "Investigator" },
      sceneState: { id: "scene_study", conditions: [] },
    });

    expect(prompt).toContain("Discover hidden items");
  });

  it("includes actor state", () => {
    const prompt = buildResolverPrompt({
      action: "Search the study",
      definitionContent: "On Success: find clues",
      actorState: { id: "npc_1", name: "Alice" },
      sceneState: { id: "scene_study" },
    });

    expect(prompt).toContain("npc_1");
    expect(prompt).toContain("Alice");
  });

  it("includes skill check result when provided", () => {
    const prompt = buildResolverPrompt({
      action: "Attempt to persuade",
      definitionContent: "On Failure: target becomes hostile",
      actorState: { id: "npc_1" },
      sceneState: { id: "scene_bar" },
      skillCheckResult: {
        done: true,
        status: "failed",
        outcomeDescription: "The dice rolled poorly",
        successLevel: "fail",
      },
    });

    expect(prompt).toContain("failed");
    expect(prompt).toContain("The dice rolled poorly");
  });

  it("includes feature context when provided", () => {
    const prompt = buildResolverPrompt({
      action: "Look around",
      definitionContent: "On Success: observe the room",
      actorState: { id: "npc_1" },
      sceneState: { id: "scene_1" },
      featureContext: "Heavy rain outside. Visibility reduced.",
    });

    expect(prompt).toContain("Heavy rain outside");
  });

  it("respects the language parameter", () => {
    const prompt = buildResolverPrompt({
      action: "Search",
      definitionContent: "On Success: find clue",
      actorState: { id: "npc_1" },
      sceneState: { id: "scene_1" },
      language: "zh",
    });

    expect(prompt).toContain("zh");
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
});
