import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { Item } from "../../../state/types.js";
import { makeDGSMFeatureReadContext } from "../../core/featureReadContext.js";
import { itemDamageFeature } from "../itemDamageFeature.js";

function makeItems(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `item-${i}`,
    name: `Item ${i}`,
  }));
}

function makeCtx(dgsm: DynamicGameStateManager) {
  return makeDGSMFeatureReadContext(dgsm, {
    callerFeatureId: "itemDamage",
    callerScope: "global",
  });
}

describe("itemDamageFeature", () => {
  beforeEach(() => {
    // Make sample selection deterministic — sort comparator returns 0 for
    // every pair so the original order is preserved.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not emit damage when temperature <= 200°C", () => {
    const dgsm = new DynamicGameStateManager();
    dgsm.updateScene("warehouse", {
      id: "warehouse",
      name: "Warehouse",
      description: "",
      parentLocationId: "town",
      items: makeItems(10),
      conditions: [],
      connections: [],
    });
    dgsm.setEnvironmentReading("warehouse", {
      temperature: 100,
      illumination: 3,
      oxygen: 1,
      noise: 0,
      airborneHazards: [],
    });

    const ctx = makeCtx(dgsm);
    const changes = itemDamageFeature.onTick!(ctx);
    expect(changes).toHaveLength(0);
  });

  it("emits damageItem for ~20% of undamaged items at temperature > 200°C", () => {
    const dgsm = new DynamicGameStateManager();
    dgsm.updateScene("warehouse", {
      id: "warehouse",
      name: "Warehouse",
      description: "",
      parentLocationId: "town",
      items: makeItems(10),
      conditions: [],
      connections: [],
    });
    dgsm.setEnvironmentReading("warehouse", {
      temperature: 300,
      illumination: 5,
      oxygen: 0.7,
      noise: 0,
      airborneHazards: ["smoke"],
    });

    const ctx = makeCtx(dgsm);
    const changes = itemDamageFeature.onTick!(ctx);
    // 10 * 0.2 = 2
    expect(changes).toHaveLength(2);
    for (const c of changes) {
      expect(c.kind).toBe("scene.damageItem");
      const dc = c as Extract<typeof c, { kind: "scene.damageItem" }>;
      expect(dc.damagedBy).toBe("fire");
      expect(dc.sourceFeatureId).toBe("itemDamage");
      expect(dc.sceneId).toBe("warehouse");
    }
  });

  it("skips already-damaged items in the sample pool", () => {
    const items = makeItems(10);
    items.slice(0, 5).forEach((it) => {
      it.damaged = true;
    });
    const dgsm = new DynamicGameStateManager();
    dgsm.updateScene("warehouse", {
      id: "warehouse",
      name: "Warehouse",
      description: "",
      parentLocationId: "town",
      items,
      conditions: [],
      connections: [],
    });
    dgsm.setEnvironmentReading("warehouse", {
      temperature: 300,
      illumination: 5,
      oxygen: 0.7,
      noise: 0,
      airborneHazards: [],
    });

    const ctx = makeCtx(dgsm);
    const changes = itemDamageFeature.onTick!(ctx);
    // 5 undamaged * 0.2 = 1
    expect(changes).toHaveLength(1);
    const dc = changes[0] as Extract<
      (typeof changes)[number],
      { kind: "scene.damageItem" }
    >;
    // Selected id must be one of the still-undamaged items (item-5..item-9).
    expect(["item-5", "item-6", "item-7", "item-8", "item-9"]).toContain(
      dc.itemId
    );
  });
});
