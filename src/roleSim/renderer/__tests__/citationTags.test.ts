import { describe, expect, it, vi } from "vitest";
import {
  repairNearMissTags,
  resolveNearMissTag,
  stripUncitableTags,
} from "../llmRenderer.js";

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

describe("resolveNearMissTag", () => {
  // The exact id set these cases come from, as the module spells them.
  const grayhaven = new Set([
    "SCN_motel_porch",
    "SCN_motel_lobby",
    "item.reyes_living.radio",
    "item.reyes_tommy.comic_stack",
    "item.reyes_tommy.savings_jar",
    "item.reyes_tommy.spare_grips",
    "item.bluebird_kitchen.old_oven",
  ]);

  it("repairs a one-key slip", () => {
    // Observed live, three times: SCM for SCN. Asking the model to fix this
    // costs a whole corrective round trip.
    expect(resolveNearMissTag("SCM_motel_porch", grayhaven)).toBe(
      "SCN_motel_porch"
    );
  });

  it("refuses to repair one thing into a DIFFERENT thing", () => {
    // Also observed live: the renderer wrote `item.reyes_tommy_radio` for
    // what the module calls `item.reyes_living.radio` — the living-room set,
    // not Tommy's. Repairing that would silently hand the actor the wrong
    // object, which is worse than dropping the tag.
    expect(resolveNearMissTag("item.reyes_tommy_radio", grayhaven)).toBeNull();
  });

  it("refuses an outright invention with no near neighbour", () => {
    expect(resolveNearMissTag("item.reyes_tommy_walkie", grayhaven)).toBeNull();
  });

  it("refuses when two candidates are equally close", () => {
    // A coin flip between two real ids is not a repair. Both are one edit
    // from the candidate, so neither wins by the margin.
    const ambiguous = new Set(["ITEM_A1", "ITEM_B1"]);
    expect(resolveNearMissTag("ITEM_X1", ambiguous)).toBeNull();
  });

  it("never invents reach: only allowed ids are candidates", () => {
    // The real id exists in the module but not in THIS actor's allowed set.
    expect(
      resolveNearMissTag("SCN_motel_porc", new Set(["SCN_LIBRARY"]))
    ).toBeNull();
  });
});

describe("repairNearMissTags", () => {
  const allowed2 = new Set(["SCN_motel_porch", "item.reyes_living.radio"]);

  it("rewrites the slip in place and leaves the prose alone", () => {
    const text = "I stop on the porch [SCM_motel_porch] and listen.";
    expect(repairNearMissTags(text, allowed2, "npc_1")).toBe(
      "I stop on the porch [SCN_motel_porch] and listen."
    );
  });

  it("leaves a legal tag untouched", () => {
    const text = "The radio [item.reyes_living.radio] mutters on.";
    expect(repairNearMissTags(text, allowed2, "npc_1")).toBe(text);
  });

  it("leaves a genuinely wrong tag for the caller to drop", () => {
    const text = "He clips the walkie [item.reyes_tommy_walkie] to his belt.";
    expect(repairNearMissTags(text, allowed2, "npc_1")).toBe(text);
  });
});
