import { describe, expect, it } from "vitest";
import {
  createPlayerState,
  hydratePlayerState,
  isPlayerState,
  type PlayerState,
  switchMode,
} from "../playerState.js";
import { emptyVisited } from "../visitedMap.js";

describe("playerState", () => {
  it("creates a manual, empty state", () => {
    const s = createPlayerState("p1");
    expect(s.characterId).toBe("p1");
    expect(s.mode).toBe("manual");
    expect(s.pending).toBeNull();
    expect(s.forceWake).toBe(false);
    expect(s.visited).toEqual(emptyVisited());
  });

  it("switchMode wakes a consult on manual", () => {
    const s0 = createPlayerState("p1");
    const s1 = switchMode(s0, "delegated");
    expect(s1.mode).toBe("delegated");

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
    const s0 = createPlayerState("p1");
    const s1 = switchMode(s0, "manual");
    expect(s1).toBe(s0);
  });

  it("isPlayerState guards the shape", () => {
    expect(isPlayerState(createPlayerState("p1"))).toBe(true);
    expect(isPlayerState({})).toBe(false);
    expect(isPlayerState(null)).toBe(false);
    const { visited: _v, ...noVisited } = createPlayerState("p1");
    expect(isPlayerState(noVisited)).toBe(false);
  });

  it("isPlayerState accepts a legacy state with queue", () => {
    const {
      met: _met,
      boardLinks: _links,
      ...previous
    } = createPlayerState("p1");
    const legacy = {
      ...previous,
      queue: [{ id: "s0", text: "go home", status: "pending" }],
    };
    expect(isPlayerState(legacy)).toBe(true);
    const hydrated = hydratePlayerState(legacy);
    expect("queue" in hydrated).toBe(false);
    expect(hydrated).toEqual(createPlayerState("p1"));
  });
});
