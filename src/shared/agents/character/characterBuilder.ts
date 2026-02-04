/**
 * Character Builder - CoC 7th Edition Rules
 *
 * Provides functions for generating random character attributes
 * according to Call of Cthulhu 7th Edition rules.
 */

/**
 * Roll dice (e.g., 3d6 means roll 3 six-sided dice)
 */
function rollDice(numDice: number, sides: number): number {
  let total = 0;
  for (let i = 0; i < numDice; i++) {
    total += Math.floor(Math.random() * sides) + 1;
  }
  return total;
}

/**
 * Generate random attributes according to CoC 7th Edition rules
 */
export function generateRandomAttributes(age?: number) {
  const attributes = {
    STR: rollDice(3, 6) * 5,      // Strength: 3d6×5
    DEX: rollDice(3, 6) * 5,      // Dexterity: 3d6×5
    SIZ: (rollDice(2, 6) + 6) * 5, // Size: (2d6+6)×5
    APP: rollDice(3, 6) * 5,      // Appearance: 3d6×5
    CON: rollDice(3, 6) * 5,      // Constitution: 3d6×5
    INT: (rollDice(2, 6) + 6) * 5, // Intelligence: (2d6+6)×5
    POW: rollDice(3, 6) * 5,      // Power: 3d6×5
    EDU: (rollDice(2, 6) + 6) * 5, // Education: (2d6+6)×5
    LCK: rollDice(3, 6) * 5,      // Luck: 3d6×5
  };

  // Apply age modifiers if age is provided
  if (age) {
    applyAgeModifiers(attributes, age);
  }

  // Calculate derived attributes
  const derived = calculateDerivedAttributes(attributes);

  return {
    ...attributes,
    ...derived,
  };
}

/**
 * Apply age modifiers to attributes according to CoC 7th Edition rules
 */
function applyAgeModifiers(attributes: any, age: number) {
  if (age >= 15 && age <= 19) {
    // Teenager: -5 STR and SIZ, -5 EDU
    attributes.STR = Math.max(5, attributes.STR - 5);
    attributes.SIZ = Math.max(5, attributes.SIZ - 5);
    attributes.EDU = Math.max(5, attributes.EDU - 5);
    // Roll twice for Luck and take the higher value
    const luck1 = rollDice(3, 6) * 5;
    const luck2 = rollDice(3, 6) * 5;
    attributes.LCK = Math.max(luck1, luck2);
  } else if (age >= 20 && age <= 39) {
    // Young adult: Make an improvement check for EDU
    // (This would typically be done during character creation process)
  } else if (age >= 40 && age <= 49) {
    // Middle age: -5 STR, CON, or DEX (player choice), +10 EDU
    // For random generation, we'll reduce DEX
    attributes.DEX = Math.max(5, attributes.DEX - 5);
    attributes.EDU = Math.min(99, attributes.EDU + 10);
  } else if (age >= 50 && age <= 59) {
    // Senior: -10 STR, CON, or DEX (total), +20 EDU
    attributes.STR = Math.max(5, attributes.STR - 5);
    attributes.DEX = Math.max(5, attributes.DEX - 5);
    attributes.EDU = Math.min(99, attributes.EDU + 20);
  } else if (age >= 60 && age <= 69) {
    // Old: -20 STR, CON, or DEX (total), +30 EDU
    attributes.STR = Math.max(5, attributes.STR - 10);
    attributes.CON = Math.max(5, attributes.CON - 5);
    attributes.DEX = Math.max(5, attributes.DEX - 5);
    attributes.EDU = Math.min(99, attributes.EDU + 30);
  } else if (age >= 70 && age <= 79) {
    // Very old: -40 STR, CON, or DEX (total), +40 EDU
    attributes.STR = Math.max(5, attributes.STR - 15);
    attributes.CON = Math.max(5, attributes.CON - 10);
    attributes.DEX = Math.max(5, attributes.DEX - 15);
    attributes.EDU = Math.min(99, attributes.EDU + 40);
  } else if (age >= 80) {
    // Ancient: -80 STR, CON, or DEX (total), +40 EDU
    attributes.STR = Math.max(5, attributes.STR - 25);
    attributes.CON = Math.max(5, attributes.CON - 25);
    attributes.DEX = Math.max(5, attributes.DEX - 25);
    attributes.APP = Math.max(5, attributes.APP - 5);
    attributes.EDU = Math.min(99, attributes.EDU + 40);
  }
}

/**
 * Calculate derived attributes (HP, MP, SAN, MOV, BUILD, DB)
 */
function calculateDerivedAttributes(attributes: any) {
  // Hit Points: (CON + SIZ) / 10 (rounded down)
  const HP = Math.floor((attributes.CON + attributes.SIZ) / 10);

  // Magic Points: POW / 5 (rounded down)
  const MP = Math.floor(attributes.POW / 5);

  // Sanity: Equal to POW
  const SAN = attributes.POW;

  // Luck: Equal to LCK
  const LUCK = attributes.LCK;

  // Movement Rate
  let MOV = 8; // Default
  if (attributes.DEX < attributes.SIZ && attributes.STR < attributes.SIZ) {
    MOV = 7;
  } else if (attributes.DEX >= attributes.SIZ && attributes.STR >= attributes.SIZ) {
    MOV = 9;
  }

  // Build and Damage Bonus
  const buildSum = attributes.STR + attributes.SIZ;
  let BUILD = 0;
  let DB = "0";

  if (buildSum >= 2 && buildSum <= 64) {
    BUILD = -2;
    DB = "-2";
  } else if (buildSum >= 65 && buildSum <= 84) {
    BUILD = -1;
    DB = "-1";
  } else if (buildSum >= 85 && buildSum <= 124) {
    BUILD = 0;
    DB = "0";
  } else if (buildSum >= 125 && buildSum <= 164) {
    BUILD = 1;
    DB = "+1d4";
  } else if (buildSum >= 165 && buildSum <= 204) {
    BUILD = 2;
    DB = "+1d6";
  } else if (buildSum >= 205 && buildSum <= 284) {
    BUILD = 3;
    DB = "+2d6";
  } else if (buildSum >= 285 && buildSum <= 364) {
    BUILD = 4;
    DB = "+3d6";
  } else if (buildSum >= 365 && buildSum <= 444) {
    BUILD = 5;
    DB = "+4d6";
  } else if (buildSum >= 445) {
    BUILD = 6;
    DB = "+5d6";
  }

  return {
    HP,
    MP,
    SAN,
    LUCK,
    MOV,
    BUILD,
    DB,
    ARMOR: "-", // Default no armor
  };
}

/**
 * Validate attribute value (should be between 1 and 99 for most attributes)
 */
export function validateAttribute(attribute: string, value: number): boolean {
  if (value < 1 || value > 99) {
    return false;
  }
  return true;
}
