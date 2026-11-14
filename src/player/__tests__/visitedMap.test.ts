import { describe, expect, it } from "vitest";
import type { CharacterPosition } from "../../state/topologyTypes.js";
import {
  emptyVisited,
  recordPosition,
  type VisitedMap,
  type VisitTopology,
} from "../visitedMap.js";

const roads: Record<string, { endpointA: string; endpointB: string }> = {
  R1: { endpointA: "A", endpointB: "B" },
  R2: { endpointA: "B", endpointB: "C" },
  R3: { endpointA: "A", endpointB: "C" },
};

const topo: VisitTopology = {
  road: (id) => roads[id] ?? null,
  roadsBetween: (a, b) =>
    Object.entries(roads)
      .filter(
        ([, r]) =>
          (r.endpointA === a && r.endpointB === b) ||
          (r.endpointA === b && r.endpointB === a)
      )
      .map(([id]) => id),
};

const scene = (sceneId: string): CharacterPosition => ({ type: "scene", sceneId });
const road = (roadId: string, position = 0.5): CharacterPosition => ({
  type: "road",
  roadId,
  position,
});

function run(steps: Array<[CharacterPosition | null, string]>): VisitedMap {
  return steps.reduce(
    (v, [p, t]) => recordPosition(v, p, topo, t),
    emptyVisited()
  );
}

describe("recordPosition", () => {
  it("records first arrival and does not overwrite it", () => {
    const v = run([
      [scene("A"), "t0"],
      [scene("A"), "t1"],
    ]);
    expect(v.scenes.A).toBe("t0");
    expect(v.lastSceneId).toBe("A");
  });

  it("records a road fully walked A -> R1 -> B", () => {
    const v = run([
      [scene("A"), "t0"],
      [road("R1"), "t1"],
      [scene("B"), "t2"],
    ]);
    expect(v.roads.R1).toBe("t2");
    expect(v.scenes.B).toBe("t2");
    expect(v.roadEntry).toBeUndefined();
  });

  it("does not record a road walked back to its start", () => {
    const v = run([
      [scene("A"), "t0"],
      [road("R1"), "t1"],
      [scene("A"), "t2"],
    ]);
    expect(v.roads.R1).toBeUndefined();
    expect(v.roadEntry).toBeUndefined();
  });

  it("handles crossing node B straight onto R2 in one tick", () => {
    const v = run([
      [scene("A"), "t0"],
      [road("R1"), "t1"],
      [road("R2"), "t2"],
    ]);
    expect(v.roads.R1).toBe("t2");
    expect(v.scenes.B).toBe("t2");
    expect(v.roadEntry).toEqual({ roadId: "R2", fromSceneId: "B" });
  });

  it("records a jump only when exactly one road connects the scenes", () => {
    const one = run([
      [scene("A"), "t0"],
      [scene("B"), "t1"],
    ]);
    expect(one.roads.R1).toBe("t1");

    const twoTopo: VisitTopology = {
      ...topo,
      roadsBetween: () => ["R1", "R3"],
    };
    let v = recordPosition(emptyVisited(), scene("A"), twoTopo, "t0");
    v = recordPosition(v, scene("B"), twoTopo, "t1");
    expect(v.roads).toEqual({});
  });

  it("does not record a road entered from a non-endpoint scene", () => {
    const v = run([
      [scene("I"), "t0"],
      [road("R1"), "t1"],
      [scene("B"), "t2"],
    ]);
    expect(v.scenes.B).toBe("t2");
    expect(v.roads.R1).toBeUndefined();
  });

  it("returns the same reference for a null position", () => {
    const v = emptyVisited();
    expect(recordPosition(v, null, topo, "t")).toBe(v);
  });
});
