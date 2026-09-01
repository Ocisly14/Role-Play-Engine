import { describe, expect, it } from "vitest";
import { groupByLocation, runWithConcurrency } from "../npcActionController.js";

describe("groupByLocation", () => {
  it("groups ids sharing a location, preserving order", () => {
    const locations: Record<string, string | null> = {
      a: "SCN_1",
      b: "SCN_2",
      c: "SCN_1",
      d: "SCN_2",
    };
    expect(
      groupByLocation(["a", "b", "c", "d"], (id) => locations[id])
    ).toEqual([
      ["a", "c"],
      ["b", "d"],
    ]);
  });

  it("gives unresolvable (empty) locations solo groups and drops null ids", () => {
    const locations: Record<string, string | null> = {
      a: "",
      b: "",
      dead: null,
      c: "SCN_1",
    };
    expect(
      groupByLocation(["a", "b", "dead", "c"], (id) => locations[id])
    ).toEqual([["a"], ["b"], ["c"]]);
  });
});

describe("runWithConcurrency", () => {
  it("processes every item while never exceeding the limit", async () => {
    const seen: number[] = [];
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(n);
      inFlight--;
    });
    expect(seen.sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("keeps items within one lane sequential", async () => {
    const order: string[] = [];
    await runWithConcurrency([["a", "b"], ["c"]], 2, async (group) => {
      for (const id of group) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        order.push(id);
      }
    });
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order).toHaveLength(3);
  });

  it("propagates worker rejections", async () => {
    await expect(
      runWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });
});
