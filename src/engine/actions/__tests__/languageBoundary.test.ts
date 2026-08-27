// Languages is the one domain with no single value: a character reads Latin
// haltingly and speaks their own tongue perfectly, and that difference is all
// this domain adjudicates. The boundary is where "which tongue" is settled,
// because the roll downstream needs a number and the domain does not have one.

import { describe, expect, it, vi } from "vitest";
import { buildActionCommand } from "../commandBuilder.js";
import { resolveSkillValue } from "../skillRollService.js";

// The perceivable directory is not what this file is about; the real one wants
// a whole world to build itself from.
vi.mock("../../../state/perceivableDirectory.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../../state/perceivableDirectory.js"
  );
  return {
    ...actual,
    buildPerceivableDirectory: () => ({
      characters: new Set<string>(),
      characterHandles: new Map<string, string>(),
      items: new Set<string>(),
      scenes: new Set(["SCN_1"]),
    }),
  };
});

const languages = {
  native: ["English"],
  learned: { Latin: 60, Greek: 35 },
};

const dgsm = {
  getGameDateTime: () => "1923-04-02T09:15:00",
  getCharacterPosition: () => ({ kind: "scene", sceneId: "SCN_1" }),
  resolveLocationId: () => "SCN_1",
  getNpcProfile: () => ({ skills: { Social: 55 }, languages }),
  getState: () => ({ scenes: new Map(), npcInventories: {} }),
  getScene: (id: string) => (id === "SCN_1" ? {} : null),
  getJunction: () => null,
  getRoad: () => null,
} as never;

const build = (skillId?: string, language?: string) =>
  buildActionCommand(
    "npc_1",
    {
      description: "I read the inscription.",
      objectRefs: [],
      proposedDurationTicks: 2,
      ...(skillId ? { skillId } : {}),
      ...(language ? { language } : {}),
    },
    { dgsm }
  );

describe("declaring a language", () => {
  it("carries the named tongue through to the command", () => {
    const result = build("Languages", "Latin");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.declaredSkillId).toBe("Languages");
    expect(result.command.declaredLanguage).toBe("Latin");
  });

  it("matches the tongue case-insensitively but stores the sheet's spelling", () => {
    const result = build("Languages", "latin");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.declaredLanguage).toBe("Latin");
  });

  it("drops the declaration for a native tongue instead of rejecting it", () => {
    // Nobody rolls to speak the language they think in. Rejecting would cost a
    // retry to teach a rule that changes nothing about what the actor meant.
    const result = build("Languages", "English");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.declaredSkillId).toBeUndefined();
    expect(result.command.declaredLanguage).toBeUndefined();
  });

  it("refuses a tongue the character never learned", () => {
    const result = build("Languages", "Aramaic");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("you have no Aramaic");
    // The reason names what they DO have, so the retry has somewhere to go.
    expect(result.reason).toContain("Latin");
    expect(result.reason).toContain("cannot make");
  });

  it("refuses Languages with no tongue named", () => {
    const result = build("Languages");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not a single fluency");
  });
});

describe("resolving the fluency the dice use", () => {
  it("reads the named tongue, never a flat Languages entry", () => {
    // A legacy sheet may still carry `Languages: 80`. It is not a fluency in
    // any particular tongue, so it must not become one.
    const resolved = resolveSkillValue(
      "Languages",
      { Languages: 80 },
      languages,
      "Greek"
    );
    expect(resolved).toEqual({ canonicalSkillId: "Languages", value: 35 });
  });

  it("resolves nothing without a tongue", () => {
    expect(
      resolveSkillValue("Languages", { Languages: 80 }, languages)
    ).toBeUndefined();
  });

  it("leaves every other domain alone", () => {
    expect(resolveSkillValue("Social", { Social: 55 })).toEqual({
      canonicalSkillId: "Social",
      value: 55,
    });
  });
});
