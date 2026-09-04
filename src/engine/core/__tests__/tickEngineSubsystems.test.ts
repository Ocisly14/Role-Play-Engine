// A subsystem's state has to be written where the next tick reads it: under
// its own anchor kind. And the outdoors is a region even though no scene
// names it as a parent — the module's weather presets do.

import { describe, expect, it, vi } from "vitest";
import type { AnchorSubsystem } from "../../subsystem/types.js";
import type { WeatherRegionState } from "../../subsystem/weather.js";
import type { WeatherJudgeFn } from "../../weather/weatherEngine.js";
import { makeEngine, makeOutdoorDgsm } from "./outdoorFixture.js";

describe("subsystem state scope", () => {
  it("writes a region subsystem's state where the next tick reads it", async () => {
    const dgsm = makeOutdoorDgsm();
    const seen: string[] = [];
    const counter: AnchorSubsystem = {
      id: "counter",
      kind: "anchor",
      anchorKind: "region",
      description: "counts ticks per region",
      effectSummary: "",
      affectedKinds: ["feature.setState"],
      shouldExist: () => true,
      initialState: (anchorId) => [
        { kind: "feature.setState", featureId: "counter", key: anchorId, state: { n: 0 } },
      ],
      onTick: (anchorId, ctx) => {
        const prev = ctx.getFeatureState<{ n: number }>(anchorId);
        seen.push(`${anchorId}:${prev?.n ?? "missing"}`);
        return [
          {
            kind: "feature.setState",
            featureId: "counter",
            key: anchorId,
            state: { n: (prev?.n ?? 0) + 1 },
          },
        ];
      },
    };
    const engine = makeEngine(dgsm, [counter]);
    await engine.tick();
    await engine.tick();

    // Tick 1 runs before its own initialState is flushed ("missing"); tick 2
    // reads what tick 1 wrote — under "region", where it was written. The
    // inn's building (B_INN) is a region too; only the implicit outdoors is
    // asserted on.
    expect(seen.filter((s) => s.startsWith("OUTDOOR"))).toEqual([
      "OUTDOOR:missing",
      "OUTDOOR:1",
    ]);
    expect(dgsm.getScopedFeatureState("counter", "region", "OUTDOOR")).toEqual({
      n: 2,
    });
  });
});

/** A weather stub that seeds one region in the given weather and raises the
 *  transition event once, on its first tick. */
function weatherStub(state: WeatherRegionState): AnchorSubsystem {
  return {
    id: "weather",
    kind: "anchor",
    anchorKind: "region",
    description: "stub weather",
    effectSummary: "",
    affectedKinds: ["feature.setState", "event.emit"],
    shouldExist: () => true,
    // Like the real subsystem: a region without a preset (here the inn's
    // building, B_INN) gets no state and no event.
    initialState: (anchorId) =>
      anchorId === "OUTDOOR"
        ? [
            { kind: "feature.setState", featureId: "weather", key: anchorId, state },
            {
              kind: "event.emit",
              event: {
                type: "weather.transition",
                impact: 0,
                description: "stub",
                data: { regionId: anchorId, state },
              },
            },
          ]
        : [],
    onTick: () => [],
  };
}

const AFFECTED = ["SCN_ridge", "SCN_hollow", "ROAD_pass"];

describe("weather judgement (Phase 8b)", () => {
  it("asks the weather engine on a transition and applies its judgement in the same tick", async () => {
    const dgsm = makeOutdoorDgsm();
    const judge = vi.fn<WeatherJudgeFn>(async (request) => ({
      ok: true,
      judgement: {
        blocks: [{ connectionId: "weather:ROAD_pass|SCN_ridge", reason: "雪堆没过膝盖" }],
        conditions: [{ placeId: "SCN_ridge", description: "风雪横扫山脊" }],
      },
    }));
    const engine = makeEngine(
      dgsm,
      [weatherStub({ weatherType: "snow", intensity: 5, minutesInState: 0, affectedSceneIds: AFFECTED })],
      { weatherJudgeFn: judge }
    );
    await engine.tick();

    expect(judge).toHaveBeenCalledTimes(1);
    const request = judge.mock.calls[0][0];
    expect(request.regionId).toBe("OUTDOOR");
    expect(request.passages.map((p) => p.connectionId).sort()).toEqual([
      "weather:ROAD_pass|SCN_hollow",
      "weather:ROAD_pass|SCN_ridge",
    ]);
    expect(dgsm.getConnectionBlockReason("SCN_ridge", "ROAD_pass")).toBe("雪堆没过膝盖");
    expect(dgsm.getConnectionBlockReason("SCN_hollow", "ROAD_pass")).toBeUndefined();
    expect(dgsm.getSceneConditions("SCN_ridge")).toEqual([
      expect.objectContaining({ featureId: "weather", description: "[Weather] 风雪横扫山脊" }),
    ]);
    expect(dgsm.getScopedFeatureState("weather", "region", "OUTDOOR")).toMatchObject({
      judgedBlockIds: ["weather:ROAD_pass|SCN_ridge"],
    });

    // The only region in the world got exactly one judgement; a second tick
    // with no transition asks for none.
    await engine.tick();
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("clears without asking: everything the last judgement closed reopens", async () => {
    const dgsm = makeOutdoorDgsm();
    dgsm.setConnectionBlocked("SCN_ridge", "ROAD_pass", true, "雪堆没过膝盖");
    dgsm.appendSceneCondition("SCN_ridge", { featureId: "weather", description: "[Weather] 旧的" });
    const judge = vi.fn<WeatherJudgeFn>();
    const engine = makeEngine(
      dgsm,
      [
        weatherStub({
          weatherType: "clear",
          intensity: 0,
          minutesInState: 0,
          affectedSceneIds: AFFECTED,
          judgedBlockIds: ["weather:ROAD_pass|SCN_ridge"],
        }),
      ],
      { weatherJudgeFn: judge }
    );
    await engine.tick();
    expect(judge).not.toHaveBeenCalled();
    expect(dgsm.getConnectionBlockReason("SCN_ridge", "ROAD_pass")).toBeUndefined();
    expect(dgsm.getSceneConditions("SCN_ridge")).toEqual([]);
  });

  it("leaves passages and conditions as they were when the judgement fails", async () => {
    const dgsm = makeOutdoorDgsm();
    dgsm.setConnectionBlocked("SCN_ridge", "ROAD_pass", true, "雪堆没过膝盖");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const judge = vi.fn<WeatherJudgeFn>(async () => ({ ok: false, failure: "model error: boom" }));
    const engine = makeEngine(
      dgsm,
      [weatherStub({ weatherType: "snow", intensity: 3, minutesInState: 0, affectedSceneIds: AFFECTED, judgedBlockIds: ["weather:ROAD_pass|SCN_ridge"] })],
      { weatherJudgeFn: judge }
    );
    await engine.tick();
    expect(dgsm.getConnectionBlockReason("SCN_ridge", "ROAD_pass")).toBe("雪堆没过膝盖");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("weather judgement for OUTDOOR failed"));
    warn.mockRestore();
  });
});
