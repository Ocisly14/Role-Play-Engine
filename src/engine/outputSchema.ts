import type { OutputSchemaConfig } from "./types.js";

export const OUTPUT_SCHEMA_PRESETS: Record<string, readonly string[]> = {
  default: ["memory.event", "character.fatigue", "scene.condition"],
  item_modify: [
    "item.move",
    "item.modify",
    "item.destroy",
    "item.create",
    "memory.information",
  ],
};

/**
 * Expand presets and explicit use entries into one ordered, deduplicated list.
 * Preset-expanded types always come before explicit additions.
 */
export function resolveOutputSchemaTypeIds(
  config?: OutputSchemaConfig
): string[] {
  if (!config) return [];

  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const presetName of config.presets ?? []) {
    const presetTypes = OUTPUT_SCHEMA_PRESETS[presetName];
    if (!presetTypes) {
      throw new Error(`Unknown output schema preset: "${presetName}"`);
    }

    for (const typeId of presetTypes) {
      if (seen.has(typeId)) continue;
      seen.add(typeId);
      resolved.push(typeId);
    }
  }

  for (const typeId of config.use ?? []) {
    if (seen.has(typeId)) continue;
    seen.add(typeId);
    resolved.push(typeId);
  }

  return resolved;
}
