import { describe, expect, it } from "vitest";
import type { SceneCondition, StateChange, TickReport } from "../types.js";

describe("core types", () => {
  it("StateChange union discriminates by kind", () => {
    const hp: StateChange = {
      kind: "character.hp",
      characterId: "npc1",
      delta: -3,
      sourceFeatureId: "fire",
      reason: "burn",
    };
    const setBlock: StateChange = {
      kind: "connection.setBlock",
      connectionId: "c1",
      blocked: true,
      sourceFeatureId: "weather",
      reason: "storm",
    };
    expect(hp.kind).toBe("character.hp");
    expect(setBlock.kind).toBe("connection.setBlock");
  });

  it("SceneCondition v2 carries featureId + data + mechanicalEffect", () => {
    const cond: SceneCondition = {
      featureId: "fire",
      data: { intensity: 3 },
      mechanicalEffect: {
        skillPenalty: { Spot: -20 },
        blockConnections: false,
      },
      description: "burning intensely",
    };
    expect(cond.featureId).toBe("fire");
  });

  it("TickReport shape carries all expected collections", () => {
    const report: TickReport = {
      tickTime: { day: 1, tickTime: "08:00" },
      commits: [],
      interruptions: [],
      cancellations: [],
      featureEvents: [],
      stateChanges: [],
      damageReports: [],
    };
    expect(report.commits).toHaveLength(0);
  });
});
