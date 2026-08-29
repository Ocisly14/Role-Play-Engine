// M3 two-tier context against a REAL DynamicGameStateManager: Tier 1 carries
// every place (scenes, junctions, roads) and every authored edge — connection
// ids, road travel times, block reasons; Tier 2 carries full snapshots of
// only the involved places, junctions/roads included, with hidden items and
// connection ids visible to the all-knowing Engine.

import { describe, expect, it } from "vitest";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../../../state/DynamicGameState.js";
import type { JunctionNode, RoadNode } from "../../../state/topologyTypes.js";
import type { DynamicScene } from "../../../state/types.js";
import type { ActionCommand, EngineAction } from "../../actions/types.js";
import { buildEngineResolutionContext } from "../contextBuilder.js";

function makeDgsm(): DynamicGameStateManager {
  const state = initialDynamicGameState({
    sessionId: "test-session",
    moduleName: "test-module",
  });

  const home: DynamicScene = {
    id: "S_HOME",
    name: "Home",
    description: "A parlour with a daisy display.",
    parentLocationId: "LOC_TOWN",
    items: [
      { id: "item_chair", name: "a chair" },
      { id: "item_bills", name: "duplicate bills", hidden: true },
    ],
    conditions: [{ id: "cond.home.dust", description: "dust everywhere" }],
    connections: [
      { id: "exit.home.junc", targetId: "J_A" },
      { id: "exit.home.secret", targetId: "R_MAIN", hidden: true },
    ],
    indoor: true,
  };

  const far: DynamicScene = {
    id: "S_FAR",
    name: "Far house",
    description: "Nobody's business today.",
    parentLocationId: "LOC_TOWN",
    items: [{ id: "item_vase", name: "a vase" }],
    conditions: [],
    connections: [{ id: "exit.far.junc", targetId: "J_A" }],
  };

  const junction: JunctionNode = {
    id: "J_A",
    name: "Crossing",
    description: "A windswept crossing.",
    parentLocationId: "OUTDOOR",
    items: [{ id: "item_lamppost", name: "a lamppost" }],
    conditions: [],
    connections: [
      { id: "exit.junc.home", targetId: "S_HOME" },
      { id: "exit.junc.road", targetId: "R_MAIN" },
    ],
    connectedSceneIds: ["S_HOME"],
  };

  const junctionB: JunctionNode = {
    id: "J_B",
    name: "Far Corner",
    description: "The far corner.",
    parentLocationId: "OUTDOOR",
    items: [],
    conditions: [],
    connections: [],
    connectedSceneIds: [],
  };

  const road: RoadNode = {
    id: "R_MAIN",
    name: "Star Avenue",
    description: "A long avenue.",
    parentLocationId: "OUTDOOR",
    connections: [
      { id: "exit.road.a", targetId: "J_A", role: "endpointA" },
      { id: "exit.road.b", targetId: "J_B", role: "endpointB" },
    ],
    endpointA: "J_A",
    endpointB: "J_B",
    travelTimeMinutes: 15,
    alongConnections: [],
    items: [{ id: "item_glove", name: "a dropped glove" }],
    conditions: [],
  };

  state.scenes.set(home.id, home);
  state.scenes.set(far.id, far);
  state.junctions.set(junction.id, junction);
  state.junctions.set(junctionB.id, junctionB);
  state.roads.set(road.id, road);
  state.scenarioOutlines = [
    {
      id: "LOC_TOWN",
      name: "Grayhaven",
      description: "",
      subSceneCount: 2,
    },
  ];
  state.npcInventories = { npc_home: [{ id: "item_coin", name: "a coin" }] };

  const dgsm = new DynamicGameStateManager(state);
  for (const [id, sceneId] of [
    ["npc_home", "S_HOME"],
    ["npc_far", "S_FAR"],
  ] as const) {
    seedNpc(dgsm, id);
    dgsm.setCharacterPosition(id, { type: "scene", sceneId });
  }
  seedNpc(dgsm, "npc_walker");
  dgsm.setCharacterPosition("npc_walker", {
    type: "road",
    roadId: "R_MAIN",
    position: 0.4,
  });
  // A live block so the graph edge carries its reason.
  dgsm.setConnectionBlocked("J_A", "R_MAIN", true, "a felled tree");
  return dgsm;
}

function seedNpc(dgsm: DynamicGameStateManager, id: string): void {
  dgsm.registerNpcProfile({
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
      hp: 10,
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
    longTermIntent: "",
    relationships: [],
  } as never);
}

const cmd: ActionCommand = {
  commandId: "c1",
  actorId: "npc_home",
  issuedAt: "1985-07-08T09:00:00",
  issuedSceneId: "S_HOME",
  description: "I examine the lamppost across the way.",
  objectRefs: [{ kind: "item", id: "item_lamppost" }],
  proposedDurationTicks: 1,
};

