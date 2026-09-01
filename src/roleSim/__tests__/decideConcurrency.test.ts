import { describe, expect, it, vi } from "vitest";
import { runWithConcurrency } from "../npcActionController.js";

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

  it("starts every item independently when the limit allows it", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = runWithConcurrency(["a", "b", "c"], 3, async (id) => {
      started.push(id);
      await gate;
    });

    await vi.waitFor(() => expect(started).toHaveLength(3));
    release();
    await pending;
  });

  it("waits for in-flight work to settle before propagating a rejection", async () => {
    let otherSettled = false;
    await expect(
      runWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        await new Promise((resolve) => setTimeout(resolve, 5));
        otherSettled = true;
      })
    ).rejects.toThrow("boom");
    expect(otherSettled).toBe(true);
  });
});
