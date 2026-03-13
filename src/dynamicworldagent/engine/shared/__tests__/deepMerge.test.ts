import { describe, expect, it } from "vitest";
import { deepMergeItem } from "../deepMerge.js";

// Tests use Record<string, unknown> to exercise the runtime deep-merge behavior
// without fighting TypeScript's shallow Partial<T> constraint on nested objects.

describe("deepMergeItem", () => {
  it("overwrites flat fields", () => {
    const target: Record<string, unknown> = {
      id: "x",
      name: "Torch",
      description: "A lit torch",
    };
    const result = deepMergeItem(target, { description: "A burnt-out torch" });
    expect(result.description).toBe("A burnt-out torch");
    expect(result.name).toBe("Torch");
  });

  it("deep-merges nested objects", () => {
    const target: Record<string, unknown> = {
      id: "x",
      name: "Safe",
      containerStats: {
        capacity: 10,
        locked: true,
        lockDifficulty: "hard",
        contents: [],
      },
    };
    deepMergeItem(target, { containerStats: { locked: false } });
    const cs = target.containerStats as Record<string, unknown>;
    expect(cs.locked).toBe(false);
    expect(cs.capacity).toBe(10);
    expect(cs.lockDifficulty).toBe("hard");
  });

  it("replaces arrays (does not merge them)", () => {
    const target: Record<string, unknown> = {
      id: "x",
      name: "Box",
      containerStats: { capacity: 5, locked: false, contents: ["item_a"] },
    };
    deepMergeItem(target, { containerStats: { contents: ["item_b"] } });
    const cs = target.containerStats as Record<string, unknown>;
    expect(cs.contents).toEqual(["item_b"]);
  });

  it("adds new fields without removing existing ones", () => {
    const target: Record<string, unknown> = { id: "x", name: "Key" };
    deepMergeItem(target, {
      damaged: true,
      damageDetails: {
        damagedBy: "fire",
        damagedAt: "12:00",
        reason: "burned",
      },
    });
    expect(target.damaged).toBe(true);
    const dd = target.damageDetails as Record<string, unknown>;
    expect(dd.damagedBy).toBe("fire");
    expect(target.name).toBe("Key");
  });

  it("returns mutated target (in-place merge)", () => {
    const target: Record<string, unknown> = { id: "x", name: "Pen" };
    const result = deepMergeItem(target, { description: "A red pen" });
    expect(result).toBe(target);
  });

  it("skips undefined values in updates", () => {
    const target: Record<string, unknown> = {
      id: "x",
      name: "Torch",
      description: "A lit torch",
    };
    deepMergeItem(target, { description: undefined });
    expect(target.description).toBe("A lit torch");
  });
});
