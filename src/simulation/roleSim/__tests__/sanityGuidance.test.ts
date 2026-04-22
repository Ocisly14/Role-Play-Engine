import {
  BOUT_OF_MADNESS_TABLE,
  SANITY_GUIDANCE_PROMPT,
} from "../sanityGuidance.js";

describe("sanityGuidance", () => {
  it("BOUT_OF_MADNESS_TABLE has 10 entries spanning rolls 1-10", () => {
    expect(BOUT_OF_MADNESS_TABLE).toHaveLength(10);
    const rolls = BOUT_OF_MADNESS_TABLE.map((b) => b.roll).sort((a, b) => a - b);
    expect(rolls).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("SANITY_GUIDANCE_PROMPT contains every bout label", () => {
    for (const entry of BOUT_OF_MADNESS_TABLE) {
      expect(SANITY_GUIDANCE_PROMPT).toContain(entry.label);
    }
  });

  it("SANITY_GUIDANCE_PROMPT mentions key trigger thresholds and StateChange shape", () => {
    expect(SANITY_GUIDANCE_PROMPT).toContain("5+");
    expect(SANITY_GUIDANCE_PROMPT).toContain("character.addCondition");
    expect(SANITY_GUIDANCE_PROMPT).toContain("expiresAt");
    expect(SANITY_GUIDANCE_PROMPT).toContain("globalSkillPenalty");
  });
});
