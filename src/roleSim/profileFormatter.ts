// src/roleSim/profileFormatter.ts
//
// Formats the 12-field profile block for the user prompt's "## Who you are"
// section. Inventory and relationships come from runtime DGSM (not the
// profile's static fields), so this helper takes both.

import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { DynamicNPCProfile, InventoryItem } from "../state/types.js";

export function formatProfile(
  npc: DynamicNPCProfile,
  dgsm: DynamicGameStateManager
): string {
  const lines: string[] = [];
  lines.push(`Name: ${npc.name}`);

  const ageGenderParts: string[] = [];
  if (npc.age != null) ageGenderParts.push(`Age: ${npc.age}`);
  if (npc.gender) ageGenderParts.push(`Gender: ${npc.gender}`);
  if (ageGenderParts.length > 0) lines.push(ageGenderParts.join("  "));

  if (npc.occupation) lines.push(`Occupation: ${npc.occupation}`);
  if (npc.appearance) lines.push(`Appearance: ${npc.appearance}`);
  if (npc.personality) lines.push(`Personality: ${npc.personality}`);
  if (npc.background) lines.push(`Background: ${npc.background}`);
  if (npc.backstory) lines.push(`Backstory: ${npc.backstory}`);
  if (npc.residence) lines.push(`Residence: ${npc.residence}`);

  lines.push(formatStatusLine(npc));

  const inventoryLine = formatInventoryLine(dgsm, npc.id);
  if (inventoryLine) lines.push(inventoryLine);

  const relationshipsBlock = formatRelationshipsBlock(dgsm, npc.id);
  if (relationshipsBlock) lines.push(relationshipsBlock);

  return lines.join("\n");
}

function formatStatusLine(npc: DynamicNPCProfile): string {
  const s = npc.status;
  const parts = [
    `HP ${s.hp}/${s.maxHp}`,
    `SAN ${s.san}/${s.maxSan}`,
    `Fatigue ${s.fatigue}/${s.maxFatigue}`,
  ];
  let line = `Status: ${parts.join(", ")}`;
  if (s.conditions && s.conditions.length > 0) {
    const condDescs = s.conditions.map((c) => c.description).join(", ");
    line += `, Conditions: ${condDescs}`;
  }
  return line;
}

function formatInventoryLine(
  dgsm: DynamicGameStateManager,
  npcId: string
): string | null {
  const items = dgsm.getState().npcInventories?.[npcId] as
    | InventoryItem[]
    | undefined;
  if (!items || items.length === 0) return null;
  const parts = items.map((item) => {
    const qty =
      item.quantity && item.quantity > 1 ? ` (x${item.quantity})` : "";
    return `${item.name} [id: ${item.id}]${qty}`;
  });
  return `Inventory (cite items by id): ${parts.join(", ")}`;
}

function formatRelationshipsBlock(
  dgsm: DynamicGameStateManager,
  npcId: string
): string | null {
  const graph = dgsm.getState().npcRelationshipGraph?.[npcId];
  if (!graph) return null;
  const entries = Object.entries(graph);
  if (entries.length === 0) return null;

  const allNpcs = dgsm.getState().npcCharacters;
  const lines = entries.map(([targetId, rel]) => {
    const target = allNpcs.find((n) => n.id === targetId);
    const name = target?.name ?? targetId;
    return `  - ${name}: ${rel.note} (score: ${rel.score})`;
  });
  return ["Relationships:", ...lines].join("\n");
}
