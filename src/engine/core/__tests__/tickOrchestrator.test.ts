// Phase 8 tick loop: action-driven gate (idle ticks → zero engine calls),
// new-command trigger, due-action re-trigger via nextWakeAt, replacement
// triggers, dead-actor rejection, lifecycle commit and persistence
// round-trips — all against a stubbed World Action Engine.

import { describe, expect, it, vi } from "vitest";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { buildTopology } from "../../../state/topologyTypes.js";
import type { RoadNode } from "../../../state/topologyTypes.js";
import type { DynamicScene } from "../../../state/types.js";
import type { ActionCommand } from "../../actions/types.js";
import type { EngineResolutionContext } from "../../resolution/types.js";
import type { RawTickResolution } from "../../resolution/worldDeltaSchema.js";
import { finalizeResolution } from "../../resolution/worldDeltaValidator.js";
import { SubsystemRegistry } from "../../subsystem/registry.js";
import { CodeToolRegistry } from "../../tools/codeTool.js";
import { type TickEngine, createTickEngine } from "../tickEngine.js";
import type { CharacterCondition } from "../types.js";

function makeDgsm(
  opts: {
    aliveIds?: string[];
    skills?: Record<string, number>;
    conditions?: CharacterCondition[];
  } = {}
) {
  let clock = "1923-04-02T09:00:00";
  const alive = new Set(opts.aliveIds ?? ["npc_1", "npc_2"]);
  const npc = (id: string) => ({
    id,
    name: id,
    attributes: { STR: 50 },
    skills: opts.skills ?? {},
    status: {
      hp: 10,
      maxHp: 10,
      san: 50,
      maxSan: 60,
      fatigue: 0,
      maxFatigue: 10,
      conditions: opts.conditions ?? [],
    },
    relationships: [],
  });
  return {
    getGameDateTime: () => clock,
    setGameDateTime: (t: string) => {
      clock = t;
    },
    isNpcAlive: (id: string) => alive.has(id),
    getState: () => ({
      scenes: new Map(),
      npcCharacters: [npc("npc_1"), npc("npc_2")],
      npcInventories: {},
    }),
    getAllSceneIds: () => [],
    getRegionIdForScene: () => undefined,
    getAllScopedFeatureStates: () => [],
    getEnvironmentReading: () => ({
      temperature: 20,
      illumination: 3,
      oxygen: 1,
      noise: 0,
      airborneHazards: [],
    }),
    getSceneConditions: () => [],
    getConnectionBlockReason: () => undefined,
    getCharactersInScene: () => [],
    getCharacterPosition: () => ({ type: "scene", sceneId: "SCN_1" }),
    getCharacterSpot: () => null,
    resolveLocationId: () => "SCN_1",
    getNpcInventory: () => [],
    getNpcProfile: (id: string) => (alive.has(id) ? npc(id) : npc(id)),
  } as unknown as DynamicGameStateManager;
}

/** Honest stub engine, speaking the two-moment contract: a starting action
 *  gets a duration and nothing else; a due one gets a result. Lifecycle and
 *  progress are never stated — code derives both — so this runs through the
 *  real finalizeResolution exactly like production. */
function stubResolve() {
  const calls: EngineResolutionContext[] = [];
  const fn = vi.fn(async (context: EngineResolutionContext) => {
    calls.push(context);
    const raw: Required<
      Pick<RawTickResolution, "starting" | "ending" | "occurrences">
    > &
      RawTickResolution = { starting: [], ending: [], occurrences: [] };
    // An ending is two scalars; its trace is a flat `occurrences` row that
    // cites the action in `actionIds`.
    const cite = (actionId: string) => {
      raw.occurrences.push({
        actionIds: [actionId],
        speech: false,
        perceivers: [{ characterId: "npc_1", clarity: "full" }],
        content: "stub fact",
      });
    };
    for (const t of context.trigger.triggers) {
      for (const actionId of t.actionIds) {
        if (t.reason === "new_action") {
          raw.starting.push({ actionId, resolvedDurationTicks: 2 });
        } else if (t.reason === "duration_reached") {
          raw.ending.push({ actionId, outcome: "stub done" });
          cite(actionId);
        } else if (t.reason === "replacement" || t.reason === "interrupted") {
          raw.ending.push({ actionId, outcome: "stub interruption" });
          cite(actionId);
        }
      }
    }
    const finalized = finalizeResolution(raw, context);
    return {
      ok: true as const,
      resolution: finalized.resolution,
      movementInits: finalized.movementInits,
      checkInits: finalized.checkInits,
      codeToolInvocations: [],
    };
  });
  return { fn, calls };
}

