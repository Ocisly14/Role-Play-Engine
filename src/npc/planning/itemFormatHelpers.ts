import type { DynamicScene, Item } from "../../state/types.js";

/**
 * One-line summary of an Item: "Name (id: X, type: Y, ...key stats)"
 * Designed for LLM consumption in planning prompts.
 */
export function formatItemSummary(item: Item): string {
  const tags: string[] = [`id: ${item.id}`];
  if (item.type) tags.push(`type: ${item.type}`);
  if (item.damaged) tags.push("damaged");
  if (item.isLightSource !== undefined) {
    tags.push(item.isLightSource ? "lit" : "unlit");
  }
  if (item.consumableStats?.uses !== undefined) {
    tags.push(`uses: ${item.consumableStats.uses}`);
  }
  if (item.containerStats) {
    tags.push(item.containerStats.locked ? "locked" : "unlocked");
  }
  if (item.weaponStats?.ammo !== undefined) {
    tags.push(`ammo: ${item.weaponStats.ammo}`);
  }
  return `${item.name} (${tags.join(", ")})`;
}

/** Format an array of Items as a bulleted list of summaries. */
export function formatItemList(items: Item[]): string {
  if (items.length === 0) return "";
  return items.map((i) => `- ${formatItemSummary(i)}`).join("\n");
}

/** Format scene items for prompt injection. Returns empty string if scene is null. */
export function formatSceneItems(scene: DynamicScene | null): string {
  if (!scene) return "";
  if (scene.items.length === 0) return "No items in this scene.";
  return formatItemList(scene.items);
}
