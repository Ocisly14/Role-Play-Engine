// The trust boundary with a citation scope (concealment design §5.4): an id
// that names something real but never reached this actor is refused, exactly
// like an id that names nothing. Without a scope the boundary keeps asking
// only "is it real".

import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { type RoadNode, buildTopology } from "../../../state/topologyTypes.js";
import type { DynamicScene } from "../../../state/types.js";
import { buildActionCommand } from "../commandBuilder.js";

function makeDgsm(): DynamicGameStateManager {
  const scenes = new Map<string, unknown>([
    [
      "SCN_1",
      {
        id: "SCN_1",
        name: "Study",
        setting: "A desk [item.desk] and a door to [SCN_2].",
        items: [
          { id: "item.desk", name: "desk" },
          { id: "item.secret", name: "letter under the blotter" },
        ],
        connections: [{ id: "c.1.2", targetId: "SCN_2" }],
      },
    ],
    [
      "SCN_2",
      {
        id: "SCN_2",
        name: "Hall",
        setting: "Back to [SCN_1].",
        items: [],
        connections: [{ id: "c.2.1", targetId: "SCN_1" }],
      },
    ],
    [
      "SCN_far",
      {
        id: "SCN_far",
        name: "Far",
        setting: "",
        items: [],
        connections: [],
      },
    ],
  ]);
  const roads = new Map<string, RoadNode>();
  return {
    getNpcProfile: (id: string) => ({ id, name: id, skills: {} }),
    getState: () => ({
      npcRelationshipGraph: {},
      npcCharacters: [{ id: "npc_1", name: "npc_1" }],
      scenes,
    }),
    isNpcAlive: () => true,
    getCharacterPosition: () => ({ type: "scene", sceneId: "SCN_1" }),
    resolveLocationId: () => "SCN_1",
    getTopology: () =>
      buildTopology(scenes as unknown as Map<string, DynamicScene>, roads),
    getScene: (id: string) => scenes.get(id) ?? null,
    getRoad: () => null,
    hasItem: (id: string) => id === "item.desk" || id === "item.secret",
    getVehicle: () => null,
    getVehicles: () => [],
    getVehicleByInterior: () => null,
    getSceneConditions: () => [],
    getNpcInventory: () => [],
    getGameDateTime: () => "1923-04-02T09:00:00",
    getRelationship: () => undefined,
  } as unknown as DynamicGameStateManager;
}

const act = (id: string) => ({
  description: "I look at it.",
  objectRefs: [{ id }],
  proposedDurationTicks: 1,
});

describe("buildActionCommand with a citation scope", () => {
  const dgsm = makeDgsm();
  const scope = { knownIds: new Set<string>() };

  it("accepts what is in plain view and the ways out", () => {
    expect(
      buildActionCommand("npc_1", act("item.desk"), {
        dgsm,
        citationScope: scope,
      }).ok
    ).toBe(true);
    expect(
      buildActionCommand("npc_1", act("SCN_2"), { dgsm, citationScope: scope })
        .ok
    ).toBe(true);
  });

  it("refuses an unnoticed item and a place never shown", () => {
    const secret = buildActionCommand("npc_1", act("item.secret"), {
      dgsm,
      citationScope: scope,
    });
    expect(secret.ok).toBe(false);
    if (!secret.ok) expect(secret.code).toBe("unknown_ref");
    expect(
      buildActionCommand("npc_1", act("SCN_far"), {
        dgsm,
        citationScope: scope,
      }).ok
    ).toBe(false);
  });

  it("accepts what they remember or perceived before", () => {
    const known = { knownIds: new Set(["item.secret", "SCN_far"]) };
    expect(
      buildActionCommand("npc_1", act("item.secret"), {
        dgsm,
        citationScope: known,
      }).ok
    ).toBe(true);
    expect(
      buildActionCommand("npc_1", act("SCN_far"), {
        dgsm,
        citationScope: known,
      }).ok
    ).toBe(true);
  });

  it("accepts what they noticed this minute", () => {
    const noticed = {
      knownIds: new Set<string>(),
      noticed: { itemIds: new Set(["item.secret"]) },
    };
    expect(
      buildActionCommand("npc_1", act("item.secret"), {
        dgsm,
        citationScope: noticed,
      }).ok
    ).toBe(true);
  });

  it("without a scope, only asks whether the id is real", () => {
    expect(buildActionCommand("npc_1", act("item.secret"), { dgsm }).ok).toBe(
      true
    );
  });
});
