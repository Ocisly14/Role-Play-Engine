// Trust-boundary tests: raw `act` args → validated args → trusted
// ActionCommand. Covers required/optional fields, object-ref roles, duration
// boundaries, perceivable-scope enforcement, envelope non-forgeability and
// the immediate-skill-roll invariant (declaredSkillId ⇔ skillRoll).

import { describe, expect, it, vi } from "vitest";
import { buildActionCommand } from "../commandBuilder.js";
import {
  MAX_PROPOSED_DURATION_TICKS,
  validateActArgs,
} from "../commandValidator.js";
import { resolveSkillValue, successLevelFor } from "../skillRollService.js";

/** A stranger is cited by alias; only the world resolver knows the real id. */
const HOLLINS_ALIAS = "stranger_a";

/** The world beyond what the actor can currently see. `ITEM_FAR` and
 *  `SCN_FAR` exist but are nowhere near them — the boundary lets those
 *  through now, because "still within reach?" is the Engine's question. */
const world = {
  resolveCharacter: (handle: string) =>
    handle === HOLLINS_ALIAS
      ? "Hollins"
      : handle === "stranger_faraway"
        ? "Marsh"
        : undefined,
  hasItem: (id: string) => ["ITEM_1", "cabinet_lock", "ITEM_FAR"].includes(id),
  hasPlace: (id: string) => ["SCN_1", "SCN_2", "SCN_FAR"].includes(id),
};

function args(overrides: Record<string, unknown> = {}) {
  return {
    description: "I try to pick the lock with my picks.",
    objectRefs: [{ kind: "item", id: "cabinet_lock", role: "target" }],
    proposedDurationTicks: 3,
    ...overrides,
  };
}

describe("validateActArgs", () => {
  it("accepts a well-formed command and normalizes strings", () => {
    const result = validateActArgs(
      args({ description: "  padded  ", utterance: "hello" }),
      world
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.description).toBe("padded");
    expect(result.args.utterance).toBe("hello");
    expect(result.args.objectRefs).toEqual([
      { kind: "item", id: "cabinet_lock", role: "target" },
    ]);
  });

  it("accepts an empty objectRefs array", () => {
    const result = validateActArgs(args({ objectRefs: [] }), world);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["non-string", 42],
  ])("rejects %s description", (_label, description) => {
    const result = validateActArgs(args({ description }), world);
    expect(result).toMatchObject({ ok: false, code: "invalid_description" });
  });

  it("rejects missing objectRefs (must be [] when none)", () => {
    const result = validateActArgs(args({ objectRefs: undefined }), world);
    expect(result).toMatchObject({ ok: false, code: "invalid_object_refs" });
  });

  it("ignores the kind label entirely — the id decides", () => {
    // A nonsense label on a real id costs nothing.
    const labelled = validateActArgs(
      args({ objectRefs: [{ kind: "monster", id: "ITEM_1" }] }),
      world
    );
    expect(labelled.ok).toBe(true);
    if (!labelled.ok) return;
    expect(labelled.args.objectRefs[0].kind).toBe("item");

    // And no label at all is fine too.
    const bare = validateActArgs(
      args({ objectRefs: [{ id: "SCN_1", role: "destination" }] }),
      world
    );
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.args.objectRefs[0].kind).toBe("scene");
  });

  it("rejects a ref with an invalid role", () => {
    const result = validateActArgs(
      args({ objectRefs: [{ kind: "item", id: "ITEM_1", role: "weapon" }] }),
      world
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_object_refs" });
  });

  it("accepts every legal role and a role-less ref", () => {
    for (const role of ["target", "tool", "destination", "recipient"]) {
      const result = validateActArgs(
        args({ objectRefs: [{ kind: "item", id: "ITEM_1", role }] }),
        world
      );
      expect(result.ok).toBe(true);
    }
    const bare = validateActArgs(
      args({ objectRefs: [{ kind: "item", id: "ITEM_1" }] }),
      world
    );
    expect(bare.ok).toBe(true);
  });

  it("rejects a ref outside the perceivable scope", () => {
    const result = validateActArgs(
      args({ objectRefs: [{ kind: "character", id: "Nyarlathotep" }] }),
      world
    );
    expect(result).toMatchObject({ ok: false, code: "unknown_ref" });
    if (result.ok) return;
    expect(result.reason).toContain("Nyarlathotep");
  });

  it("rejects an exit id — connections are not a citable space", () => {
    // A passage is topology bookkeeping: the prose points at the place a
    // door leads to, and a door that matters as an object is an item. An
    // `connection.*` id therefore names nothing an actor may cite.
    const result = validateActArgs(
      args({ objectRefs: [{ id: "connection.scn1.door", role: "destination" }] }),
      world
    );
    expect(result).toMatchObject({ ok: false, code: "unknown_ref" });
  });

  it("resolves a mislabelled real id by the id, not the label", () => {
    // The door tagged with the id of the room it stands in came back as an
    // `item`, was refused as "not an item in this world" — it was a scene,
    // and it existed — and the retry re-pointed the action at an unrelated
    // statue. The label is a guess about a real thing; the id is the thing.
    const result = validateActArgs(
      args({ objectRefs: [{ kind: "character", id: "ITEM_1" }] }),
      world
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.objectRefs[0]).toMatchObject({
      kind: "item",
      id: "ITEM_1",
    });
  });

  it("resolves a stranger's alias to the real id", () => {
    const result = validateActArgs(
      args({
        objectRefs: [{ kind: "character", id: HOLLINS_ALIAS, role: "target" }],
      }),
      world
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.objectRefs).toEqual([
      { kind: "character", id: "Hollins", role: "target" },
    ]);
  });

  it("rejects the real character id — the actor is never given it", () => {
    const result = validateActArgs(
      args({ objectRefs: [{ kind: "character", id: "Hollins" }] }),
      world
    );
    expect(result).toMatchObject({ ok: false, code: "unknown_ref" });
  });

  it.each([
    ["zero", 0],
    ["negative", -3],
    ["fractional", 1.5],
    ["above cap", MAX_PROPOSED_DURATION_TICKS + 1],
    ["missing", undefined],
    ["string", "3"],
  ])("rejects %s proposedDurationTicks", (_label, proposedDurationTicks) => {
    const result = validateActArgs(args({ proposedDurationTicks }), world);
    expect(result).toMatchObject({ ok: false, code: "invalid_duration" });
  });

  it("accepts the duration boundaries", () => {
    expect(validateActArgs(args({ proposedDurationTicks: 1 }), world).ok).toBe(
      true
    );
    expect(
      validateActArgs(
        args({ proposedDurationTicks: MAX_PROPOSED_DURATION_TICKS }),
        world
      ).ok
    ).toBe(true);
  });

  it("drops an empty skillId instead of failing", () => {
    const result = validateActArgs(args({ skillId: "  " }), world);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.skillId).toBeUndefined();
  });
});

