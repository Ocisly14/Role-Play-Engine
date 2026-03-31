import { describe, expect, it } from "vitest";
import {
  buildFailureTriggerDescription,
  buildImpactTriggerDescription,
} from "../NPCPlanningAgent.js";
import type { FailureTrigger, ImpactTrigger } from "../types.js";

describe("NPCPlanningAgent trigger description localization", () => {
  it("localizes co-presence impact descriptions in Chinese", () => {
    const trigger: ImpactTrigger = {
      type: "impact",
      triggeringAction: {
        characterId: "__encounter__",
        characterName: "共同在场",
        gameTime: "08:15",
        action: "相遇",
        location: "月台",
        type: "scene_interaction",
        impact: 2,
        status: "completed",
        outcome: "Ben Cleo, Haran Greenwood 在 月台",
      },
    };

    expect(buildImpactTriggerDescription("npc-1", trigger, "zh")).toBe(
      "与他人面对面相遇：Ben Cleo, Haran Greenwood 在 月台"
    );
  });

  it("localizes failure descriptions in Chinese", () => {
    const trigger: FailureTrigger = {
      type: "failure",
      failureReason: "location_blocked",
      action: "前往月台",
      gameTime: "08:15",
    };

    expect(buildFailureTriggerDescription(trigger, "zh")).toBe(
      "行动“前往月台”在 08:15 因 location_blocked 而失败。"
    );
  });
});
