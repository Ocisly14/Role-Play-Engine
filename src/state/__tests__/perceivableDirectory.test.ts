import { describe, expect, it } from "vitest";
import {
  buildPerceivableDirectory,
  descriptionIdentifier,
  isKnownTo,
} from "../perceivableDirectory.js";

// Hand-rolled DGSM stub keeps coverage on directory logic, not state plumbing.

function stubDgsm(opts: {
  npcs: Array<{
    id: string;
    name: string;
    appearance?: string;
    age?: number;
    gender?: string;
    occupation?: string;
    relationships?: Array<{ targetId: string; targetName: string }>;
    inventory?: Array<{ name: string }>;
    alive?: boolean;
    sceneId?: string;
  }>;
  scenes: Array<{
    id: string;
    name: string;
    items?: Array<{ id: string; name: string }>;
    connections?: Array<{ targetId: string }>;
  }>;
}) {
  return {
    getNpcProfile: (id: string) => opts.npcs.find((n) => n.id === id),
    isNpcAlive: (id: string) =>
      opts.npcs.find((n) => n.id === id)?.alive !== false,
    getScene: (id: string) => opts.scenes.find((s) => s.id === id) ?? null,
    getCharacterPosition: (id: string) => {
      const npc = opts.npcs.find((n) => n.id === id);
      return npc?.sceneId ? { type: "scene" as const, sceneId: npc.sceneId } : null;
    },
    getState: () => ({ npcCharacters: opts.npcs }),
  } as never;
}

describe("buildPerceivableDirectory — characters", () => {
  it("includes KNOWN characters from actor.relationships using canonical names", () => {
    const dgsm = stubDgsm({
      npcs: [
        { id: "alice", name: "Alice", relationships: [{ targetId: "bob", targetName: "Bob" }], sceneId: "lib" },
        { id: "bob", name: "Bob", sceneId: "harbor" },
      ],
      scenes: [{ id: "lib", name: "Library" }, { id: "harbor", name: "Harbor" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.characters.get("Bob")).toBe("bob");
  });

  it("includes UNKNOWN in-scene characters via descriptionIdentifier", () => {
    const dgsm = stubDgsm({
      npcs: [
        { id: "alice", name: "Alice", relationships: [], sceneId: "lib" },
        { id: "stranger", name: "Cyrus", appearance: "gaunt man with sunken eyes", sceneId: "lib" },
      ],
      scenes: [{ id: "lib", name: "Library" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.characters.get("the gaunt man with sunken eyes")).toBe("stranger");
    // Canonical name should NOT be present (would leak identity)
    expect(dir.characters.has("Cyrus")).toBe(false);
  });

  it("KNOWN actors take canonical name even if also in scene", () => {
    const dgsm = stubDgsm({
      npcs: [
        { id: "alice", name: "Alice", relationships: [{ targetId: "bob", targetName: "Bob" }], sceneId: "lib" },
        { id: "bob", name: "Bob", appearance: "hulking sailor", sceneId: "lib" },
      ],
      scenes: [{ id: "lib", name: "Library" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.characters.get("Bob")).toBe("bob");
    expect(dir.characters.has("the hulking sailor")).toBe(false);
  });

  it("excludes characters neither in relationships nor in scene", () => {
    const dgsm = stubDgsm({
      npcs: [
        { id: "alice", name: "Alice", relationships: [], sceneId: "lib" },
        { id: "remote", name: "Remote", sceneId: "harbor" },
      ],
      scenes: [{ id: "lib", name: "Library" }, { id: "harbor", name: "Harbor" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.characters.has("Remote")).toBe(false);
  });

  it("excludes dead characters from in-scene unknowns", () => {
    const dgsm = stubDgsm({
      npcs: [
        { id: "alice", name: "Alice", relationships: [], sceneId: "lib" },
        { id: "ghost", name: "Ghost", appearance: "pale figure", sceneId: "lib", alive: false },
      ],
      scenes: [{ id: "lib", name: "Library" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.characters.size).toBe(0);
  });

  it("excludes the actor themselves from their own directory", () => {
    const dgsm = stubDgsm({
      npcs: [
        { id: "alice", name: "Alice", relationships: [], sceneId: "lib" },
      ],
      scenes: [{ id: "lib", name: "Library" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.characters.has("Alice")).toBe(false);
  });
});

describe("buildPerceivableDirectory — items", () => {
  it("includes scene items by name → id", () => {
    const dgsm = stubDgsm({
      npcs: [{ id: "alice", name: "Alice", relationships: [], sceneId: "lib" }],
      scenes: [
        { id: "lib", name: "Library", items: [{ id: "ledger42", name: "the bound ledger" }] },
      ],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.items.get("the bound ledger")).toBe("ledger42");
  });

  it("includes actor inventory items (using name as id)", () => {
    const dgsm = stubDgsm({
      npcs: [
        {
          id: "alice",
          name: "Alice",
          relationships: [],
          inventory: [{ name: "the worn key" }],
          sceneId: "lib",
        },
      ],
      scenes: [{ id: "lib", name: "Library" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.items.get("the worn key")).toBe("the worn key");
  });

  it("scene wins on item name collision (OQ4 conflict rule)", () => {
    const dgsm = stubDgsm({
      npcs: [
        {
          id: "alice",
          name: "Alice",
          relationships: [],
          inventory: [{ name: "letter" }],
          sceneId: "lib",
        },
      ],
      scenes: [
        { id: "lib", name: "Library", items: [{ id: "letter_scene", name: "letter" }] },
      ],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.items.get("letter")).toBe("letter_scene");
  });
});

describe("buildPerceivableDirectory — scenes", () => {
  it("includes current scene by name", () => {
    const dgsm = stubDgsm({
      npcs: [{ id: "alice", name: "Alice", relationships: [], sceneId: "lib" }],
      scenes: [{ id: "lib", name: "Library" }],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.scenes.get("Library")).toBe("lib");
  });

  it("includes adjacent scenes via connections", () => {
    const dgsm = stubDgsm({
      npcs: [{ id: "alice", name: "Alice", relationships: [], sceneId: "lib" }],
      scenes: [
        { id: "lib", name: "Library", connections: [{ targetId: "harbor" }] },
        { id: "harbor", name: "Harbor" },
      ],
    });
    const dir = buildPerceivableDirectory("alice", dgsm);
    expect(dir.scenes.get("Library")).toBe("lib");
    expect(dir.scenes.get("Harbor")).toBe("harbor");
  });
});

describe("isKnownTo / descriptionIdentifier", () => {
  it("isKnownTo true when targetId in relationships", () => {
    const profile = {
      relationships: [{ targetId: "bob", targetName: "Bob" }],
    } as never;
    expect(isKnownTo(profile, "bob")).toBe(true);
    expect(isKnownTo(profile, "alice")).toBe(false);
  });

  it("descriptionIdentifier prefers appearance", () => {
    const profile = { appearance: "gaunt man" } as never;
    expect(descriptionIdentifier(profile)).toBe("the gaunt man");
  });

  it("descriptionIdentifier falls back to age + gender", () => {
    const profile = { age: 40, gender: "male" } as never;
    expect(descriptionIdentifier(profile)).toBe("the age 40, male");
  });

  it("descriptionIdentifier falls back to occupation", () => {
    const profile = { occupation: "fisherman" } as never;
    expect(descriptionIdentifier(profile)).toBe("the fisherman");
  });

  it("descriptionIdentifier returns generic when nothing", () => {
    const profile = {} as never;
    expect(descriptionIdentifier(profile)).toBe("an unfamiliar person");
  });
});
