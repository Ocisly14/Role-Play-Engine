import { describe, expect, it } from "vitest";
import { SimulationEventEmitter } from "../SimulationEventEmitter.js";
import type { CharacterAction } from "../npc/planning/types.js";

function makeAction(
  status: CharacterAction["status"],
  overrides: Partial<CharacterAction> = {}
): CharacterAction {
  return {
    characterId: "npc-1",
    characterName: "Johnny",
    gameTime: "19:10",
    action: "Check the mezzanine upstairs",
    location: "SCN_16_SUB_1",
    type: "movement",
    impact: 1,
    status,
    outcome: "Test outcome",
    ...overrides,
  };
}

describe("SimulationEventEmitter", () => {
  it("maps interrupted actions to action_interrupted events", () => {
    const emitter = new SimulationEventEmitter("session-1");

    const events = emitter.actionsToEvents(
      [
        makeAction("completed"),
        makeAction("failed", { characterId: "npc-2" }),
        makeAction("interrupted", { characterId: "npc-3" }),
      ],
      1
    );

    expect(events.map((event) => event.type)).toEqual([
      "action_executed",
      "action_failed",
      "action_interrupted",
    ]);
  });
});
