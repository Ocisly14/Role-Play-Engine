import { describe, expect, it } from "vitest";
import type { StateChange } from "../../core/types.js";
import type { ResolverValidRefs } from "../stateContextBuilder.js";
import { invalidRefsOf } from "../stateResolver.js";

// Every failure mode below was observed live before the validator existed:
// item.destroy citing a staged condition's featureId ("sim_stage"),
// relationship.change / memory.witness naming invented characters, and
// item.move handing an item to a holder DGSM would auto-create an inventory
// for. The validator is the resolver-side gate that turns those into retry
// feedback instead of silent Applier drops.

const refs: ResolverValidRefs = {
  characterIds: new Set(["Solomon", "Angela"]),
  itemIds: new Set(["ITEM_1", "PROP_KEY_1_0"]),
  sceneIds: new Set(["SCN_1", "SCN_2"]),
  junctionIds: new Set(["J_1"]),
  executionSceneId: "SCN_1",
};

function errs(c: StateChange): string[] {
  return invalidRefsOf(c, refs);
}

describe("invalidRefsOf", () => {
  it("accepts changes whose ids all exist", () => {
    expect(
      errs({
        kind: "memory.event",
        characterId: "Solomon",
        content: "x",
      } as StateChange)
    ).toEqual([]);
    expect(
      errs({ kind: "item.destroy", itemId: "ITEM_1" } as StateChange)
    ).toEqual([]);
    expect(
      errs({
        kind: "scene.addCondition",
        sceneId: "SCN_1",
        condition: { description: "x" },
      } as StateChange)
    ).toEqual([]);
    expect(
      errs({
        kind: "item.move",
        itemId: "PROP_KEY_1_0",
        from: "scene:SCN_1",
        to: "Angela",
      } as StateChange)
    ).toEqual([]);
    expect(
      errs({
        kind: "item.move",
        itemId: "ITEM_1",
        from: "Angela",
        to: "scene:SCN_2",
      } as StateChange)
    ).toEqual([]);
  });

  it("rejects a fabricated character on memory/relationship changes", () => {
    expect(
      errs({
        kind: "memory.witness",
        characterId: "witness",
        content: "x",
      } as StateChange)
    ).toHaveLength(1);
    expect(
      errs({
        kind: "relationship.change",
        fromId: "Solomon",
        toId: "unknown_target",
      } as unknown as StateChange)
    ).toHaveLength(1);
  });

  it("rejects a non-item id cited as itemId (the sim_stage case)", () => {
    expect(
      errs({ kind: "item.destroy", itemId: "sim_stage" } as StateChange)
    ).toHaveLength(1);
    expect(
      errs({
        kind: "item.modify",
        itemId: "item_",
        description: "x",
      } as StateChange)
    ).toHaveLength(1);
  });

  it("rejects item.move to a holder or scene that does not exist", () => {
    expect(
      errs({
        kind: "item.move",
        itemId: "ITEM_1",
        from: "scene:SCN_1",
        to: "some_stranger",
      } as StateChange)
    ).toHaveLength(1);
    expect(
      errs({
        kind: "item.move",
        itemId: "ITEM_1",
        from: "Angela",
        to: "scene:SCN_404",
      } as StateChange)
    ).toHaveLength(1);
  });

  it("item.create accepts both holder forms and rejects fabricated ones", () => {
    // Same holder grammar as item.move's `to`: "scene:<id>" or a character id.
    expect(
      errs({
        kind: "item.create",
        name: "x",
        location: "scene:SCN_1",
      } as StateChange)
    ).toEqual([]);
    expect(
      errs({
        kind: "item.create",
        name: "x",
        location: "Angela",
      } as StateChange)
    ).toEqual([]);
    // Observed live: the resolver putting the item's NAME in `location`.
    expect(
      errs({
        kind: "item.create",
        name: "Modified Jacket",
        location: "Modified Jacket",
      } as StateChange)
    ).toHaveLength(1);
    expect(
      errs({
        kind: "item.create",
        name: "x",
        location: "scene:SCN_404",
      } as StateChange)
    ).toHaveLength(1);
  });

  it("rejects fabricated scenes and reports multiple violations at once", () => {
    expect(
      errs({
        kind: "scene.addCondition",
        sceneId: "SCN_404",
        condition: { description: "x" },
      } as StateChange)
    ).toHaveLength(1);
    expect(
      errs({
        kind: "item.move",
        itemId: "ghost_item",
        from: "scene:SCN_1",
        to: "some_stranger",
      } as StateChange)
    ).toHaveLength(2);
  });

  it("validates character.position against scenes and junctions", () => {
    expect(
      errs({
        kind: "character.position",
        characterId: "Solomon",
        position: { type: "scene", sceneId: "SCN_2" },
        sourceSubsystem: "resolver",
      } as StateChange)
    ).toEqual([]);
    expect(
      errs({
        kind: "character.position",
        characterId: "Solomon",
        position: { type: "junction", junctionId: "J_404" },
        sourceSubsystem: "resolver",
      } as StateChange)
    ).toHaveLength(1);
  });

  it("ignores subsystem-only kinds the resolver does not emit", () => {
    expect(
      errs({
        kind: "feature.setState",
        featureId: "fire",
        key: "k",
        state: 1,
      } as StateChange)
    ).toEqual([]);
  });
});