describe("skillRollService", () => {
  it("resolves a trained skill case-insensitively", () => {
    expect(
      resolveSkillValue("stealth & security", { "Stealth & Security": 60 })
    ).toEqual({
      canonicalSkillId: "Stealth & Security",
      value: 60,
    });
  });

  it("falls back to the base value for an untrained known domain", () => {
    expect(resolveSkillValue("Stealth & Security", {})).toEqual({
      canonicalSkillId: "Stealth & Security",
      value: 10,
    });
  });

  it("returns undefined for an unknown skill name", () => {
    expect(resolveSkillValue("Underwater Basketweaving", {})).toBeUndefined();
  });

  it("grades the six-level success ladder at its boundaries", () => {
    // skillValue 60: extreme ≤ 12, hard ≤ 30, regular ≤ 60.
    expect(successLevelFor(1, 60)).toBe("critical");
    expect(successLevelFor(12, 60)).toBe("extreme");
    expect(successLevelFor(13, 60)).toBe("hard");
    expect(successLevelFor(30, 60)).toBe("hard");
    expect(successLevelFor(31, 60)).toBe("regular");
    expect(successLevelFor(60, 60)).toBe("regular");
    expect(successLevelFor(61, 60)).toBe("failure");
    expect(successLevelFor(98, 60)).toBe("fumble");
  });
});

// ── commandBuilder: envelope + immediate roll ─────────────────────────────

vi.mock("../../../state/perceivableDirectory.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../../state/perceivableDirectory.js"
  );
  return {
    ...actual,
    buildPerceivableDirectory: () => ({
      characters: new Set(["Hollins"]),
      characterHandles: new Map([[HOLLINS_ALIAS, "Hollins"]]),
      items: new Set(["ITEM_1", "cabinet_lock"]),
      scenes: new Set(["SCN_1", "SCN_2"]),
    }),
  };
});

const dgsm = {
  getGameDateTime: () => "1923-04-02T09:15:00",
  getCharacterPosition: () => ({ kind: "scene", sceneId: "SCN_1" }),
  resolveLocationId: () => "SCN_1",
  getNpcProfile: () => ({ skills: { "Stealth & Security": 60 } }),
  hasItem: (id: string) => ["ITEM_1", "cabinet_lock"].includes(id),
  getState: () => ({
    scenes: new Map([
      ["SCN_1", { items: [{ id: "cabinet_lock" }, { id: "ITEM_1" }] }],
    ]),
    npcInventories: {},
    // Every ref is probed against all three id spaces now, so even an item
    // citation reaches the character resolver.
    npcCharacters: [],
  }),
  getScene: (id: string) => (id === "SCN_1" || id === "SCN_2" ? {} : null),
  getJunction: () => null,
  getRoad: () => null,
} as never;

