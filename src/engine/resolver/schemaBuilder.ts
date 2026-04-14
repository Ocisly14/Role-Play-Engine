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

// ===== Exports =====

export function buildOutputSchema(config: OutputSchemaConfig): JsonSchema {
  const properties: Record<string, any> = {};

  for (const typeId of config.use) {
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
  const schema = buildOutputSchema(config);
  const schemaJson = JSON.stringify(schema, null, 2);

  const descriptionBullets: string[] = [];

  for (const typeId of config.use) {
    const typeDef = STATE_CHANGE_TYPES[typeId];
    if (typeDef !== undefined) {
      descriptionBullets.push(`- **${typeId}**: ${typeDef.description}`);
    }
  }

  if (config.custom !== undefined) {
    for (const [fieldName, fieldDef] of Object.entries(config.custom)) {
      const desc =
        fieldDef.description ?? `Custom field of type ${fieldDef.type}.`;
      descriptionBullets.push(`- **${fieldName}**: ${desc}`);
    }
  }

  const descriptionsSection =
    descriptionBullets.length > 0
      ? `\n### Field Descriptions\n\n${descriptionBullets.join("\n")}`
      : "";

  return [
    "## Output Format",
    "",
    "Respond with a JSON object matching this schema exactly. Do not include any fields not listed here. Each state change type is an array (may be empty or omitted if no changes of that type).",
    "",
    "```json",
    schemaJson,
    "```",
    descriptionsSection,
  ].join("\n");
}
