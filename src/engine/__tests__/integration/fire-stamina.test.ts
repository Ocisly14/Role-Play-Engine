import { describe, expect, it } from "vitest";
import type { StaminaCharacterState } from "../../features/staminaFeature.js";
import {
  injectFire,
  makeIntegrationEngine,
  seedNpc,
  seedScene,
} from "./makeIntegrationEngine.js";

/**
 * Layer-2 chain: fire → env.temperature → stamina accel.
 *
 * Verifies that:
 *   - fireFeature.onTick contributes intensity*100 °C to env.temperature
 *   - the Applier writes that contribution into the EnvironmentReading
 *   - staminaFeature.onTick reads env.temperature on the *next* tick and
 *     applies the +1x or +2x multiplier (extreme thermal range)
 *
 * Per-feature tests cover each link in isolation. This test exercises them
 * end-to-end through TickOrchestrator → FeatureRunner → Applier.
 */
describe("integration: fire → stamina chain", () => {
  it("fire at intensity 3 lifts env.temperature past stamina's extreme threshold", async () => {
    const setup = makeIntegrationEngine();
    seedScene(setup.dgsm, "warehouse", { parentLocationId: "town" });
    seedNpc(setup.dgsm, "miner", "warehouse");
    injectFire(setup.dgsm, "warehouse", 3);

    // Tick 1: fire onTick contributes 300 °C; Applier flushes env.
    // Tick 2: stamina onTick reads env.temperature, applies accel.
    // Tick 3..N: continued accel accumulation. We tick 6 to give stamina
    // ~5 minutes of accelerated ticks (1 unaccelerated tick of lag + 5 hot).
    await setup.tickN(6);

    const env = setup.dgsm.getEnvironmentReading("warehouse");
    // baseline 20 + intensity*100 = 320 (fire stays at intensity 3 for the
    // first 10 minutes — well within the 6-tick window).
    expect(env.temperature).toBe(20 + 3 * 100);

    const stamina = setup.dgsm.getScopedFeatureState<StaminaCharacterState>(
      "stamina",
      "character",
      "miner"
    );
    expect(stamina).toBeDefined();
    // 6 ticks total. Tick 1 stamina sees default 20°C (no accel; +1 minute).
    // Ticks 2..6 stamina sees 320°C → +1x base + 1x hostile + 1x extreme = 3x
    // → +3 per tick * 5 ticks = +15. Total fatigue ≥ 1 + 15 = 16. We assert
    // ≥ 10 to be lenient around any future tweak to phase 5/9 ordering.
    expect(stamina!.fatigue).toBeGreaterThanOrEqual(10);
  });

  it("baseline (no fire) accumulates fatigue at 1x — sanity check", async () => {
    const setup = makeIntegrationEngine();
    seedScene(setup.dgsm, "warehouse", { parentLocationId: "town" });
    seedNpc(setup.dgsm, "miner", "warehouse");

    await setup.tickN(6);

    const stamina = setup.dgsm.getScopedFeatureState<StaminaCharacterState>(
      "stamina",
      "character",
      "miner"
    );
    expect(stamina).toBeDefined();
    // No env contributions → default 20 °C → 1x accel → exactly elapsed minutes.
    expect(stamina!.fatigue).toBe(6);
  });

  it("fire-accelerated fatigue strictly exceeds the no-fire baseline", async () => {
    const noFire = makeIntegrationEngine();
    seedScene(noFire.dgsm, "warehouse", { parentLocationId: "town" });
    seedNpc(noFire.dgsm, "miner", "warehouse");

    const withFire = makeIntegrationEngine();
    seedScene(withFire.dgsm, "warehouse", { parentLocationId: "town" });
    seedNpc(withFire.dgsm, "miner", "warehouse");
    injectFire(withFire.dgsm, "warehouse", 3);

    await Promise.all([noFire.tickN(8), withFire.tickN(8)]);

    const baseline = noFire.dgsm.getScopedFeatureState<StaminaCharacterState>(
      "stamina",
      "character",
      "miner"
    );
    const accelerated =
      withFire.dgsm.getScopedFeatureState<StaminaCharacterState>(
        "stamina",
        "character",
        "miner"
      );
    expect(accelerated!.fatigue).toBeGreaterThan(baseline!.fatigue);
  });
});
