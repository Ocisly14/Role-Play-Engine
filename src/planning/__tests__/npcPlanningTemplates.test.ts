import { describe, expect, it } from "vitest";
import {
  buildDailySchedulePrompt,
  buildDetailedNodesPrompt,
  buildImpactGatePrompt,
  buildReviseSchedulePrompt,
} from "../npcPlanningTemplates.js";

describe("npcPlanningTemplates", () => {
  it("includes item scope guardrails even when registry prompts are provided", () => {
    const { systemPrompt } = buildDetailedNodesPrompt({
      npcName: "Tom Harris",
      npcId: "npc_tom",
      npcProfile: "A cautious office worker.",
      longTermIntent: "Protect myself and keep records straight.",
      memoryLog: "Victor searched the filing cabinet earlier.",
      todayPlan: [{ location: "Victor's Company Building", activity: "Work" }],
      yourLocation: "Victor's Company Building",
      townMap: "Victor's Company Building",
      sceneDescription: "A small office.",
      sceneItems: "- Filing Cabinet\n- Office Computer",
      sceneNpcs: "- Lisa Chen",
      sceneConditions: "Nothing unusual.",
      worldStatePrompt: "",
      npcInventory: "- Notebook",
      currentTime: "10:00",
      gameDay: 1,
      language: "en",
      handlerPrompt: "## Custom Handler Prompt",
      planningPrompt: "## Custom Planning Prompt",
      outputSchemaPrompt: "## Custom Output Prompt",
    });

    expect(systemPrompt).toContain("## Planning Guardrails");
    expect(systemPrompt).toContain(
      "you may only target items that already appear in `Items You Can See` or `What You're Carrying`"
    );
    expect(systemPrompt).toContain(
      "Do not invent new documents, copies, notes, printouts, receipts, witness copies, or memo variants"
    );
  });

  it("keeps dynamic map context in the user prompt", () => {
    const townMap = "Town Map:\n- Study\n- Hallway";

    const daily = buildDailySchedulePrompt({
      npcName: "Tom Harris",
      npcId: "npc_tom",
      npcProfile: "A cautious office worker.",
      longTermIntent: "Protect myself and keep records straight.",
      relationships: "- Lisa Chen",
      townMap,
      yourLocation: "Study",
      scenarioConditions: "Nothing unusual.",
      worldStatePrompt: "",
      gameDay: 1,
      currentTime: "10:00",
      language: "en",
    });

    const reviseSchedule = buildReviseSchedulePrompt({
      npcName: "Tom Harris",
      npcId: "npc_tom",
      npcProfile: "A cautious office worker.",
      longTermIntent: "Protect myself and keep records straight.",
      memoryContext: "Victor has been pressuring me all day.",
      relationships: "- Lisa Chen",
      townMap,
      yourLocation: "Study",
      scenarioConditions: "Nothing unusual.",
      worldStatePrompt: "",
      remainingSchedule: "- Go to Hallway",
      triggerDescription: "A gunshot echoed downstairs.",
      gameDay: 1,
      currentTime: "10:00",
      language: "en",
    });

    const detailed = buildDetailedNodesPrompt({
      npcName: "Tom Harris",
      npcId: "npc_tom",
      npcProfile: "A cautious office worker.",
      longTermIntent: "Protect myself and keep records straight.",
      memoryLog: "Victor searched the filing cabinet earlier.",
      todayPlan: [{ location: "Study", activity: "Work" }],
      yourLocation: "Study",
      townMap,
      sceneDescription: "A small office.",
      sceneItems: "- Filing Cabinet",
      sceneNpcs: "- Lisa Chen",
      sceneConditions: "Nothing unusual.",
      sceneConnections: "- Hallway",
      worldStatePrompt: "",
      npcInventory: "- Notebook",
      currentTime: "10:00",
      gameDay: 1,
      language: "en",
    });

    for (const prompt of [daily, detailed, reviseSchedule]) {
      expect(prompt.systemPrompt).not.toContain(townMap);
      expect(prompt.userPrompt).toContain("## Places You Know");
      expect(prompt.userPrompt).toContain(townMap);
    }
  });

  it("uses destination only for movement nodes in node planning prompts", () => {
    const detailed = buildDetailedNodesPrompt({
      npcName: "Tom Harris",
      npcId: "npc_tom",
      npcProfile: "A cautious office worker.",
      longTermIntent: "Protect myself and keep records straight.",
      memoryLog: "Victor searched the filing cabinet earlier.",
      todayPlan: [{ location: "Study", activity: "Work" }],
      yourLocation: "Study",
      townMap: "Town Map:\n- Study\n- Hallway",
      sceneDescription: "A small office.",
      sceneItems: "- Filing Cabinet",
      sceneNpcs: "- Lisa Chen",
      sceneConditions: "Nothing unusual.",
      worldStatePrompt: "",
      npcInventory: "- Notebook",
      currentTime: "10:00",
      gameDay: 1,
      language: "en",
    });

    expect(detailed.systemPrompt).toContain(
      '"destination": "ONLY for movement'
    );
    expect(detailed.systemPrompt).not.toContain('Keep "location", "type"');
  });

  it("tightens impact gate prompt to major immediate disruptions only", () => {
    const { systemPrompt } = buildImpactGatePrompt({
      bucketTime: "15:08",
      candidate: {
        npcId: "npc_tom",
        npcName: "Tom Harris",
        currentLocation: "Victor's Company Building",
        longTermIntent: "Protect myself and keep records straight.",
        todayScheduleSummary: "Work at the office.",
        currentDetailedPlan: "Review the custody log.",
        triggeringEvents:
          "[impact 2] You noticed Victor search the filing cabinet.",
      },
      language: "en",
    });

    expect(systemPrompt).toContain("shouldUpdateIntent");
    expect(systemPrompt).toContain("shouldInterruptCurrentNode");
    expect(systemPrompt).not.toContain('"shouldRevise"');
  });
});
