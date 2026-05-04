import { describe, expect, it } from "vitest";
import type { FeatureReadContext } from "../featureReadContext.js";
import { FeatureRunner } from "../featureRunner.js";
import type { WorldFeature } from "../worldFeature.js";

const lowPrio: WorldFeature = {
  id: "lo",
  description: "",
  stateScope: "global",
  affectedKinds: ["character.hp"],
  effectSummary: "",
  priority: 400,
  onTick: () => [
    {
      kind: "character.hp",
      characterId: "x",
      delta: -1,
      sourceFeatureId: "lo",
      reason: "lo",
    },
  ],
};
const highPrio: WorldFeature = {
  id: "hi",
  description: "",
  stateScope: "global",
  affectedKinds: ["character.hp"],
  effectSummary: "",
  priority: 100,
  onTick: () => [
    {
      kind: "character.hp",
      characterId: "x",
      delta: -2,
      sourceFeatureId: "hi",
      reason: "hi",
    },
  ],
};
const noTick: WorldFeature = {
  id: "noop",
  description: "",
  stateScope: "global",
  affectedKinds: [],
  effectSummary: "",
};

const fakeCtx = {} as FeatureReadContext;

describe("FeatureRunner", () => {
  it("runs features in priority order (low-number first) and concatenates StateChanges", () => {
    const runner = new FeatureRunner([lowPrio, noTick, highPrio]);
    const changes = runner.runTick(fakeCtx);
    expect(
      changes.map((c) => (c.kind === "character.hp" ? c.sourceFeatureId : ""))
    ).toEqual(["hi", "lo"]);
  });

  it("getFeatureScopeMap returns featureId → stateScope", () => {
    const runner = new FeatureRunner([lowPrio, highPrio]);
    expect(runner.getFeatureScopeMap().get("lo")).toBe("global");
    expect(runner.getFeatureScopeMap().get("hi")).toBe("global");
  });
});
