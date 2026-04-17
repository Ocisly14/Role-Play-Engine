import { resolveOutputSchemaTypeIds } from "../../outputSchema.js";
import type { OutputSchemaConfig } from "../../types.js";
import {
  buildOutputSchema,
  formatOutputSchemaPrompt,
} from "../schemaBuilder.js";

describe("resolveOutputSchemaTypeIds", () => {
  it("expands presets and preserves stable merged order", () => {
    const config: OutputSchemaConfig = {
      presets: ["default"],
      use: ["memory.information", "character.fatigue", "relationship.change"],
    };

    expect(resolveOutputSchemaTypeIds(config)).toEqual([
      "memory.event",
      "character.fatigue",
      "scene.condition",
      "memory.information",
      "relationship.change",
    ]);
  });

  it("expands reusable item presets for skill composition", () => {
    const config: OutputSchemaConfig = {
      presets: ["default", "item_modify"],
      use: ["scene.condition", "item.modify"],
    };

    expect(resolveOutputSchemaTypeIds(config)).toEqual([
      "memory.event",
      "character.fatigue",
      "scene.condition",
      "item.move",
      "item.modify",
      "item.destroy",
      "item.create",
      "memory.information",
    ]);
  });

  it("throws on unknown preset", () => {
    expect(() =>
      resolveOutputSchemaTypeIds({
        presets: ["missing"],
      })
    ).toThrow('Unknown output schema preset: "missing"');
  });
});

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
    const config: OutputSchemaConfig = {};
    const schema = buildOutputSchema(config);

    expect(schema.properties).toEqual({});
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("handles a realistic definition with 6 types, all present as arrays", () => {
    const config: OutputSchemaConfig = {
      presets: ["default"],
      use: [
        "character.hp",
        "character.san",
        "character.condition",
        "relationship.change",
      ],
    };
    const schema = buildOutputSchema(config);

    const expectedTypes = [
      "character.hp",
      "character.san",
      "character.fatigue",
      "scene.condition",
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

    expect(Object.keys(schema.properties)).toHaveLength(7);
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

  it("includes preset-derived fields in the prompt", () => {
    const result = formatOutputSchemaPrompt({
      presets: ["default"],
      use: ["relationship.change"],
    });

    expect(result).toContain("memory.event");
    expect(result).toContain("character.fatigue");
    expect(result).toContain("scene.condition");
    expect(result).toContain("relationship.change");
  });

  it("uses compact field contracts instead of raw JSON schema", () => {
    const result = formatOutputSchemaPrompt({
      use: ["scene.condition", "item.destroy"],
    });

    expect(result).toContain("`scene.condition[]`");
    expect(result).toContain(
      "{ sceneId: string, add?: string[], remove?: string[] }"
    );
    expect(result).toContain("`item.destroy[]`");
    expect(result).toContain("{ itemId: string, from?: string }");
    expect(result).not.toContain('"additionalProperties"');
    expect(result).not.toContain('"type": "object"');
    expect(result).not.toContain('"required"');
  });

  it("omits the Required-on-Success block when skillSucceeded is false", () => {
    const result = formatOutputSchemaPrompt(
      {
        use: ["character.hp", "character.condition"],
        requireOnSuccess: ["character.hp", "character.condition"],
      },
      { skillSucceeded: false }
    );

    expect(result).not.toContain("Required on Success");
  });

  it("omits the Required-on-Success block when requireOnSuccess is empty", () => {
    const result = formatOutputSchemaPrompt(
      {
        use: ["memory.event"],
      },
      { skillSucceeded: true }
    );

    expect(result).not.toContain("Required on Success");
  });

  it("emits the Required-on-Success block when skillSucceeded and requireOnSuccess are set", () => {
    const result = formatOutputSchemaPrompt(
      {
        use: ["character.hp", "character.condition"],
        requireOnSuccess: ["character.hp", "character.condition"],
      },
      { skillSucceeded: true }
    );

    expect(result).toContain("### Required on Success");
    expect(result).toContain("`character.hp`");
    expect(result).toContain("`character.condition`");
    expect(result).toContain("at least one of");
    expect(result).toContain("Do NOT respond with only");
  });
});
