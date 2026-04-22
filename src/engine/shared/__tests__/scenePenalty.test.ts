import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { applyPenalties, getScenePenalties } from "../scenePenalty.js";

describe("getScenePenalties — reads Record-shape skillPenalty from SceneCondition", () => {
  it("aggregates skill penalties from a single Record-shape condition", () => {
    const dgsm = new DynamicGameStateManager();
    dgsm.appendSceneCondition("warehouse", {
      featureId: "fire",
      description: "[Fire] Heavy smoke and flames",
      mechanicalEffect: { skillPenalty: { Perception: -30, Listen: -20 } },
    });
    const penalties = getScenePenalties("warehouse", dgsm);
    expect(penalties.get("Perception")).toBe(-30);
    expect(penalties.get("Listen")).toBe(-20);
  });

  it("sums penalties across multiple conditions on the same scene", () => {
    const dgsm = new DynamicGameStateManager();
    dgsm.appendSceneCondition("warehouse", {
      featureId: "fire",
      description: "[Fire] flames",
      mechanicalEffect: { skillPenalty: { Perception: -10 } },
    });
    dgsm.appendSceneCondition("warehouse", {
      featureId: "weather",
      description: "[Weather] heavy rain",
      mechanicalEffect: { skillPenalty: { Perception: -5, Climb: -10 } },
    });
    const penalties = getScenePenalties("warehouse", dgsm);
    expect(penalties.get("Perception")).toBe(-15);
    expect(penalties.get("Climb")).toBe(-10);
  });

  it("ignores conditions without mechanicalEffect or without skillPenalty", () => {
    const dgsm = new DynamicGameStateManager();
    dgsm.appendSceneCondition("warehouse", {
      featureId: "fire",
      description: "[Fire Aftermath] Minor smoke stains",
    });
    dgsm.appendSceneCondition("warehouse", {
      featureId: "weather",
      description: "[Weather] light breeze",
      mechanicalEffect: { blockConnections: false },
    });
    const penalties = getScenePenalties("warehouse", dgsm);
    expect(penalties.size).toBe(0);
  });

  it("returns empty map for an unknown scene", () => {
    const dgsm = new DynamicGameStateManager();
    const penalties = getScenePenalties("nowhere", dgsm);
    expect(penalties.size).toBe(0);
  });

  it("end-to-end: applyPenalties reduces skill values from getScenePenalties output", () => {
    const dgsm = new DynamicGameStateManager();
    dgsm.appendSceneCondition("warehouse", {
      featureId: "fire",
      description: "[Fire]",
      mechanicalEffect: { skillPenalty: { Perception: -20 } },
    });
    const penalties = getScenePenalties("warehouse", dgsm);
    const adjusted = applyPenalties(
      { Perception: 60, Climb: 50 },
      penalties,
    );
    expect(adjusted.Perception).toBe(40);
    expect(adjusted.Climb).toBe(50); // unchanged
  });
});
