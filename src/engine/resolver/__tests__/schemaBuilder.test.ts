import type { OutputSchemaConfig } from "../../types.js";
import {
  buildOutputSchema,
  formatOutputSchemaPrompt,
} from "../schemaBuilder.js";

describe("buildOutputSchema", () => {
  it("wraps standard state change types as arrays", () => {
    const config: OutputSchemaConfig = {
      use: ["character.hp", "character.san"],
    };
    const schema = buildOutputSchema(config);

    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);

    expect(schema.properties["character.hp"]).toEqual({
      type: "array",
      items: expect.objectContaining({ type: "object" }),
    });
    expect(schema.properties["character.san"]).toEqual({
      type: "array",
      items: expect.objectContaining({ type: "object" }),
    });
  });

  it("includes custom fields at top level", () => {
    const config: OutputSchemaConfig = {
      use: [],
      custom: {
        narrative: { type: "string", description: "Story summary" },
        severity: { type: "number" },
      },
    };
    const schema = buildOutputSchema(config);

    expect(schema.properties["narrative"]).toEqual({
      type: "string",
      description: "Story summary",
    });
    expect(schema.properties["severity"]).toEqual({
      type: "number",
    });
  });

  it("converts string[] custom type to array of strings", () => {
    const config: OutputSchemaConfig = {
      use: [],
      custom: {
        tags: { type: "string[]", description: "List of tags" },
      },
    };
    const schema = buildOutputSchema(config);

    expect(schema.properties["tags"]).toEqual({
      type: "array",
      items: { type: "string" },
      description: "List of tags",
    });
  });

  it("converts number[] custom type to array of numbers", () => {
    const config: OutputSchemaConfig = {
      use: [],
      custom: {
        scores: { type: "number[]" },
      },
    };
    const schema = buildOutputSchema(config);

    expect(schema.properties["scores"]).toEqual({
      type: "array",
      items: { type: "number" },
    });
  });

  it("throws on unknown state change type", () => {
    const config: OutputSchemaConfig = {
      use: ["character.hp", "nonexistent.type"],
    };
    expect(() => buildOutputSchema(config)).toThrow(
      'Unknown state change type: "nonexistent.type"'
    );
  });

  it("returns empty properties for empty use and no custom", () => {
    const config: OutputSchemaConfig = {
      use: [],
    };
    const schema = buildOutputSchema(config);

    expect(schema.properties).toEqual({});
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("handles a realistic definition with 6 types, all present as arrays", () => {
    const config: OutputSchemaConfig = {
      use: [
        "character.hp",
        "character.san",
        "character.fatigue",
        "character.condition",
        "memory.event",
        "relationship.change",
      ],
    };
    const schema = buildOutputSchema(config);

    const expectedTypes = [
      "character.hp",
      "character.san",
      "character.fatigue",
      "character.condition",
      "memory.event",
      "relationship.change",
    ];

    for (const typeId of expectedTypes) {
      expect(schema.properties[typeId]).toBeDefined();
      expect(schema.properties[typeId].type).toBe("array");
      expect(schema.properties[typeId].items).toBeDefined();
      expect(schema.properties[typeId].items.type).toBe("object");
    }

    expect(Object.keys(schema.properties)).toHaveLength(6);
  });
});

describe("formatOutputSchemaPrompt", () => {
  it("returns a string containing 'Output Format'", () => {
    const config: OutputSchemaConfig = {
      use: ["character.hp"],
    };
    const result = formatOutputSchemaPrompt(config);

    expect(typeof result).toBe("string");
    expect(result).toContain("Output Format");
  });
});
