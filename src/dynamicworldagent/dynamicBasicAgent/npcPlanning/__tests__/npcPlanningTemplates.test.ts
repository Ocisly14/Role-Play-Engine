import { describe, expect, it } from "vitest";
import {
  buildDetailedNodesPrompt,
  buildImpactGatePrompt,
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
      currentLocation: "Victor's Company Building",
      sceneMap: "Victor's Company Building",
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
      currentLocation: "Victor's Company Building",
      currentPositionDetail: "Inside the main office.",
      sceneMap: "Victor's Company Building",
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
      "Set shouldRevise=true only for major immediate disruptions"
    );
    expect(systemPrompt).toContain(
      "Minor observations, background tension, ordinary chatter, low-stakes suspicion"
    );
    expect(systemPrompt).toContain(
      "Use shouldRevise=true when your current action is materially blocked"
    );
  });
});
