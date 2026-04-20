import { resolveOutputSchemaTypeIds } from "../outputSchema.js";
import type { CustomFieldDef, OutputSchemaConfig } from "../types.js";
import { STATE_CHANGE_TYPES } from "./stateChangeTypes.js";

// ===== Interfaces =====

export interface JsonSchema {
  type: string;
  properties: Record<string, any>;
  additionalProperties: boolean;
}

// ===== Helpers =====

function customFieldToJsonSchema(
  fieldDef: CustomFieldDef
): Record<string, any> {
  const schema: Record<string, any> = {};

  if (fieldDef.type === "string[]") {
    schema.type = "array";
    schema.items = { type: "string" };
  } else if (fieldDef.type === "number[]") {
    schema.type = "array";
    schema.items = { type: "number" };
  } else {
    schema.type = fieldDef.type;
  }

  if (fieldDef.description !== undefined) {
    schema.description = fieldDef.description;
  }

  return schema;
}

function formatSchemaTypeLabel(schema: Record<string, any>): string {
  if (schema.type === "array") {
    const itemLabel = schema.items
      ? formatSchemaTypeLabel(schema.items as Record<string, any>)
      : "unknown";
    return `${itemLabel}[]`;
  }

  if (schema.type === "object") {
    if (schema.properties) {
      const required = new Set<string>(schema.required ?? []);
      const fields = Object.entries(schema.properties).map(
        ([fieldName, fieldSchema]) => {
          const optionalSuffix = required.has(fieldName) ? "" : "?";
          return `${fieldName}${optionalSuffix}: ${formatSchemaTypeLabel(fieldSchema as Record<string, any>)}`;
        }
      );
      return `{ ${fields.join(", ")} }`;
    }
    return "object";
  }

  return String(schema.type ?? "unknown");
}

// ===== Exports =====

export function buildOutputSchema(config: OutputSchemaConfig): JsonSchema {
  const properties: Record<string, any> = {};

  for (const typeId of resolveOutputSchemaTypeIds(config)) {
    const typeDef = STATE_CHANGE_TYPES[typeId];
    if (typeDef === undefined) {
      throw new Error(`Unknown state change type: "${typeId}"`);
    }
    properties[typeId] = {
      type: "array",
      items: typeDef.schema,
    };
  }

  if (config.custom !== undefined) {
    for (const [fieldName, fieldDef] of Object.entries(config.custom)) {
      properties[fieldName] = customFieldToJsonSchema(fieldDef);
    }
  }

  return {
    type: "object",
    properties,
    additionalProperties: false,
  };
}

/**
 * Static system prompt shared by every resolver call.
 *
 * Contains universal rules that never vary by definition or per-invocation:
 * role, output format conventions, always-required fields, elapsedMinutes
 * priority rules, and the semantics of the per-definition blocks.
 *
 * Kept as a top-level constant so LLM providers can prefix-cache it: all
 * resolver calls share an identical prompt prefix, and only the
 * per-definition + per-request tail varies.
 */
