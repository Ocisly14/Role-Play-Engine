// The two-session tick loop against a stubbed World Action Engine: a START
// JUDGEMENT at the minute a command is drained, before the clock advances,
// and a SETTLEMENT — over due / replaced / interrupted active actions, with
// newCommands: [] — after it. Idle ticks make zero engine calls; a trigger
// with nothing to settle opens no session at all. Covers the due-action
// re-trigger via nextWakeAt, replacement and interruption triggers,
// dead-actor rejection, lifecycle commit, and persistence round-trips.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { buildTopology } from "../../../state/topologyTypes.js";
import type { RoadNode } from "../../../state/topologyTypes.js";
import type { DynamicScene } from "../../../state/types.js";
import {
  ACTION_SCHEMA_VERSION,
  type ActionCommand,
} from "../../actions/types.js";
import type {
  EngineResolutionContext,
  WorldActionEngineResult,
} from "../../resolution/types.js";
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

function receiptActionId(receipt: { actionId?: string }): string {
  if (!receipt.actionId) throw new Error("expected an accepted action receipt");
  return receipt.actionId;
}

/** Honest stub engine, speaking the two-moment contract: a starting action
 *  gets a duration and nothing else; a due one gets a result — the same stub
 *  serves the start judgement and the settlement, since each context carries
 *  only one kind of trigger. */
function stubResolve(durationTicks = 2) {
  const calls: EngineResolutionContext[] = [];
  const fn = vi.fn(
    async (
      context: EngineResolutionContext
    ): Promise<WorldActionEngineResult> => {
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
          perceivers: [
            { characterId: "npc_1", sight: "clear", hearing: "clear" },
          ],
          content: "stub fact",
        });
      };
      for (const t of context.trigger.triggers) {
        for (const actionId of t.actionIds) {
          if (t.reason === "new_action") {
            raw.starting.push({
              actionId,
              resolvedDurationTicks: durationTicks,
            });
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
    }
  );
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

  it("a new command is judged at the minute it was decided, before the clock moves", async () => {
    const { engine, resolve } = makeEngine();
    const receipt = await engine.submitCommand(command());
    expect(receipt).toMatchObject({ accepted: true, status: "queued" });

    await engine.tick();

    expect(resolve.fn).toHaveBeenCalledTimes(1);
    const context = resolve.calls[0];
    expect(context.actions.newCommands).toHaveLength(1);
    expect(context.trigger.triggers).toEqual([
      { actionIds: [receipt.actionId], reason: "new_action" },
    ]);
    // The start judgement saw the 09:00 world, not the 09:01 one.
    expect(context.tick.tickStartTime).toBe("1923-04-02T09:00:00");

    expect(engine.getAction(receiptActionId(receipt))).toMatchObject({
      status: "active",
      resolvedDurationTicks: 2,
      startedAt: "1923-04-02T09:00:00",
      nextWakeAt: "1923-04-02T09:02:00",
      progressMinutes: 1,
    });
  });

  it("the active action is settled on the tick its minutes run out, and not before", async () => {
    const { engine, resolve } = makeEngine();
    const receipt = await engine.submitCommand(command());

    await engine.tick(); // 09:00 judged, clock → 09:01, one minute spent
    expect(resolve.fn).toHaveBeenCalledTimes(1);

    await engine.tick(); // 09:02 — two minutes spent: due, settled
    expect(resolve.fn).toHaveBeenCalledTimes(2);
    const settlement = resolve.calls[1];
    expect(settlement.trigger.triggers[0].reason).toBe("duration_reached");
    expect(settlement.actions.newCommands).toEqual([]);
    expect(settlement.tick.tickStartTime).toBe("1923-04-02T09:02:00");
    expect(engine.getAction(receiptActionId(receipt))).toMatchObject({
      status: "completed",
      progressMinutes: 2,
    });

    await engine.tick(); // nothing left
    expect(resolve.fn).toHaveBeenCalledTimes(2);
  });

  it("a one-minute action decided at 09:00 ends at 09:01, in one tick with two sessions", async () => {
    const { engine, resolve } = makeEngine(makeDgsm(), stubResolve(1));
    const reports: import("../types.js").TickReport[] = [];
    engine.on("tickCompleted", (r) => {
      reports.push(r);
    });
    const receipt = await engine.submitCommand(command());
    await engine.tick();

    // Start judgement on 09:00, settlement on 09:01: two sessions, one tick.
    expect(resolve.fn).toHaveBeenCalledTimes(2);
    expect(resolve.calls[0].trigger.triggers[0].reason).toBe("new_action");
    expect(resolve.calls[1].trigger.triggers[0].reason).toBe(
      "duration_reached"
    );
    expect(reports[0].transitions.map((t) => t.to)).toEqual([
      "active",
      "completed",
    ]);
    expect(engine.getAction(receiptActionId(receipt))).toMatchObject({
      status: "completed",
      startedAt: "1923-04-02T09:00:00",
      progressMinutes: 1,
    });
    expect(reports[0].commits).toHaveLength(1);
    expect(reports[0].commits[0].outcome?.elapsedMinutes).toBe(1);
    expect(reports[0].occurrences).toHaveLength(1);
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

    expect(reports[0].transitions).toHaveLength(1);
    expect(reports[0].transitions[0].to).toBe("active");
    expect(reports[1].commits).toHaveLength(1);
    expect(reports[1].commits[0]).toMatchObject({
      characterId: "npc_1",
      actionText: "I search the desk.",
      definitionId: "act",
    });
  });
});

