import { describe, expect, it, vi } from "vitest";
import {
  normalizeTagBrackets,
  repairNearMissTags,
  resolveNearMissTag,
  scrubStrangerCanonicalLabels,
  strangerCanonicalLabelViolations,
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

describe("normalizeTagBrackets", () => {
  it("folds a full-width bracket into the ASCII tag", () => {
    // Measured live: `妈妈【npc_susan_holt】` — the id copied exactly, the
    // bracket taken from the input method. Left alone it is not a tag, so
    // the strip never sees it and the actor reads an id they cannot cite.
    expect(normalizeTagBrackets("妈妈【npc_susan_holt】跪在床边")).toBe(
      "妈妈[npc_susan_holt]跪在床边"
    );
    expect(normalizeTagBrackets("台灯［item.holt_denny.desk_lamp］亮着")).toBe(
      "台灯[item.holt_denny.desk_lamp]亮着"
    );
  });

  it("leaves ASCII tags and bracketless prose untouched", () => {
    const text = "The tall pale man [stranger_a] says nothing.";
    expect(normalizeTagBrackets(text)).toBe(text);
  });

  it("feeds the strip, so a wide-bracketed real id survives and a fake one is dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = stripUncitableTags(
      normalizeTagBrackets("妈妈【stranger_a】把书【Hollins】递过来"),
      allowed,
      "npc_1"
    );
    expect(out).toBe("妈妈 [stranger_a]把书递过来");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("stranger identity firewall", () => {
  const identities = [
    {
      alias: "stranger_a",
      canonicalName: "Tommy Miller",
      description: "the lean, taller man",
    },
  ];

  it("detects a first or full canonical name bound to a stranger alias", () => {
    expect(
      strangerCanonicalLabelViolations(
        "Tommy [stranger_a] watches the door.",
        identities
      )
    ).toEqual(["Tommy [stranger_a]"]);
    expect(
      strangerCanonicalLabelViolations(
        "Tommy Miller [stranger_a] watches the door.",
        identities
      )
    ).toContain("Tommy Miller [stranger_a]");
  });

  it("replaces the forbidden name-label binding with the unknown description", () => {
    expect(
      scrubStrangerCanonicalLabels(
        "Tommy [stranger_a] watches the door.",
        identities
      )
    ).toBe("the lean, taller man [stranger_a] watches the door.");
  });

  it("preserves an audibly spoken name that is not asserted as the stranger's label", () => {
    const text =
      'Someone says "Tommy"; the lean, taller man [stranger_a] watches the door.';
    expect(scrubStrangerCanonicalLabels(text, identities)).toBe(text);
  });
});
