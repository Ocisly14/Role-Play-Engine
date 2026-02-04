import type { CoCDatabase } from "../../../src/shared/agents/memory/database/index.js";

/**
 * Prepare character data for database insertion
 * @param characterData - Raw character data from frontend
 * @returns Formatted character data ready for database
 */
export function prepareCharacterForDB(characterData: any): any {
  const characterId = `char-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  return {
    character_id: characterId,
    name: characterData.identity.name,
    attributes: JSON.stringify(characterData.attributes || {}),
    status: JSON.stringify({
      hp: characterData.derived?.HP || 10,
      maxHp: characterData.derived?.HP || 10,
      sanity: characterData.derived?.SAN || (characterData.attributes?.POW || 60),
      maxSanity: 99, // COC规则：最大理智值固定为99
      luck: characterData.derived?.LUCK || characterData.attributes?.LCK || 50,
      mp: characterData.derived?.MP || (characterData.attributes?.POW ? Math.floor(characterData.attributes.POW / 5) : 10),
      damageBonus: characterData.derived?.DB || "0",
      build: characterData.derived?.BUILD || 0,
      mov: characterData.derived?.MOV || 8,
      conditions: [],
    }),
    inventory: JSON.stringify([
      // Add items as InventoryItem objects
      ...(characterData.items || [])
        .filter((item: any) => item.name)
        .map((item: any) => ({
          name: item.name,
          quantity: item.quantity || 1,
          properties: item.properties || undefined
        })),
      // Add weapons as InventoryItem objects (for backward compatibility)
      ...(characterData.weapons || [])
        .filter((w: any) => w.name)
        .map((w: any) => ({
          name: w.name,
          quantity: 1,
          properties: {
            type: 'weapon',
            skill: w.skill,
            damage: w.damage,
            range: w.range,
            attacks: w.attacks,
            ammo: w.ammo
          }
        }))
    ]),
    skills: JSON.stringify(
      Object.entries(characterData.skills || {}).reduce((acc: any, [name, data]: [string, any]) => {
        // Support both old format (data.value) and new format (data.total with breakdown)
        if (typeof data === 'object' && data.total !== undefined) {
          // New format: store complete skill data with breakdown
          acc[name] = {
            value: data.total,
            base: data.base || 0,
            occupationalPoints: data.occupationalPoints || 0,
            interestPoints: data.interestPoints || 0
          };
        } else {
          // Old format or simple value: store as is
          acc[name] = typeof data === 'object' ? (data.value || 0) : data;
        }
        return acc;
      }, {})
    ),
    notes: JSON.stringify({
      era: characterData.identity?.era || "",
      gender: characterData.identity?.gender || "",
      residence: characterData.identity?.residence || "",
      birthplace: characterData.identity?.birthplace || "",
      appearance: characterData.notes?.appearance || "",
      ideology: characterData.notes?.ideology || "",
      people: characterData.notes?.people || "",
      gear: characterData.notes?.gear || "",
      backstory: characterData.notes?.backstory || "",
      weapons: characterData.weapons || [],
    }),
    is_npc: 0, // Player character
    occupation: characterData.identity?.occupation || null,
    age: characterData.identity?.age || null,
    appearance: characterData.notes?.appearance || null,
    personality: characterData.notes?.ideology || null,
    background: characterData.notes?.backstory || null,
    goals: null,
    secrets: null,
  };
}

/**
 * Parse character data from database for frontend
 * @param character - Raw character data from database
 * @returns Parsed character with JSON fields converted
 */
export function parseCharacterFromDB(character: any): any {
  const attributes = character.attributes ? JSON.parse(character.attributes) : null;
  const derived = character.derived ? JSON.parse(character.derived) : null;
  const status = character.status ? JSON.parse(character.status) : null;
  const skills = character.skills ? JSON.parse(character.skills) : null;
  const inventory = character.inventory ? JSON.parse(character.inventory) : [];
  const notes = character.notes ? JSON.parse(character.notes) : null;

  // Extract weapons from inventory
  const weapons: any[] = [];
  const items: any[] = [];

  if (Array.isArray(inventory)) {
    inventory.forEach((item: any) => {
      if (item.properties && item.properties.type === 'weapon') {
        // This is a weapon stored in inventory
        weapons.push({
          name: item.name,
          skill: item.properties.skill || '',
          damage: item.properties.damage || '',
          range: item.properties.range || '',
          attacks: item.properties.attacks || '',
          ammo: item.properties.ammo || ''
        });
      } else {
        // Regular inventory item
        items.push(item);
      }
    });
  }

  // Process skills to extract the value
  const processedSkills: any = {};
  if (skills) {
    Object.keys(skills).forEach(skillName => {
      const skillData = skills[skillName];
      if (typeof skillData === 'object' && skillData.value !== undefined) {
        processedSkills[skillName] = skillData.value;
      } else {
        processedSkills[skillName] = skillData;
      }
    });
  }

  return {
    ...character,
    attributes,
    derived,
    status,
    skills: processedSkills,
    weapons,
    items,
    notes,
    // Explicitly preserve occupation and other direct fields
    occupation: character.occupation,
    age: character.age,
    gender: character.gender,
    appearance: character.appearance,
    personality: character.personality,
    background: character.background,
  };
}
