// src/engine/weather/__tests__/weatherEngine.test.ts
//
// The weather engine's turn loop against a stubbed model: one clean
// submission, one repair, one refusal, one model error.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "../../../models/providers/types.js";

const generateToolCalls = vi.fn();

vi.mock("../../../models/index.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../../models/types.js"
  );
  return { ...actual, generateToolCalls };
});

const { judgeWeather, renderWeatherRequest } = await import("../weatherEngine.js");

const RIDGE_PASS = "weather:ROAD_pass|SCN_ridge";

const request = {
  regionId: "OUTDOOR",
  weather: { type: "snow" as const, intensity: 4, label: "Blizzard" },
  places: [
    { id: "SCN_ridge", kind: "scene" as const, name: "山脊", description: "裸露的山脊。" },
    { id: "ROAD_pass", kind: "road" as const, name: "山道", description: "翻山的土路。" },
  ],
  passages: [{ connectionId: RIDGE_PASS, from: "SCN_ridge", to: "ROAD_pass", travelTimeMinutes: 20 }],
  previouslyClosed: [],
};

function submission(args: object, id = "call_1") {
  const toolCalls = [{ id, name: "submit_weather_judgement", args }];
  return { toolCalls, assistantMessage: { role: "assistant" as const, toolCalls } };
}

beforeEach(() => {
  generateToolCalls.mockReset();
});

describe("judgeWeather", () => {
  it("renders the passages the model may name and accepts a clean judgement", async () => {
    generateToolCalls.mockResolvedValueOnce(
      submission({
        blocks: [{ connectionId: RIDGE_PASS, reason: "雪堆没过膝盖" }],
        conditions: [{ placeId: "SCN_ridge", description: "风雪横扫" }],
      })
    );
    const result = await judgeWeather(request);
    expect(result).toEqual({
      ok: true,
      judgement: {
        blocks: [{ connectionId: RIDGE_PASS, reason: "雪堆没过膝盖" }],
        conditions: [{ placeId: "SCN_ridge", description: "风雪横扫" }],
      },
    });
    const options = generateToolCalls.mock.calls[0][0];
    expect(options.toolChoice).toEqual({ name: "submit_weather_judgement" });
    expect(options.operation).toBe("weather-engine");
    const prompt = (options.messages as ModelMessage[])[0];
    expect(JSON.stringify(prompt)).toContain(RIDGE_PASS);
    expect(renderWeatherRequest(request)).toContain("裸露的山脊");
  });

  it("sends the errors back once and takes the corrected judgement", async () => {
    generateToolCalls
      .mockResolvedValueOnce(
        submission({ blocks: [{ connectionId: "connection.ridge.pass", reason: "x" }], conditions: [] })
      )
      .mockResolvedValueOnce(submission({ blocks: [], conditions: [] }, "call_2"));
    const result = await judgeWeather(request);
    expect(result).toEqual({ ok: true, judgement: { blocks: [], conditions: [] } });
    const second = generateToolCalls.mock.calls[1][0].messages as ModelMessage[];
    const feedback = second.at(-1);
    expect(feedback?.role).toBe("tool");
    expect(JSON.stringify(feedback)).toContain("REJECTED");
    expect(JSON.stringify(feedback)).toContain("blocks[0]");
  });

  it("gives up after one repair", async () => {
    const bad = submission({ blocks: [{ connectionId: "nope", reason: "x" }], conditions: [] });
    generateToolCalls.mockResolvedValueOnce(bad).mockResolvedValueOnce(bad);
    const result = await judgeWeather(request);
    expect(result.ok).toBe(false);
    expect(generateToolCalls).toHaveBeenCalledTimes(2);
  });

  it("reports a model error instead of throwing", async () => {
    generateToolCalls.mockRejectedValueOnce(new Error("boom"));
    const result = await judgeWeather(request);
    expect(result).toEqual({ ok: false, failure: "model error: boom" });
  });
});
