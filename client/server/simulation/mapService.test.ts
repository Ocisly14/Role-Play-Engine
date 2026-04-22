import { describe, expect, it } from "vitest";
import type { SceneCondition } from "../../../src/engine/core/types.js";
import { mergeSceneConditions } from "./mapService.js";

describe("mergeSceneConditions", () => {
  it("deduplicates identical static and runtime scene conditions", () => {
    const coldBrewery: SceneCondition = {
      description: "酒厂内部空旷冷清，冬季的寒气在空置厂房中格外明显",
    };
    const vodkaSmell: SceneCondition = {
      description:
        "空气中弥漫着伏特加酿造的淡淡酒精气味，混合着尘土和潮湿的味道",
    };

    expect(
      mergeSceneConditions(
        [coldBrewery, vodkaSmell],
        [coldBrewery, vodkaSmell, coldBrewery]
      )
    ).toEqual([coldBrewery, vodkaSmell]);
  });

  it("keeps distinct conditions that share the same description", () => {
    const baseDescription = "地面湿滑";

    expect(
      mergeSceneConditions(
        [{ description: baseDescription }],
        [
          {
            description: baseDescription,
            mechanicalEffect: {
              skillPenalty: { 潜行: -10 },
            },
          },
        ]
      )
    ).toEqual([
      { description: baseDescription },
      {
        description: baseDescription,
        mechanicalEffect: {
          skillPenalty: { 潜行: -10 },
        },
      },
    ]);
  });
});
