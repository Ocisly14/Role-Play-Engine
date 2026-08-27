// src/roleSim/profileFormatter.ts
//
// Formats the character's own description, split by how long each part stays
// true:
//
//  - `formatProfile` — who they are. Module-authored, never moves for the
//    life of the session, so it can sit inside the prompt's cached prefix.
//  - `formatSkills` — what they are good and bad at. Also frozen: no
//    WorldDelta operation touches skill values, so a character's training is
//    fixed for the session.
//  - `formatCondition` — how they are RIGHT NOW: vitals, conditions, what
//    they carry, who they know. The stamina subsystem moves fatigue on most
//    ticks and items change hands, so this must sit AFTER the breakpoint.
//    Mixed in with the profile it invalidated the whole prefix every tick.

import { resolveSkillValue } from "../engine/actions/skillRollService.js";
import { SKILL_CATALOG } from "../engine/rules/skillCatalog.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { DynamicNPCProfile, InventoryItem } from "../state/types.js";

/** Who they are. Nothing here changes while the session runs. */
export function formatProfile(npc: DynamicNPCProfile): string {
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

  return lines.join("\n");
}

/** How they are this minute. Expected to differ from the previous tick. */
export function formatCondition(
  npc: DynamicNPCProfile,
  dgsm: DynamicGameStateManager
): string {
  const lines: string[] = [formatStatusLine(npc)];

  const inventoryLine = formatInventoryLine(dgsm, npc.id);
  if (inventoryLine) lines.push(inventoryLine);

  // No relationships block. It rendered the graph's note verbatim — and that
  // note IS the character's own `relationship` memory, which is injected whole
  // a few lines further down. The character was reading the same sentence
  // twice, and paying for it twice.

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
    return `${item.name} [${item.id}]${qty}`;
  });
  return `Inventory (the bracketed tag is how you cite it): ${parts.join(", ")}`;
}
/**
 * What this character is good and bad at, best first.
 *
 * A person knows their own hands. Withholding the numbers left the agent
 * choosing whether to declare a skill with no idea whether it was a strength,
 * and it declared none at all — 25 actions out of 25 in one measured run.
 *
 * Every value goes through `resolveSkillValue`, the same resolver the intake
 * uses when a skill is actually declared: trained value if the sheet has one,
 * the catalog's base value otherwise. A prompt that computed its own numbers
 * would be telling the character something the dice then disagree with.
 */
export function formatSkills(npc: DynamicNPCProfile): string {
  const rated = SKILL_CATALOG.map((skill) => ({
    name: skill.name,
    value: resolveSkillValue(skill.name, npc.skills ?? {})?.value ?? skill.base,
  })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

  const lines = [
    // Stated in the terms the ladder actually uses (`successLevelFor`), so the
    // character can weigh an attempt instead of guessing what 65 means.
    "Your training, best first. The number is your chance in 100 of a",
    "straightforward success; half of it does notably better, a fifth of it is",
    "your best work. Low is not nothing — it is a long shot, not a refusal.",
    "",
    // Languages is excluded from the rated list: it has no single value, and
    // printing one would tell the character something the dice never use.
    ...rated
      .filter((s) => s.name !== "Languages")
      .map((s) => `- ${s.name} ${s.value}`),
  ];

  const native = npc.languages?.native ?? [];
  const learned = Object.entries(npc.languages?.learned ?? {}).sort(
    (a, b) => b[1] - a[1]
  );
  if (native.length > 0 || learned.length > 0) {
    lines.push(
      "",
      "Languages. You never roll to use one you grew up in — you simply speak",
      "it. Naming any other tongue is a Languages check at the fluency below.",
      ...(native.length > 0
        ? [`- ${native.join(", ")} (yours, no check)`]
        : []),
      ...learned.map(([tongue, value]) => `- ${tongue} ${value}`)
    );
  }

  return lines.join("\n");
}
