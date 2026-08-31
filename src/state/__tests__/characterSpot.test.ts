import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../DynamicGameState.js";
import { MAX_SPOT_LENGTH, normalizeSpot } from "../characterSpot.js";

describe("normalizeSpot", () => {
  it("strips square brackets rather than escaping them", () => {
    // The same string is printed into the renderer's prompt, where a bracket
    // means "a citable id". A module author writing "在[柜台]旁" would hand the
    // renderer a tag it may legally copy and the actor a citation the trust
    // boundary then rejects.
    expect(normalizeSpot("at the [ITEM_7] counter")).toBe(
      "at the ITEM_7 counter"
    );
  });

  it("collapses a multi-line value onto one line", () => {
    expect(normalizeSpot("at the workbench,\n  back to the door")).toBe(
      "at the workbench, back to the door"
    );
  });

  it("truncates at MAX_SPOT_LENGTH", () => {
    const long = "a".repeat(MAX_SPOT_LENGTH + 50);
    expect(normalizeSpot(long)).toHaveLength(MAX_SPOT_LENGTH);
  });

  it('returns "" for whitespace, brackets-only and non-strings', () => {
    expect(normalizeSpot("   ")).toBe("");
    expect(normalizeSpot("[]")).toBe("");
    expect(normalizeSpot(undefined)).toBe("");
    expect(normalizeSpot(42)).toBe("");
  });
});

describe("spot clearing follows the character out of a location", () => {
  const withSpot = (): DynamicGameStateManager => {
    const dgsm = new DynamicGameStateManager();
    dgsm.setCharacterPosition("npc_1", { type: "scene", sceneId: "SCN_1" });
    dgsm.setCharacterSpot("npc_1", "at the workbench, back to the door");
    return dgsm;
  };

  it("keeps the spot when repositioned inside the same scene", () => {
    // The delta said nothing about where in the room.
    const dgsm = withSpot();
    dgsm.setCharacterPosition("npc_1", { type: "scene", sceneId: "SCN_1" });
    expect(dgsm.getCharacterSpot("npc_1")).toBe(
      "at the workbench, back to the door"
    );
  });

  it("keeps the spot while interpolating along one road", () => {
    // roadId is unchanged, so the resolved location id is unchanged — a spot
    // like "keeping to the wall side" stays true for the whole leg.
    const dgsm = new DynamicGameStateManager();
    dgsm.setCharacterPosition("npc_1", {
      type: "road",
      roadId: "R_MAIN",
      position: 0.1,
    });
    dgsm.setCharacterSpot("npc_1", "keeping to the wall side");
    dgsm.setCharacterPosition("npc_1", {
      type: "road",
      roadId: "R_MAIN",
      position: 0.7,
    });
    expect(dgsm.getCharacterSpot("npc_1")).toBe("keeping to the wall side");
  });

  it("clears the spot scene -> scene", () => {
    const dgsm = withSpot();
    dgsm.setCharacterPosition("npc_1", { type: "scene", sceneId: "SCN_2" });
    expect(dgsm.getCharacterSpot("npc_1")).toBeNull();
  });

  it("clears the spot scene -> road and road -> scene", () => {
    const dgsm = withSpot();
    dgsm.setCharacterPosition("npc_1", {
      type: "road",
      roadId: "R_MAIN",
      position: 0,
    });
    expect(dgsm.getCharacterSpot("npc_1")).toBeNull();

    dgsm.setCharacterSpot("npc_1", "keeping to the wall side");
    dgsm.setCharacterPosition("npc_1", { type: "scene", sceneId: "SCN_2" });
    expect(dgsm.getCharacterSpot("npc_1")).toBeNull();
  });

  it("does not clear on the first position write of a character who had none", () => {
    // characterInjection may set position and spot in either order.
    const dgsm = new DynamicGameStateManager();
    dgsm.setCharacterSpot("npc_1", "in the corner armchair");
    dgsm.setCharacterPosition("npc_1", { type: "scene", sceneId: "SCN_1" });
    expect(dgsm.getCharacterSpot("npc_1")).toBe("in the corner armchair");
  });

  it("clears via an empty spot, and normalizes on the way in", () => {
    const dgsm = withSpot();
    dgsm.setCharacterSpot("npc_1", "   ");
    expect(dgsm.getCharacterSpot("npc_1")).toBeNull();

    dgsm.setCharacterSpot("npc_1", "  by the [window]  ");
    expect(dgsm.getCharacterSpot("npc_1")).toBe("by the window");
  });
});