function makeEngine(
  dgsm = makeDgsm(),
  resolve = stubResolve()
): {
  engine: TickEngine;
  resolve: typeof resolve;
  dgsm: DynamicGameStateManager;
} {
  const engine = createTickEngine({
    dgsm,
    scriptedEvents: [],
    subsystemRegistry: new SubsystemRegistry(),
    tickDurationMinutes: 1,
    codeTools: new CodeToolRegistry(),
    resolveTickFn: resolve.fn,
  });
  return { engine, resolve, dgsm };
}

function command(overrides: Partial<ActionCommand> = {}): ActionCommand {
  return {
    commandId: "c1",
    actorId: "npc_1",
    issuedAt: "1923-04-02T09:00:00",
    issuedSceneId: "SCN_1",
    description: "I search the desk.",
    objectRefs: [],
    proposedDurationTicks: 4,
    ...overrides,
  };
}

describe("action-driven trigger gate", () => {
  it("idle clock ticks make ZERO engine calls", async () => {
    const { engine, resolve } = makeEngine();
    await engine.tick();
    await engine.tick();
    await engine.tick();
    expect(resolve.fn).not.toHaveBeenCalled();
  });

  it("a new command triggers exactly one global resolution", async () => {
    const { engine, resolve } = makeEngine();
    const receipt = await engine.submitCommand(command());
    expect(receipt).toMatchObject({ accepted: true, status: "queued" });

    await engine.tick();

    expect(resolve.fn).toHaveBeenCalledTimes(1);
    const context = resolve.calls[0];
    expect(context.actions.newCommands).toHaveLength(1);
    expect(context.trigger.triggers[0].reason).toBe("new_action");

    const action = engine.getAction(receipt.actionId!);
    expect(action).toMatchObject({
      status: "active",
      resolvedDurationTicks: 2,
      startedAt: "1923-04-02T09:01:00",
      nextWakeAt: "1923-04-02T09:03:00",
    });
    expect(action?.status).toBe("active");
  });

  it("the active action re-triggers only at nextWakeAt, then completes", async () => {
    const { engine, resolve } = makeEngine();
    const receipt = await engine.submitCommand(command());

    await engine.tick(); // 09:01 — first resolution, wake at 09:03
    await engine.tick(); // 09:02 — no trigger
    expect(resolve.fn).toHaveBeenCalledTimes(1);

    await engine.tick(); // 09:03 — due
    expect(resolve.fn).toHaveBeenCalledTimes(2);
    expect(resolve.calls[1].trigger.triggers[0].reason).toBe(
      "duration_reached"
    );
    expect(engine.getAction(receipt.actionId!)).toMatchObject({
      status: "completed",
      progressMinutes: 2,
    });

    await engine.tick(); // nothing left
    expect(resolve.fn).toHaveBeenCalledTimes(2);
  });

  it("emits derived commits and the transition/occurrence report", async () => {
    const { engine } = makeEngine();
    const reports: import("../types.js").TickReport[] = [];
    engine.on("tickCompleted", (r) => {
      reports.push(r);
    });
    await engine.submitCommand(command());
    await engine.tick();
    await engine.tick();
    await engine.tick();

    expect(reports[0].transitions).toHaveLength(1);
    expect(reports[0].transitions[0].to).toBe("active");
    expect(reports[2].commits).toHaveLength(1);
    expect(reports[2].commits[0]).toMatchObject({
      characterId: "npc_1",
      actionText: "I search the desk.",
      definitionId: "act",
    });
  });
});

