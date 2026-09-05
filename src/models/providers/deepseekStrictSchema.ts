// src/models/providers/deepseekStrictSchema.ts
//
// The DeepSeek-only shape of a `strict` tool schema.
//
// DeepSeek's strict mode (beta) constrains sampling to the tool's JSON Schema,
// but it accepts a narrower schema language than either of the other two
// vendors, and its server VALIDATES that language before generating anything:
// an unsupported keyword or an unclosed object 400s the whole request rather
// than degrading to unconstrained output. The rules, from the tool-calling
// guide:
//
//   * every property of every object must be listed in `required`
//   * every object must set `additionalProperties: false`
//   * `minLength`/`maxLength` (string) and `minItems`/`maxItems` (array) are
//     not supported — everything else our schemas use is: `enum`, `const`,
//     `anyOf`, `minimum`/`maximum`, `$ref`/`$defs`
//
// The first rule is the hard one. Every phase tool is `strict: true` for
// Anthropic, whose strict mode allows optional properties, and several of their
// nested fields are genuinely optional — on `submit_starts` alone, `check` is
// absent when no check applies and `movement` when nobody travels — so marking
// them required would be a lie the model has to satisfy.
//
// So this module DERIVES the DeepSeek variant instead of asking anyone to
// author a second copy. Each optional property becomes required-but-nullable —
// `anyOf: [<the original>, {type: "null"}]`, the same trick OpenAI's strict
// mode documents — and the adapter strips those nulls back out of the answer,
// so nothing downstream ever learns that this happened. One schema stays the
// source of truth; the variant cannot drift from it, because it is a function
// of it.
//
// The alternative — a hand-written second schema — was rejected for exactly
// the reason `SUBMISSION_PROPERTIES` exists as one table: a contract stated
// twice is a contract that disagrees with itself by the third edit.

/** Keywords DeepSeek's strict validator names as unsupported. Dropping them
 *  loses a bound the schema was never enforcing anyway — `worldDeltaValidator`
 *  is what actually holds the contract (see its note on `maxItems`). */
const UNSUPPORTED_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);

/** Properties handled by the object rebuild below rather than copied through. */
const REBUILT_KEYWORDS = new Set(["properties", "required"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * DeepSeek's validator demands that EVERY node declare one of `type`, `anyOf`
 * or `$ref`:
 *
 *   400 invalid_request_error — "Invalid tool parameters schema : field
 *   `anyOf`: one of `type`, `anyOf`, `$ref` field is required"
 *
 * `opSchema` writes a discriminator as a bare `{const: "hp"}` — legal JSON
 * Schema, and enough for Anthropic, which infers the type from the value. This
 * is the one thing that stood between DeepSeek and strict submission of the
 * phase tools' operation unions; it read as a grammar-size problem (Anthropic's
 * failure mode for the same schemas) and was neither.
 *
 * So the type is filled in from the constant itself. Only for a node that
 * declares nothing else — a `const` sitting beside an explicit `type` is
 * already valid and is left alone.
 */
function typeOfConst(value: unknown): string | undefined {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  if (value === null) return "null";
  return undefined;
}

/**
 * "Absent" spelled the only way a strict grammar can spell it. The description
 * is hoisted onto the wrapper so the model still reads the field's guidance at
 * the place it fills the field in — buried inside an `anyOf` branch it is easy
 * to miss, and these descriptions are load-bearing (`movement` alone carries
 * the rule that a route is stated, never invented).
 */
function nullable(schema: unknown): Record<string, unknown> {
  if (!isPlainObject(schema)) {
    return { anyOf: [schema, { type: "null" }] };
  }
  const { description, ...rest } = schema;
  return {
    ...(description !== undefined ? { description } : {}),
    anyOf: [rest, { type: "null" }],
  };
}

/**
 * Rewrite a tool's `inputSchema` into the subset DeepSeek's strict mode
 * accepts. Pure: the input is never mutated.
 *
 * An object with no `properties` is left as it is — closing it with
 * `additionalProperties: false` would narrow it to the empty object, which is
 * a different contract, not a stricter spelling of the same one.
 */
export function toDeepSeekStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toDeepSeekStrictSchema);
  if (!isPlainObject(schema)) return schema;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key) || REBUILT_KEYWORDS.has(key)) continue;
    out[key] = toDeepSeekStrictSchema(value);
  }

  if (
    "const" in schema &&
    out.type === undefined &&
    out.anyOf === undefined &&
    out.$ref === undefined
  ) {
    const inferred = typeOfConst(schema.const);
    if (inferred !== undefined) out.type = inferred;
  }

  const properties = schema.properties;
  if (!isPlainObject(properties)) {
    // No property map to close over — but `required` may still be here (a
    // branch that names fields defined by a sibling `$ref`), so carry it.
    if (schema.required !== undefined) out.required = schema.required;
    return out;
  }

  // Read the ORIGINAL required set before overwriting it: which fields were
  // optional is the one fact this whole rewrite turns on.
  const wasRequired = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : []
  );
  const rebuilt: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(properties)) {
    const converted = toDeepSeekStrictSchema(sub);
    rebuilt[name] = wasRequired.has(name) ? converted : nullable(converted);
  }

  out.properties = rebuilt;
  out.required = Object.keys(rebuilt);
  out.additionalProperties = false;
  return out;
}

