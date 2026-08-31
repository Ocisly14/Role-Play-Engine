// A module authors a relationship as a dossier — third person, about the
// character rather than by them. Dropped into the memory block unchanged it
// sits among sentences the character wrote themselves and reads as somebody
// else's notes. And `relationshipType` and `attitude`, which the prose does
// not carry at all, were simply lost.

import { describe, expect, it } from "vitest";
import type { NPCRelationship } from "../../state/types.js";
import { buildRelationshipMemory } from "../relationshipMemory.js";

const rel = (over: Partial<NPCRelationship> = {}): NPCRelationship => ({
  targetId: "Simon Laplace",
  targetName: "Simon Laplace",
  relationshipType: "friend",
  attitude: 90,
  description: "Her closest companion and protector.",
  ...over,
});

describe("buildRelationshipMemory", () => {
  it("states the stance the raw prose never carried", () => {
    const built = buildRelationshipMemory(rel(), "en");
    expect(built?.content).toContain("a friend");
    expect(built?.content).toContain("trust them with anything");
    // The author's own writing survives verbatim — it is the only part that
    // says anything specific.
    expect(built?.content).toContain("Her closest companion and protector.");
  });

  it("turns the attitude number into something a person would think", () => {
    const warmths = [90, 40, 0, -50, -90].map(
      (attitude) => buildRelationshipMemory(rel({ attitude }), "en")?.content
    );
    expect(new Set(warmths).size).toBe(5);
    for (const w of warmths) expect(w).not.toMatch(/\d/);
  });

  it("keeps the target joinable while naming them as the holder does", () => {
    const built = buildRelationshipMemory(
      rel({ targetId: "npc_17", targetName: "the tall pale man" }),
      "en"
    );
    expect(built?.targetId).toBe("npc_17");
    expect(built?.content).toContain("the tall pale man");
    expect(built?.content).not.toContain("npc_17");
  });

  it("still says something when the module wrote no prose", () => {
    const built = buildRelationshipMemory(
      rel({ description: undefined, history: undefined }),
      "en"
    );
    expect(built?.content).toContain("a friend");
  });

  it("skips an entry with no target", () => {
    expect(buildRelationshipMemory(rel({ targetId: "" }), "en")).toBeNull();
  });
});