describe("buildActionCommand", () => {
  it("stamps the trusted envelope from live state, ignoring model input", () => {
    // Even if the model smuggles envelope fields into its args, they are
    // not read — the builder only consumes intent fields.
    const result = buildActionCommand(
      "npc_1",
      args({
        actorId: "someone_else",
        issuedAt: "1666-01-01T00:00:00",
        issuedSceneId: "SCN_FORGED",
        commandId: "forged",
        replacesActionId: "forged_action",
      }),
      { dgsm }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.actorId).toBe("npc_1");
    expect(result.command.issuedAt).toBe("1923-04-02T09:15:00");
    expect(result.command.issuedSceneId).toBe("SCN_1");
    expect(result.command.commandId).not.toBe("forged");
    expect(result.command.replacesActionId).toBeUndefined();
  });

  it("sets replacesActionId only from the engine-side dep", () => {
    const result = buildActionCommand("npc_1", args(), {
      dgsm,
      replacesActionId: "action_live",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.replacesActionId).toBe("action_live");
  });

  it("settles the skill's NAME at intake and rolls nothing", () => {
    // The dice wait for the action to run its course. Rolling here would put
    // a number in front of the Engine while it is still choosing the
    // difficulty — the one thing the two-moment contract exists to prevent.
    const result = buildActionCommand(
      "npc_1",
      args({ skillId: "stealth & security" }),
      { dgsm }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.declaredSkillId).toBe("Stealth & Security");
    expect(result.command.skillRoll).toBeUndefined();
  });

  it("accepts an untrained but known domain", () => {
    // Base values make every domain usable; whether it was trained only
    // matters when code rolls it later.
    const noSkills = {
      ...(dgsm as Record<string, unknown>),
      getNpcProfile: () => ({ skills: {} }),
    } as never;
    const result = buildActionCommand(
      "npc_1",
      args({ skillId: "Investigation" }),
      { dgsm: noSkills }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.declaredSkillId).toBe("Investigation");
  });

  it("rejects an unknown skill name without rolling", () => {
    const result = buildActionCommand(
      "npc_1",
      args({ skillId: "Underwater Basketweaving" }),
      { dgsm }
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_skill" });
  });

  it("emits no skill fields when no skillId is declared", () => {
    const result = buildActionCommand("npc_1", args(), { dgsm });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.declaredSkillId).toBeUndefined();
    expect(result.command.skillRoll).toBeUndefined();
  });

  it("returns the validator rejection for an out-of-scope ref", () => {
    const result = buildActionCommand(
      "npc_1",
      args({ objectRefs: [{ kind: "scene", id: "SCN_UNSEEN" }] }),
      { dgsm }
    );
    expect(result).toMatchObject({ ok: false, code: "unknown_ref" });
  });
});

describe("what a citation is scoped to", () => {
  // The boundary used to refuse any id outside the actor's perception this
  // tick. That treated "is it still within reach?" as an id-validity question,
  // and it is not: a florist reaching for a bouquet sold ten minutes ago
  // should be told by the WORLD that the display is empty — an occurrence she
  // learns from — rather than by a rejection she cannot act on and cannot see.
  it("accepts an item that exists but is nowhere near the actor", () => {
    const result = validateActArgs(
      args({ objectRefs: [{ kind: "item", id: "ITEM_FAR", role: "target" }] }),
      world
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a place that exists but is not adjacent", () => {
    const result = validateActArgs(
      args({
        objectRefs: [{ kind: "scene", id: "SCN_FAR", role: "destination" }],
      }),
      world
    );
    expect(result.ok).toBe(true);
  });

  it("still refuses an id that names nothing at all", () => {
    const result = validateActArgs(
      args({ objectRefs: [{ kind: "item", id: "ITEM_INVENTED" }] }),
      world
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("nothing in this world");
  });

  it("accepts a stranger who has since walked out of the room", () => {
    // The alias is derived from (viewer, target), so it means the same person
    // whenever it is cited — including out of the actor's own perception
    // history. Whether they are still here is the Engine's to answer.
    const result = validateActArgs(
      args({ objectRefs: [{ kind: "character", id: "stranger_faraway" }] }),
      world
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.objectRefs[0].id).toBe("Marsh");
  });

  it("still refuses a handle that resolves to nobody", () => {
    const result = validateActArgs(
      args({ objectRefs: [{ kind: "character", id: "stranger_nobody" }] }),
      world
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // One message for all three spaces: the actor no longer declares what
    // kind of thing it meant, so the boundary cannot say "nobody" specifically.
    expect(result.reason).toContain("nothing in this world");
  });
});
