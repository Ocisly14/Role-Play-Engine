// Trust-boundary tests: raw `act` args → validated args → trusted
// ActionCommand. Covers required/optional fields, object-ref roles, duration
// boundaries, perceivable-scope enforcement, envelope non-forgeability and
// the immediate-skill-roll invariant (declaredSkillId ⇔ skillRoll).

import { describe, expect, it, vi } from "vitest";
import type { PerceivableDirectory } from "../../../state/perceivableDirectory.js";
import { buildActionCommand } from "../commandBuilder.js";
import {
  MAX_PROPOSED_DURATION_TICKS,
  validateActArgs,
} from "../commandValidator.js";
import { resolveSkillValue, successLevelFor } from "../skillRollService.js";

const directory: PerceivableDirectory = {
  characters: new Set(["Hollins"]),
  items: new Set(["ITEM_1", "cabinet_lock"]),
  scenes: new Set(["SCN_1", "SCN_2"]),
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
      directory
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
    const result = validateActArgs(args({ objectRefs: [] }), directory);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["non-string", 42],
  ])("rejects %s description", (_label, description) => {
    const result = validateActArgs(args({ description }), directory);
    expect(result).toMatchObject({ ok: false, code: "invalid_description" });
  });

  it("rejects missing objectRefs (must be [] when none)", () => {
    const result = validateActArgs(args({ objectRefs: undefined }), directory);
    expect(result).toMatchObject({ ok: false, code: "invalid_object_refs" });
  });

  it("rejects a ref with an invalid kind", () => {
    const result = validateActArgs(
      args({ objectRefs: [{ kind: "monster", id: "x" }] }),
      directory
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_object_refs" });
  });

  it("rejects a ref with an invalid role", () => {
    const result = validateActArgs(
      args({ objectRefs: [{ kind: "item", id: "ITEM_1", role: "weapon" }] }),
      directory
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_object_refs" });
  });

  it("accepts every legal role and a role-less ref", () => {
    for (const role of ["target", "tool", "destination", "recipient"]) {
      const result = validateActArgs(
        args({ objectRefs: [{ kind: "item", id: "ITEM_1", role }] }),
        directory
      );
      expect(result.ok).toBe(true);
    }
    const bare = validateActArgs(
      args({ objectRefs: [{ kind: "item", id: "ITEM_1" }] }),
      directory
    );
    expect(bare.ok).toBe(true);
  });

  it("rejects a ref outside the perceivable scope", () => {
    const result = validateActArgs(
      args({ objectRefs: [{ kind: "character", id: "Nyarlathotep" }] }),
      directory
    );
    expect(result).toMatchObject({ ok: false, code: "unknown_ref" });
    if (result.ok) return;
    expect(result.reason).toContain("Nyarlathotep");
  });

  it("checks scope per kind — an item id cited as a character is rejected", () => {
    const result = validateActArgs(
      args({ objectRefs: [{ kind: "character", id: "ITEM_1" }] }),
      directory
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
    const result = validateActArgs(args({ proposedDurationTicks }), directory);
    expect(result).toMatchObject({ ok: false, code: "invalid_duration" });
  });

  it("accepts the duration boundaries", () => {
    expect(
      validateActArgs(args({ proposedDurationTicks: 1 }), directory).ok
    ).toBe(true);
    expect(
      validateActArgs(
        args({ proposedDurationTicks: MAX_PROPOSED_DURATION_TICKS }),
        directory
      ).ok
    ).toBe(true);
  });

  it("drops an empty skillId instead of failing", () => {
    const result = validateActArgs(args({ skillId: "  " }), directory);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.skillId).toBeUndefined();
  });
});

describe("skillRollService", () => {
  it("resolves a trained skill case-insensitively", () => {
    expect(resolveSkillValue("locksmith", { Locksmith: 60 })).toEqual({
      canonicalSkillId: "Locksmith",
      value: 60,
    });
  });

  it("falls back to the CoC base value for an untrained known skill", () => {
    expect(resolveSkillValue("Locksmith", {})).toEqual({
      canonicalSkillId: "Locksmith",
      value: 1,
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
      items: new Set(["ITEM_1", "cabinet_lock"]),
      scenes: new Set(["SCN_1", "SCN_2"]),
    }),
  };
});

const dgsm = {
  getGameDateTime: () => "1923-04-02T09:15:00",
  getCharacterPosition: () => ({ kind: "scene", sceneId: "SCN_1" }),
  resolveLocationId: () => "SCN_1",
  getNpcProfile: () => ({ skills: { Locksmith: 60 } }),
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

  it("rolls immediately for a declared trained skill", () => {
    const result = buildActionCommand(
      "npc_1",
      args({ skillId: "locksmith" }),
      { dgsm }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.declaredSkillId).toBe("Locksmith");
    const roll = result.command.skillRoll;
    expect(roll).toBeDefined();
    if (!roll) return;
    expect(roll.skillId).toBe("Locksmith");
    expect(roll.skillValue).toBe(60);
    expect(roll.roll).toBeGreaterThanOrEqual(1);
    expect(roll.roll).toBeLessThanOrEqual(100);
    expect(roll.rollId).toBeTruthy();
  });

  it("rolls with the base value for an untrained known skill", () => {
    const noSkills = {
      ...(dgsm as Record<string, unknown>),
      getNpcProfile: () => ({ skills: {} }),
    } as never;
    const result = buildActionCommand(
      "npc_1",
      args({ skillId: "Spot Hidden" }),
      { dgsm: noSkills }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.skillRoll?.skillValue).toBeGreaterThan(0);
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
