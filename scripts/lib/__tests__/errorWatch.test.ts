import { describe, expect, it, vi } from "vitest";
import { ErrorWatch } from "../errorWatch.js";
const missing = (id: string) =>
  `resolution — triggering action "action_${id}" was not answered — it starts this tick and needs a "starting" entry`;
const failed = (tick: number) =>
  `[WorldActionEngine] tick_${tick}_2038-12-06T19:09:00: phase starts still invalid after 3 attempts, nothing applied`;

describe("ErrorWatch per-tick accounting", () => {
  it("counts four affected actions once toward recurrence and stops only after three ticks", () => {
    const watch = new ErrorWatch(3);
    watch.beginTick();
    for (const id of ["a", "b", "c", "d"]) watch.record("warn", missing(id));
    expect(watch.endTick().stopReason).toBeNull();
    expect(watch.top()[0]).toMatchObject({ count: 4, tickCount: 1 });
    watch.beginTick();
    watch.record("warn", missing("e"));
    expect(watch.endTick().stopReason).toBeNull();
    watch.beginTick();
    watch.record("warn", missing("f"));
    expect(watch.endTick().stopReason).toContain("3 ticks (6 log rows)");
  });

  it("counts engine rejection as a failed tick and does not double count runner exceptions", () => {
    const watch = new ErrorWatch(10);
    watch.beginTick();
    watch.record("warn", failed(1));
    watch.record("error", "[SimulationRunner] Error during tick");
    expect(watch.endTick().stopReason).toBeNull();
    watch.beginTick();
    watch.record("warn", failed(2));
    expect(watch.endTick().stopReason).toBe(
      "two ticks in a row failed to resolve"
    );
  });

  it("resets consecutive failures after a successful tick and records phase recovery separately", () => {
    const watch = new ErrorWatch(10);
    watch.beginTick();
    watch.record("warn", failed(1));
    watch.endTick();
    watch.beginTick();
    watch.record(
      "log",
      "[WorldActionEngine] tick tick_2 phase occurrences accepted after 3 attempt(s), 8/12 calls"
    );
    expect(watch.endTick()).toMatchObject({
      stopReason: null,
      diagnostics: {
        failed: false,
        phaseAttempts: [{ phase: "occurrences", attempts: 3, accepted: true }],
        correctionAttempts: 2,
      },
    });
    watch.beginTick();
    watch.record("warn", failed(3));
    expect(watch.endTick().stopReason).toBeNull();
  });

  it("does not confuse a recovered phase with a successful whole tick", () => {
    const watch = new ErrorWatch(3);
    watch.beginTick();
    watch.record(
      "log",
      "[WorldActionEngine] tick tick_1 phase starts accepted after 2 attempt(s), 3/12 calls"
    );
    watch.record("warn", failed(1));
    expect(watch.endTick().diagnostics).toMatchObject({
      failed: true,
      phaseAttempts: [
        { phase: "starts", attempts: 2, accepted: true },
        { phase: "starts", attempts: 3, accepted: false },
      ],
      correctionAttempts: 3,
    });
  });

  it("ignores out-of-tick logs, restores console identity, and starts a resumed invocation fresh", () => {
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = console.warn;
    const watch = new ErrorWatch(3);
    try {
      watch.install();
      console.warn(missing("outside"));
      watch.beginTick();
      console.warn(missing("inside"));
      watch.endTick();
      expect(watch.top()[0]).toMatchObject({ count: 1, tickCount: 1 });
      watch.uninstall();
      expect(console.warn).toBe(original);
      expect(new ErrorWatch(3).top()).toEqual([]);
    } finally {
      watch.uninstall();
      quiet.mockRestore();
    }
  });
});

describe("diagnostic edge cases", () => {
  it("reports actual tick numbers after resume", () => {
    const watch = new ErrorWatch(3);
    watch.beginTick(51);
    watch.record("warn", failed(51));
    watch.endTick();
    expect(watch.summary().failedTicks).toEqual([51]);
  });
  it("counts completed correction attempts before a provider error", () => {
    const watch = new ErrorWatch(3);
    watch.beginTick();
    watch.record(
      "warn",
      "[WorldActionEngine] tick_1: model error in phase starts after 2 submission attempt(s), nothing applied"
    );
    expect(watch.endTick().diagnostics).toMatchObject({
      failedPhase: "starts",
      correctionAttempts: 1,
      phaseAttempts: [{ phase: "starts", attempts: 2, accepted: false }],
    });
  });
  it("reports rewind submissions separately from local corrections", () => {
    const watch = new ErrorWatch(3);
    watch.beginTick();
    watch.record(
      "warn",
      "[WorldActionEngine] tick tick_1: assembled draft rejected by the global gate (1 error(s)); rewinding to phase sceneChanges, 6/12 calls spent"
    );
    watch.record(
      "log",
      "[WorldActionEngine] tick tick_1 phase sceneChanges accepted after 1 attempt(s), 7/12 calls"
    );
    watch.record(
      "log",
      "[WorldActionEngine] tick tick_1 phase occurrences accepted after 1 attempt(s), 8/12 calls"
    );
    expect(watch.endTick().diagnostics).toMatchObject({
      failed: false,
      globalRewinds: 1,
      rewindSubmissions: 2,
      correctionAttempts: 0,
    });
  });
});