describe("replacement and interruption", () => {
  it("a replacing command triggers interruption of the old action in the same resolution", async () => {
    const { engine, resolve } = makeEngine();
    const first = await engine.submitCommand(command());
    await engine.tick(); // first is active

    await engine.submitCommand(
      command({
        commandId: "c2",
        description: "I abandon the desk and run to the door.",
        replacesActionId: first.actionId,
      })
    );
    await engine.tick();

    expect(resolve.fn).toHaveBeenCalledTimes(2);
    const reasons = resolve.calls[1].trigger.triggers.map((t) => t.reason);
    expect(reasons).toContain("new_action");
    expect(reasons).toContain("replacement");

    expect(engine.getAction(first.actionId!)?.status).toBe("interrupted");
    const second = engine
      .getActorActions("npc_1")
      .find((a) => a.status === "active");
    expect(second?.command.commandId).toBe("c2");
  });

  it("requestInterruption resolves the action instead of dropping it", async () => {
    const { engine, resolve } = makeEngine();
    const receipt = await engine.submitCommand(command());
    await engine.tick();

    engine.requestInterruption(receipt.actionId!, "scripted force-stop");
    await engine.tick();

    expect(resolve.calls[1].trigger.triggers[0].reason).toBe("interrupted");
    expect(engine.getAction(receipt.actionId!)?.status).toBe("interrupted");
  });

  it("a dead actor's command fails without an engine call", async () => {
    const dgsm = makeDgsm({ aliveIds: ["npc_2"] });
    const resolve = stubResolve();
    const { engine } = makeEngine(dgsm, resolve);
    const receipt = await engine.submitCommand(command());

    const reports: import("../types.js").TickReport[] = [];
    engine.on("tickCompleted", (r) => {
      reports.push(r);
    });
    await engine.tick();

    expect(resolve.fn).not.toHaveBeenCalled();
    expect(engine.getAction(receipt.actionId!)?.status).toBe("failed");
    expect(reports[0].transitions[0]).toMatchObject({
      to: "failed",
      reason: "actor is dead",
    });
  });
});

describe("an ended action always leaves something to perceive", () => {
  // The regression this guards: a failed move changes nothing the actor can
  // see, so without an objective trace their next perception is identical and
  // they re-issue the same doomed action. Observed live as a seven-tick loop
  // after the old movement subsystem's "couldn't work out a way to get there"
  // feedback was removed. Memory is the character's own now, so the trace has
  // to arrive as perception.
  it("synthesizes an occurrence for a transition the Engine never saw", async () => {
    // A dead actor's command fails in the orchestrator itself — the Engine is
    // never called, so no submission could have carried the occurrence.
    const dgsm = makeDgsm({ aliveIds: ["npc_2"] });
    const resolve = stubResolve();
    const { engine } = makeEngine(dgsm, resolve);
    const receipt = await engine.submitCommand(command());

    const reports: import("../types.js").TickReport[] = [];
    engine.on("tickCompleted", (r) => {
      reports.push(r);
    });
    await engine.tick();

    expect(resolve.fn).not.toHaveBeenCalled();
    const occurrences = reports[0].occurrences;
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].sourceActionIds).toEqual([receipt.actionId]);
    // The actor perceives their own failure; nobody else necessarily could.
    expect(occurrences[0].perceivers).toEqual([
      { characterId: "npc_1", clarity: "full" },
    ]);
    expect(occurrences[0].facts[0].type).toBe("action_result");
    expect(occurrences[0].facts[0].content).toContain("actor is dead");
  });

  it("leaves the Engine's own occurrence alone rather than doubling up", async () => {
    // Every ending is cited by at least one `occurrences` row (the validator
    // refuses one nothing cites), so the fallback below should never fire for
    // an Engine-resolved ending. It still exists for terminal transitions that
    // never reach the Engine at all.
    const resolve = stubResolve();
    const { engine } = makeEngine(makeDgsm(), resolve);
    await engine.submitCommand(command());

    const reports: import("../types.js").TickReport[] = [];
    engine.on("tickCompleted", (r) => {
      reports.push(r);
    });
    await engine.tick(); // active
    await engine.tick();
    await engine.tick(); // due → completed, engine emits its own occurrence

    const completedTick = reports[2];
    expect(completedTick.transitions[0].to).toBe("completed");
    // Exactly one — the fallback must not double up on the Engine's fact.
    expect(completedTick.occurrences).toHaveLength(1);
    expect(completedTick.occurrences[0].facts[0].content).toBe("stub fact");
  });

  it("does not synthesize for an action that is merely still running", async () => {
    const { engine } = makeEngine();
    await engine.submitCommand(command());

    const reports: import("../types.js").TickReport[] = [];
    engine.on("tickCompleted", (r) => {
      reports.push(r);
    });
    await engine.tick(); // queued → active, nothing has ended yet

    expect(reports[0].transitions[0].to).toBe("active");
    expect(reports[0].occurrences).toEqual([]);
  });
});

