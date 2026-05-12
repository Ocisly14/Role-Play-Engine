/// <reference types="vitest/globals" />
import {
  STATE_CHANGE_TYPES,
  getAllStateChangeTypeIds,
  getStateChangeType,
} from "../stateChangeTypes.js";

// ─── All expected type IDs ────────────────────────────────────────────────────

const CHARACTER_TYPES = [
  "character.hp",
  "character.san",
  "character.fatigue",
  "character.condition",
  "character.position",
];

const ITEM_TYPES = ["item.move", "item.destroy", "item.create", "item.modify"];

const SCENE_TYPES = ["scene.condition"];

const MEMORY_TYPES = ["memory.event", "memory.witness"];

const RELATIONSHIP_TYPES = ["relationship.change"];

// ─── Existence checks ─────────────────────────────────────────────────────────

describe("STATE_CHANGE_TYPES — character types", () => {
  it.each(CHARACTER_TYPES)("has type %s", (typeId) => {
    expect(STATE_CHANGE_TYPES[typeId]).toBeDefined();
  });
});

describe("STATE_CHANGE_TYPES — item types", () => {
  it.each(ITEM_TYPES)("has type %s", (typeId) => {
    expect(STATE_CHANGE_TYPES[typeId]).toBeDefined();
  });
});

describe("STATE_CHANGE_TYPES — scene, memory, relationship types", () => {
  it.each([...SCENE_TYPES, ...MEMORY_TYPES, ...RELATIONSHIP_TYPES])(
    "has type %s",
    (typeId) => {
      expect(STATE_CHANGE_TYPES[typeId]).toBeDefined();
    }
  );
});

// ─── Schema shape checks ──────────────────────────────────────────────────────

const ALL_TYPES = [
  ...CHARACTER_TYPES,
  ...ITEM_TYPES,
  ...SCENE_TYPES,
  ...MEMORY_TYPES,
  ...RELATIONSHIP_TYPES,
];

describe("STATE_CHANGE_TYPES — schema shape", () => {
  it.each(ALL_TYPES)(
    "%s has schema with type=object, properties, and description",
    (typeId) => {
      const def = STATE_CHANGE_TYPES[typeId];
      expect(def).toBeDefined();
      expect(def.description).toBeTruthy();
      expect(typeof def.description).toBe("string");
      expect(def.schema).toBeDefined();
      expect(def.schema.type).toBe("object");
      expect(def.schema.properties).toBeDefined();
      expect(typeof def.schema.properties).toBe("object");
    }
  );
});

// ─── getStateChangeType ───────────────────────────────────────────────────────

describe("getStateChangeType", () => {
  it("returns the correct def for character.hp", () => {
    const def = getStateChangeType("character.hp");
    expect(def).toBeDefined();
    expect(def?.schema.type).toBe("object");
    expect(def?.schema.properties.characterId).toBeDefined();
    expect(def?.schema.properties.delta).toBeDefined();
    expect(def?.schema.required).toContain("characterId");
    expect(def?.schema.required).toContain("delta");
  });

  it("returns the correct def for character.san", () => {
    const def = getStateChangeType("character.san");
    expect(def).toBeDefined();
    expect(def?.schema.required).toContain("characterId");
    expect(def?.schema.required).toContain("delta");
  });

  it("returns the correct def for character.fatigue", () => {
    const def = getStateChangeType("character.fatigue");
    expect(def).toBeDefined();
    expect(def?.schema.required).toContain("characterId");
    expect(def?.schema.required).toContain("delta");
  });

  it("returns the correct def for character.condition — required is characterId only", () => {
    const def = getStateChangeType("character.condition");
    expect(def).toBeDefined();
    expect(def?.schema.required).toContain("characterId");
    expect(def?.schema.properties.add).toBeDefined();
    expect(def?.schema.properties.remove).toBeDefined();
    expect(def?.schema.properties.add?.type).toBe("array");
    expect(def?.schema.properties.remove?.type).toBe("array");
  });

  it("returns the correct def for character.position", () => {
    const def = getStateChangeType("character.position");
    expect(def).toBeDefined();
    expect(def?.schema.required).toContain("characterId");
    expect(def?.schema.required).toContain("sceneId");
    expect(def?.schema.properties.junction).toBeDefined();
  });

  it("returns the correct def for item.move — all three fields required", () => {
    const def = getStateChangeType("item.move");
    expect(def).toBeDefined();
    expect(def?.schema.required).toContain("itemId");
    expect(def?.schema.required).toContain("from");
    expect(def?.schema.required).toContain("to");
  });

  it("returns the correct def for item.destroy — only itemId required", () => {
    const def = getStateChangeType("item.destroy");
    expect(def).toBeDefined();
    expect(def?.schema.required).toContain("itemId");
    expect(def?.schema.required).not.toContain("from");
    expect(def?.schema.properties.from).toBeDefined();
  });

  it("returns the correct def for item.create — name and location required", () => {
    const def = getStateChangeType("item.create");
    expect(def).toBeDefined();
    expect(def?.schema.required).toContain("name");
    expect(def?.schema.required).toContain("location");
    expect(def?.schema.properties.properties).toBeDefined();
  });

  it("returns the correct def for item.modify — itemId and properties required", () => {
    const def = getStateChangeType("item.modify");
    expect(def).toBeDefined();
    expect(def?.schema.required).toContain("itemId");
    expect(def?.schema.required).toContain("properties");
  });

  it("returns the correct def for scene.condition — sceneId required", () => {
    const def = getStateChangeType("scene.condition");
    expect(def).toBeDefined();
    expect(def?.schema.required).toContain("sceneId");
    expect(def?.schema.properties.add).toBeDefined();
    expect(def?.schema.properties.remove).toBeDefined();
  });

  it("returns the correct def for memory.event — both fields required", () => {
    const def = getStateChangeType("memory.event");
    expect(def).toBeDefined();
    expect(def?.schema.required).toContain("characterId");
    expect(def?.schema.required).toContain("content");
  });

  it("returns the correct def for memory.witness — both fields required", () => {
    const def = getStateChangeType("memory.witness");
    expect(def).toBeDefined();
    expect(def?.schema.required).toContain("characterId");
    expect(def?.schema.required).toContain("content");
  });

  it("returns the correct def for relationship.change — fromId and toId required", () => {
    const def = getStateChangeType("relationship.change");
    expect(def).toBeDefined();
    expect(def?.schema.required).toContain("fromId");
    expect(def?.schema.required).toContain("toId");
    expect(def?.schema.properties.delta).toBeDefined();
    expect(def?.schema.properties.note).toBeDefined();
  });

  it("returns undefined for an unknown type", () => {
    expect(getStateChangeType("unknown.type")).toBeUndefined();
    expect(getStateChangeType("")).toBeUndefined();
    expect(getStateChangeType("character")).toBeUndefined();
  });
});

// ─── getAllStateChangeTypeIds ──────────────────────────────────────────────────

describe("getAllStateChangeTypeIds", () => {
  it("returns all registered type IDs", () => {
    const ids = getAllStateChangeTypeIds();
    for (const typeId of ALL_TYPES) {
      expect(ids).toContain(typeId);
    }
  });

  it("returns an array of strings", () => {
    const ids = getAllStateChangeTypeIds();
    expect(Array.isArray(ids)).toBe(true);
    for (const id of ids) {
      expect(typeof id).toBe("string");
    }
  });

  it("length matches the number of entries in STATE_CHANGE_TYPES", () => {
    const ids = getAllStateChangeTypeIds();
    expect(ids.length).toBe(Object.keys(STATE_CHANGE_TYPES).length);
  });
});
