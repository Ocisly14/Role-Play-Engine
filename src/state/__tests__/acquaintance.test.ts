// Knowing WHO someone is, and having a view of them, are different facts.
// They used to be one: `isKnownTo` meant "has a relationship entry", so the
// moment a shopkeeper recorded that a customer made her uneasy, the renderer
// started calling him by his full legal name — which nobody had said to her.
// She then wrote down that she had "learned his name", believing she heard it.

import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../DynamicGameState.js";
import { isKnownTo, knownAs } from "../perceivableDirectory.js";

function makeDgsm(): DynamicGameStateManager {
  return new DynamicGameStateManager({
    npcRelationshipGraph: {},
    npcCharacters: [
      { id: "npc_1", name: "Nancy" },
      { id: "npc_2", name: "Philip Scaletta" },
    ],
  } as never);
}

describe("an opinion is not an introduction", () => {
  it("leaves someone unknown after a view is recorded about them", () => {
    const dgsm = makeDgsm();
    dgsm.updateRelationship("npc_1", "npc_2", -5, "He keeps eyeing the till.");

    expect(isKnownTo(dgsm, "npc_1", "npc_2")).toBe(false);
    expect(knownAs(dgsm, "npc_1", "npc_2")).toBeUndefined();
  });

  it("makes them known once a name is recorded", () => {
    const dgsm = makeDgsm();
    dgsm.updateRelationship("npc_1", "npc_2", 0, "He gave a name.", "Philip");

    expect(isKnownTo(dgsm, "npc_1", "npc_2")).toBe(true);
    // What SHE calls him, which need not be what is on his papers.
    expect(knownAs(dgsm, "npc_1", "npc_2")).toBe("Philip");
  });

  it("keeps the name once learned, through later revisions", () => {
    const dgsm = makeDgsm();
    dgsm.updateRelationship("npc_1", "npc_2", 0, "He gave a name.", "Philip");
    dgsm.updateRelationship("npc_1", "npc_2", -20, "He lied to me.");

    expect(knownAs(dgsm, "npc_1", "npc_2")).toBe("Philip");
  });

  it("never makes the other party know anything", () => {
    // A relationship is a private reading. That she has taken a view of him,
    // and even learned his name, says nothing about what he knows of her.
    const dgsm = makeDgsm();
    dgsm.updateRelationship("npc_1", "npc_2", 0, "He gave a name.", "Philip");

    expect(dgsm.getRelationship("npc_2", "npc_1")).toBeUndefined();
    expect(isKnownTo(dgsm, "npc_2", "npc_1")).toBe(false);
  });
});
