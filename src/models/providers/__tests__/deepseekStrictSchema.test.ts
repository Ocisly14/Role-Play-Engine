import { describe, expect, it } from "vitest";
import { stripNulls, toDeepSeekStrictSchema } from "../deepseekStrictSchema.js";

/** DeepSeek's strict validator, as documented, applied to a derived schema:
 *  every object closed, every property required, no length/size keywords.
 *  Returns the offending paths so a failure names where it broke. */
function violations(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => violations(item, `${path}[${i}]`));
  }
  if (typeof node !== "object" || node === null) return [];
  const o = node as Record<string, unknown>;
  const found: string[] = [];

  for (const banned of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (banned in o) found.push(`${path}.${banned}`);
  }

  if (o.properties && typeof o.properties === "object") {
    const props = Object.keys(o.properties as Record<string, unknown>);
    const required = new Set((o.required as string[] | undefined) ?? []);
    for (const name of props) {
      if (!required.has(name))
        found.push(`${path}.required is missing ${name}`);
    }
    if (o.additionalProperties !== false) {
      found.push(`${path}.additionalProperties is not false`);
    }
  }

  for (const [key, value] of Object.entries(o)) {
    found.push(...violations(value, `${path}.${key}`));
  }
  return found;
}

describe("toDeepSeekStrictSchema", () => {
  it("requires every property, spelling the optional ones as nullable", () => {
    const converted = toDeepSeekStrictSchema({
      type: "object",
      properties: {
        actionId: { type: "string" },
        outcome: { type: "string", description: "what came of it" },
      },
      required: ["actionId"],
      additionalProperties: false,
    }) as Record<string, unknown>;

    expect(converted.required).toEqual(["actionId", "outcome"]);
    const props = converted.properties as Record<string, unknown>;
    // The required one is untouched.
    expect(props.actionId).toEqual({ type: "string" });
    // The optional one gains a null branch — and keeps its description at the
    // level the model reads it, not buried inside a branch.
    expect(props.outcome).toEqual({
      description: "what came of it",
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  it("drops the four keywords DeepSeek's validator rejects", () => {
    const converted = toDeepSeekStrictSchema({
      type: "object",
      properties: {
        route: { type: "array", items: { type: "string" }, minItems: 1 },
        name: { type: "string", minLength: 2, maxLength: 40 },
        tags: { type: "array", items: { type: "string" }, maxItems: 8 },
      },
      required: ["route", "name", "tags"],
    });

    expect(violations(converted)).toEqual([]);
    expect(JSON.stringify(converted)).not.toMatch(
      /minItems|maxItems|minLength|maxLength/
    );
  });

  it("keeps the keywords DeepSeek does support", () => {
    // enum, const and minimum/maximum are all in the supported list; dropping
    // them would loosen the grammar for no reason.
    const converted = toDeepSeekStrictSchema({
      type: "object",
      properties: {
        level: { type: "string", enum: ["easy", "hard"] },
        kind: { const: "scene" },
        ticks: { type: "integer", minimum: 1 },
      },
      required: ["level", "kind", "ticks"],
    }) as { properties: Record<string, unknown> };

    expect(converted.properties.level).toEqual({
      type: "string",
      enum: ["easy", "hard"],
    });
    // `const` survives; the `type` beside it is the separate rule above.
    expect(converted.properties.kind).toEqual({
      type: "string",
      const: "scene",
    });
    expect(converted.properties.ticks).toEqual({
      type: "integer",
      minimum: 1,
    });
  });

  it("gives a bare `const` the type DeepSeek insists every node declares", () => {
    // `opSchema` writes discriminators as `{const: "hp"}`. Anthropic infers the
    // type; DeepSeek 400s the request ("one of `type`, `anyOf`, `$ref` field is
    // required") and that single omission is what kept submit_effects out of
    // strict mode — it looked like the grammar-size refusal and was not.
    const converted = toDeepSeekStrictSchema({
      type: "object",
      properties: {
        kind: { const: "hp" },
        flag: { const: true },
        count: { const: 3 },
        already: { type: "string", const: "scene" },
      },
      required: ["kind", "flag", "count", "already"],
    }) as { properties: Record<string, Record<string, unknown>> };

    expect(converted.properties.kind).toEqual({ type: "string", const: "hp" });
    expect(converted.properties.flag).toEqual({ type: "boolean", const: true });
    expect(converted.properties.count).toEqual({ type: "integer", const: 3 });
    // An explicit type already there is left exactly as written.
    expect(converted.properties.already).toEqual({
      type: "string",
      const: "scene",
    });
  });

  it("closes and completes objects nested under arrays and anyOf alike", () => {
    const converted = toDeepSeekStrictSchema({
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { a: { type: "string" }, b: { type: "string" } },
            required: ["a"],
          },
        },
        op: {
          anyOf: [
            {
              type: "object",
              properties: { hp: { type: "integer" }, why: { type: "string" } },
              required: ["hp"],
            },
          ],
        },
      },
      required: ["rows", "op"],
    });

    expect(violations(converted)).toEqual([]);
  });

  it("leaves an object with no property map alone", () => {
    // Closing a free-form object would narrow it to `{}` — a different
    // contract, not a stricter spelling of the same one.
    expect(toDeepSeekStrictSchema({ type: "object" })).toEqual({
      type: "object",
    });
    expect(toDeepSeekStrictSchema({})).toEqual({});
  });

  it("does not mutate the schema it was given", () => {
    const original = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    };
    const snapshot = JSON.stringify(original);
    toDeepSeekStrictSchema(original);
    // The same object is handed to Anthropic and OpenAI on the very next call.
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe("stripNulls", () => {
  it("removes the nulls a nullable grammar forces the model to write", () => {
    expect(
      stripNulls({
        starting: [
          {
            actionId: "a1",
            resolvedDurationTicks: null,
            check: null,
            movement: { route: ["SCN_A"], vehicleId: null },
          },
        ],
        ending: [],
      })
    ).toEqual({
      starting: [{ actionId: "a1", movement: { route: ["SCN_A"] } }],
      ending: [],
    });
  });

  it('drops the word "null" — the model spelling our own null branch', () => {
    // DeepSeek's strict mode does not enforce `enum` (probed), so nothing on
    // the wire stops this. It only appears because the rewrite offered a null
    // branch in the first place.
    expect(stripNulls({ skillId: "null", language: "null", a: 1 })).toEqual({
      a: 1,
    });
  });

  it("keeps falsy values that are not null", () => {
    // `0`, `""` and `false` all mean something here — `spot: ""` clears a spot.
    // `""` stays: `spot: ""` clears a spot, and the trust boundary already
    // reads an empty string as absent wherever one can turn up.
    expect(stripNulls({ a: 0, b: "", c: false, d: null })).toEqual({
      a: 0,
      b: "",
      c: false,
    });
  });

  it("leaves a null inside an array where the validator can see it", () => {
    // No schema makes an array ELEMENT nullable, so one arriving is the model
    // breaking the grammar. That belongs in the validator's report.
    expect(stripNulls({ route: ["SCN_A", null] })).toEqual({
      route: ["SCN_A", null],
    });
  });
});
