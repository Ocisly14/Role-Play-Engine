import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { ScriptedEvent } from "../../scriptedEvents/types.js";
import { type TickEngine, createTickEngine } from "../tickEngine.js";

/**
 * Integration tests for ScriptedEventRunner — see plan §C-testing.
 * Three end-to-end scenarios exercising tracker accumulation, cascade,
 * and DGSM-based persistence.
 */

interface TestEngine {
  dgsm: DynamicGameStateManager;
  engine: TickEngine;
  seedNpc: (id: string, sceneId: string) => void;
  submitAndTick: (
    npcId: string,
    actionText: string,
    definitionId: string,
    sceneId: string
  ) => Promise<void>;
}

function makeTestEngine(
  events: ScriptedEvent[],
  existingDgsm?: DynamicGameStateManager
): TestEngine {
  const dgsm = existingDgsm ?? new DynamicGameStateManager();

  const engine = createTickEngine({
    dgsm,
    features: [],
    scriptedEvents: events,
    emergentScanners: [],
    interpretAction: async (input) => ({
      steps: [
        {
          definitionId:
            (input.overlayFields?.__definitionId as string) ?? "noop",
          actionText: input.actionText,
          impact: 0,
        } as never,
      ],
    }),
    resolve: async () => ({
      outcome: { stateChanges: [], elapsedMinutes: 0 } as never,
      plannedDuration: 0,
    }),
    getActorDex: () => 50,
    tickDurationMinutes: 1,
    lang: "en",
  });

  function seedNpc(id: string, sceneId: string): void {
    dgsm.registerNpcProfile({
      id,
      name: id,
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
    dgsm.setCharacterPosition(id, { type: "scene", sceneId });
    dgsm.ensureScene(sceneId);
  }

  async function submitAndTick(
    npcId: string,
    actionText: string,
    definitionId: string,
    sceneId: string
  ): Promise<void> {
    await engine.submitAction({
      characterId: npcId,
      actionText,
      sceneId,
      overlayFields: { __definitionId: definitionId },
    });
    await engine.tick();
  }

  return { dgsm, engine, seedNpc, submitAndTick };
}

describe("ScriptedEventRunner — integration", () => {
  it("fires onComplete when fireWhen + tracker condition met across ticks", async () => {
    const event: ScriptedEvent = {
      id: "ritual",
      label: "Altar Ritual",
      trackers: [
        { id: "pray", kind: "actionCount", match: { definitionId: "pray" } },
      ],
      fireWhen: {
        op: "trackerCount",
        trackerId: "pray",
        cmp: "gte",
        value: 3,
      },
      onComplete: [
        {
          kind: "character.san",
          targetFilter: { op: "atScene", sceneId: "altar" },
          delta: -10,
        },
      ],
    };
    const { dgsm, seedNpc, submitAndTick } = makeTestEngine([event]);
    seedNpc("priest", "altar");
    seedNpc("witness1", "altar");
    seedNpc("witness2", "altar");

    await submitAndTick("priest", "pray at altar", "pray", "altar");
    expect(
      dgsm.getScriptedEventState("ritual")?.trackerStates.pray
    ).toMatchObject({
      kind: "actionCount",
      count: 1,
    });
    expect(dgsm.getScriptedEventState("ritual")?.status).toBe("active");

    await submitAndTick("priest", "pray at altar", "pray", "altar");
    expect(
      dgsm.getScriptedEventState("ritual")?.trackerStates.pray
    ).toMatchObject({
      kind: "actionCount",
      count: 2,
    });
    expect(dgsm.getScriptedEventState("ritual")?.status).toBe("active");

    await submitAndTick("priest", "pray at altar", "pray", "altar");

    expect(dgsm.getScriptedEventState("ritual")?.status).toBe("completed");
    expect(dgsm.getNpcProfile("priest")?.status.san).toBe(40);
    expect(dgsm.getNpcProfile("witness1")?.status.san).toBe(40);
    expect(dgsm.getNpcProfile("witness2")?.status.san).toBe(40);
  });

  it("cascade: event A completion triggers event B same tick via eventStatus predicate", async () => {
    const events: ScriptedEvent[] = [
      {
        id: "A",
        label: "Event A",
        fireWhen: {
          op: "actionCommittedThisTick",
          match: { definitionId: "ritual" },
        },
        onComplete: [
          { kind: "event.transition", otherEventId: "B", to: "active" },
        ],
      },
      {
        id: "B",
        label: "Event B",
        initialStatus: "disabled",
        fireWhen: {
          op: "eventStatus",
          otherEventId: "A",
          isStatus: "completed",
        },
        onComplete: [
          {
            kind: "character.san",
            targetFilter: { op: "alive", expectedAlive: true },
            delta: -5,
          },
        ],
      },
    ];
    const { dgsm, seedNpc, submitAndTick } = makeTestEngine(events);
    seedNpc("npc1", "any");

    await submitAndTick("npc1", "perform ritual", "ritual", "any");

    expect(dgsm.getScriptedEventState("A")?.status).toBe("completed");
    expect(dgsm.getScriptedEventState("B")?.status).toBe("completed");
    expect(dgsm.getNpcProfile("npc1")?.status.san).toBe(45);
  });

  it("DGSM persistence: state survives serialize/rehydrate cycle", async () => {
    const event: ScriptedEvent = {
      id: "ritual",
      label: "Altar Ritual",
      trackers: [
        { id: "pray", kind: "actionCount", match: { definitionId: "pray" } },
      ],
      fireWhen: {
        op: "trackerCount",
        trackerId: "pray",
        cmp: "gte",
        value: 3,
      },
      onComplete: [
        {
          kind: "character.san",
          targetFilter: { op: "atScene", sceneId: "altar" },
          delta: -10,
        },
      ],
    };
    const setup1 = makeTestEngine([event]);
    setup1.seedNpc("priest", "altar");
    await setup1.submitAndTick("priest", "pray", "pray", "altar");
    await setup1.submitAndTick("priest", "pray", "pray", "altar");

    expect(
      setup1.dgsm.getScriptedEventState("ritual")?.trackerStates.pray
    ).toMatchObject({ kind: "actionCount", count: 2 });
    expect(setup1.dgsm.getScriptedEventState("ritual")?.status).toBe("active");
    // Priest's SAN should be unchanged (event hasn't fired yet).
    expect(setup1.dgsm.getNpcProfile("priest")?.status.san).toBe(50);

    // Serialize + rehydrate.
    const serialized = setup1.dgsm.serialize();
    expect(serialized.scriptedEventStates.ritual.trackerStates.pray.count).toBe(
      2
    );

    const jsonRoundTripped = JSON.parse(JSON.stringify(serialized));
    const rehydrated = DynamicGameStateManager.deserialize(jsonRoundTripped);
    const dgsm2 = new DynamicGameStateManager(rehydrated);

    // Sanity: rehydrated tracker state survives round-trip.
    expect(
      dgsm2.getScriptedEventState("ritual")?.trackerStates.pray
    ).toMatchObject({ kind: "actionCount", count: 2 });
    expect(dgsm2.getNpcProfile("priest")?.name).toBe("priest");

    // Build a new engine pointing at the rehydrated DGSM.
    const setup2 = makeTestEngine([event], dgsm2);

    // Submit 3rd pray on new engine → should trigger completion.
    await setup2.submitAndTick("priest", "pray", "pray", "altar");

    expect(dgsm2.getScriptedEventState("ritual")?.status).toBe("completed");
    expect(dgsm2.getNpcProfile("priest")?.status.san).toBe(40);
  });
});
