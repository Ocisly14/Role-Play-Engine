import { describe, it, expect } from "vitest";
import { formatItemSummary, formatItemList, formatSceneItems } from "../itemFormatHelpers.js";
import type { Item, DynamicScene } from "../../../world_builder/types.js";

describe("formatItemSummary", () => {
  it("formats a basic item with id, name, type", () => {
    const item: Item = { id: "torch", name: "Torch", type: "lighting" };
    const result = formatItemSummary(item);
    expect(result).toContain("torch");
    expect(result).toContain("Torch");
    expect(result).toContain("lighting");
  });

  it("includes consumableStats.uses when present", () => {
    const item: Item = {
      id: "medkit", name: "First Aid Kit", type: "consumable",
      consumableStats: { uses: 3, effect: "heals minor wounds" },
    };
    const result = formatItemSummary(item);
    expect(result).toContain("uses: 3");
  });

  it("includes locked status for containers", () => {
    const item: Item = {
      id: "safe", name: "Safe", type: "container",
      containerStats: { locked: true, lockDifficulty: "hard" },
    };
    const result = formatItemSummary(item);
    expect(result).toContain("locked");
  });

  it("includes isLightSource status for lighting", () => {
    const item: Item = {
      id: "lantern", name: "Lantern", type: "lighting",
      isLightSource: true, lightLevel: 3,
    };
    const result = formatItemSummary(item);
    expect(result).toContain("lit");
  });

  it("includes damaged status when damaged", () => {
    const item: Item = { id: "gun", name: "Revolver", type: "weapon", damaged: true };
    const result = formatItemSummary(item);
    expect(result).toContain("damaged");
  });

  it("includes ammo for weapons with weaponStats", () => {
    const item: Item = {
      id: "gun", name: "Revolver", type: "weapon",
      weaponStats: { skill: "Firearms", damage: "1d10", range: "30m", attacksPerRound: 1, ammo: 6 },
    };
    const result = formatItemSummary(item);
    expect(result).toContain("ammo: 6");
  });
});

describe("formatItemList", () => {
  it("returns empty string for empty array", () => {
    expect(formatItemList([])).toBe("");
  });

  it("formats multiple items as bulleted list", () => {
    const items: Item[] = [
      { id: "key", name: "Room Key", type: "key" },
      { id: "torch", name: "Torch", type: "lighting" },
    ];
    const result = formatItemList(items);
    expect(result).toContain("- ");
    expect(result.split("\n").length).toBe(2);
  });
});

describe("formatSceneItems", () => {
  it("returns empty string for null scene", () => {
    expect(formatSceneItems(null)).toBe("");
  });

  it("returns 'No items.' for scene with empty items", () => {
    const scene = { items: [] } as unknown as DynamicScene;
    expect(formatSceneItems(scene)).toBe("No items in this scene.");
  });

  it("formats scene items with full details", () => {
    const scene = {
      items: [
        { id: "safe", name: "Safe", type: "container", containerStats: { locked: true } },
      ],
    } as unknown as DynamicScene;
    const result = formatSceneItems(scene);
    expect(result).toContain("safe");
    expect(result).toContain("Safe");
    expect(result).toContain("locked");
  });
});