describe("replacement and interruption", () => {
  it("a replacing command is judged at its own minute, and the old action is settled as replaced a minute later", async () => {
    const { engine, resolve } = makeEngine(makeDgsm(), stubResolve(3));
    const first = await engine.submitCommand(command());
    await engine.tick(); // c1 active from 09:00, one minute spent

    await engine.submitCommand(
      command({
        commandId: "c2",
        description: "I abandon the desk and run to the door.",
        replacesActionId: first.actionId,
      })
    );
    await engine.tick();

    expect(resolve.fn).toHaveBeenCalledTimes(3);
    // The start judgement of c2, alone, on the 09:01 world…
    expect(resolve.calls[1].trigger.triggers.map((t) => t.reason)).toEqual([
      "new_action",
    ]);
    // …then the settlement, which is told c1 was cut short.
    expect(resolve.calls[2].trigger.triggers.map((t) => t.reason)).toEqual([
      "replacement",
    ]);
    expect(engine.getAction(receiptActionId(first))?.status).toBe(
      "interrupted"
    );
    const second = engine
      .getActorActions("npc_1")
      .find((a) => a.status === "active");
    expect(second?.command.commandId).toBe("c2");
  });

  it("an action whose time is spent this minute is due, not replaced, whatever its actor does next", async () => {
    const { engine, resolve } = makeEngine(); // duration 2
    const first = await engine.submitCommand(command());
    await engine.tick(); // one minute spent
    await engine.submitCommand(
      command({ commandId: "c2", replacesActionId: first.actionId })
    );
    await engine.tick(); // second minute spent: c1 is due at 09:02

    const reasons = resolve.calls[2].trigger.triggers.map((t) => t.reason);
    expect(reasons).toEqual(["duration_reached"]);
    expect(engine.getAction(receiptActionId(first))?.status).toBe("completed");
  });

  it("a start session that fails leaves nothing for the settlement to address", async () => {
    const { engine, resolve } = makeEngine();
    resolve.fn.mockImplementationOnce(async () => ({
      ok: false,
      failure: "x",
      errors: [],
      codeToolInvocations: [],
    }));

    const first = await engine.submitCommand(command());
    await engine.submitCommand(
      command({ commandId: "c2", replacesActionId: first.actionId })
    );

    await engine.tick();

    // The failed start left both commands queued. A settlement cannot
    // address a still-queued action, so no settlement session opens for the
    // one c2 claims to replace: exactly one engine call this tick.
    expect(resolve.fn).toHaveBeenCalledTimes(1);
    expect(engine.getAction(receiptActionId(first))?.status).toBe("queued");

    await engine.tick();

    // Both commands are re-drained and started on the next tick, as a
    // perfectly ordinary start judgement — the failure left no trace.
    expect(resolve.fn).toHaveBeenCalledTimes(3);
    const restart = resolve.calls[0];
    expect(restart.trigger.triggers).toEqual([
      {
        actionIds: expect.arrayContaining([first.actionId]),
        reason: "new_action",
      },
    ]);
    expect(restart.actions.newCommands).toHaveLength(2);
    // c1 is now genuinely active (started this same tick), so c2 naming it
    // as replaced opens a real settlement — unlike the failed tick, this one
    // has something to address.
    expect(resolve.calls[1].trigger.triggers[0].reason).toBe("replacement");
    expect(engine.getAction(receiptActionId(first))?.status).toBe(
      "interrupted"
    );
  });

  it("requestInterruption resolves the action instead of dropping it", async () => {
    const { engine, resolve } = makeEngine(makeDgsm(), stubResolve(3));
    const receipt = await engine.submitCommand(command());
    await engine.tick(); // active from 09:00, one minute spent, wakes at 09:03

    engine.requestInterruption(receiptActionId(receipt), "scripted force-stop");
    await engine.tick(); // 09:02 — not due yet, but interrupted

    expect(resolve.calls[1].trigger.triggers[0].reason).toBe("interrupted");
    expect(engine.getAction(receiptActionId(receipt))?.status).toBe(
      "interrupted"
    );
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
    expect(engine.getAction(receiptActionId(receipt))?.status).toBe("failed");
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
      { characterId: "npc_1", sight: "clear", hearing: "clear" },
    ]);
    expect(occurrences[0].facts[0].type).toBe("action_result");
    expect(occurrences[0].facts[0].content).toContain("actor is dead");
  });

  it("closes a wait and emits its transition without a fallback observation event", async () => {
    const resolve = stubResolve();
    const { engine } = makeEngine(makeDgsm(), resolve);
    const receipt = await engine.submitCommand(
      command({ description: "I wait and watch." })
    );
    if (!receipt.actionId) throw new Error("wait was rejected");
    const actionId = receipt.actionId;
    const reports: import("../types.js").TickReport[] = [];
    engine.on("tickCompleted", (r) => {
      reports.push(r);
    });
    await engine.tick();
    resolve.fn.mockImplementationOnce(async (context) => {
      const finalized = finalizeResolution(
        { ending: [{ actionId, outcome: null }], occurrences: [] },
        context
      );
      return { ok: true as const, ...finalized, codeToolInvocations: [] };
    });
    await engine.tick();
    expect(reports[1].transitions).toEqual([
      expect.objectContaining({ actionId: receipt.actionId, to: "completed" }),
    ]);
    expect(reports[1].occurrences).toEqual([]);
    expect(engine.getAction(actionId)?.status).toBe("completed");
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
    await engine.tick(); // due → completed, engine emits its own occurrence

    const completedTick = reports[1];
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
    await engine.tick(); // active from 09:00, wake 09:02

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

    const restored = engine2.getAction(receiptActionId(receipt));
    expect(restored).toMatchObject({
      status: "active",
      nextWakeAt: "1923-04-02T09:02:00",
    });

    await engine2.tick(); // 09:02 — due
    expect(resolve2.fn).toHaveBeenCalledTimes(1);
    expect(engine2.getAction(receiptActionId(receipt))?.status).toBe(
      "completed"
    );
    expect(resolve.fn).toHaveBeenCalledTimes(1);
  });

  it("rejects the immediately previous snapshot schema", () => {
    expect(() =>
      createTickEngine({
        dgsm: makeDgsm(),
        scriptedEvents: [],
        subsystemRegistry: new SubsystemRegistry(),
        tickDurationMinutes: 1,
        codeTools: new CodeToolRegistry(),
        persistedState: {
          actionSchemaVersion: ACTION_SCHEMA_VERSION - 1,
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
    const calls: EngineResolutionContext[] = [];
    const fn = vi.fn(async (context: EngineResolutionContext) => {
      calls.push(context);
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
    return { fn, calls };
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

/** A two-ended street, R_MAIN from J_A to J_B, with the walker standing on
 *  it — one tenth of the way down unless `position` says otherwise. */
function makeRoadDgsm(position = 0.1) {
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
    // Walking back to J_A.
    getCharacterPosition: () => ({
      type: "road",
      roadId: "R_MAIN",
      position,
    }),
    setCharacterPosition: () => undefined,
    getBlockedConnections: () => new Map<string, string>(),
    getConnectionBlockReason: () => undefined,
  } as unknown as DynamicGameStateManager;
}

/** A start that walks to J_A (with a bar, when `check` is set) and a
 *  settlement that writes the arrival as an outcome. */
function stubResolveWithWalk(opts: { check?: boolean } = {}) {
  const calls: EngineResolutionContext[] = [];
  const fn = vi.fn(async (context: EngineResolutionContext) => {
    calls.push(context);
    const raw: RawTickResolution = { starting: [], ending: [] };
    // An action both due and interrupted is named by two triggers; it still
    // ends once.
    const ended = new Set<string>();
    for (const t of context.trigger.triggers) {
      for (const actionId of t.actionIds) {
        if (t.reason === "new_action") {
          raw.starting?.push({
            actionId,
            resolvedDurationTicks: 4,
            movement: { route: ["J_A"] },
            ...(opts.check ? { check: { requiredLevel: "regular" } } : {}),
          });
        } else if (
          (t.reason === "duration_reached" || t.reason === "interrupted") &&
          !ended.has(actionId)
        ) {
          ended.add(actionId);
          raw.ending?.push({ actionId, outcome: "arrived at J_A" });
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
    // The clock is at 09:00 when the action starts, plus its own 2 ticks.
    expect(started?.nextWakeAt).toBe("1923-04-02T09:02:00");
  });

  it("takes the first step in the tick the route is judged, so a one-minute walk ends a minute after it was decided", async () => {
    const positions: unknown[] = [];
    const dgsm = makeRoadDgsm();
    // Standing right next to J_A: the whole walk is one step.
    (
      dgsm as unknown as { getCharacterPosition: () => unknown }
    ).getCharacterPosition = () => ({
      type: "road",
      roadId: "R_MAIN",
      position: 0.05,
    });
    (
      dgsm as unknown as {
        setCharacterPosition: (id: string, position: unknown) => void;
      }
    ).setCharacterPosition = (_id, position) => {
      positions.push(position);
    };
    const { engine, resolve } = makeEngine(dgsm, stubResolveWithWalk());
    const reports: import("../types.js").TickReport[] = [];
    engine.on("tickCompleted", (r) => {
      reports.push(r);
    });
    const receipt = await engine.submitCommand(
      command({ description: "我沿主街往回走到北口。" })
    );
    await engine.tick();

    // Judged on 09:00, stepped and settled on 09:01.
    expect(resolve.fn).toHaveBeenCalledTimes(2);
    expect(
      reports[0].stateChanges.some((c) => c.kind === "character.position")
    ).toBe(true);
    expect(engine.getAction(receiptActionId(receipt))).toMatchObject({
      status: "completed",
      startedAt: "1923-04-02T09:00:00",
      progressMinutes: 1,
    });
    expect(positions.length).toBeGreaterThan(0);
  });
});

describe("a plain arrival closes in code (ENGINE_ARRIVAL_SKIP)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Standing right next to J_A: the walk is judged, stepped and due in one
   *  tick. Returns the engine, its stub and every report it emitted. */
  async function walkOneTick(
    opts: {
      check?: boolean;
      overrides?: Partial<ActionCommand>;
      interrupt?: boolean;
    } = {}
  ) {
    const { engine, resolve } = makeEngine(
      makeRoadDgsm(0.05),
      stubResolveWithWalk({ check: opts.check })
    );
    const reports: import("../types.js").TickReport[] = [];
    engine.on("tickCompleted", (r) => {
      reports.push(r);
    });
    const id = receiptActionId(
      await engine.submitCommand(
        command({ description: "我沿主街往回走到北口。", ...opts.overrides })
      )
    );
    if (opts.interrupt) engine.requestInterruption(id, "actor died");
    await engine.tick();
    return { engine, resolve, report: reports[0], id };
  }

  it("on: a plain walk is closed by code — one Engine call (the start), completed, committed", async () => {
    vi.stubEnv("ENGINE_ARRIVAL_SKIP", "on");
    const { engine, resolve, report, id } = await walkOneTick();

    expect(resolve.fn).toHaveBeenCalledTimes(1);
    expect(engine.getAction(id)).toMatchObject({ status: "completed" });
    expect(report.transitions).toContainEqual(
      expect.objectContaining({ actionId: id, to: "completed" })
    );
    expect(report.commits.map((c) => c.handleId)).toContain(id);
    // Closed with nothing to say: no fallback "it ended" event for the actor.
    expect(report.occurrences.some((o) => o.sourceActionIds.includes(id))).toBe(
      false
    );
  });

  it("off: the same walk is settled by the Engine (two calls)", async () => {
    const { engine, resolve, id } = await walkOneTick();
    expect(resolve.fn).toHaveBeenCalledTimes(2);
    expect(engine.getAction(id)).toMatchObject({ status: "completed" });
  });

  it("a walk that carries an utterance is still settled by the Engine", async () => {
    vi.stubEnv("ENGINE_ARRIVAL_SKIP", "on");
    const { resolve, id } = await walkOneTick({
      overrides: { utterance: "到了。" },
    });
    expect(resolve.fn).toHaveBeenCalledTimes(2);
    expect(
      resolve.calls[1].trigger.triggers.flatMap((t) => t.actionIds)
    ).toContain(id);
  });

  it("a walk with a check is still settled by the Engine", async () => {
    vi.stubEnv("ENGINE_ARRIVAL_SKIP", "on");
    const { resolve, id } = await walkOneTick({
      check: true,
      overrides: { declaredSkillId: "Athletics" },
    });
    expect(resolve.fn).toHaveBeenCalledTimes(2);
    expect(
      resolve.calls[1].trigger.triggers.flatMap((t) => t.actionIds)
    ).toContain(id);
  });

  it("an interrupted arrival still goes to the Engine", async () => {
    vi.stubEnv("ENGINE_ARRIVAL_SKIP", "on");
    // Requested while the command is still queued: it takes effect once the
    // start judgement has made the action active, in this same tick.
    const { resolve, id } = await walkOneTick({ interrupt: true });
    expect(resolve.fn).toHaveBeenCalledTimes(2);
    const interrupted = resolve.calls[1].trigger.triggers.find(
      (t) => t.reason === "interrupted"
    );
    expect(interrupted?.actionIds).toContain(id);
  });

  it("shadow: settled by the Engine, and one shadow line records the disagreement", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "arrival-")), "shadow.jsonl");
    vi.stubEnv("ENGINE_ARRIVAL_SKIP", "shadow");
    vi.stubEnv("DECISIONS_SHADOW_LOG", file);
    const { resolve, id } = await walkOneTick();

    expect(resolve.fn).toHaveBeenCalledTimes(2);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    // The stub wrote the arrival as an outcome, so the Engine disagreed.
    expect(JSON.parse(lines[0])).toMatchObject({
      fastPath: "ENGINE_ARRIVAL_SKIP",
      actionId: id,
      predicted: "no_change",
      llm: "result",
      agree: false,
    });
  });
});

describe("conditions reach the dice", () => {
  /** A stub that sets a bar when the action starts, so code rolls when its
   *  time is spent — the only place in the engine a skill is actually rolled. */
  function stubResolveWithCheck() {
    const calls: EngineResolutionContext[] = [];
    const fn = vi.fn(async (context: EngineResolutionContext) => {
      calls.push(context);
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
    return { fn, calls };
  }

  const shaken: CharacterCondition = {
    id: "sanity_tick_1_0",
    featureId: "sanity",
    description: "my hands will not stop shaking",
    mechanicalEffect: { globalSkillPenalty: -20 },
  };

  it("resumes an in-flight social action from an old save without its check", async () => {
    const dgsm = makeDgsm();
    const actionId = "action_c1";
    const resolve = stubResolve();
    const engine = createTickEngine({
      dgsm,
      scriptedEvents: [],
      subsystemRegistry: new SubsystemRegistry(),
      tickDurationMinutes: 1,
      codeTools: new CodeToolRegistry(),
      resolveTickFn: resolve.fn,
      persistedState: {
        actionSchemaVersion: ACTION_SCHEMA_VERSION,
        inbox: [],
        actions: [
          {
            id: actionId,
            command: command({
              description: "I ask him where he was last night.",
              utterance: "Where were you last night?",
              declaredSkillId: "Social",
            }),
            status: "active",
            submittedAt: "1923-04-02T09:00:00",
            startedAt: "1923-04-02T09:00:00",
            nextWakeAt: "1923-04-02T09:01:00",
            progressMinutes: 0,
            resolvedDurationTicks: 1,
            check: { skillId: "Social", requiredLevel: "regular" },
          },
        ],
      },
    });
    await engine.tick();
    expect(engine.getAction(actionId)?.status).toBe("completed");
    expect(engine.getAction(actionId)?.check).toBeUndefined();
    expect(engine.getAction(actionId)?.checkOutcome).toBeUndefined();
    expect(resolve.calls[0].actions.activeActions[0].command.utterance).toBe(
      "Where were you last night?"
    );
  });

  it("rolls the actor against a value their conditions lowered", async () => {
    // The handicap lives in the deterministic dice, NOT in the trust boundary:
    // the command was accepted exactly as it would have been for a steady
    // character, and only the roll knows the difference.
    const { engine } = makeEngine(
      makeDgsm({ skills: { Athletics: 60 }, conditions: [shaken] }),
      stubResolveWithCheck()
    );
    const receipt = await engine.submitCommand(
      command({ declaredSkillId: "Athletics" })
    );
    expect(receipt.accepted).toBe(true);

    await engine.tick(); // judged at 09:00, spent and rolled at 09:01

    const action = engine.getAction(receiptActionId(receipt));
    expect(action?.checkOutcome?.actor).toMatchObject({
      skillId: "Athletics",
      skillValue: 40,
      skillValueBase: 60,
    });
  });

  it("leaves a steady character's roll untouched, and says so by omission", async () => {
    const { engine } = makeEngine(
      makeDgsm({ skills: { Athletics: 60 } }),
      stubResolveWithCheck()
    );
    const receipt = await engine.submitCommand(
      command({ declaredSkillId: "Athletics" })
    );
    await engine.tick(); // judged at 09:00, spent and rolled at 09:01

    const roll = engine.getAction(receiptActionId(receipt))?.checkOutcome
      ?.actor;
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
      makeDgsm({ skills: { Athletics: 55 }, conditions: [exhausted] }),
      stubResolveWithCheck()
    );
    const receipt = await engine.submitCommand(
      command({ declaredSkillId: "Athletics" })
    );
    await engine.tick(); // judged at 09:00, spent and rolled at 09:01

    expect(
      engine.getAction(receiptActionId(receipt))?.checkOutcome?.actor
        ?.skillValue
    ).toBe(35);
  });
});

describe("a drive whose driver is not in the cab", () => {
  function makeTruckDgsm() {
    const base = makeDgsm();
    const scenes = new Map([
      [
        "SCN_1",
        {
          id: "SCN_1",
          name: "车库门口",
          connections: [{ id: "connection.scn1.jb", targetId: "J_B" }],
        },
      ],
      [
        "S_CAB",
        {
          id: "S_CAB",
          name: "驾驶室",
          parentLocationId: "VEH_TRUCK",
          connections: [],
        },
      ],
      [
        "J_B",
        {
          id: "J_B",
          name: "南口",
          connections: [{ id: "connection.jb.scn1", targetId: "SCN_1" }],
        },
      ],
    ]);
    const truck = {
      id: "VEH_TRUCK",
      name: "旧卡车",
      interiorSceneId: "S_CAB",
      position: { type: "scene", sceneId: "SCN_1" },
    };
    return {
      ...base,
      getState: () => ({ ...base.getState(), scenes }),
      getScene: (id: string) => scenes.get(id) ?? null,
      getVehicle: (id: string) => (id === "VEH_TRUCK" ? truck : null),
      getVehicles: () => [truck],
      getTopology: () => ({
        roads: new Map(),
        nodeSceneIds: new Set(["SCN_1", "J_B"]),
        sceneToParent: new Map(),
        sceneToRoads: new Map(),
      }),
    } as unknown as DynamicGameStateManager;
  }

  function stubResolveWithDrive() {
    const calls: EngineResolutionContext[] = [];
    const fn = vi.fn(async (context: EngineResolutionContext) => {
      calls.push(context);
      const raw: RawTickResolution = { starting: [], ending: [] };
      for (const t of context.trigger.triggers) {
        for (const actionId of t.actionIds) {
          if (t.reason === "new_action") {
            raw.starting?.push({
              actionId,
              movement: { route: ["J_B"], vehicleId: "VEH_TRUCK" },
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
    return { fn, calls };
  }

  it("never sets off, and the actor is told they are standing beside the vehicle", async () => {
    const { engine } = makeEngine(makeTruckDgsm(), stubResolveWithDrive());
    await engine.submitCommand(command({ description: "我开卡车去南口。" }));
    const reports: import("../types.js").TickReport[] = [];
    engine.on("tickCompleted", (r) => {
      reports.push(r);
    });
    await engine.tick();

    const transition = reports[0].transitions[0];
    expect(transition.to).toBe("failed");
    expect(transition.notAboard).toEqual({
      vehicleId: "VEH_TRUCK",
      interiorSceneId: "S_CAB",
    });
    const fact = reports[0].occurrences[0].facts[0].content;
    expect(fact).toContain("旧卡车");
    expect(fact).toContain("没有出发");
    expect(fact).toContain("先上车");
  });
});
