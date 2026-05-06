// src/roleSim/__tests__/perceptionRenderer.test.ts

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterPosition } from "../../state/topologyTypes.js";
import type { DynamicNPCProfile } from "../../state/types.js";
import { buildPerceptionNarrative } from "../perceptionRenderer.js";

function makeNpc(
  id: string,
  name: string,
  status?: Partial<DynamicNPCProfile["status"]>
): DynamicNPCProfile {
  return {
    id,
    name,
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
      ...status,
    },
    inventory: [],
    skills: {},
    longTermIntent: "",
    relationships: [],
  };
}

function makeDgsm(opts: {
  scene?: {
    id: string;
    name: string;
    description: string;
    conditions?: Array<{ description: string }>;
  };
  characterPositions?: Record<string, CharacterPosition>;
  npcs: DynamicNPCProfile[];
  selfPosition: CharacterPosition;
}): DynamicGameStateManager {
  return {
    getCharacterPosition: (id: string) => {
      if (id === opts.npcs[0].id) return opts.selfPosition;
      return opts.characterPositions?.[id];
    },
    getState: () => ({
      npcCharacters: opts.npcs,
      characterPositions: {
        ...(opts.characterPositions ?? {}),
        [opts.npcs[0].id]: opts.selfPosition,
      },
    }),
    getScene: (sceneId: string) =>
      opts.scene && opts.scene.id === sceneId
        ? {
            id: opts.scene.id,
            name: opts.scene.name,
            description: opts.scene.description,
            conditions: opts.scene.conditions ?? [],
          }
        : null,
    isNpcAlive: () => true,
  } as unknown as DynamicGameStateManager;
}

describe("buildPerceptionNarrative", () => {
  test("renders scene name + description, present NPCs, no status feel when healthy", () => {
    const self = makeNpc("npc1", "Alice");
    const smith = makeNpc("smith", "Smith");
    const dgsm = makeDgsm({
      npcs: [self, smith],
      scene: {
        id: "library",
        name: "Library",
        description: "A dim hall with floor-to-ceiling shelves.",
      },
      selfPosition: { type: "scene", sceneId: "library" },
      characterPositions: {
        smith: { type: "scene", sceneId: "library" },
      },
    });

    const out = buildPerceptionNarrative("npc1", dgsm);

    expect(out).toContain(
      "You are in Library. A dim hall with floor-to-ceiling shelves."
    );
    expect(out).toContain("Smith is here");
    expect(out).not.toContain("badly hurt");
    expect(out).not.toContain("mind is fraying");
    expect(out).not.toContain("exhausted");
  });

  test("excludes self and NPCs in other scenes", () => {
    const self = makeNpc("npc1", "Alice");
    const smith = makeNpc("smith", "Smith");
    const jones = makeNpc("jones", "Jones");
    const dgsm = makeDgsm({
      npcs: [self, smith, jones],
      scene: {
        id: "library",
        name: "Library",
        description: "Quiet.",
      },
      selfPosition: { type: "scene", sceneId: "library" },
      characterPositions: {
        smith: { type: "scene", sceneId: "library" },
        jones: { type: "scene", sceneId: "harbor" },
      },
    });

    const out = buildPerceptionNarrative("npc1", dgsm);
    expect(out).toContain("Smith is here");
    expect(out).not.toContain("Jones");
    expect(out).not.toContain("Alice is here"); // self excluded
  });

  test("renders scene conditions joined by '; '", () => {
    const self = makeNpc("npc1", "Alice");
    const dgsm = makeDgsm({
      npcs: [self],
      scene: {
        id: "library",
        name: "Library",
        description: "A hall.",
        conditions: [
          { description: "smoke fills the air" },
          { description: "fire crackles in the corner" },
        ],
      },
      selfPosition: { type: "scene", sceneId: "library" },
    });

    const out = buildPerceptionNarrative("npc1", dgsm);
    expect(out).toContain("smoke fills the air; fire crackles in the corner");
  });

  test("includes 'badly hurt' when HP < 25% maxHp", () => {
    const self = makeNpc("npc1", "Alice", { hp: 2, maxHp: 12 });
    const dgsm = makeDgsm({
      npcs: [self],
      scene: { id: "library", name: "Library", description: "." },
      selfPosition: { type: "scene", sceneId: "library" },
    });
    const out = buildPerceptionNarrative("npc1", dgsm);
    expect(out).toContain("badly hurt");
  });

  test("includes 'mind is fraying' when SAN < 20% maxSan", () => {
    const self = makeNpc("npc1", "Alice", { san: 5, maxSan: 50 });
    const dgsm = makeDgsm({
      npcs: [self],
      scene: { id: "library", name: "Library", description: "." },
      selfPosition: { type: "scene", sceneId: "library" },
    });
    const out = buildPerceptionNarrative("npc1", dgsm);
    expect(out).toContain("mind is fraying");
  });

  test("includes 'exhausted' when Fatigue > 75% maxFatigue", () => {
    const self = makeNpc("npc1", "Alice", { fatigue: 80, maxFatigue: 100 });
    const dgsm = makeDgsm({
      npcs: [self],
      scene: { id: "library", name: "Library", description: "." },
      selfPosition: { type: "scene", sceneId: "library" },
    });
    const out = buildPerceptionNarrative("npc1", dgsm);
    expect(out).toContain("exhausted");
  });

  test("returns minimal narrative when scene not found", () => {
    const self = makeNpc("npc1", "Alice");
    const dgsm = makeDgsm({
      npcs: [self],
      selfPosition: { type: "scene", sceneId: "unknown" },
    });
    const out = buildPerceptionNarrative("npc1", dgsm);
    // Should not crash; returns some safe fallback string.
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});
