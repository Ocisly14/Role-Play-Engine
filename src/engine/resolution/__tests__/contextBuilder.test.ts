// D7 full-context guarantee: every scene, item, character, new command and
// active action appears in the context — nothing is filtered for perceived
// relevance — and all state carries the same tick-start worldVersion fields.

import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { ActionCommand, EngineAction } from "../../actions/types.js";
import { buildEngineResolutionContext } from "../contextBuilder.js";

function makeDgsm(): DynamicGameStateManager {
  const scenes = new Map(
    ["SCN_1", "SCN_2", "SCN_FAR"].map((id) => [
      id,
      {
        id,
        name: id,
        description: `about ${id}`,
        parentLocationId: "L1",
        items: id === "SCN_1" ? [{ id: "lamp", name: "lamp" }] : [],
        conditions: [],
        connections:
          id === "SCN_1" ? [{ targetId: "SCN_2", description: "a door" }] : [],
      },
    ])
  );
  const npcs = [
    makeNpc("npc_1", "SCN_1"),
    makeNpc("npc_2", "SCN_2"),
    makeNpc("npc_far", "SCN_FAR"),
  ];
  return {
    getState: () => ({
      scenes,
      npcCharacters: npcs,
      npcInventories: { npc_1: [{ id: "pick", name: "lockpicks" }] },
    }),
    getEnvironmentReading: () => ({
      temperature: 20,
      illumination: 3,
      oxygen: 1,
      noise: 0,
      airborneHazards: [],
    }),
    getSceneConditions: () => [],
    getConnectionBlockReason: (from: string, to: string) =>
      from === "SCN_1" && to === "SCN_2" ? "rubble" : undefined,
    getCharactersInScene: (sceneId: string) =>
      npcs.filter((n) => n.__scene === sceneId).map((n) => n.id),
    getCharacterPosition: (id: string) => {
      const npc = npcs.find((n) => n.id === id);
      return npc ? { type: "scene", sceneId: npc.__scene } : null;
    },
    resolveLocationId: (p: { sceneId: string }) => p.sceneId,
    isNpcAlive: () => true,
    getNpcInventory: (id: string) =>
      id === "npc_1" ? [{ id: "pick", name: "lockpicks" }] : [],
  } as unknown as DynamicGameStateManager;
}

function makeNpc(id: string, scene: string) {
  return {
    id,
    name: id,
    __scene: scene,
    attributes: { STR: 50 },
    skills: { Locksmith: 60 },
    status: {
      hp: 10,
      maxHp: 12,
      san: 40,
      maxSan: 60,
      fatigue: 1,
      maxFatigue: 10,
      conditions: [],
    },
    relationships: [{ targetId: "npc_2" }],
  };
}

const cmd: ActionCommand = {
  commandId: "c1",
  actorId: "npc_1",
  issuedAt: "1923-04-02T09:15:00",
  issuedSceneId: "SCN_1",
  description: "act",
  objectRefs: [],
  proposedDurationTicks: 1,
};

const active: EngineAction = {
  id: "action_live",
  command: { ...cmd, commandId: "live", actorId: "npc_2" },
  status: "active",
  submittedAt: "t",
  progressMinutes: 3,
};

describe("buildEngineResolutionContext", () => {
  const context = buildEngineResolutionContext({
    dgsm: makeDgsm(),
    tickId: "tick_9",
    tickStartTime: "1923-04-02T09:15:00",
    durationMinutes: 1,
    worldVersion: "v9",
    randomSeed: "seed",
    triggers: [
      { actionIds: ["action_c1"], reason: "new_action" },
      { actionIds: ["action_live"], reason: "duration_reached" },
    ],
    newCommands: [cmd],
    activeActions: [active],
  });

  it("includes EVERY scene, item and character — no relevance trimming", () => {
    expect(context.state.scenes.map((s) => s.id).sort()).toEqual([
      "SCN_1",
      "SCN_2",
      "SCN_FAR",
    ]);
    // The far-away idle character is present too.
    expect(context.state.characters.map((c) => c.id).sort()).toEqual([
      "npc_1",
      "npc_2",
      "npc_far",
    ]);
    // Items from scenes AND inventories, with holders.
    expect(
      context.state.items.map((i) => `${i.id}@${i.holder}`).sort()
    ).toEqual(["lamp@scene:SCN_1", "pick@npc_1"]);
  });

  it("carries real skill values, positions and blocked connections", () => {
    const npc1 = context.state.characters.find((c) => c.id === "npc_1");
    expect(npc1?.skills.Locksmith).toBe(60);
    expect(npc1?.locationId).toBe("SCN_1");
    const scn1 = context.state.scenes.find((s) => s.id === "SCN_1");
    expect(scn1?.connections[0]).toMatchObject({
      targetId: "SCN_2",
      blockedReason: "rubble",
    });
    expect(scn1?.presentCharacterIds).toEqual(["npc_1"]);
  });

  it("unions trigger action ids and stamps tick/version/seed", () => {
    expect(context.trigger.actionIds.sort()).toEqual([
      "action_c1",
      "action_live",
    ]);
    expect(context.tick).toEqual({
      tickId: "tick_9",
      tickStartTime: "1923-04-02T09:15:00",
      durationMinutes: 1,
      worldVersion: "v9",
      randomSeed: "seed",
    });
    expect(context.rules.worldInvariants.length).toBeGreaterThan(0);
    expect(context.actions.newCommands).toEqual([cmd]);
    expect(context.actions.activeActions).toEqual([active]);
  });
});
