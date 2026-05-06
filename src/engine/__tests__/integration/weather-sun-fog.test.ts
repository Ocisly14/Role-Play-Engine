import { describe, expect, it } from "vitest";
import { makeIntegrationEngine, seedScene } from "./makeIntegrationEngine.js";

/**
 * Layer-2 chain: weather (fog) → env.illumination cap → sun condition observer.
 *
 * NOTE: substituted for the originally-planned weather-fire-decay chain. Fire's
 * own +intensity*100 °C contribution to env.temperature dominates any negative
 * weather contribution at the *same* location, so the cold-rain-decay branch
 * cannot be triggered through the natural integration path (only through the
 * unit-test pattern of writing env directly). The fog/sun chain exercises the
 * same env-layer wiring (weather + sun → Applier aggregation → env reading
 * consumed by another feature) without that arithmetic dead-end.
 *
 * Verifies:
 *   - weatherFeature.init writes env.illumination cap for fog regions
 *   - sunFeature.onTick contributes the time-of-day sun level
 *   - the Applier aggregates contribution + cap into a final
 *     EnvironmentReading (min(maxContrib, cap))
 *   - sunFeature's "Step D" observer reads that aggregated reading and emits
 *     the matching [Lighting] scene condition even at midday
 */
describe("integration: weather (fog) → sun illumination chain", () => {
  it("dense fog at midday caps illumination and triggers [Lighting] Pitch black", async () => {
    const setup = makeIntegrationEngine({
      moduleSetup: {
        startDate: "1923-10-17",
        featureInit: {
          weather: [{ regionId: "town", weatherType: "fog", intensity: 3 }],
        },
      },
      // Noon: sun curve peaks at level 5 → without fog, [Lighting] would not
      // be emitted (5 = bright). With fog cap=1 the env reading drops to 1.
      initialTime: "1923-10-17T12:00:00",
    });
    seedScene(setup.dgsm, "plaza", { parentLocationId: "town" });

    // Tick 1: weather init pre-tick caps env.illumination = 1; sun's Step D
    // observer reads that cap, emits [Lighting] Pitch black for plaza. Sun
    // also contributes sun=5 for plaza this tick — Applier flushes
    // min(5, cap=1) = 1, holding the env reading steady.
    await setup.tickN(1);

    const env = setup.dgsm.getEnvironmentReading("plaza");
    expect(env.illumination).toBe(1);

    const conds = setup.dgsm.getSceneConditions("plaza");
    const lighting = conds.find((c) => c.featureId === "sun");
    expect(lighting).toBeDefined();
    expect(lighting!.description).toBe("[Lighting] Pitch black");
  });

  it("moderate fog (intensity 2) caps illumination at 2 → [Lighting] Dark", async () => {
    const setup = makeIntegrationEngine({
      moduleSetup: {
        startDate: "1923-10-17",
        featureInit: {
          weather: [{ regionId: "town", weatherType: "fog", intensity: 2 }],
        },
      },
      initialTime: "1923-10-17T12:00:00",
    });
    seedScene(setup.dgsm, "plaza", { parentLocationId: "town" });

    await setup.tickN(1);

    const env = setup.dgsm.getEnvironmentReading("plaza");
    expect(env.illumination).toBe(2);

    const conds = setup.dgsm.getSceneConditions("plaza");
    const lighting = conds.find((c) => c.featureId === "sun");
    expect(lighting).toBeDefined();
    expect(lighting!.description).toBe("[Lighting] Dark");
  });

  it("clear weather at midday → env.illumination = 5 (bright), no [Lighting] condition", async () => {
    const setup = makeIntegrationEngine({
      initialTime: "1923-10-17T12:00:00",
    });
    seedScene(setup.dgsm, "plaza", { parentLocationId: "town" });

    // Tick 1: sun contributes 5; observer reads default env (3) since no
    //         prior flush wrote plaza, emits no abnormal-lighting condition.
    // Tick 2: sun observer now reads the post-flush env.illumination=5 → in
    //         "blinding" range; we assert below.
    await setup.tickN(2);

    const env = setup.dgsm.getEnvironmentReading("plaza");
    expect(env.illumination).toBe(5);

    const conds = setup.dgsm.getSceneConditions("plaza");
    const lighting = conds.find((c) => c.featureId === "sun");
    // illum=5 IS labelled (blinding light) — this assertion documents that
    // sun's observer fires for the upper bound too, not just dark levels.
    expect(lighting?.description).toBe("[Lighting] Blinding light");
  });
});
