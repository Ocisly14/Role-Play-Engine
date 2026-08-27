// Phase 8 tick loop: action-driven gate (idle ticks → zero engine calls),
// new-command trigger, due-action re-trigger via nextWakeAt, replacement
// triggers, dead-actor rejection, lifecycle commit and persistence
// round-trips — all against a stubbed World Action Engine.

import { describe, expect, it, vi } from "vitest";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { ActionCommand } from "../../actions/types.js";
import type { EngineResolutionContext } from "../../resolution/types.js";
import { finalizeResolution } from "../../resolution/worldDeltaValidator.js";
import type { RawTickResolution } from "../../resolution/worldDeltaSchema.js";
import { SubsystemRegistry } from "../../subsystem/registry.js";
import { CodeToolRegistry } from "../../tools/codeTool.js";
import { type TickEngine, createTickEngine } from "../tickEngine.js";

function makeDgsm(opts: { aliveIds?: string[] } = {}) {
  let clock = "1923-04-02T09:00:00";
  const alive = new Set(opts.aliveIds ?? ["npc_1", "npc_2"]);
  const npc = (id: string) => ({
    id,
    name: id,
    attributes: { STR: 50 },
    skills: {},
    status: {
      hp: 10,
      maxHp: 10,
      san: 50,
      maxSan: 60,
      fatigue: 0,
      maxFatigue: 10,
      conditions: [],
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
    resolveLocationId: () => "SCN_1",
    getNpcInventory: () => [],
    getNpcProfile: (id: string) => (alive.has(id) ? npc(id) : npc(id)),
  } as unknown as DynamicGameStateManager;
}

/** Honest stub engine, speaking the two-moment contract: a starting action
 *  gets a duration and nothing else; a due one gets a result. Lifecycle and
 *  progress are never stated — code derives both — so this runs through the
 *  real finalizeResolution exactly like production. */
function stubResolve(opts: { withOccurrence?: boolean } = {}) {
  const calls: EngineResolutionContext[] = [];
  const fn = vi.fn(async (context: EngineResolutionContext) => {
    calls.push(context);
    const raw: RawTickResolution = { actions: [] };
    for (const t of context.trigger.triggers) {
      for (const actionId of t.actionIds) {
        if (t.reason === "new_action") {
          raw.actions.push({
            actionId,
            resolvedDurationTicks: 2,
            timingReason: "stub: two minutes of work",
          });
        } else if (t.reason === "duration_reached") {
          raw.actions.push({
            actionId,
            result: { outcome: "success", reason: "stub done" },
          });
          if (opts.withOccurrence) {
            raw.occurrences = [
              ...(raw.occurrences ?? []),
              {
                sourceActionIds: [actionId],
                facts: [{ type: "action_result", content: "stub fact" }],
                participants: [{ characterId: "npc_1", role: "actor" }],
                perceiverCharacterIds: ["npc_1"],
              },
            ];
          }
        } else if (t.reason === "replacement" || t.reason === "interrupted") {
          raw.actions.push({
            actionId,
            result: { outcome: "blocked", reason: "stub interruption" },
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

function makeEngine(
  dgsm = makeDgsm(),
  resolve = stubResolve()
): { engine: TickEngine; resolve: typeof resolve; dgsm: DynamicGameStateManager } {
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
    const second = engine.getActorActions("npc_1").find((a) => a.status === "active");
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
    expect(occurrences[0].perceiverCharacterIds).toEqual(["npc_1"]);
    expect(occurrences[0].facts[0].type).toBe("action_result");
    expect(occurrences[0].facts[0].content).toContain("actor is dead");
  });

  it("leaves the Engine's own occurrence alone when it emitted one", async () => {
    const resolve = stubResolve({ withOccurrence: true });
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
          connectionVotes: {},
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
