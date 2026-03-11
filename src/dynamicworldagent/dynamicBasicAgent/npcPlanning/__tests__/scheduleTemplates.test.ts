import { describe, it, expect } from "vitest";
import {
  buildDailySchedulePrompt,
  buildDetailedNodesPrompt,
  buildReviseSchedulePrompt,
} from "../npcPlanningTemplates.js";

describe("buildDailySchedulePrompt", () => {
  it("includes NPC name, profile, and scene map", () => {
    const result = buildDailySchedulePrompt({
      npcName: "Dr. Morgan",
      npcId: "npc_morgan",
      npcProfile: "Name: Dr. Morgan\nOccupation: Physician",
      longTermIntent: "Investigate strange occurrences at the hospital",
      memorySummary: "Day1 09:00 - Arrived at hospital",
      todayLog: "",
      relationships: "- Player: score=30 (wary acquaintance)",
      sceneMap: "Current Scene: hospital_lobby",
      scenarioConditions: "",
      worldStatePrompt: "",
      gameDay: 2,
      currentTime: "08:00",
      language: "en",
    });
    expect(result).toContain("Dr. Morgan");
    expect(result).toContain("npc_morgan");
    expect(result).toContain("Physician");
    expect(result).toContain("hospital_lobby");
    expect(result).toContain("Day 2");
  });

  it("instructs LLM to output ScheduleEntry array", () => {
    const result = buildDailySchedulePrompt({
      npcName: "Test",
      npcId: "npc_test",
      npcProfile: "",
      longTermIntent: "",
      memorySummary: "",
      todayLog: "",
      relationships: "",
      sceneMap: "",
      scenarioConditions: "",
      worldStatePrompt: "",
      gameDay: 1,
      currentTime: "08:00",
      language: "en",
    });
    expect(result).toContain('"time"');
    expect(result).toContain('"location"');
    expect(result).toContain('"activity"');
    // Must NOT mention PlanNode fields like actionType, objectInteractionPayload
    expect(result).not.toContain("actionType");
    expect(result).not.toContain("objectInteractionPayload");
  });

  it("includes world state prompt when provided", () => {
    const result = buildDailySchedulePrompt({
      npcName: "Test",
      npcId: "npc_test",
      npcProfile: "",
      longTermIntent: "",
      memorySummary: "",
      todayLog: "",
      relationships: "",
      sceneMap: "",
      scenarioConditions: "",
      worldStatePrompt: "## World Conditions\n\nWeather: Heavy rain intensity 4/5\nNearby fires:\n- SCN_3: intensity 4/5 (Blazing) — visible from current location",
      gameDay: 1,
      currentTime: "08:00",
      language: "en",
    });
    expect(result).toContain("Heavy rain");
    expect(result).toContain("Blazing");
    expect(result).toContain("visible from current location");
  });
});

describe("buildDetailedNodesPrompt", () => {
  it("includes schedule entry and scene items", () => {
    const result = buildDetailedNodesPrompt({
      npcName: "Dr. Morgan",
      npcId: "npc_morgan",
      npcProfile: "Name: Dr. Morgan",
      longTermIntent: "Investigate strange occurrences",
      memoryLog: "",
      scheduleEntry: { time: "09:00", location: "library_main", activity: "Search for ritual texts" },
      sceneDescription: "A dusty old library with towering shelves.",
      sceneItems: "- Ancient Tome (id: tome_1, type: document)\n- Locked Cabinet (id: cabinet, type: container, locked)",
      sceneNpcs: "- Librarian (npc_librarian)",
      sceneConditions: "Dim lighting",
      worldStatePrompt: "",
      npcInventory: "- Flashlight (id: flashlight, type: lighting, unlit)",
      currentTime: "09:00",
      gameDay: 2,
      language: "en",
    });
    expect(result).toContain("Search for ritual texts");
    expect(result).toContain("tome_1");
    expect(result).toContain("cabinet");
    expect(result).toContain("flashlight");
  });

  it("includes handler and output schema prompts when provided", () => {
    const result = buildDetailedNodesPrompt({
      npcName: "Test",
      npcId: "npc_test",
      npcProfile: "",
      longTermIntent: "",
      memoryLog: "",
      scheduleEntry: { time: "09:00", location: "room_a", activity: "Do something" },
      sceneDescription: "",
      sceneItems: "",
      sceneNpcs: "",
      sceneConditions: "",
      worldStatePrompt: "",
      npcInventory: "",
      currentTime: "09:00",
      gameDay: 1,
      language: "en",
      handlerPrompt: "## Custom Handlers\ntest handler info",
      outputSchemaPrompt: "## Custom Schema\ntest schema info",
    });
    expect(result).toContain("Custom Handlers");
    expect(result).toContain("Custom Schema");
  });
});

describe("buildReviseSchedulePrompt", () => {
  it("includes trigger description and remaining schedule", () => {
    const result = buildReviseSchedulePrompt({
      npcName: "Dr. Morgan",
      npcProfile: "Name: Dr. Morgan",
      longTermIntent: "Investigate occurrences",
      memoryLog: "",
      remainingSchedule: JSON.stringify([
        { time: "12:00", location: "home", activity: "Lunch" },
        { time: "15:00", location: "church", activity: "Meet pastor" },
      ]),
      triggerDescription: "Witnessed: explosion at the hospital",
      language: "en",
    });
    expect(result).toContain("explosion at the hospital");
    expect(result).toContain("12:00");
    expect(result).toContain("Meet pastor");
  });
});
