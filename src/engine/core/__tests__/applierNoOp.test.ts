import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { Applier } from "../applier.js";
import type { StateChange } from "../types.js";

/** Minimal DGSM stand-in recording what actually reached the state layer. */
function makeDgsm(seed: {
  sceneConditions?: Record<string, Array<{ featureId: string; id?: string }>>;
  featureStates?: Record<string, unknown>;
  characterConditions?: Array<{ id: string; description: string }>;
  /** When set, only these character ids resolve via getNpcProfile. */
  knownCharacters?: string[];
}) {
  const applied: string[] = [];
  const dgsm = {
    getSceneConditions: (sceneId: string) =>
      seed.sceneConditions?.[sceneId] ?? [],
    removeSceneConditionsByFeatureId: (sceneId: string, featureId: string) =>
      applied.push(`removeScene:${sceneId}:${featureId}`),
    appendSceneCondition: (sceneId: string) =>
      applied.push(`addScene:${sceneId}`),
    getNpcProfile: (id: string) =>
      seed.knownCharacters && !seed.knownCharacters.includes(id)
        ? undefined
        : { status: { conditions: seed.characterConditions ?? [] } },
    removeCharacterCondition: (characterId: string, conditionId: string) =>
      applied.push(`removeChar:${characterId}:${conditionId}`),
    addCharacterCondition: (characterId: string) =>
      applied.push(`addChar:${characterId}`),
    getScopedFeatureState: (featureId: string, _scope: string, key: string) =>
      seed.featureStates?.[`${featureId}:${key}`],
    setScopedFeatureState: (featureId: string, _s: string, key: string) =>
      applied.push(`setFeature:${featureId}:${key}`),
    updateRelationship: (from: string, to: string) =>
      applied.push(`rel:${from}->${to}`),
  } as unknown as DynamicGameStateManager;

  return { dgsm, applied };
}

function flush(dgsm: DynamicGameStateManager, changes: StateChange[]) {
  return new Applier(dgsm, new Map()).flush(changes, "1923-04-02T09:15:00");
}

describe("Applier — no-op filtering", () => {
  it("drops a scene.removeCondition when no such condition exists", () => {
    // The sun observer emits this every tick regardless; 3 scenes x every tick
    // was the bulk of the noise in every tick record.
    const { dgsm, applied } = makeDgsm({ sceneConditions: { SCN_1: [] } });

    const result = flush(dgsm, [
      {
        kind: "scene.removeCondition",
        sceneId: "SCN_1",
        predicate: { featureId: "sun" },
      },
    ] as StateChange[]);

    expect(result.stateChanges).toHaveLength(0);
    expect(applied).toEqual([]);
  });

  it("keeps a scene.removeCondition that actually removes something", () => {
    const { dgsm, applied } = makeDgsm({
      sceneConditions: { SCN_1: [{ featureId: "sun" }] },
    });

    const result = flush(dgsm, [
      {
        kind: "scene.removeCondition",
        sceneId: "SCN_1",
        predicate: { featureId: "sun" },
      },
    ] as StateChange[]);

    expect(result.stateChanges).toHaveLength(1);
    expect(applied).toEqual(["removeScene:SCN_1:sun"]);
  });

  it("drops a feature.setState that writes the value already stored", () => {
    const { dgsm, applied } = makeDgsm({
      featureStates: {
        "stamina:npc_1": {
          fatigue: 1,
          fatigueLevel: 0,
          exhaustedDrainTicks: 0,
        },
      },
    });

    const result = flush(dgsm, [
      {
        kind: "feature.setState",
        featureId: "stamina",
        key: "npc_1",
        state: { fatigue: 1, fatigueLevel: 0, exhaustedDrainTicks: 0 },
      },
    ] as StateChange[]);

    expect(result.stateChanges).toHaveLength(0);
    expect(applied).toEqual([]);
  });

  it("keeps a feature.setState whose value differs", () => {
    const { dgsm, applied } = makeDgsm({
      featureStates: { "stamina:npc_1": { fatigue: 1 } },
    });

    const result = flush(dgsm, [
      {
        kind: "feature.setState",
        featureId: "stamina",
        key: "npc_1",
        state: { fatigue: 2 },
      },
    ] as StateChange[]);

    expect(result.stateChanges).toHaveLength(1);
    expect(applied).toEqual(["setFeature:stamina:npc_1"]);
  });

  it("keeps the first write of a feature state", () => {
    // initialState runs before anything is stored; undefined must not compare
    // equal to the initial value or subsystems would never initialise.
    const { dgsm, applied } = makeDgsm({});

    const result = flush(dgsm, [
      {
        kind: "feature.setState",
        featureId: "stamina",
        key: "npc_1",
        state: { fatigue: 0 },
      },
    ] as StateChange[]);

    expect(result.stateChanges).toHaveLength(1);
    expect(applied).toEqual(["setFeature:stamina:npc_1"]);
  });

  it("drops a character.removeCondition for a condition that is not present", () => {
    const { dgsm, applied } = makeDgsm({ characterConditions: [] });

    const result = flush(dgsm, [
      {
        kind: "character.removeCondition",
        characterId: "npc_1",
        conditionId: "c1",
      },
    ] as StateChange[]);

    expect(result.stateChanges).toHaveLength(0);
    expect(applied).toEqual([]);
  });

  it("never filters records that downstream consumers read", () => {
    // memory.* drives NpcActionController.routeResolverMemories and
    // relationship.change feeds the relationship graph — these are records,
    // not state writes, and must survive regardless.
    const { dgsm } = makeDgsm({});

    const result = flush(dgsm, [
      { kind: "memory.event", characterId: "npc_1", content: "x" },
      { kind: "memory.witness", characterId: "npc_2", content: "y" },
      {
        kind: "relationship.change",
        fromId: "npc_1",
        toId: "npc_2",
        delta: -2,
        note: "n",
      },
      {
        kind: "scene.addCondition",
        sceneId: "SCN_1",
        condition: { id: "c", description: "d" },
      },
    ] as StateChange[]);

    expect(result.stateChanges.map((c) => c.kind)).toEqual([
      "memory.event",
      "memory.witness",
      "relationship.change",
      "scene.addCondition",
    ]);
  });
});

describe("Applier — character id validation", () => {
  // The relationship operation is gone: what one character thinks of another
  // is theirs to write via `writeMemory`, not the Engine's to assert. It used
  // to be validated here because the resolver kept naming placeholder ids and
  // `updateRelationship` auto-created ghost nodes for them — a problem that
  // now cannot arise, because nothing reaches that function any more.
  it("still refuses a condition on a character that does not exist", () => {
    const { dgsm, applied } = makeDgsm({
      knownCharacters: ["Bruno Galilei", "Lux Lynch"],
    });

    const result = flush(dgsm, [
      {
        kind: "character.addCondition",
        characterId: "npc_colleague",
        condition: { id: "shaken", description: "rattled" },
      },
    ] as StateChange[]);

    expect(result.stateChanges).toHaveLength(0);
    expect(applied).toEqual([]);
  });
});
