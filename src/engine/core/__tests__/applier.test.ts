import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { Applier } from "../applier.js";
import type { StateChange } from "../types.js";

function seedNpc(
  d: DynamicGameStateManager,
  id: string,
  hp = 10,
  maxHp = 10
): void {
  d.registerNpcProfile({
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
      hp,
      maxHp,
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
  });
}

describe("Applier", () => {
  it("sums same-character hp deltas, clamps, emits DamageReport", () => {
    const d = new DynamicGameStateManager();
    seedNpc(d, "npc1", 10);
    const applier = new Applier(d, new Map([["fire", "scene"]]));
    const changes: StateChange[] = [
      {
        kind: "character.hp",
        characterId: "npc1",
        delta: -4,
        sourceFeatureId: "fire",
        reason: "burn",
      },
      {
        kind: "character.hp",
        characterId: "npc1",
        delta: -8,
        sourceFeatureId: "fire",
        reason: "burn-spread",
      },
    ];
    const report = applier.flush(changes, "1923-10-17T08:00:00");
    expect(d.getNpcProfile("npc1")?.status.hp).toBe(0);
    expect(report.damageReports).toHaveLength(1);
    expect(report.damageReports[0].contributors).toHaveLength(2);
    expect(report.damageReports[0].died).toBe(true);
    expect(report.featureEvents.some((e) => e.type === "character.died")).toBe(
      true
    );
  });

  it("connection.setBlock uses refcount: two voters must both withdraw", () => {
    const d = new DynamicGameStateManager();
    d.ensureConnection("c1");
    const applier = new Applier(d, new Map());
    applier.flush(
      [
        {
          kind: "connection.setBlock",
          connectionId: "c1",
          blocked: true,
          sourceFeatureId: "fire",
          reason: "flames",
        },
        {
          kind: "connection.setBlock",
          connectionId: "c1",
          blocked: true,
          sourceFeatureId: "weather",
          reason: "flooded",
        },
      ],
      "1923-10-17T08:00:00"
    );
    expect(d.isConnectionBlocked("c1")).toBe(true);

    applier.flush(
      [
        {
          kind: "connection.setBlock",
          connectionId: "c1",
          blocked: false,
          sourceFeatureId: "fire",
          reason: "flames",
        },
      ],
      "1923-10-17T08:01:00"
    );
    expect(d.isConnectionBlocked("c1")).toBe(true);

    applier.flush(
      [
        {
          kind: "connection.setBlock",
          connectionId: "c1",
          blocked: false,
          sourceFeatureId: "weather",
          reason: "flooded",
        },
      ],
      "1923-10-17T08:02:00"
    );
    expect(d.isConnectionBlocked("c1")).toBe(false);
  });

  it("feature.setState routes to correct scope bucket", () => {
    const d = new DynamicGameStateManager();
    const scopes = new Map<string, "scene" | "region" | "character" | "global">(
      [
        ["fire", "scene"],
        ["weather", "region"],
      ]
    );
    const applier = new Applier(d, scopes);
    applier.flush(
      [
        {
          kind: "feature.setState",
          featureId: "fire",
          key: "s1",
          state: { intensity: 3 },
        },
        {
          kind: "feature.setState",
          featureId: "weather",
          key: "r1",
          state: { kind: "storm" },
        },
      ],
      "1923-10-17T08:00:00"
    );
    expect(d.getScopedFeatureState("fire", "scene", "s1")).toEqual({
      intensity: 3,
    });
    expect(d.getScopedFeatureState("weather", "region", "r1")).toEqual({
      kind: "storm",
    });
  });

  it("feature.setState / removeState on same key honor emission order", () => {
    const d = new DynamicGameStateManager();
    const scopes = new Map<string, "scene" | "region" | "character" | "global">(
      [["fire", "scene"]]
    );
    const applier = new Applier(d, scopes);
    applier.flush(
      [
        { kind: "feature.removeState", featureId: "fire", key: "s1" },
        {
          kind: "feature.setState",
          featureId: "fire",
          key: "s1",
          state: { intensity: 4 },
        },
      ],
      "1923-10-17T08:00:00"
    );
    expect(d.getScopedFeatureState("fire", "scene", "s1")).toEqual({
      intensity: 4,
    });

    applier.flush(
      [
        {
          kind: "feature.setState",
          featureId: "fire",
          key: "s1",
          state: { intensity: 9 },
        },
        { kind: "feature.removeState", featureId: "fire", key: "s1" },
      ],
      "1923-10-17T08:01:00"
    );
    expect(d.getScopedFeatureState("fire", "scene", "s1")).toBeUndefined();
  });

  it("scene.removeCondition + scene.addCondition respect emission order (replace-wholesale pattern)", () => {
    const d = new DynamicGameStateManager();
    d.ensureScene("s1");
    d.appendSceneCondition("s1", {
      featureId: "fire",
      description: "smoldering",
      data: { intensity: 1 },
    });
    const applier = new Applier(d, new Map());
    applier.flush(
      [
        {
          kind: "scene.removeCondition",
          sceneId: "s1",
          predicate: { featureId: "fire" },
        },
        {
          kind: "scene.addCondition",
          sceneId: "s1",
          condition: {
            featureId: "fire",
            description: "roaring",
            data: { intensity: 4 },
          },
        },
      ],
      "1923-10-17T08:00:00"
    );
    const conds = d.getSceneConditions("s1");
    expect(conds).toHaveLength(1);
    expect(conds[0].description).toBe("roaring");
  });
});
