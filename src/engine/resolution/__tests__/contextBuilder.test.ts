// Two-tier context (M3): Tier 1 carries EVERY place and connection as a
// graph; Tier 2 carries full snapshots of only the involved places; the
// full-world lookup surfaces (itemHolders) are never trimmed; characters stay
// complete.

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
          id === "SCN_1"
            ? [
                {
                  id: "exit.scn1.door",
                  targetId: "SCN_2",
                  description: "a door",
                },
              ]
            : [],
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
      scenarioOutlines: [
        { id: "L1", name: "The Manor", description: "", subSceneCount: 3 },
      ],
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
    getCharacterSpot: () => null,
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
    triggers: [
      { actionIds: ["action_c1"], reason: "new_action" },
      { actionIds: ["action_live"], reason: "duration_reached" },
    ],
    newCommands: [cmd],
    activeActions: [active],
  });

  it("puts EVERY place and character in Tier 1 / the character list", () => {
    expect(context.state.graph.places.map((p) => p.id).sort()).toEqual([
      "SCN_1",
      "SCN_2",
      "SCN_FAR",
    ]);
    expect(context.state.graph.macroLocations).toEqual([
      { id: "L1", name: "The Manor" },
    ]);
    // The far-away idle character is present too.
    expect(context.state.characters.map((c) => c.id).sort()).toEqual([
      "npc_1",
      "npc_2",
      "npc_far",
    ]);
    // The full-world holder map is never trimmed.
    expect(context.state.itemHolders).toEqual({
      lamp: "scene:SCN_1",
      pick: "npc_1",
    });
  });

  it("snapshots only the involved places in Tier 2", () => {
    // npc_1 (new command) stands in SCN_1; npc_2 (active action) in SCN_2.
    // SCN_FAR involves no action and gets no detailed snapshot.
    expect(context.state.places.map((p) => p.id).sort()).toEqual([
      "SCN_1",
      "SCN_2",
    ]);
    // Items: the involved places' floors plus the involved actors' pockets.
    expect(
      context.state.items.map((i) => `${i.id}@${i.holder}`).sort()
    ).toEqual(["lamp@scene:SCN_1", "pick@npc_1"]);
  });

  it("carries real skill values, positions and blocked connections", () => {
    const npc1 = context.state.characters.find((c) => c.id === "npc_1");
    expect(npc1?.skills.Locksmith).toBe(60);
    expect(npc1?.locationId).toBe("SCN_1");
    const scn1 = context.state.places.find((s) => s.id === "SCN_1");
    expect(scn1?.kind).toBe("scene");
    expect(scn1?.connections[0]).toMatchObject({
      connectionId: "exit.scn1.door",
      targetId: "SCN_2",
      blockedReason: "rubble",
    });
    expect(scn1?.presentCharacterIds).toEqual(["npc_1"]);
    // The graph edge carries the same connection id and block reason.
    expect(context.state.graph.edges).toEqual([
      {
        connectionId: "exit.scn1.door",
        from: "SCN_1",
        to: "SCN_2",
        blockedReason: "rubble",
      },
    ]);
  });

  it("unions trigger action ids and stamps the tick frame", () => {
    expect(context.trigger.actionIds.sort()).toEqual([
      "action_c1",
      "action_live",
    ]);
    expect(context.tick).toEqual({
      tickId: "tick_9",
      tickStartTime: "1923-04-02T09:15:00",
      durationMinutes: 1,
    });
    expect(context.rules.worldInvariants.length).toBeGreaterThan(0);
    expect(context.actions.newCommands).toEqual([cmd]);
    expect(context.actions.activeActions).toEqual([active]);
  });
});
