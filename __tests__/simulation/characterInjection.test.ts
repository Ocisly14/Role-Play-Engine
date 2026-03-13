import { describe, expect, it } from "vitest";
import { buildInjectedProfile } from "../../src/dynamicworldagent/simulation/characterInjection.js";

describe("buildInjectedProfile", () => {
  const baseInput = {
    name: "Alice",
    attributes: {
      STR: 50,
      CON: 60,
      SIZ: 70,
      DEX: 55,
      APP: 65,
      INT: 75,
      POW: 80,
      EDU: 70,
      luck: 50,
    },
    skills: { "Library Use": 60, "Spot Hidden": 45 },
    backstory: "A curious journalist",
    residence: "MACRO_HOTEL",
  };

  it("generates a UUID id", () => {
    const profile = buildInjectedProfile(baseInput);
    // UUID v4 pattern
    expect(profile.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("generates a different UUID on each call", () => {
    const profile1 = buildInjectedProfile(baseInput);
    const profile2 = buildInjectedProfile(baseInput);
    expect(profile1.id).not.toBe(profile2.id);
  });

  it("sets isNPC to true and isPlayerInjected to true", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.isNPC).toBe(true);
    expect(profile.isPlayerInjected).toBe(true);
  });

  it("derives HP from floor((CON + SIZ) / 10)", () => {
    // (60 + 70) / 10 = 13
    const profile = buildInjectedProfile(baseInput);
    expect(profile.status.hp).toBe(13);
    expect(profile.status.maxHp).toBe(13);
  });

  it("derives sanity from POW", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.status.sanity).toBe(80);
  });

  it("sets maxSanity to 99", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.status.maxSanity).toBe(99);
  });

  it("includes luck from attributes.luck in status", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.status.luck).toBe(50);
  });

  it("defaults luck to 50 when not provided in attributes", () => {
    const inputWithoutLuck = {
      ...baseInput,
      attributes: {
        STR: 50,
        CON: 60,
        SIZ: 70,
        DEX: 55,
        APP: 65,
        INT: 75,
        POW: 80,
        EDU: 70,
      },
    };
    const profile = buildInjectedProfile(inputWithoutLuck);
    expect(profile.status.luck).toBe(50);
  });

  it("initializes conditions as an empty array", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.status.conditions).toEqual([]);
  });

  it("initializes knowledge as an empty array", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.knowledge).toEqual([]);
  });

  it("initializes relationships as an empty array", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.relationships).toEqual([]);
  });

  it("initializes inventory as an empty array", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.inventory).toEqual([]);
  });

  it("passes through name, skills, backstory, and residence", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.name).toBe("Alice");
    expect(profile.skills).toEqual({ "Library Use": 60, "Spot Hidden": 45 });
    expect(profile.backstory).toBe("A curious journalist");
    expect(profile.residence).toBe("MACRO_HOTEL");
  });

  it("passes through optional personality field", () => {
    const profile = buildInjectedProfile({
      ...baseInput,
      personality: "Inquisitive and bold",
    });
    expect(profile.personality).toBe("Inquisitive and bold");
  });

  it("passes through optional occupation field", () => {
    const profile = buildInjectedProfile({
      ...baseInput,
      occupation: "Journalist",
    });
    expect(profile.occupation).toBe("Journalist");
  });

  it("passes through optional age field", () => {
    const profile = buildInjectedProfile({ ...baseInput, age: 34 });
    expect(profile.age).toBe(34);
  });

  it("passes through optional gender field", () => {
    const profile = buildInjectedProfile({ ...baseInput, gender: "Female" });
    expect(profile.gender).toBe("Female");
  });

  it("leaves optional fields undefined when not provided", () => {
    const profile = buildInjectedProfile(baseInput);
    expect(profile.personality).toBeUndefined();
    expect(profile.occupation).toBeUndefined();
    expect(profile.age).toBeUndefined();
    expect(profile.gender).toBeUndefined();
  });

  it("correctly derives HP with different CON and SIZ values (floor rounding)", () => {
    // (55 + 60) / 10 = 11.5 → floor = 11
    const input = {
      ...baseInput,
      attributes: { ...baseInput.attributes, CON: 55, SIZ: 60 },
    };
    const profile = buildInjectedProfile(input);
    expect(profile.status.hp).toBe(11);
    expect(profile.status.maxHp).toBe(11);
  });
});
