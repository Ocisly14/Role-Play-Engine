import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../DynamicGameState.js";

const RETIRED_KEYS = [
  "npcStats",
  "npcResidences",
  "hiddenCharacterIds",
  "npcInjectionPolicy",
  "loadedAt",
  "lastUpdated",
  "sessionId",
  "moduleName",
] as const;

describe("DynamicGameState persistence boundary", () => {
  it("migrates legacy npcStats into character status without retaining retired state", () => {
    const restored = DynamicGameStateManager.deserialize({
      sessionId: "legacy-session",
      moduleName: "legacy-module",
      npcStats: { npc_1: { hp: 3, san: 17 } },
      npcResidences: { npc_1: "S_HOME" },
      hiddenCharacterIds: ["npc_1"],
      npcInjectionPolicy: { tiers: {} },
      loadedAt: "2026-01-01T00:00:00.000Z",
      lastUpdated: "2026-01-02T00:00:00.000Z",
      npcCharacters: [
        {
          id: "npc_1",
          name: "Nancy",
          status: { hp: 10, san: 50, conditions: [] },
        },
      ],
      scenes: {},
      roads: {},
    });

    expect(restored.npcCharacters[0].status).toMatchObject({ hp: 3, san: 17 });
    for (const key of RETIRED_KEYS) expect(restored).not.toHaveProperty(key);

    const serialized = new DynamicGameStateManager(restored).serialize();
    for (const key of RETIRED_KEYS) expect(serialized).not.toHaveProperty(key);
  });
});
