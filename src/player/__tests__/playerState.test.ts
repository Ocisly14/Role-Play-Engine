import { describe, expect, it } from "vitest";
import {
  createPlayerState,
  dropRunning,
  isPlayerState,
  markDone,
  markRunning,
  nextPendingStep,
  type PlayerState,
  runningStep,
  setQueue,
  switchMode,
} from "../playerState.js";
import { emptyVisited } from "../visitedMap.js";

describe("playerState", () => {
  it("creates a manual, empty state", () => {
    const s = createPlayerState("p1");
    expect(s.characterId).toBe("p1");
    expect(s.mode).toBe("manual");
    expect(s.queue).toEqual([]);
    expect(s.pending).toBeNull();
    expect(s.forceWake).toBe(false);
    expect(s.visited).toEqual(emptyVisited());
  });

  it("setQueue makes pending steps and replaces non-done ones", () => {
    const s0 = setQueue(createPlayerState("p1"), ["去图书馆", "查旧报纸"]);
    expect(s0.queue.map((q) => q.text)).toEqual(["去图书馆", "查旧报纸"]);
    expect(s0.queue.every((q) => q.status === "pending")).toBe(true);

    const s1 = markDone(markRunning(s0, s0.queue[0].id, "a1"), "a1");
    const s2 = setQueue(s1, ["回家"]);
    expect(s2.queue.map((q) => [q.text, q.status])).toEqual([
      ["去图书馆", "done"],
      ["回家", "pending"],
    ]);
  });

  it("tracks running and done steps", () => {
    const s0 = setQueue(createPlayerState("p1"), ["a", "b"]);
    const s1 = markRunning(s0, s0.queue[0].id, "a1");
    expect(runningStep(s1)?.actionId).toBe("a1");
    expect(nextPendingStep(s1)?.text).toBe("b");
    const s2 = markDone(s1, "a1");
    expect(s2.queue[0].status).toBe("done");
    expect(runningStep(s2)).toBeUndefined();
    expect(nextPendingStep(s2)?.text).toBe("b");
    expect(markDone(s2, "nope")).toBe(s2);
    expect(s0.queue[0].status).toBe("pending");
  });

  it("dropRunning removes the running step only", () => {
    const s0 = setQueue(createPlayerState("p1"), ["a", "b"]);
    const s1 = dropRunning(markRunning(s0, s0.queue[0].id, "a1"));
    expect(s1.queue.map((q) => q.text)).toEqual(["b"]);
  });

  it("switchMode clears non-done steps and wakes a consult on manual", () => {
    const s0 = setQueue(createPlayerState("p1"), ["a", "b"]);
    const s1 = switchMode(s0, "delegated");
    expect(s1.mode).toBe("delegated");
    expect(s1.queue).toEqual([]);

    const s2 = switchMode(
      { ...s1, pending: { kind: "consult", since: "t1", question: "q?" } },
      "manual"
    );
    expect(s2.mode).toBe("manual");
    expect(s2.pending).toEqual({ kind: "decision", reason: "woken", since: "t1" });
  });

  it("switchMode to delegated hands a waiting decision to the character", () => {
    const s0: PlayerState = {
      ...createPlayerState("p1"),
      pending: { kind: "decision", since: "t1", reason: "idle" },
    };
    const s1 = switchMode(s0, "delegated");
    expect(s1.mode).toBe("delegated");
    expect(s1.pending).toBeNull();
    expect(s1.forceWake).toBe(true);
  });

  it("switchMode leaves a death pending in either direction", () => {
    const dead: PlayerState = {
      ...createPlayerState("p1"),
      pending: { kind: "dead", since: "t1" },
    };
    const s1 = switchMode(dead, "delegated");
    expect(s1.pending).toEqual({ kind: "dead", since: "t1" });
    expect(s1.forceWake).toBe(false);
    const s2 = switchMode(s1, "manual");
    expect(s2.pending).toEqual({ kind: "dead", since: "t1" });
  });

  it("switchMode to the same mode is a no-op", () => {
    const s0 = setQueue(createPlayerState("p1"), ["a", "b"]);
    const s1 = switchMode(s0, "manual");
    expect(s1).toBe(s0);
    expect(s1.queue).toHaveLength(2);
  });

  it("isPlayerState guards the shape", () => {
    expect(isPlayerState(createPlayerState("p1"))).toBe(true);
    expect(isPlayerState({})).toBe(false);
    expect(isPlayerState(null)).toBe(false);
    const { visited: _v, ...noVisited } = createPlayerState("p1");
    expect(isPlayerState(noVisited)).toBe(false);
  });
});
