import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  injectFire,
  makeIntegrationEngine,
  seedScene,
} from "./makeIntegrationEngine.js";

/**
 * Layer-2 chain: fire → env.temperature → itemDamage.
 *
 * Verifies that fire raising env.temperature past itemDamage's 200°C threshold
 * causes the next tick of itemDamage.onTick to mark a sample of undamaged
 * items in the same scene as damaged. Both features participate via the
 * shared env layer — itemDamage has no direct knowledge of fire.
 */
describe("integration: fire → itemDamage chain", () => {
  beforeEach(() => {
    // Stable shuffle in itemDamage's sample selection.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fire intensity 3 in a scene with 10 items damages ~2 per tick after the lag", async () => {
    const setup = makeIntegrationEngine();
    seedScene(setup.dgsm, "vault", {
      parentLocationId: "town",
      items: Array.from({ length: 10 }, (_, i) => ({
        id: `item-${i}`,
        name: `Item ${i}`,
      })),
    });
    injectFire(setup.dgsm, "vault", 3);

    // Tick 1: fire onTick contributes temp; itemDamage reads default (20°C),
    //         no damage. Applier flushes env to 320°C.
    // Tick 2: itemDamage reads env.temperature = 320, damages floor(10*0.2)=2.
    await setup.tickN(2);

    const scene = setup.dgsm.getScene("vault")!;
    const damaged = scene.items.filter((it) => it.damaged);
    expect(damaged).toHaveLength(2);
    for (const item of damaged) {
      expect(item.damageDetails?.damagedBy).toBe("fire");
      expect(item.damageDetails?.reason).toMatch(/heat/i);
    }
  });

  it("no fire → no items damaged even after several ticks", async () => {
    const setup = makeIntegrationEngine();
    seedScene(setup.dgsm, "vault", {
      parentLocationId: "town",
      items: Array.from({ length: 10 }, (_, i) => ({
        id: `item-${i}`,
        name: `Item ${i}`,
      })),
    });

    await setup.tickN(5);

    const scene = setup.dgsm.getScene("vault")!;
    expect(scene.items.every((it) => !it.damaged)).toBe(true);
  });

  it("fire below the 200°C threshold (intensity 1 → 100°C) does not damage items", async () => {
    const setup = makeIntegrationEngine();
    seedScene(setup.dgsm, "vault", {
      parentLocationId: "town",
      items: Array.from({ length: 10 }, (_, i) => ({
        id: `item-${i}`,
        name: `Item ${i}`,
      })),
    });
    injectFire(setup.dgsm, "vault", 1);

    await setup.tickN(3);

    const scene = setup.dgsm.getScene("vault")!;
    // Intensity 1 contributes +100 → final temp 120 → below 200 threshold.
    expect(setup.dgsm.getEnvironmentReading("vault").temperature).toBe(120);
    expect(scene.items.every((it) => !it.damaged)).toBe(true);
  });
});
