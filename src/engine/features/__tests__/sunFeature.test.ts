import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { makeDGSMFeatureReadContext } from "../../core/featureReadContext.js";
import type { StateChange } from "../../core/types.js";
import { computeSunLevel, sunFeature } from "../sunFeature.js";

function makeSunCtx(dgsm: DynamicGameStateManager) {
  return makeDGSMFeatureReadContext(dgsm, {
    callerFeatureId: "sun",
    callerScope: "global",
  });
}

function seedOutdoorAndIndoorScenes(dgsm: DynamicGameStateManager): void {
  dgsm.updateScene("street", {
    id: "street",
    name: "Street",
    description: "",
    parentLocationId: "town",
    items: [],
    conditions: [],
    connections: [],
  });
  dgsm.updateScene("tavern", {
    id: "tavern",
    name: "Tavern",
    description: "",
    parentLocationId: "town",
    items: [],
    conditions: [],
    connections: [],
    indoor: true,
  });
}

function illumContributions(
  changes: StateChange[],
  locationId: string
): number[] {
  return changes
    .filter(
      (c): c is Extract<StateChange, { kind: "environment.contribute" }> =>
        c.kind === "environment.contribute" &&
        c.quantity === "illumination" &&
        c.locationId === locationId &&
        c.sourceFeatureId === "sun"
    )
    .map((c) => c.value);
}

function setTickTime(dgsm: DynamicGameStateManager, time: string): void {
  dgsm.setTickTime(time);
}

describe("sunFeature internal invariants", () => {
  it("sun curve matches expected values at known times", () => {
    expect(computeSunLevel("12:00")).toBe(5);
    expect(computeSunLevel("04:00")).toBe(1);
    expect(computeSunLevel("06:00")).toBe(3);
    expect(computeSunLevel("22:00")).toBe(1);
  });

  it("contributes peak illumination (5) at noon to outdoor scenes; nothing to indoor", () => {
    const dgsm = new DynamicGameStateManager();
    seedOutdoorAndIndoorScenes(dgsm);
    setTickTime(dgsm, "12:00");
    const ctx = makeSunCtx(dgsm);
    const changes = sunFeature.onTick?.(ctx) ?? [];

    const streetIllums = illumContributions(changes, "street");
    expect(streetIllums).toContain(5);
    // No moonlight at noon.
    expect(streetIllums).not.toContain(2);

    const tavernIllums = illumContributions(changes, "tavern");
    expect(tavernIllums).toHaveLength(0);
  });

  it("at night emits sun=1 + moonlight=2 for outdoor; still nothing for indoor without items", () => {
    const dgsm = new DynamicGameStateManager();
    seedOutdoorAndIndoorScenes(dgsm);
    setTickTime(dgsm, "02:00");
    const ctx = makeSunCtx(dgsm);
    const changes = sunFeature.onTick?.(ctx) ?? [];

    const streetIllums = illumContributions(changes, "street");
    expect(streetIllums.sort()).toEqual([1, 2]);

    const tavernIllums = illumContributions(changes, "tavern");
    expect(tavernIllums).toHaveLength(0);
  });

  it("indoor scene with a lit, undamaged light-source item emits an item contribution", () => {
    const dgsm = new DynamicGameStateManager();
    seedOutdoorAndIndoorScenes(dgsm);
    dgsm.updateScene("tavern", {
      id: "tavern",
      name: "Tavern",
      description: "",
      parentLocationId: "town",
      items: [
        {
          id: "lamp-1",
          name: "Oil Lamp",
          isLightSource: true,
          lightLevel: 4,
        },
        {
          id: "broken-lamp",
          name: "Broken Lamp",
          isLightSource: true,
          lightLevel: 4,
          damaged: true,
        },
      ],
      conditions: [],
      connections: [],
      indoor: true,
    });
    setTickTime(dgsm, "12:00");
    const ctx = makeSunCtx(dgsm);
    const changes = sunFeature.onTick?.(ctx) ?? [];

    const tavernIllums = illumContributions(changes, "tavern");
    // Exactly one item contribution (the undamaged lamp at level 4);
    // the damaged lamp must be skipped and no sun contribution for indoor.
    expect(tavernIllums).toEqual([4]);
  });
});
