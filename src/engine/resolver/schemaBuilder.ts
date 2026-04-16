import type { CustomFieldDef, OutputSchemaConfig } from "../types.js";
import { resolveOutputSchemaTypeIds } from "../outputSchema.js";
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

export function formatOutputSchemaPrompt(config: OutputSchemaConfig): string {
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

  return [
    "## Output Format",
    "",
    "Respond with a JSON object using only the allowed top-level fields below. Omit any field with no changes.",
    "For state change fields, each top-level field is an array of objects. Required keys are shown plainly; optional keys use `?`.",
    "",
    "### Allowed Fields",
    "",
    ...fieldBullets,
  ].join("\n");
}
