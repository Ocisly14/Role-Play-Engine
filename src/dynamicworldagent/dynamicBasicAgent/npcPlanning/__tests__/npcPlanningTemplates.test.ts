import { describe, expect, it } from "vitest";
import {
  buildDailySchedulePrompt,
  buildDetailedNodesPrompt,
  buildImpactGatePrompt,
  buildReviseSchedulePrompt,
  buildRevisePlansPrompt,
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

  it("injects detailed failure context into revise prompts", () => {
    const { userPrompt } = buildRevisePlansPrompt({
      npcName: "Tom Harris",
      npcId: "npc_tom",
      npcProfile: "A cautious office worker.",
      longTermIntent: "Protect myself and keep records straight.",
      memoryLog: "Victor has been pressuring me all day.",
      todayPlan: [{ location: "Victor's Company Building", activity: "Work" }],
      pendingNodes: "[]",
      triggerDescription:
        'Action "Ask Lisa to re-sign a witness copy" at 15:08 failed with object_not_found.',
      yourLocation: "Victor's Company Building",
      currentPositionDetail: "Inside the main office.",
      townMap: "Victor's Company Building",
      sceneDescription: "A small office.",
      sceneItems: "- Filing Cabinet\n- Office Computer",
      sceneNpcs: "- Lisa Chen",
      sceneConditions: "Victor is nearby.",
      worldStatePrompt: "",
      npcInventory: "- Notebook",
      currentTime: "15:08",
      gameDay: 1,
      language: "en",
      failureReason: "object_not_found",
      failureOutcome:
        "Ask Lisa to re-sign a witness copy ... [item signed_witness_copy not in inventory] failed",
      blockedReason: "",
    });

    expect(userPrompt).toContain("## Why The Last Action Failed");
    expect(userPrompt).toContain("Engine failure reason: object_not_found");
    expect(userPrompt).toContain("signed_witness_copy not in inventory");
    expect(userPrompt).toContain("## Relevant Memories / Recent Context");
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

    const revisePlans = buildRevisePlansPrompt({
      npcName: "Tom Harris",
      npcId: "npc_tom",
      npcProfile: "A cautious office worker.",
      longTermIntent: "Protect myself and keep records straight.",
      memoryLog: "Victor has been pressuring me all day.",
      todayPlan: [{ location: "Study", activity: "Work" }],
      pendingNodes: "[]",
      triggerDescription: "A gunshot echoed downstairs.",
      yourLocation: "Study",
      currentPositionDetail: "Inside the study.",
      townMap,
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

    for (const prompt of [daily, detailed, reviseSchedule, revisePlans]) {
      expect(prompt.systemPrompt).not.toContain(townMap);
      expect(prompt.userPrompt).toContain("## Places You Know");
      expect(prompt.userPrompt).toContain(townMap);
    }
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

    expect(systemPrompt).toContain(
      "shouldRevise=true ONLY when the event directly threatens your current plan's success or your personal safety"
    );
    expect(systemPrompt).toContain(
      "Casual encounters, background noise, overhearing conversation, minor curiosity"
    );
    expect(systemPrompt).toContain(
      "Your current action is materially blocked or impossible to continue"
    );
  });
});