describe("persistence", () => {
  it("round-trips queued and active actions without re-resolution", async () => {
    const { engine, resolve } = makeEngine();
    const receipt = await engine.submitCommand(command());
    await engine.tick(); // active, wake 09:03

    const snapshot = JSON.parse(JSON.stringify(engine.serialize()));
    const dgsm2 = makeDgsm();
    dgsm2.setGameDateTime("1923-04-02T09:01:00");
    const resolve2 = stubResolve();
    const engine2 = createTickEngine({
      dgsm: dgsm2,
      scriptedEvents: [],
      subsystemRegistry: new SubsystemRegistry(),
      tickDurationMinutes: 1,
      codeTools: new CodeToolRegistry(),
      resolveTickFn: resolve2.fn,
      persistedState: snapshot,
    });

    const restored = engine2.getAction(receipt.actionId!);
    expect(restored).toMatchObject({
      status: "active",
      nextWakeAt: "1923-04-02T09:03:00",
    });

    await engine2.tick(); // 09:02 — not due, no call
    expect(resolve2.fn).not.toHaveBeenCalled();
    await engine2.tick(); // 09:03 — due
    expect(resolve2.fn).toHaveBeenCalledTimes(1);
    expect(engine2.getAction(receipt.actionId!)?.status).toBe("completed");
    expect(resolve.fn).toHaveBeenCalledTimes(1);
  });

  it("rejects a snapshot with a foreign schema version", () => {
    expect(() =>
      createTickEngine({
        dgsm: makeDgsm(),
        scriptedEvents: [],
        subsystemRegistry: new SubsystemRegistry(),
        tickDurationMinutes: 1,
        codeTools: new CodeToolRegistry(),
        persistedState: {
          actionSchemaVersion: 999,
          inbox: [],
          actions: [],
        },
      })
    ).toThrow(/actionSchemaVersion/);
  });

  it("retrying the same commandId never mints a second action", async () => {
    const { engine } = makeEngine();
    const first = await engine.submitCommand(command());
    const second = await engine.submitCommand(command());
    expect(second.actionId).toBe(first.actionId);
    await engine.tick();
    const third = await engine.submitCommand(command());
    expect(third.actionId).toBe(first.actionId);
    expect(engine.getActorActions("npc_1")).toHaveLength(1);
  });
});

describe("a route that does not join up", () => {
  // Observed live: Tommy's remembered way merged two real lanes into one
  // ("north gate, then Holt Lane, then ten minutes to the trailhead" — Holt
  // Lane goes to the Holt gate). The Engine refused to invent the missing
  // stretch, which is correct; but all the actor was told is that his action
  // "did not go on", so he read it as a dizzy spell and re-stated the SAME
  // wrong route twice more. Three ticks on a mistake one sentence could fix.
  function makeMapDgsm() {
    const base = makeDgsm();
    const named = new Map([
      ["SCN_1", { id: "SCN_1", name: "家门口", connections: [] }],
      [
        "SCN_TRAILHEAD",
        { id: "SCN_TRAILHEAD", name: "林道口", connections: [] },
      ],
    ]);
    return {
      ...base,
      getScene: (id: string) => named.get(id) ?? null,
      getTopology: () => ({
        roads: new Map(),
        nodeSceneIds: new Set(["SCN_1", "SCN_TRAILHEAD"]),
        sceneToParent: new Map(),
        sceneToRoads: new Map(),
      }),
    } as unknown as DynamicGameStateManager;
  }

  /** Starts the action with a movement leg whose single hop is not a stretch. */
  function stubResolveWithBadRoute() {
    const fn = vi.fn(async (context: EngineResolutionContext) => {
      const raw: RawTickResolution = { starting: [], ending: [] };
      for (const t of context.trigger.triggers) {
        for (const actionId of t.actionIds) {
          if (t.reason === "new_action") {
            raw.starting?.push({
              actionId,
              resolvedDurationTicks: 10,
              movement: { route: ["SCN_TRAILHEAD"] },
            });
          }
        }
      }
      const finalized = finalizeResolution(raw, context);
      return {
        ok: true as const,
        resolution: finalized.resolution,
        movementInits: finalized.movementInits,
        checkInits: finalized.checkInits,
        codeToolInvocations: [],
      };
    });
    return { fn, calls: [] as EngineResolutionContext[] };
  }

  it("tells the actor which two places their way ran between, in words about the world", async () => {
    const { engine } = makeEngine(makeMapDgsm(), stubResolveWithBadRoute());
    await engine.submitCommand(
      command({ description: "我骑车往北去林道口找他们。" })
    );

    const reports: import("../types.js").TickReport[] = [];
    engine.on("tickCompleted", (r) => {
      reports.push(r);
    });
    await engine.tick();

    const transition = reports[0].transitions[0];
    expect(transition.to).toBe("failed");
    expect(transition.unstatedHop).toEqual({
      fromId: "SCN_1",
      toId: "SCN_TRAILHEAD",
    });

    const fact = reports[0].occurrences[0].facts[0].content;
    // Both places by name — this is the whole point: he can correct the route.
    expect(fact).toContain("家门口");
    expect(fact).toContain("林道口");
    expect(fact).toContain("没有出发");
    // And NOT the engine's own diagnostic, which has no experience in it and
    // got rendered as a dizzy spell.
    expect(fact).not.toContain("not a single stretch");
    expect(fact).not.toContain("movement init failed");
  });

  it("carries the reason into the persisted outcome instead of an empty string", async () => {
    const { engine } = makeEngine(makeMapDgsm(), stubResolveWithBadRoute());
    await engine.submitCommand(command());

    const reports: import("../types.js").TickReport[] = [];
    engine.on("tickCompleted", (r) => {
      reports.push(r);
    });
    await engine.tick();

    // SimulationEventEmitter reads `outcome.narrative` into the event row.
    // Nothing wrote it before, so every failed row in the log said only that
    // something had ended.
    const narrative = reports[0].cancellations[0].outcome?.narrative;
    expect(narrative).toContain("not a single stretch");
    expect(narrative).toContain("林道口 (SCN_TRAILHEAD)");
  });
});