export const RESOLVER_STATIC_SYSTEM_PROMPT = `You are a Call of Cthulhu 7th Edition game state resolver. You output structured state changes only — no narrative, no prose.

## Output Format

Respond with a JSON object using only the top-level fields declared as allowed for this action. Omit any field with no changes.
For state-change fields, each top-level field is an array of objects. Required keys are shown plainly; optional keys use \`?\`.

## Universally Required Fields

Two top-level fields MUST appear in EVERY resolution, regardless of skill outcome (success, failure, fumble, or interrupted):

### \`memory.event\`
First-person record of what the actor did or attempted. An empty resolution is NEVER acceptable.

### \`elapsedMinutes\` (integer ≥ 1)
Decide using this PRIORITY ORDER:
1. **Explicit time in the action text is AUTHORITATIVE.** If the actor says "半小时"/"30 分钟"/"two hours"/"整整一天"/"a few minutes", use that number. HONOR it even when it exceeds the definition's Duration Guidance range — the range is typical, not a hard cap.
2. **Qualitative time modifiers shift toward a bound of the Duration Guidance range.** "扫一眼"/"a quick glance"/"匆匆" → lower bound. "仔细"/"彻底"/"thoroughly"/"carefully" → upper bound. "瞬间"/"instantly" → minimum 1.
3. **Otherwise use the Duration Guidance default**, adjusted by skill outcome (critical = faster, extreme = may finish early, fumble = slower) and context (injured actor, obstructed scene).
Report ACTUAL elapsed time — never echo the scheduled duration.

## Schema Conventions

The per-action block below may contain any of these sub-sections:

- **Allowed Fields** — the only top-level keys you may emit. Any other key is rejected.
- **Duration Guidance** — default and range for \`elapsedMinutes\` for this skill.
- **Required on Success** — when the skill check succeeded, your output MUST include at least one of these fields with non-empty content, in addition to the universally required fields. Fallback keys (\`memory.event\` / \`character.fatigue\`) do NOT satisfy this requirement on their own — they are already required.
- **Required on Failure** — when the skill check failed or fumbled, your output MUST include at least one of these fields with non-empty content. Failure is NOT "nothing happened" — the world still changed. These capture the physical side effects of the failed attempt (damaged tools, wasted materials, spilled contents, etc.).
`;

export interface FormatOutputSchemaPromptOptions {
  /** Whether the action's skill check succeeded (no-skill-check counts as success). */
  skillSucceeded?: boolean;
}

/**
 * Render the per-definition output-schema section that is concatenated after
 * the shared `RESOLVER_STATIC_SYSTEM_PROMPT`.
 *
 * Contains only the definition-specific values (allowed field list,
 * duration numbers, specific required-key lists) — no general explanation,
 * which lives in the static prompt.
 */
export function formatOutputSchemaPrompt(
  config: OutputSchemaConfig,
  options?: FormatOutputSchemaPromptOptions
): string {
  const fieldBullets: string[] = [];

  for (const typeId of resolveOutputSchemaTypeIds(config)) {
    const typeDef = STATE_CHANGE_TYPES[typeId];
    if (typeDef !== undefined) {
      fieldBullets.push(
        `- \`${typeId}[]\`: ${formatSchemaTypeLabel(typeDef.schema)} — ${typeDef.description}`
      );
    }
  }

  if (config.custom !== undefined) {
    for (const [fieldName, fieldDef] of Object.entries(config.custom)) {
      const desc =
        fieldDef.description ?? `Custom field of type ${fieldDef.type}.`;
      fieldBullets.push(
        `- \`${fieldName}\`: ${formatSchemaTypeLabel(customFieldToJsonSchema(fieldDef))} — ${desc}`
      );
    }
  }

  const sections: string[] = [
    "## This Action",
    "",
    "### Allowed Fields",
    "",
    ...fieldBullets,
    "- `elapsedMinutes`: integer — minutes this action actually consumed.",
  ];

  const duration = config.durationGuidance;
  if (duration !== undefined) {
    sections.push("");
    sections.push("### Duration Guidance");
    sections.push("");
    const parts: string[] = [`Default: ${duration.default} min`];
    if (duration.range) parts.push(`Range: ${duration.range}`);
    sections.push(parts.join(". ") + ".");
    if (duration.notes) {
      sections.push(duration.notes);
    }
  }

  const skillSucceeded = options?.skillSucceeded ?? true;

  if (
    skillSucceeded &&
    config.requireOnSuccess !== undefined &&
    config.requireOnSuccess.length > 0
  ) {
    const requiredList = config.requireOnSuccess
      .map((key) => `\`${key}\``)
      .join(", ");
    sections.push("");
    sections.push("### Required on Success");
    sections.push("");
    sections.push(`At least one of: ${requiredList}.`);
  }

  if (
    !skillSucceeded &&
    config.requireOnFailure !== undefined &&
    config.requireOnFailure.length > 0
  ) {
    const requiredList = config.requireOnFailure
      .map((key) => `\`${key}\``)
      .join(", ");
    sections.push("");
    sections.push("### Required on Failure");
    sections.push("");
    sections.push(`At least one of: ${requiredList}.`);
  }

  return sections.join("\n");
}
