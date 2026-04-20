import { resolveOutputSchemaTypeIds } from "../../outputSchema.js";
import type { OutputSchemaConfig } from "../../types.js";
import {
  buildOutputSchema,
  formatOutputSchemaPrompt,
  RESOLVER_STATIC_SYSTEM_PROMPT,
} from "../schemaBuilder.js";

describe("resolveOutputSchemaTypeIds", () => {
  it("expands presets and preserves stable merged order", () => {
    const config: OutputSchemaConfig = {
      presets: ["default"],
      use: ["relationship.change", "character.fatigue", "item.modify"],
    };

    expect(resolveOutputSchemaTypeIds(config)).toEqual([
      "memory.event",
      "character.fatigue",
      "scene.condition",
      "relationship.change",
      "item.modify",
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

describe("RESOLVER_STATIC_SYSTEM_PROMPT", () => {
  it("declares universal output format rules", () => {
    expect(RESOLVER_STATIC_SYSTEM_PROMPT).toContain("Output Format");
    expect(RESOLVER_STATIC_SYSTEM_PROMPT).toContain("JSON object");
  });

  it("names memory.event and elapsedMinutes as universally required", () => {
    expect(RESOLVER_STATIC_SYSTEM_PROMPT).toContain(
      "Universally Required Fields"
    );
    expect(RESOLVER_STATIC_SYSTEM_PROMPT).toContain("`memory.event`");
    expect(RESOLVER_STATIC_SYSTEM_PROMPT).toContain("`elapsedMinutes`");
    expect(RESOLVER_STATIC_SYSTEM_PROMPT).toContain("EVERY resolution");
  });

  it("encodes the elapsedMinutes priority order (explicit > qualitative > default)", () => {
    expect(RESOLVER_STATIC_SYSTEM_PROMPT).toContain("PRIORITY ORDER");
    expect(RESOLVER_STATIC_SYSTEM_PROMPT).toContain("AUTHORITATIVE");
    expect(RESOLVER_STATIC_SYSTEM_PROMPT).toContain("半小时");
    expect(RESOLVER_STATIC_SYSTEM_PROMPT).toContain("扫一眼");
  });

  it("explains Required-on-Success / Required-on-Failure semantics", () => {
    expect(RESOLVER_STATIC_SYSTEM_PROMPT).toContain("Required on Success");
    expect(RESOLVER_STATIC_SYSTEM_PROMPT).toContain("Required on Failure");
    expect(RESOLVER_STATIC_SYSTEM_PROMPT).toContain(
      'Failure is NOT "nothing happened"'
    );
  });
});

describe("formatOutputSchemaPrompt", () => {
  it("returns a string with the per-action section header", () => {
    const config: OutputSchemaConfig = { use: ["character.hp"] };
    const result = formatOutputSchemaPrompt(config);

    expect(typeof result).toBe("string");
    expect(result).toContain("## This Action");
    expect(result).toContain("### Allowed Fields");
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
    expect(result).toContain("At least one of");
  });

  it("omits the Required-on-Failure block when skillSucceeded is true", () => {
    const result = formatOutputSchemaPrompt(
      {
        use: ["item.modify"],
        requireOnFailure: ["item.modify"],
      },
      { skillSucceeded: true }
    );

    expect(result).not.toContain("Required on Failure");
  });

  it("omits the Required-on-Failure block when requireOnFailure is empty", () => {
    const result = formatOutputSchemaPrompt(
      {
        use: ["memory.event"],
      },
      { skillSucceeded: false }
    );

    expect(result).not.toContain("Required on Failure");
  });

  it("emits the Required-on-Failure block when skillSucceeded is false and requireOnFailure is set", () => {
    const result = formatOutputSchemaPrompt(
      {
        use: ["item.modify", "character.fatigue"],
        requireOnFailure: ["item.modify", "character.fatigue"],
      },
      { skillSucceeded: false }
    );

    expect(result).toContain("### Required on Failure");
    expect(result).toContain("`item.modify`");
    expect(result).toContain("`character.fatigue`");
    expect(result).toContain("At least one of");
  });

  it("lists elapsedMinutes alongside state-change fields in Allowed Fields", () => {
    const result = formatOutputSchemaPrompt({
      use: ["character.hp"],
    });

    expect(result).toContain("`elapsedMinutes`");
    expect(result).toContain("integer");
  });

  it("renders Duration Guidance block when durationGuidance is set", () => {
    const result = formatOutputSchemaPrompt({
      use: ["character.hp"],
      durationGuidance: {
        default: 5,
        range: "1-15",
        notes: "light wound 1-3 min; severe bleeding 3-10 min.",
      },
    });

    expect(result).toContain("### Duration Guidance");
    expect(result).toContain("Default: 5 min");
    expect(result).toContain("Range: 1-15");
    expect(result).toContain("light wound 1-3 min");
  });

  it("omits Duration Guidance block when durationGuidance is absent", () => {
    const result = formatOutputSchemaPrompt({
      use: ["character.hp"],
    });

    expect(result).not.toContain("Duration Guidance");
  });

  it("renders Duration Guidance with only default when range and notes omitted", () => {
    const result = formatOutputSchemaPrompt({
      use: ["character.hp"],
      durationGuidance: { default: 3 },
    });

    expect(result).toContain("### Duration Guidance");
    expect(result).toContain("Default: 3 min");
    expect(result).not.toContain("Range:");
  });
});
