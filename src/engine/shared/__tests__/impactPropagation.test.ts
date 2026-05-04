import { describe, expect, it } from "vitest";
import { findAffectedCharacters } from "../impactPropagation.js";

function createMockDgsm() {
  const positions: Record<string, any> = {
    actor: { type: "road", roadId: "ROAD_1", position: 0.1 },
    near: { type: "road", roadId: "ROAD_1", position: 0.25 },
    dead: { type: "road", roadId: "ROAD_1", position: 0.18 },
    far: { type: "road", roadId: "ROAD_1", position: 0.8 },
    elsewhere: { type: "scene", sceneId: "SCENE_2" },
  };
  const hpByNpc: Record<string, number> = {
    actor: 10,
    near: 10,
    dead: 0,
    far: 10,
    elsewhere: 10,
  };

  return {
    getState() {
      return {
        npcCharacters: [
          { id: "actor" },
          { id: "near" },
          { id: "dead" },
          { id: "far" },
          { id: "elsewhere" },
        ],
        roads: new Map([
          [
            "ROAD_1",
            {
              id: "ROAD_1",
              name: "Harbor Road",
              parentLocationId: "OUTDOOR",
              endpointA: "JUNC_A",
              endpointB: "JUNC_B",
              travelTimeMinutes: 10,
              alongConnections: [],
              items: [],
              conditions: [],
            },
          ],
        ]),
        transportEdges: [],
      };
    },
    isNpcAlive(characterId: string) {
      return (hpByNpc[characterId] ?? 0) > 0;
    },
    getCharacterPosition(characterId: string) {
      return positions[characterId] ?? null;
    },
    resolveLocationId(position: any) {
      if (position.type === "road") return position.roadId;
      if (position.type === "scene") return position.sceneId;
      return position.junctionId;
    },
    getScene(sceneId: string) {
      if (sceneId === "ROAD_1") {
        return {
          id: "ROAD_1",
          name: "Harbor Road",
          parentLocationId: "OUTDOOR",
        };
      }
      if (sceneId === "SCENE_2") {
        return {
          id: "SCENE_2",
          name: "Warehouse",
          parentLocationId: "OUTDOOR",
        };
      }
      return null;
    },
  };
}

describe("findAffectedCharacters", () => {
  it("limits level-2 road impact to nearby characters on the same road", () => {
    const dgsm = createMockDgsm() as any;
    const result = findAffectedCharacters(
      {
        characterId: "actor",
        location: "ROAD_1",
      },
      2,
      dgsm
    );

    expect(result.get("near")).toBe(2);
    expect(result.has("dead")).toBe(false);
    expect(result.has("far")).toBe(false);
    expect(result.has("elsewhere")).toBe(false);
  });
});
