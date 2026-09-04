import { describe, expect, it, vi } from "vitest";
import { makeOutdoorDgsm } from "../../../../src/engine/core/__tests__/outdoorFixture.js";
import type { WeatherJudgeFn } from "../../../../src/engine/weather/weatherEngine.js";
import { applyGlobalWeather } from "../service.js";

describe("applyGlobalWeather", () => {
  it("uses the weather engine for blocks and conditions, then clears by diff", async () => {
    const dgsm = makeOutdoorDgsm();
    const connectionId = "weather:ROAD_pass|SCN_ridge";
    const judge = vi.fn<WeatherJudgeFn>(async () => ({
      ok: true,
      judgement: {
        blocks: [{ connectionId, reason: "积雪封住山口" }],
        conditions: [{ placeId: "SCN_ridge", description: "风雪扫过山脊" }],
      },
    }));

    await applyGlobalWeather(dgsm, "snow", judge);

    expect(judge).toHaveBeenCalledTimes(1);
    expect(dgsm.getConnectionBlockReason("SCN_ridge", "ROAD_pass")).toBe(
      "积雪封住山口"
    );
    expect(dgsm.getSceneConditions("SCN_ridge")).toEqual([
      expect.objectContaining({
        featureId: "weather",
        description: "[Weather] 风雪扫过山脊",
      }),
    ]);
    expect(
      dgsm.getScopedFeatureState("weather", "region", "OUTDOOR")
    ).toMatchObject({
      weatherType: "snow",
      judgedBlockIds: [connectionId],
    });

    await applyGlobalWeather(dgsm, "clear", judge);

    expect(judge).toHaveBeenCalledTimes(1);
    expect(
      dgsm.getConnectionBlockReason("SCN_ridge", "ROAD_pass")
    ).toBeUndefined();
    expect(dgsm.getSceneConditions("SCN_ridge")).toEqual([]);
  });
});
