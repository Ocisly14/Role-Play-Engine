// The skill model has three sources that must agree: the catalog (names +
// base values), the per-skill guidance documents both prompts inject, and the
// legacy consolidation map that carries pre-consolidation character data onto
// the broad domains. A drift between them is silent in production — an agent
// declares a skill the Engine has no guidance for, or a character's trained
// value stops resolving — so it is pinned here.

import { describe, expect, it } from "vitest";
import { COC_SKILL_BASE_VALUES } from "../../../planning/cocSkillList.js";
import {
  LEGACY_SKILL_TO_CANONICAL,
  SKILL_CATALOG,
  canonicalSkillName,
} from "../skillCatalog.js";
import {
  buildSkillCatalogPrompt,
  getSkillReference,
  loadSkillReferences,
} from "../skillReference.js";

const catalogNames = new Set<string>(SKILL_CATALOG.map((s) => s.name));

describe("skill catalog", () => {
  it("has unique names and sane base values", () => {
    expect(catalogNames.size).toBe(SKILL_CATALOG.length);
    for (const skill of SKILL_CATALOG) {
      expect(skill.base).toBeGreaterThanOrEqual(0);
      expect(skill.base).toBeLessThanOrEqual(100);
      expect(skill.description.trim()).not.toBe("");
    }
  });

  it("exposes every catalog entry as a base value", () => {
    for (const skill of SKILL_CATALOG) {
      expect(COC_SKILL_BASE_VALUES.get(skill.name)).toBe(skill.base);
    }
  });
});

describe("legacy consolidation map", () => {
  it("only maps onto real catalog names", () => {
    const badTargets = [
      ...new Set(Object.values(LEGACY_SKILL_TO_CANONICAL)),
    ].filter((target) => !catalogNames.has(target));
    expect(badTargets).toEqual([]);
  });

  it("leaves canonical names untouched", () => {
    for (const name of catalogNames) {
      expect(canonicalSkillName(name)).toBe(name);
    }
  });

  it("never maps a legacy name onto itself as a no-op entry", () => {
    // A self-mapping entry that is NOT a catalog name would silently keep a
    // dead skill alive.
    for (const [legacy, canonical] of Object.entries(
      LEGACY_SKILL_TO_CANONICAL
    )) {
      if (legacy === canonical) expect(catalogNames.has(legacy)).toBe(true);
    }
  });
});

describe("skill guidance documents", () => {
  const refs = loadSkillReferences();

  it("provides exactly one document per catalog skill", () => {
    const titles = refs.map((r) => r.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect([...titles].sort()).toEqual([...catalogNames].sort());
  });

  it("is reachable by canonical name and by legacy alias", () => {
    expect(getSkillReference("Stealth & Security")?.title).toBe(
      "Stealth & Security"
    );
    // Case-insensitive lookup is what the agent's free-form casing relies on.
    expect(getSkillReference("stealth & security")?.title).toBe(
      "Stealth & Security"
    );
  });

  it("carries a non-empty description and guidance body for each skill", () => {
    for (const ref of refs) {
      expect(ref.description.trim(), `${ref.title} description`).not.toBe("");
      expect(ref.guidanceBody.trim(), `${ref.title} guidance`).not.toBe("");
    }
  });

  it("gives every skill duration guidance the Engine can ground timing on", () => {
    // `renderSkillGuidance` prints this into the resolution request, and the
    // Engine sets the authoritative resolvedDurationTicks from it. A missing
    // block silently sends the Engine back to estimating.
    for (const ref of refs) {
      const guidance = ref.durationGuidance;
      expect(guidance, `${ref.title} durationGuidance`).toBeDefined();
      if (!guidance) continue;
      expect(guidance.default, `${ref.title} default`).toBeGreaterThan(0);
      expect(guidance.range, `${ref.title} range`).toMatch(/^\d+-\d+$/);
      const [low, high] = (guidance.range ?? "").split("-").map(Number);
      expect(low, `${ref.title} range low`).toBeLessThanOrEqual(
        guidance.default
      );
      expect(high, `${ref.title} range high`).toBeGreaterThanOrEqual(
        guidance.default
      );
    }
  });

  it("shades every success level and the fumble", () => {
    // Post-roll assessment needs something to tell a regular success from an
    // extreme one, and the rules document requires that a fumble be able to
    // worsen the outcome. Without per-level shading the Engine has only the
    // one-line description to work from.
    for (const ref of refs) {
      for (const marker of [
        "**Regular**",
        "**Hard**",
        "**Extreme**",
        "**Fumble**",
      ]) {
        expect(ref.guidanceBody, `${ref.title} ${marker}`).toContain(marker);
      }
    }
  });

  it("names only real WorldDelta operations in its state surface", () => {
    // The guidance tells the Engine which deltas a domain typically produces.
    // A made-up operation name (`item.condition`) reads as authoritative and
    // then fails validation, costing a repair round for nothing. Mirrors the
    // switches in engine/resolution/worldDeltaValidator.ts.
    const OPERATIONS: Record<string, string[]> = {
      character: [
        "hp",
        "san",
        "fatigue",
        "position",
        "addCondition",
        "removeCondition",
        "relationship",
      ],
      scene: [
        "addCondition",
        "removeCondition",
        "connectionBlock",
        "environmentContribute",
        "environmentHazard",
      ],
      item: ["create", "move", "modify", "damage", "destroy"],
    };

    for (const ref of refs) {
      expect(ref.guidanceBody, `${ref.title} state surface`).toContain(
        "## State surface"
      );
      const cited = ref.guidanceBody.matchAll(
        /\b(character|scene|item)\.([A-Za-z]+)\b/g
      );
      for (const [token, domain, operation] of cited) {
        expect(
          OPERATIONS[domain],
          `${ref.title} cites unknown operation ${token}`
        ).toContain(operation);
      }
    }
  });

  it("renders a catalog prompt naming every skill", () => {
    const prompt = buildSkillCatalogPrompt();
    for (const name of catalogNames) {
      expect(prompt).toContain(name);
    }
  });
});
