import { describe, expect, it } from "vitest";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../DynamicGameState.js";
import type { DynamicNPCProfile } from "../types.js";

function makeNpc(id: string, hp: number): DynamicNPCProfile {
  return {
    id,
    name: id,
    attributes: {
      STR: 50,
      CON: 50,
      DEX: 50,
      APP: 50,
      POW: 50,
      SIZ: 50,
      INT: 50,
      EDU: 50,
    },
    status: {
      hp,
      maxHp: 10,
      san: 50,
      maxSan: 50,
      fatigue: 0,
      maxFatigue: 100,
      luck: 50,
      conditions: [],
    },
    inventory: [],
    skills: {},
    longTermIntent: "Keep living",
    relationships: [],
  };
}

describe("DynamicGameStateManager death helpers", () => {
  it("excludes dead NPCs from simulated NPCs", () => {
    const state = initialDynamicGameState({
      sessionId: "session",
      moduleName: "module",
    });
    state.npcCharacters = [makeNpc("alive", 10), makeNpc("dead", 0)];
    state.npcStats = {
      alive: { hp: 10, san: 50 },
      dead: { hp: 0, san: 50 },
    };
    state.npcInjectionPolicy = {
      mode: "manual",
      tiers: {
        daily_sim: ["alive", "dead"],
        investigator_sim: [],
        background: [],
      },
    } as any;

    const dgsm = new DynamicGameStateManager(state);
    expect(dgsm.getSimulatedNpcs().map((npc) => npc.id)).toEqual(["alive"]);
  });

  it("persists hidden NPC ids through serialize and deserialize", () => {
    const state = initialDynamicGameState({
      sessionId: "session",
      moduleName: "module",
    });
    state.npcCharacters = [makeNpc("alive", 10), makeNpc("dead", 0)];

    const dgsm = new DynamicGameStateManager(state);
    dgsm.setCharacterHidden("alive", true);

    const restored = new DynamicGameStateManager(
      DynamicGameStateManager.deserialize(dgsm.serialize())
    );

    expect(restored.isCharacterHidden("alive")).toBe(true);
    expect(restored.isCharacterHidden("dead")).toBe(false);
  });
});