const active: EngineAction = {
  id: "action_live",
  command: {
    ...cmd,
    commandId: "live",
    actorId: "npc_walker",
    objectRefs: [],
  },
  status: "active",
  submittedAt: "1985-07-08T08:50:00",
  progressMinutes: 3,
};

function build() {
  return buildEngineResolutionContext({
    dgsm: makeDgsm(),
    tickId: "tick_1",
    tickStartTime: "1985-07-08T09:00:00",
    durationMinutes: 1,
    triggers: [
      { actionIds: ["action_c1"], reason: "new_action" },
      { actionIds: ["action_live"], reason: "duration_reached" },
    ],
    newCommands: [cmd],
    activeActions: [active],
  });
}

describe("Tier 1 — the whole world as a graph", () => {
  const { graph } = build().state;

  it("lists every place with its kind, and the macro locations", () => {
    expect(graph.places.map((p) => `${p.kind}:${p.id}`).sort()).toEqual([
      "junction:J_A",
      "junction:J_B",
      "road:R_MAIN",
      "scene:S_FAR",
      "scene:S_HOME",
    ]);
    expect(graph.macroLocations).toEqual([
      { id: "LOC_TOWN", name: "Grayhaven" },
    ]);
  });

  it("lists every authored edge with connectionId, travel time and block reason", () => {
    const byId = new Map(graph.edges.map((e) => [e.connectionId, e]));
    expect([...byId.keys()].sort()).toEqual([
      "exit.far.junc",
      "exit.home.junc",
      "exit.home.secret",
      "exit.junc.home",
      "exit.junc.road",
      "exit.road.a",
      "exit.road.b",
    ]);
    // Road endpoint edges carry the full walk time.
    expect(byId.get("exit.road.a")).toMatchObject({
      from: "R_MAIN",
      to: "J_A",
      travelTimeMinutes: 15,
    });
    // The blocked junction↔road edge names its reason, seen from both sides.
    expect(byId.get("exit.junc.road")?.blockedReason).toBe("a felled tree");
    expect(byId.get("exit.road.a")?.blockedReason).toBe("a felled tree");
    // Hidden connections stay in the graph, flagged: the Engine is all-knowing.
    expect(byId.get("exit.home.secret")?.hidden).toBe(true);
  });
});

describe("Tier 2 — full snapshots of the involved places only", () => {
  const state = build().state;

  it("includes the actors' places and the referenced item's holder place — nothing else", () => {
    // npc_home stands in S_HOME; npc_walker stands ON the road; the command's
    // objectRef points at the lamppost held by J_A. S_FAR is uninvolved.
    expect(state.places.map((p) => `${p.kind}:${p.id}`).sort()).toEqual([
      "junction:J_A",
      "road:R_MAIN",
      "scene:S_HOME",
    ]);
  });

  it("snapshots junctions and roads with the same detail as scenes", () => {
    const road = state.places.find((p) => p.id === "R_MAIN");
    expect(road?.kind).toBe("road");
    expect(road?.itemIds).toEqual(["item_glove"]);
    expect(road?.presentCharacterIds).toEqual(["npc_walker"]);
    const junction = state.places.find((p) => p.id === "J_A");
    expect(junction?.kind).toBe("junction");
    expect(junction?.connections.map((c) => c.connectionId).sort()).toEqual([
      "exit.junc.home",
      "exit.junc.road",
    ]);
  });

  it("shows hidden items and hidden exits to the Engine, flagged", () => {
    const home = state.places.find((p) => p.id === "S_HOME");
    expect(home?.conditions).toEqual([
      { id: "cond.home.dust", description: "dust everywhere" },
    ]);
    const secret = home?.connections.find(
      (c) => c.connectionId === "exit.home.secret"
    );
    expect(secret?.hidden).toBe(true);

    const bills = state.items.find((i) => i.id === "item_bills");
    expect(bills).toMatchObject({ holder: "scene:S_HOME", hidden: true });
  });

  it("trims items to the involved places and actors, but never the holder map", () => {
    expect(state.items.map((i) => `${i.id}@${i.holder}`).sort()).toEqual([
      "item_bills@scene:S_HOME",
      "item_chair@scene:S_HOME",
      "item_coin@npc_home",
      "item_glove@scene:R_MAIN",
      "item_lamppost@scene:J_A",
    ]);
    // The vase at the uninvolved S_FAR is absent from the prompt list but
    // present in the full-world lookup map.
    expect(state.itemHolders.item_vase).toBe("scene:S_FAR");
    // Characters stay complete regardless of involvement.
    expect(state.characters.map((c) => c.id).sort()).toEqual([
      "npc_far",
      "npc_home",
      "npc_walker",
    ]);
  });
});
