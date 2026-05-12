// src/roleSim/__tests__/profileFormatter.test.ts
/// <reference types="vitest/globals" />

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { DynamicNPCProfile, InventoryItem } from "../../state/types.js";
import { formatProfile } from "../profileFormatter.js";

function makeNpc(
  overrides: Partial<DynamicNPCProfile> = {}
): DynamicNPCProfile {
  return {
    id: "npc1",
    name: "Alice",
    attributes: {
      STR: 50,
      CON: 50,
      DEX: 50,
      APP: 50,
      POW: 50,
      SIZ: 50,
      INT: 50,
      EDU: 50,
    },
    status: {
      hp: 12,
      maxHp: 12,
      san: 50,
      maxSan: 50,
      fatigue: 0,
      maxFatigue: 100,
      luck: 50,
      conditions: [],
    },
    inventory: [],
    skills: {},
    longTermIntent: "",
    relationships: [],
    ...overrides,
  };
}

function makeDgsm(opts?: {
  npcInventories?: Record<string, InventoryItem[]>;
  npcRelationshipGraph?: Record<
    string,
    Record<string, { score: number; note: string }>
  >;
  npcCharacters?: Array<{ id: string; name: string }>;
}): DynamicGameStateManager {
  return {
    getState: () => ({
      npcInventories: opts?.npcInventories ?? {},
      npcRelationshipGraph: opts?.npcRelationshipGraph ?? {},
      npcCharacters: opts?.npcCharacters ?? [],
    }),
  } as unknown as DynamicGameStateManager;
}

describe("formatProfile", () => {
  test("renders all populated 12 fields", () => {
    const npc = makeNpc({
      age: 34,
      gender: "female",
      occupation: "librarian",
      appearance: "tall, brown hair",
      personality: "introverted, observant",
      background: "small-town academic",
      backstory: "grew up next to the library",
      residence: "Library Cottage",
    });
    const dgsm = makeDgsm({
      npcInventories: {
        npc1: [
          { name: "key", quantity: 1 },
          { name: "notebook", quantity: 2 },
        ],
      },
      npcRelationshipGraph: {
        npc1: {
          smith: { score: 80, note: "close friend" },
        },
      },
      npcCharacters: [{ id: "smith", name: "Smith" }],
    });

    const out = formatProfile(npc, dgsm);

    expect(out).toContain("Name: Alice");
    expect(out).toContain("Age: 34");
    expect(out).toContain("Gender: female");
    expect(out).toContain("Occupation: librarian");
    expect(out).toContain("Appearance: tall, brown hair");
    expect(out).toContain("Personality: introverted, observant");
    expect(out).toContain("Background: small-town academic");
    expect(out).toContain("Backstory: grew up next to the library");
    expect(out).toContain("Residence: Library Cottage");
    expect(out).toContain("Status: HP 12/12, SAN 50/50, Fatigue 0/100");
    expect(out).toContain("Inventory: key, notebook (x2)");
    expect(out).toContain("- Smith: close friend (score: 80)");
  });

  test("omits absent optional fields", () => {
    const npc = makeNpc(); // only required fields
    const dgsm = makeDgsm();
    const out = formatProfile(npc, dgsm);

    expect(out).toContain("Name: Alice");
    expect(out).not.toContain("Age:");
    expect(out).not.toContain("Gender:");
    expect(out).not.toContain("Occupation:");
    expect(out).not.toContain("Appearance:");
    expect(out).not.toContain("Personality:");
    expect(out).not.toContain("Background:");
    expect(out).not.toContain("Backstory:");
    expect(out).not.toContain("Residence:");
    // Status renders even at defaults (it's runtime state, not optional)
    expect(out).toContain("Status:");
    // Inventory line omitted when empty
    expect(out).not.toContain("Inventory:");
    // Relationships omitted when empty
    expect(out).not.toContain("Relationships:");
  });

  test("includes status conditions in status line", () => {
    const npc = makeNpc({
      status: {
        hp: 5,
        maxHp: 12,
        san: 30,
        maxSan: 50,
        fatigue: 80,
        maxFatigue: 100,
        luck: 50,
        conditions: [
          {
            id: "wound1",
            description: "bleeding from arm",
          },
          {
            id: "tired1",
            description: "winded",
          },
        ],
      },
    });
    const dgsm = makeDgsm();
    const out = formatProfile(npc, dgsm);
    expect(out).toContain(
      "Status: HP 5/12, SAN 30/50, Fatigue 80/100, Conditions: bleeding from arm, winded"
    );
  });

  test("renders relationship with unknown target id when name lookup fails", () => {
    const npc = makeNpc();
    const dgsm = makeDgsm({
      npcRelationshipGraph: {
        npc1: {
          ghost42: { score: -50, note: "rival" },
        },
      },
      npcCharacters: [], // no name match
    });
    const out = formatProfile(npc, dgsm);
    expect(out).toContain("- ghost42: rival (score: -50)");
  });
});
