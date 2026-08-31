import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { SourcedWorldDelta } from "../../actions/types.js";
import { Applier } from "../applier.js";
import type { StateChange } from "../types.js";

// A real DGSM, not a stand-in: the clear-on-move rule lives in
// `setCharacterPosition`, so a mock cannot express the bug these tests exist
// to catch.
function makeDgsm(): DynamicGameStateManager {
  const dgsm = new DynamicGameStateManager();
  dgsm.updateNpcs([
    {
      id: "npc_1",
      name: "Marks White",
      status: { conditions: [] },
    } as never,
  ]);
  dgsm.setCharacterPosition("npc_1", { type: "scene", sceneId: "SCN_1" });
  return dgsm;
}

const spotDelta = (spot: string): SourcedWorldDelta => ({
  source: { kind: "action", actionId: "action_1" },
  causalBasis: "she settles at the workbench",
  delta: {
    domain: "character",
    characterId: "npc_1",
    operation: { kind: "spot", spot },
  },
});

describe("Applier — spot writes land after every position write", () => {
  it("survives the arrival it describes, in the same flush", () => {
    // The ordering hazard the whole feature turns on. `flush` builds
    // [...engineDeltas, ...inputChanges], and the movement runtime's final
    // `character.position` of a walk sits in inputChanges. Applied in delta
    // order the spot would be set, then wiped by `setCharacterPosition`
    // clearing on the very arrival it was describing — silently, on exactly
    // the tick it is most wanted.
    const dgsm = makeDgsm();

    new Applier(dgsm, new Map()).flush(
      [
        {
          kind: "character.position",
          characterId: "npc_1",
          position: { type: "scene", sceneId: "SCN_2" },
          sourceSubsystem: "movementRuntime",
        },
      ] as StateChange[],
      "1923-04-02T09:15:00",
      [spotDelta("at the workbench, back to the door")]
    );

    expect(dgsm.getCharacterSpot("npc_1")).toBe(
      "at the workbench, back to the door"
    );
  });

  it("applies a plain spot delta with no movement in the tick", () => {
    const dgsm = makeDgsm();

    new Applier(dgsm, new Map()).flush([], "1923-04-02T09:15:00", [
      spotDelta("in the corner armchair"),
    ]);

    expect(dgsm.getCharacterSpot("npc_1")).toBe("in the corner armchair");
  });

  it("takes the last write when a tick produces two", () => {
    // One slot, not an accumulation.
    const dgsm = makeDgsm();

    new Applier(dgsm, new Map()).flush([], "1923-04-02T09:15:00", [
      spotDelta("at the workbench"),
      spotDelta("by the window"),
    ]);

    expect(dgsm.getCharacterSpot("npc_1")).toBe("by the window");
  });

  it('clears on spot: "" and reports the change', () => {
    const dgsm = makeDgsm();
    dgsm.setCharacterSpot("npc_1", "at the workbench");

    const result = new Applier(dgsm, new Map()).flush(
      [],
      "1923-04-02T09:15:00",
      [spotDelta("")]
    );

    expect(dgsm.getCharacterSpot("npc_1")).toBeNull();
    expect(result.stateChanges).toHaveLength(1);
  });

  it("filters an empty clear against a character who has no spot", () => {
    const dgsm = makeDgsm();

    const result = new Applier(dgsm, new Map()).flush(
      [],
      "1923-04-02T09:15:00",
      [spotDelta("")]
    );

    expect(result.stateChanges).toHaveLength(0);
  });

  it("does NOT filter a repeat of the same phrase", () => {
    // Evaluated against the PRE-flush state, and a position change later in
    // the same flush can clear the spot in between — dropping the repeat
    // would leave the character with nothing.
    const dgsm = makeDgsm();
    dgsm.setCharacterSpot("npc_1", "at the workbench");

    const result = new Applier(dgsm, new Map()).flush(
      [
        {
          kind: "character.position",
          characterId: "npc_1",
          position: { type: "scene", sceneId: "SCN_2" },
          sourceSubsystem: "movementRuntime",
        },
      ] as StateChange[],
      "1923-04-02T09:15:00",
      [spotDelta("at the workbench")]
    );

    expect(result.stateChanges.some((c) => c.kind === "character.spot")).toBe(
      true
    );
    expect(dgsm.getCharacterSpot("npc_1")).toBe("at the workbench");
  });

  it("drops a spot naming a character who does not exist", () => {
    const dgsm = makeDgsm();

    const result = new Applier(dgsm, new Map()).flush(
      [],
      "1923-04-02T09:15:00",
      [
        {
          source: { kind: "action", actionId: "action_1" },
          causalBasis: "ghost",
          delta: {
            domain: "character",
            characterId: "npc_ghost",
            operation: { kind: "spot", spot: "by the door" },
          },
        },
      ]
    );

    expect(result.stateChanges).toHaveLength(0);
    expect(dgsm.getCharacterSpot("npc_ghost")).toBeNull();
  });
});
