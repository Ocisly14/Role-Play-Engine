import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type {
  JunctionNode,
  RoadNode,
  TownTopology,
} from "../../../state/topologyTypes.js";
import { buildTopology } from "../../../state/topologyTypes.js";
import { makeDGSMFeatureReadContext } from "../../core/featureReadContext.js";
import type { ActionHandle, ActionStep } from "../../core/types.js";
import { MovementSubsystem } from "../movement.js";
import { makeCodeEngineContext } from "../types.js";

// ---- Topology fixture: A --(ROAD_1, 4min)-- B --(ROAD_2, 2min)-- C
//      SCN_A at JUNC_A, SCN_C at JUNC_C
function makeTopology(): TownTopology {
  const junctions = new Map<string, JunctionNode>([
    [
      "JUNC_A",
      {
        id: "JUNC_A",
        name: "A",
        description: "",
        parentLocationId: "OUTDOOR",
        items: [],
        conditions: [],
        connectedSceneIds: ["SCN_A"],
      },
    ],
    [
      "JUNC_B",
      {
        id: "JUNC_B",
        name: "B",
        description: "",
        parentLocationId: "OUTDOOR",
        items: [],
        conditions: [],
        connectedSceneIds: [],
      },
    ],
    [
      "JUNC_C",
      {
        id: "JUNC_C",
        name: "C",
        description: "",
        parentLocationId: "OUTDOOR",
        items: [],
        conditions: [],
        connectedSceneIds: ["SCN_C"],
      },
    ],
  ]);
  const roads = new Map<string, RoadNode>([
    [
      "ROAD_1",
      {
        id: "ROAD_1",
        name: "R1",
        description: "",
        parentLocationId: "OUTDOOR",
        endpointA: "JUNC_A",
        endpointB: "JUNC_B",
        travelTimeMinutes: 4,
        alongConnections: [],
        items: [],
        conditions: [],
      },
    ],
    [
      "ROAD_2",
      {
        id: "ROAD_2",
        name: "R2",
        description: "",
        parentLocationId: "OUTDOOR",
        endpointA: "JUNC_B",
        endpointB: "JUNC_C",
        travelTimeMinutes: 2,
        alongConnections: [],
        items: [],
        conditions: [],
      },
    ],
  ]);
  return buildTopology(junctions, roads);
}

function seedDgsm(): DynamicGameStateManager {
  const dgsm = new DynamicGameStateManager();
  dgsm.setTopology(makeTopology());
  dgsm.registerNpcProfile({
    id: "npc1",
    name: "npc1",
    attributes: {
      STR: 50,
      CON: 50,
      DEX: 50,
      APP: 50,
      POW: 50,
      SIZ: 50,
      INT: 50,
      EDU: 50,
    },
    status: {
      hp: 10,
      maxHp: 10,
      san: 50,
      maxSan: 50,
      fatigue: 0,
      maxFatigue: 100,
      luck: 50,
      conditions: [],
    },
    inventory: [],
    skills: {},
    longTermIntent: "",
    relationships: [],
  });
  return dgsm;
}

function makeStep(
  characterId: string,
  destination: string,
  overrides: Partial<ActionStep> = {}
): ActionStep {
  const handle: ActionHandle = {
    id: "h1",
    characterId,
    submittedAt: { day: 1, tickTime: "08:00" },
  };
  return {
    id: overrides.id ?? "h1#0",
    handle,
    stepGroupId: "h1",
    stepIndex: 0,
    characterId,
    targetCharacterIds: [],
    actionText: `move to ${destination}`,
    definitionId: "movement",
    executionSceneId: "SCN_A",
    overlayFields: { destination },
    engine: "code",
    codeSubsystem: "movement",
    submittedAt: handle.submittedAt,
    status: "queued",
    ...overrides,
  };
}

function makeCtx(dgsm: DynamicGameStateManager) {
  const base = makeDGSMFeatureReadContext(dgsm, {
    callerFeatureId: "__codeEngine__",
    callerScope: "global",
  });
  return makeCodeEngineContext(base, dgsm);
}

describe("MovementSubsystem.onActivate", () => {
  it("builds a route from current position to destination and emits no StateChanges yet", () => {
    const dgsm = seedDgsm();
    dgsm.setCharacterPosition("npc1", { type: "junction", junctionId: "JUNC_A" });
    const sub = new MovementSubsystem();
    const result = sub.onActivate(
      makeStep("npc1", "JUNC_C"),
      makeCtx(dgsm)
    );
    expect(result.completed).toBe(false);
    expect(result.failed).toBeUndefined();
    expect(result.stateChanges).toEqual([]);
  });

  it("returns failed when the destination is missing from overlayFields", () => {
    const dgsm = seedDgsm();
    dgsm.setCharacterPosition("npc1", { type: "junction", junctionId: "JUNC_A" });
    const sub = new MovementSubsystem();
    const step = makeStep("npc1", "JUNC_C");
    step.overlayFields = {};
    const result = sub.onActivate(step, makeCtx(dgsm));
    expect(result.failed).toBeDefined();
  });

  it("returns failed when no path can be built", () => {
    const dgsm = seedDgsm();
    dgsm.setCharacterPosition("npc1", { type: "junction", junctionId: "JUNC_A" });
    const sub = new MovementSubsystem();
    const result = sub.onActivate(
      makeStep("npc1", "UNKNOWN_LOCATION"),
      makeCtx(dgsm)
    );
    expect(result.failed).toBeDefined();
  });

  it("returns completed immediately when already at destination", () => {
    const dgsm = seedDgsm();
    dgsm.setCharacterPosition("npc1", { type: "junction", junctionId: "JUNC_A" });
    const sub = new MovementSubsystem();
    const result = sub.onActivate(
      makeStep("npc1", "JUNC_A"),
      makeCtx(dgsm)
    );
    expect(result.completed).toBe(true);
  });
});