/**
 * Can this schema be a grammar at all?
 *
 * DeepSeek requires every node — the root included — to declare one of `type`,
 * `anyOf` or `$ref`. A tool whose `inputSchema` is `{}` (or anything else that
 * declares nothing) therefore cannot be sent strict: the request would 400 as
 * a whole, taking the tools that ARE expressible down with it.
 *
 * This is the one thing that keeps "everything strict" honest. A schema that
 * says nothing constrains nothing, so asking for a grammar over it is asking
 * for a rejection in exchange for no guarantee.
 */
export function canBeStrict(derived: unknown): boolean {
  if (!isPlainObject(derived)) return false;
  return (
    derived.type !== undefined ||
    derived.anyOf !== undefined ||
    derived.$ref !== undefined
  );
}

/**
 * Undo the nullability on the way back. A grammar that requires every field
 * gets `"check": null` for a check that does not apply, and the rest of the
 * engine has never been asked to read that: `validateRawResolution` sees an
 * absent field, or it sees a malformed one. Dropping the nulls here means the
 * DeepSeek path hands downstream code byte-for-byte what the other providers
 * hand it.
 *
 * The literal STRING "null" goes too, and that is not a guess about what the
 * model meant. DeepSeek's strict mode enforces structure but NOT `enum`
 * membership — probed directly: a `strict` tool whose only property is
 * `{type: "string", enum: ["Athletics", "Occult"]}` answered `""` when pushed.
 * So nothing stops a field from carrying the word "null", and it is this
 * rewrite that put the idea there: the model is spelling OUR null branch as a
 * string. Measured over one 5-tick run, 24 `act` calls produced `skillId:
 * "null"` once and `language: "null"` twice; the first cost a rejected command
 * and a re-decided minute.
 *
 * `""` is deliberately NOT dropped. It is a real value somewhere in this
 * codebase — `spot: ""` clears a character's spot — and the trust boundary
 * already reads an empty string as absent for every field that invited one
 * (`commandValidator` trims `skillId`, `language` and `utterance`). "null" has
 * no such reading and no legitimate use: no id, no name and no sentence in
 * this world is that word.
 *
 * Only object properties are dropped. A null INSIDE an array survives, because
 * no schema here makes an array element nullable — one appearing would be the
 * model breaking the grammar, and that belongs in the validator's report, not
 * quietly deleted here.
 */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner === null || inner === "null") continue;
    out[key] = stripNulls(inner);
  }
  return out;
}