describe("a walk that starts partway along a road", () => {
  // Observed live (grayhaven gh-cross-town, DeepSeek run 2026-09-01):
  // "addMinutes expects an integer minute delta, got 2.5."
  //
  // Road positions are fractions of the road's length, so a leg that begins
  // or ends between the endpoints costs a FRACTIONAL number of minutes:
  // |0 - 0.1| * 15 = 1.5. The movement runtime handles that correctly — it
  // advances one minute per tick and clamps progress at 1, so the leg simply
  // takes 2 ticks. `resolvedDurationTicks` agreed (ceil(1.5) = 2). Only
  // `nextWakeAt` disagreed, being handed the raw 1.5, and the clock refused
  // it. The two numbers describe the same thing and must not diverge.
  function makeRoadDgsm() {
    const base = makeDgsm();
    const scenes = new Map([
      ["J_A", { id: "J_A", name: "主街北口", connections: [] }],
      ["J_B", { id: "J_B", name: "主街南口", connections: [] }],
    ]);
    const roads = new Map([
      [
        "R_MAIN",
        {
          id: "R_MAIN",
          name: "主街",
          endpointA: "J_A",
          endpointB: "J_B",
          travelTimeMinutes: 15,
          alongConnections: [],
          connections: [],
        },
      ],
    ]);
    return {
      ...base,
      getState: () => ({
        ...base.getState(),
        scenes,
      }),
      getScene: (id: string) => scenes.get(id) ?? null,
      getTopology: () =>
        buildTopology(
          scenes as unknown as Map<string, DynamicScene>,
          roads as unknown as Map<string, RoadNode>
        ),
      // Standing one tenth of the way down the road, walking back to J_A.
      getCharacterPosition: () => ({
        type: "road",
        roadId: "R_MAIN",
        position: 0.1,
      }),
      getBlockedConnections: () => new Map<string, string>(),
      getConnectionBlockReason: () => undefined,
    } as unknown as DynamicGameStateManager;
  }

  function stubResolveWithWalk() {
    const fn = vi.fn(async (context: EngineResolutionContext) => {
      const raw: RawTickResolution = { starting: [], ending: [] };
      for (const t of context.trigger.triggers) {
        for (const actionId of t.actionIds) {
          if (t.reason === "new_action") {
            raw.starting?.push({
              actionId,
              resolvedDurationTicks: 4,
              movement: { route: ["J_A"] },
            });
          }
        }
      }
      const finalized = finalizeResolution(raw, context);
      return {
        ok: true as const,
        resolution: finalized.resolution,
        movementInits: finalized.movementInits,
        checkInits: finalized.checkInits,
        codeToolInvocations: [],
      };
    });
    return { fn, calls: [] as EngineResolutionContext[] };
  }

  it("does not hand the clock a fractional minute", async () => {
    const { engine } = makeEngine(makeRoadDgsm(), stubResolveWithWalk());
    await engine.submitCommand(
      command({ description: "我沿主街往回走到北口。" })
    );
    // Before the fix this threw: addMinutes got 1.5.
    await expect(engine.tick()).resolves.toBeUndefined();
  });

  it("wakes at exactly the duration it resolved, not the raw estimate", async () => {
    const { engine } = makeEngine(makeRoadDgsm(), stubResolveWithWalk());
    await engine.submitCommand(
      command({ description: "我沿主街往回走到北口。" })
    );
    const reports: import("../types.js").TickReport[] = [];
    engine.on("tickCompleted", (r) => {
      reports.push(r);
    });
    await engine.tick();

    const started = reports[0].transitions.find((t) => t.to === "active");
    expect(started?.resolvedDurationTicks).toBe(2); // ceil(1.5 / 1)
    // The clock is at 09:01 when the action starts, plus its own 2 ticks.
    expect(started?.nextWakeAt).toBe("1923-04-02T09:03:00");
  });
});