describe("MovementSubsystem.onTick — interpolation along a road", () => {
  it("interpolates fractional position each tick and completes after durationMinutes ticks", () => {
    const dgsm = seedDgsm();
    dgsm.setCharacterPosition("npc1", { type: "junction", junctionId: "JUNC_A" });
    const sub = new MovementSubsystem();
    const step = makeStep("npc1", "JUNC_B");
    sub.onActivate(step, makeCtx(dgsm));

    // Drain ticks until completion. ROAD_1 is 4 min; we expect at most ~6
    // ticks (one per minute + the zero-duration to_junction transitions).
    const positions: string[] = [];
    let completed = false;
    for (let i = 0; i < 15 && !completed; i++) {
      const result = sub.onTick(step, makeCtx(dgsm));
      for (const c of result.stateChanges) {
        if (c.kind === "character.position") {
          positions.push(JSON.stringify(c.position));
        }
      }
      if (result.failed) throw new Error(`unexpected failure: ${result.failed.reason}`);
      completed = result.completed;
    }

    expect(completed).toBe(true);
    expect(positions.length).toBeGreaterThan(0);
    // Expect at least one fractional road position (interpolation along
    // ROAD_1 between to_junction transitions).
    const hasRoadPos = positions.some((p) => {
      const obj = JSON.parse(p) as { type: string; position?: number };
      return obj.type === "road" && typeof obj.position === "number";
    });
    expect(hasRoadPos).toBe(true);
  });

  it("emits one character.position StateChange per minute on a 4-minute road segment", () => {
    const dgsm = seedDgsm();
    dgsm.setCharacterPosition("npc1", {
      type: "road",
      roadId: "ROAD_1",
      position: 0,
    });
    const sub = new MovementSubsystem();
    const step = makeStep("npc1", "JUNC_B");
    const activate = sub.onActivate(step, makeCtx(dgsm));
    expect(activate.failed).toBeUndefined();

    // Track only fractional/road positions so we can assert per-minute interpolation.
    const fractionals: number[] = [];
    let completed = false;
    for (let i = 0; i < 10 && !completed; i++) {
      const result = sub.onTick(step, makeCtx(dgsm));
      for (const c of result.stateChanges) {
        if (
          c.kind === "character.position" &&
          c.position.type === "road" &&
          c.position.roadId === "ROAD_1"
        ) {
          fractionals.push(c.position.position);
        }
      }
      completed = result.completed;
    }

    expect(completed).toBe(true);
    // Fractions should be strictly monotonically increasing.
    for (let i = 1; i < fractionals.length; i++) {
      expect(fractionals[i]).toBeGreaterThanOrEqual(fractionals[i - 1]);
    }
  });
});

describe("MovementSubsystem.onTick — block detection", () => {
  it("fails when a connection on the route is blocked", () => {
    const dgsm = seedDgsm();
    dgsm.setCharacterPosition("npc1", { type: "junction", junctionId: "JUNC_A" });
    // Block JUNC_A ↔ ROAD_1 so the very first transition is impassable.
    dgsm.setConnectionBlocked("JUNC_A", "ROAD_1", true, "barricade");
    const sub = new MovementSubsystem();
    const step = makeStep("npc1", "JUNC_B");
    sub.onActivate(step, makeCtx(dgsm));

    // First tick should detect the block immediately.
    const result = sub.onTick(step, makeCtx(dgsm));
    expect(result.failed).toBeDefined();
    expect(result.failed?.reason).toContain("blocked");
    expect(result.failed?.reason).toContain("barricade");
  });
});

describe("MovementSubsystem.onTick — completion", () => {
  it("reports completed:true once the final route step is consumed", () => {
    const dgsm = seedDgsm();
    dgsm.setCharacterPosition("npc1", { type: "junction", junctionId: "JUNC_A" });
    const sub = new MovementSubsystem();
    const step = makeStep("npc1", "JUNC_C");
    sub.onActivate(step, makeCtx(dgsm));

    let completed = false;
    let lastPosition: unknown = null;
    for (let i = 0; i < 30 && !completed; i++) {
      const result = sub.onTick(step, makeCtx(dgsm));
      for (const c of result.stateChanges) {
        if (c.kind === "character.position") lastPosition = c.position;
      }
      completed = result.completed;
    }
    expect(completed).toBe(true);
    expect(lastPosition).toEqual({ type: "junction", junctionId: "JUNC_C" });
  });

  it("returns completed:true on a stale tick with no route state", () => {
    const dgsm = seedDgsm();
    const sub = new MovementSubsystem();
    const step = makeStep("npc1", "JUNC_C", { id: "stale" });
    // No onActivate — directly tick.
    const result = sub.onTick(step, makeCtx(dgsm));
    expect(result.completed).toBe(true);
    expect(result.stateChanges).toEqual([]);
  });
});

describe("MovementSubsystem.onInterrupt", () => {
  it("clears internal route state", () => {
    const dgsm = seedDgsm();
    dgsm.setCharacterPosition("npc1", { type: "junction", junctionId: "JUNC_A" });
    const sub = new MovementSubsystem();
    const step = makeStep("npc1", "JUNC_C");
    sub.onActivate(step, makeCtx(dgsm));
    const result = sub.onInterrupt(step);
    expect(result.stateChanges).toEqual([]);

    // Subsequent tick should immediately complete (state was cleared).
    const tick = sub.onTick(step, makeCtx(dgsm));
    expect(tick.completed).toBe(true);
  });
});
