import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  resolveDisplayLocationName,
  resolveLocationName,
} from "../sceneMapFormatter.js";

function createMockDgsm() {
  const scenes = new Map([
    [
      "SCN_17_SUB_1",
      {
        id: "SCN_17_SUB_1",
        name: "教堂主殿",
        description: "",
        parentLocationId: "SCN_17",
        items: [],
        conditions: [],
        connections: [],
      },
    ],
    [
      "SCN_17_SUB_4",
      {
        id: "SCN_17_SUB_4",
        name: "地下赌场",
        description: "",
        parentLocationId: "SCN_17",
        items: [],
        conditions: [],
        connections: [],
      },
    ],
  ]);

  return {
    getState() {
      return {
        scenes,
        scenarioOutlines: [
          {
            id: "SCN_17",
            name: "教堂",
            description: "",
            subSceneCount: 4,
            entrySceneId: "SCN_17_SUB_1",
          },
        ],
        topology: {
          junctions: new Map(),
          roads: new Map(),
        },
      };
    },
  };
}

describe("sceneMapFormatter display names", () => {
  const dgsm = createMockDgsm() as unknown as DynamicGameStateManager;

  it("keeps macro location names for planning resolution", () => {
    expect(resolveLocationName(dgsm, "SCN_17_SUB_4")).toBe("教堂");
  });

  it("renders sub-scenes with parent and child display names", () => {
    expect(resolveDisplayLocationName(dgsm, "SCN_17_SUB_1")).toBe("教堂·主殿");
    expect(resolveDisplayLocationName(dgsm, "SCN_17_SUB_4")).toBe(
      "教堂·地下赌场"
    );
  });
});
