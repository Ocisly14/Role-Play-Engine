import { describe, expect, it, vi } from "vitest";
import { stripUncitableTags } from "../llmRenderer.js";

const allowed = new Set([
  "stranger_a",
  "ITEM_7",
  "SCN_LIBRARY",
  "connection.library.stacks",
]);

describe("stripUncitableTags", () => {
  it("keeps tags the actor may cite", () => {
    const text =
      "The tall pale man [stranger_a] sets a brass key [ITEM_7] on the counter.";
    expect(stripUncitableTags(text, allowed, "npc_1")).toBe(text);
  });

  it("drops an invented tag and the space before it, keeping the prose", () => {
    // The renderer is a SMALL model copying ids by hand. A tag it made up
    // would pass the prompt and die at the trust boundary a turn later, as a
    // rejection the character can do nothing about.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = stripUncitableTags(
      "The tall pale man [Hollins] sets a brass key [ITEM_7] down.",
      allowed,
      "npc_1"
    );

    expect(out).toBe("The tall pale man sets a brass key [ITEM_7] down.");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("keeps an exit tag — doors are citable as themselves", () => {
    const text =
      "A stairway rises behind the desk [connection.library.stacks], its rail worn smooth.";
    expect(stripUncitableTags(text, allowed, "npc_1")).toBe(text);
  });

  it("leaves a narrative with no tags untouched", () => {
    const text = "Rain ticks against the window and the room smells of dust.";
    expect(stripUncitableTags(text, allowed, "npc_1")).toBe(text);
  });
});