describe("conditions reach the dice", () => {
  /** A stub that sets a bar when the action starts, so code rolls when its
   *  time is spent — the only place in the engine a skill is actually rolled. */
  function stubResolveWithCheck() {
    const fn = vi.fn(async (context: EngineResolutionContext) => {
      const raw: RawTickResolution = { starting: [], ending: [] };
      for (const t of context.trigger.triggers) {
        for (const actionId of t.actionIds) {
          if (t.reason === "new_action") {
            raw.starting?.push({
              actionId,
              resolvedDurationTicks: 1,
              check: { requiredLevel: "regular" },
            });
          }
        }
      }
      const finalized = finalizeResolution(raw, context);
      return {
        ok: true as const,
        resolution: finalized.resolution,
        movementInits: finalized.movementInits,
        checkInits: finalized.checkInits,
        codeToolInvocations: [],
      };
    });
    return { fn, calls: [] as EngineResolutionContext[] };
  }

  const shaken: CharacterCondition = {
    id: "sanity_tick_1_0",
    featureId: "sanity",
    description: "my hands will not stop shaking",
    mechanicalEffect: { globalSkillPenalty: -20 },
  };

  it("rolls the actor against a value their conditions lowered", async () => {
    // The handicap lives in the deterministic dice, NOT in the trust boundary:
    // the command was accepted exactly as it would have been for a steady
    // character, and only the roll knows the difference.
    const { engine } = makeEngine(
      makeDgsm({ skills: { Social: 60 }, conditions: [shaken] }),
      stubResolveWithCheck()
    );
    const receipt = await engine.submitCommand(
      command({ declaredSkillId: "Social" })
    );
    expect(receipt.accepted).toBe(true);

    await engine.tick(); // starts, sets the bar
    await engine.tick(); // time spent, code rolls

    const action = engine.getAction(receipt.actionId!);
    expect(action?.checkOutcome?.actor).toMatchObject({
      skillId: "Social",
      skillValue: 40,
      skillValueBase: 60,
    });
  });

  it("leaves a steady character's roll untouched, and says so by omission", async () => {
    const { engine } = makeEngine(
      makeDgsm({ skills: { Social: 60 } }),
      stubResolveWithCheck()
    );
    const receipt = await engine.submitCommand(
      command({ declaredSkillId: "Social" })
    );
    await engine.tick();
    await engine.tick();

    const roll = engine.getAction(receipt.actionId!)?.checkOutcome?.actor;
    expect(roll?.skillValue).toBe(60);
    expect(roll?.skillValueBase).toBeUndefined();
  });

  it("applies stamina's fatigue penalties, which never reached a roll before", async () => {
    // Wiring this path turns on penalties the stamina subsystem has authored
    // all along. Pinned here so the change is a test, not a surprise in a sim.
    const exhausted: CharacterCondition = {
      id: "stamina:exhausted",
      featureId: "stamina",
      description: "exhausted",
      mechanicalEffect: { globalSkillPenalty: -20 },
    };
    const { engine } = makeEngine(
      makeDgsm({ skills: { Social: 55 }, conditions: [exhausted] }),
      stubResolveWithCheck()
    );
    const receipt = await engine.submitCommand(
      command({ declaredSkillId: "Social" })
    );
    await engine.tick();
    await engine.tick();

    expect(
      engine.getAction(receipt.actionId!)?.checkOutcome?.actor?.skillValue
    ).toBe(35);
  });
});
