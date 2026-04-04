import type {
  ActionDefinition,
  DispatchResult,
  StateResolution,
  ToolResult,
} from "../types.js";

describe("engine types", () => {
  it("ActionDefinition has required fields", () => {
    const def: ActionDefinition = {
      id: "combat",
      title: "Combat",
      description: "Physical combat between characters",
      content: "# Combat\n## Skill Check\n...",
      skillCheck: {
        skills: ["Fighting (Brawl)", "Fighting (Melee)"],
        difficulty: "regular",
        type: "opposed",
        opposedDefense: ["Dodge", "Fighting (Brawl)"],
        failBehavior: "abort",
      },
    };
    expect(def.id).toBe("combat");
    expect(def.skillCheck?.type).toBe("opposed");
  });

  it("DispatchResult contains ordered steps", () => {
    const result: DispatchResult = {
      steps: [
        { definitionId: "movement", args: { destination: "harbor_docks" } },
        { definitionId: "social", args: { targetId: "captain_wang" } },
      ],
    };
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].definitionId).toBe("movement");
  });

  it("StateResolution covers all state domains", () => {
    const resolution: StateResolution = {
      characterChanges: [
        { characterId: "npc_1", hp: -5, addConditions: ["bleeding"] },
      ],
      itemChanges: [
        { itemId: "key_001", action: "move", from: "scene_study", to: "npc_1" },
      ],
      sceneChanges: [{ sceneId: "scene_study", addConditions: ["searched"] }],
      memories: [
        { characterId: "npc_1", type: "event", content: "Found a key" },
      ],
      relationships: [
        { from: "npc_1", to: "npc_2", change: "slight_distrust" },
      ],
      featureOverlays: { fireIntensity: 2 },
      narrative: "The investigator found a rusty key hidden under papers.",
    };
    expect(resolution.characterChanges).toHaveLength(1);
    expect(resolution.narrative).toBeTruthy();
  });

  it("ToolResult supports cross-tick with done flag", () => {
    const result: ToolResult = {
      done: false,
      status: "completed",
      outcomeDescription: "Moving to harbor, 3 minutes remaining",
      remainingMinutes: 3,
    };
    expect(result.done).toBe(false);
  });
});
