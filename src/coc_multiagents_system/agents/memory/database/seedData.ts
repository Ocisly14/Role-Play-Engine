/**
 * Seed data for CoC database
 * Loads default rules, skills, weapons, and sanity triggers
 */

import type { CoCDatabase } from "./schema.js";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

export function seedDatabase(db: CoCDatabase): void {
  const database = db.getDatabase();

  // Check if game data already seeded
  const count = database
    .prepare("SELECT COUNT(*) as count FROM skills")
    .get() as { count: number };

  if (count.count === 0) {
    console.log("Seeding database with CoC 7e rules...");

    db.transaction(() => {
      seedSkills(database);
      seedWeapons(database);
      seedSanityTriggers(database);
    });

    console.log("Game data seeding complete!");
  } else {
    console.log("Game data already seeded, skipping...");
  }

  // Always check and create default admin if needed (independent of game data)
  seedDefaultAdmin(database);
}

function seedSkills(db: any): void {
  const insertSkill = db.prepare(`
        INSERT INTO skills (name, base_value, description, category, uncommon, examples)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

  const skills = [
    // Interpersonal & Social Skills
    ["Charm", 15, "Being likeable, making friends, seduction", "social", 0, null],
    ["Fast Talk", 5, "Quick deception, misdirection, verbal tricks", "social", 0, null],
    ["Intimidate", 15, "Frightening or coercing others through threats", "social", 0, null],
    ["Persuade", 10, "Convincing others through logical argument", "social", 0, null],
    ["Psychology", 10, "Understanding human behavior, detecting lies, treating mental illness", "social", 0, null],

    // Knowledge & Academic Skills
    ["Accounting", 5, "Understanding financial records, detecting embezzlement", "knowledge", 0, null],
    ["Anthropology", 1, "Knowledge of human cultures and societies", "knowledge", 0, null],
    ["Archaeology", 1, "Knowledge of ancient cultures and artifacts", "knowledge", 0, null],
    ["Art and Craft", 5, "Artistic and craft skills", "knowledge", 0, null],
    ["History", 5, "Knowledge of historical events and periods", "knowledge", 0, null],
    ["Law", 5, "Knowledge of legal systems and procedures", "knowledge", 0, null],
    ["Library Use", 20, "Research in libraries, archives, databases", "knowledge", 0, null],
    ["Occult", 5, "Knowledge of supernatural beliefs, magic, and folklore", "knowledge", 0, null],
    ["Science (Biology)", 1, "Scientific knowledge of biology", "knowledge", 1, null],
    ["Science (Chemistry)", 1, "Scientific knowledge of chemistry", "knowledge", 1, null],
    ["Science (Physics)", 1, "Scientific knowledge of physics", "knowledge", 1, null],
    ["Appraise", 5, "Estimating value of objects and antiques", "knowledge", 0, null],

    // Perception & Investigation Skills
    ["Listen", 20, "Hearing sounds, eavesdropping, detecting noises", "investigation", 0, null],
    ["Spot Hidden", 25, "Finding hidden objects, spotting clues, noticing concealed things", "investigation", 0, null],
    ["Track", 10, "Following tracks and trails", "investigation", 0, null],

    // Physical & Movement Skills
    ["Climb", 20, "Scaling walls, climbing obstacles", "physical", 0, null],
    ["Dodge", 0, "Avoiding attacks and danger (calculated as DEX/2)", "physical", 0, null],
    ["Jump", 20, "Leaping over gaps and obstacles", "physical", 0, null],
    ["Swim", 20, "Swimming and water activities", "physical", 0, null],
    ["Throw", 20, "Throwing objects accurately", "physical", 0, null],
    ["Ride", 5, "Riding horses and similar animals", "physical", 0, null],

    // Stealth & Deception Skills
    ["Disguise", 5, "Changing appearance to avoid recognition", "stealth", 0, null],
    ["Sleight of Hand", 10, "Pickpocketing, palming objects, stage magic", "stealth", 0, null],
    ["Stealth", 20, "Moving silently, hiding, avoiding detection", "stealth", 0, null],

    // Mechanical & Technical Skills
    ["Electrical Repair", 10, "Repairing electrical devices", "technical", 0, null],
    ["Mechanical Repair", 10, "Repairing mechanical devices", "technical", 0, null],
    ["Operate Heavy Machinery", 1, "Operating cranes, bulldozers, etc.", "technical", 1, null],
    ["Pilot (Aircraft)", 1, "Piloting airplanes", "technical", 1, null],
    ["Pilot (Boat)", 1, "Piloting boats and ships", "technical", 1, null],
    ["Drive Auto", 20, "Driving automobiles", "technical", 0, null],
    ["Navigate", 10, "Finding direction, using maps", "technical", 0, null],

    // Medical & Survival Skills
    ["First Aid", 30, "Emergency medical treatment", "medical", 0, null],
    ["Medicine", 1, "Professional medical knowledge and practice", "medical", 1, null],
    ["Natural World", 10, "Knowledge of flora, fauna, and natural phenomena", "medical", 0, null],
    ["Survival (Arctic)", 10, "Surviving in arctic environments", "medical", 0, null],
    ["Survival (Desert)", 10, "Surviving in desert environments", "medical", 0, null],
    ["Survival (Forest)", 10, "Surviving in forest environments", "medical", 0, null],
    ["Psychoanalysis", 1, "Professional treatment of mental disorders", "medical", 1, null],

    // Combat Skills - Fighting
    ["Fighting (Brawl)", 25, "Hand-to-hand combat, punching, kicking", "combat", 0, null],
    ["Fighting (Sword)", 20, "Combat with swords", "combat", 0, null],
    ["Fighting (Axe)", 15, "Combat with axes", "combat", 0, null],
    ["Fighting (Whip)", 5, "Combat with whips", "combat", 0, null],

    // Combat Skills - Firearms
    ["Firearms (Handgun)", 20, "Using pistols and revolvers", "combat", 0, null],
    ["Firearms (Rifle/Shotgun)", 25, "Using rifles and shotguns", "combat", 0, null],
    ["Firearms (Submachine Gun)", 15, "Using submachine guns", "combat", 0, null],
    ["Firearms (Bow)", 15, "Using bows and crossbows", "combat", 0, null],

    // Criminal & Subterfuge Skills
    ["Locksmith", 1, "Picking locks and understanding security", "criminal", 1, null],
    ["Criminology", 1, "Understanding criminal behavior and investigation", "criminal", 1, null],
    ["Forgery", 1, "Creating fake documents and signatures", "criminal", 1, null],

    // Communication & Language Skills
    ["Language (Own)", 0, "Native language (EDU×5)", "language", 0, null],
    ["Language (Other)", 1, "Foreign language", "language", 0, null],

    // Financial & Status Skill
    ["Credit Rating", 0, "Wealth and social standing", "status", 0, null],

    // Cthulhu Mythos
    ["Cthulhu Mythos", 0, "Knowledge of the Mythos (reduces max Sanity)", "mythos", 1, null],
  ];

  skills.forEach((skill) => insertSkill.run(...skill));
}


function seedWeapons(db: any): void {
  const insertWeapon = db.prepare(`
        INSERT INTO weapons (name, skill, damage, range, attacks_per_round, ammo, malfunction, era)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

  const weapons = [
    // ===== MELEE WEAPONS =====
    ["Unarmed", "Fighting (Brawl)", "1d3+DB", "touch", 1, null, null, "1920s,modern"],
    ["Bow", "Firearms (Bow)", "1d6+half DB", "30 yards", 1, 1, 97, "1920s,modern"],
    ["Brass Knuckles", "Fighting (Brawl)", "1d3+1+DB", "touch", 1, null, null, "1920s,modern"],
    ["Whip", "Fighting (Whip)", "1d3+half DB", "10 feet", 1, null, null, "1920s"],
    ["Burning Torch", "Fighting (Brawl)", "1d6+burn", "touch", 1, null, null, "1920s,modern"],
    ["Chainsaw", "Fighting (Chainsaw)", "2d8", "touch", 1, null, 95, "modern"],
    ["Leather-wrapped Club", "Fighting (Brawl)", "1d8+DB", "touch", 1, null, null, "1920s,modern"],
    ["Large Club", "Fighting (Brawl)", "1d8+DB", "touch", 1, null, null, "1920s,modern"],
    ["Small Club", "Fighting (Brawl)", "1d6+DB", "touch", 1, null, null, "1920s,modern"],
    ["Crossbow", "Firearms (Bow)", "1d8+2", "50 yards", 1, 1, 96, "1920s,modern"],
    ["Garrote", "Fighting (Garrote)", "1d6+DB", "touch", 1, null, null, "1920s,modern"],
    ["Axe/Sickle", "Fighting (Axe)", "1d6+1+DB", "touch", 1, null, null, "1920s,modern"],
    ["Large Knife", "Fighting (Brawl)", "1d8+DB", "touch", 1, null, null, "1920s,modern"],
    ["Medium Knife", "Fighting (Brawl)", "1d4+2+DB", "touch", 1, null, null, "1920s,modern"],
    ["Small Knife", "Fighting (Brawl)", "1d4+DB", "touch", 1, null, null, "1920s,modern"],
    ["220V Live Wire", "Fighting (Brawl)", "2d8+stun", "touch", 1, null, 95, "modern"],
    ["Tear Gas", "Fighting (Brawl)", "stun", "6 feet", 1, 25, 95, "1920s,modern"],
    ["Nunchaku", "Fighting (Flail)", "1d8+DB", "touch", 1, null, null, "1920s,modern"],
    ["Thrown Rock", "Throw", "1d4+half DB", "STR feet", 1, null, null, "1920s,modern"],
    ["Shuriken", "Throw", "1d3+half DB", "20 yards", 2, null, 100, "1920s,modern"],
    ["Lance (Cavalry)", "Fighting (Spear)", "1d8+1+DB", "touch", 1, null, null, "1920s,modern"],
    ["Thrown Spear", "Throw", "1d8+half DB", "STR yards", 1, null, null, "rare"],
    ["Large Sword", "Fighting (Sword)", "1d8+1+DB", "touch", 1, null, null, "1920s,modern"],
    ["Medium Sword", "Fighting (Sword)", "1d6+1+DB", "touch", 1, null, null, "1920s,modern"],
    ["Light Sword", "Fighting (Sword)", "1d6+DB", "touch", 1, null, null, "1920s,modern"],
    ["Stun Baton", "Fighting (Brawl)", "1d3+stun", "touch", 1, null, 97, "modern"],
    ["Taser", "Firearms (Handgun)", "1d3+stun", "15 feet", 1, 3, 95, "modern"],
    ["Throwing Blade Boomerang", "Throw", "1d8+half DB", "STR yards", 1, null, null, "rare"],
    ["Wood Axe", "Fighting (Axe)", "1d8+2+DB", "touch", 1, null, null, "1920s,modern"],

    // ===== HANDGUNS =====
    ["Flintlock Pistol", "Firearms (Handgun)", "1d6+1", "10 yards", 1, 1, 95, "rare"],
    [".22 Short Auto Pistol", "Firearms (Handgun)", "1d6", "10 yards", 3, 6, 100, "1920s,modern"],
    [".25 Short Pistol (Derringer)", "Firearms (Handgun)", "1d6", "3 yards", 1, 1, 100, "1920s"],
    [".32 or 7.65mm Revolver", "Firearms (Handgun)", "1d8", "15 yards", 3, 6, 100, "1920s,modern"],
    [".32 or 7.65mm Auto Pistol", "Firearms (Handgun)", "1d8", "15 yards", 3, 8, 99, "1920s,modern"],
    [".357 Magnum Revolver", "Firearms (Handgun)", "1d8+1d4", "15 yards", 3, 6, 100, "modern"],
    [".38 or 9mm Revolver", "Firearms (Handgun)", "1d10", "15 yards", 3, 6, 100, "1920s,modern"],
    [".38 Auto Pistol", "Firearms (Handgun)", "1d10", "15 yards", 3, 8, 99, "1920s,modern"],
    ["Beretta M9", "Firearms (Handgun)", "1d10", "15 yards", 3, 15, 98, "modern"],
    ["Glock 17 9mm Auto", "Firearms (Handgun)", "1d10", "15 yards", 3, 17, 98, "modern"],
    ["Luger P08", "Firearms (Handgun)", "1d10", "15 yards", 3, 8, 99, "1920s,modern"],
    [".41 Revolver", "Firearms (Handgun)", "1d10", "15 yards", 3, 8, 100, "1920s,rare"],
    [".44 Magnum Revolver", "Firearms (Handgun)", "1d10+1d4+2", "15 yards", 3, 6, 100, "modern"],
    [".45 Revolver", "Firearms (Handgun)", "1d10+2", "15 yards", 3, 6, 100, "1920s,modern"],
    [".45 Auto Pistol", "Firearms (Handgun)", "1d10+2", "15 yards", 3, 7, 100, "1920s,modern"],
    ["Desert Eagle", "Firearms (Handgun)", "1d10+1d6+3", "15 yards", 3, 7, 94, "modern"],

    // ===== RIFLES =====
    [".58 Springfield Rifle", "Firearms (Rifle/Shotgun)", "1d10+4", "60 yards", 1, 1, 95, "rare"],
    [".22 Lever-action Rifle", "Firearms (Rifle/Shotgun)", "1d6+1", "30 yards", 1, 6, 99, "1920s,modern"],
    [".30 Carbine", "Firearms (Rifle/Shotgun)", "2d6", "50 yards", 1, 6, 98, "1920s,modern"],
    [".45 Martini-Henry Rifle", "Firearms (Rifle/Shotgun)", "1d8+1d6+3", "80 yards", 1, 1, 100, "1920s"],
    ["Colonel Moran's Air Rifle", "Firearms (Rifle/Shotgun)", "2d6+1", "20 yards", 1, 1, 88, "1920s"],
    ["Garand M1/M2 Rifle", "Firearms (Rifle/Shotgun)", "2d6+4", "110 yards", 1, 8, 100, "WWII+"],
    ["SKS Semi-Auto Rifle", "Firearms (Rifle/Shotgun)", "2d6+1", "90 yards", 2, 10, 97, "modern"],
    [".303 (7.7mm) Lee-Enfield", "Firearms (Rifle/Shotgun)", "2d6+4", "110 yards", 1, 5, 100, "1920s,modern"],
    [".30-06 (7.62mm) Bolt Rifle", "Firearms (Rifle/Shotgun)", "2d6+4", "110 yards", 1, 5, 100, "1920s,modern"],
    [".30-06 (7.62mm) Semi-Auto", "Firearms (Rifle/Shotgun)", "2d6+4", "110 yards", 1, 5, 100, "modern"],
    [".444 (11.28mm) Marlin Rifle", "Firearms (Rifle/Shotgun)", "2d8+4", "110 yards", 1, 5, 98, "modern"],
    ["Elephant Gun (Double Barrel)", "Firearms (Rifle/Shotgun)", "3d6+4", "100 yards", 2, 2, 100, "1920s,modern"],

    // ===== SHOTGUNS =====
    ["20-gauge Shotgun (Double)", "Firearms (Rifle/Shotgun)", "2d6/1d6/1d3", "10/20/50 yards", 2, 2, 100, "1920s"],
    ["16-gauge Shotgun (Double)", "Firearms (Rifle/Shotgun)", "2d6+2/1d6+1/1d4", "10/20/50 yards", 2, 2, 100, "1920s"],
    ["12-gauge Shotgun (Double)", "Firearms (Rifle/Shotgun)", "4d6/2d6/1d6", "10/20/50 yards", 2, 2, 100, "1920s,modern"],
    ["12-gauge Pump Shotgun", "Firearms (Rifle/Shotgun)", "4d6/2d6/1d6", "10/20/50 yards", 1, 5, 100, "modern"],
    ["12-gauge Semi-Auto Shotgun", "Firearms (Rifle/Shotgun)", "4d6/2d6/1d6", "10/20/50 yards", 2, 5, 100, "modern"],
    ["Sawed-off 12-gauge Double", "Firearms (Rifle/Shotgun)", "4d6/1d6", "5/10 yards", 2, 2, 100, "1920s"],
    ["10-gauge Shotgun (Double)", "Firearms (Rifle/Shotgun)", "4d6+2/2d6+1/1d4", "10/20/50 yards", 2, 2, 100, "1920s,rare"],
    ["Benelli M3 12-gauge (Folding)", "Firearms (Rifle/Shotgun)", "4d6/2d6/1d6", "10/20/50 yards", 2, 7, 100, "modern"],
    ["SPAS 12-gauge (Folding)", "Firearms (Rifle/Shotgun)", "4d6/2d6/1d6", "10/20/50 yards", 1, 8, 98, "modern"],

    // ===== ASSAULT RIFLES =====
    ["AK-47 or AKM", "Firearms (Rifle/Shotgun)", "2d6+1", "100 yards", 3, 30, 100, "modern"],
    ["AK-74", "Firearms (Rifle/Shotgun)", "2d6", "110 yards", 3, 30, 97, "modern"],
    ["Barrett M82", "Firearms (Rifle/Shotgun)", "2d10+1d8+6", "250 yards", 1, 11, 96, "modern"],
    ["FN FAL Light Automatic", "Firearms (Rifle/Shotgun)", "2d6+4", "110 yards", 3, 20, 97, "modern"],
    ["Galil Assault Rifle", "Firearms (Rifle/Shotgun)", "2d6", "110 yards", 3, 20, 98, "modern"],
    ["M16A2", "Firearms (Rifle/Shotgun)", "2d6", "110 yards", 3, 30, 97, "modern"],
    ["M4", "Firearms (Rifle/Shotgun)", "2d6", "90 yards", 3, 30, 97, "modern"],
    ["Steyr AUG", "Firearms (Rifle/Shotgun)", "2d6", "110 yards", 3, 30, 99, "modern"],
    ["Barrett M70/90", "Firearms (Rifle/Shotgun)", "2d6", "110 yards", 3, 30, 99, "modern"],

    // ===== SUBMACHINE GUNS =====
    ["Bergmann MP18/MP28", "Firearms (Submachine Gun)", "1d10", "20 yards", 3, 32, 96, "1920s"],
    ["Heckler-Koch MP5", "Firearms (Submachine Gun)", "1d10", "20 yards", 3, 30, 97, "modern"],
    ["MAC-11", "Firearms (Submachine Gun)", "1d10", "15 yards", 3, 32, 96, "modern"],
    ["Scorpion SMG", "Firearms (Submachine Gun)", "1d8", "15 yards", 3, 20, 96, "modern"],
    ["Thompson SMG", "Firearms (Submachine Gun)", "1d10+2", "20 yards", 3, 30, 96, "1920s"],
    ["Uzi Mini SMG", "Firearms (Submachine Gun)", "1d10", "20 yards", 3, 32, 98, "modern"],

    // ===== MACHINE GUNS =====
    ["M1882 Gatling Gun", "Firearms (Machine Gun)", "2d6+4", "100 yards", 999, 200, 96, "1920s,rare"],
    ["M1918 Browning Auto Rifle", "Firearms (Machine Gun)", "2d6+4", "90 yards", 3, 20, 100, "1920s"],
    ["M1917A1 Browning Heavy MG", "Firearms (Machine Gun)", "2d6+4", "150 yards", 999, 250, 96, "1920s"],
    ["Bren Light Machine Gun", "Firearms (Machine Gun)", "2d6+4", "110 yards", 3, 30, 96, "1920s"],
    ["Lewis Light Machine Gun", "Firearms (Machine Gun)", "2d6+4", "110 yards", 999, 97, 96, "1920s"],
    ["Minigun", "Firearms (Machine Gun)", "2d6+4", "200 yards", 999, 4000, 98, "modern"],
    ["FN Minimi 5.56mm LMG", "Firearms (Machine Gun)", "2d6", "110 yards", 999, 200, 99, "modern"],
    ["Vickers MK1 Machine Gun", "Firearms (Machine Gun)", "2d6+4", "110 yards", 999, 250, 99, "1920s"],

    // ===== EXPLOSIVES & HEAVY WEAPONS =====
    ["Molotov Cocktail", "Throw", "2d6+burn", "STR yards", 1, null, 95, "1920s,modern"],
    ["Flare Gun", "Firearms (Handgun)", "1d10+1d3+burn", "10 yards", 1, 1, 100, "1920s,modern"],
    ["M79 Grenade Launcher", "Firearms (Heavy Weapon)", "3d10/2 yards", "20 yards", 1, 1, 99, "modern"],
    ["Improvised Explosive", "Throw", "4d10/3 yards", "STR feet", 1, null, 99, "1920s,modern"],
    ["Blasting Cap", "Electrical Repair", "2d10/1 yard", "placed", 1, null, 100, "1920s,modern"],
    ["Pipe Bomb", "Demolitions", "1d10/3 yards", "placed", 1, null, 95, "1920s,modern"],
    ["Plastic Explosive (C4) 100g", "Demolitions", "6d10/3 yards", "placed", 1, null, 99, "modern"],
    ["Hand Grenade", "Throw", "4d10/3 yards", "STR feet", 1, null, 99, "1920s,modern"],
    ["81mm Mortar", "Artillery", "6d10/6 yards", "500 yards", 2, null, 100, "modern"],
    ["75mm Field Gun", "Artillery", "10d10/2 yards", "500 yards", 1, null, 99, "1920s,modern"],
    ["120mm Tank Cannon (Stabilized)", "Artillery", "15d10/4 yards", "2000 yards", 1, null, 100, "modern"],
    ["5-inch Naval Gun (Stabilized)", "Artillery", "12d10/4 yards", "3000 yards", 2, null, 98, "modern"],
    ["Anti-personnel Mine", "Demolitions", "4d10/5 yards", "placed", 1, null, 99, "1920s,modern"],
    ["Claymore Mine", "Demolitions", "6d6/20 yards", "placed", 1, null, 99, "modern"],
    ["Flamethrower", "Firearms (Flamethrower)", "2d6+burn", "25 yards", 1, 10, 93, "1920s,modern"],
    ["Light Anti-tank Weapon", "Firearms (Heavy Weapon)", "8d10/1 yard", "150 yards", 1, 1, 98, "modern"],
  ];

  weapons.forEach((weapon) => insertWeapon.run(...weapon));
}

function seedSanityTriggers(db: any): void {
  const insertTrigger = db.prepare(`
        INSERT INTO sanity_triggers (trigger, sanity_loss, description)
        VALUES (?, ?, ?)
    `);

  const triggers = [
    // Common horrors
    ["Seeing a dead body", "0/1d3", null],
    ["Seeing a particularly gruesome death", "1/1d6", null],
    ["Seeing a loved one die", "1d4/1d6+2", null],
    ["Witnessing a violent death", "0/1d4", null],
    ["Seeing a mutilated corpse", "0/1d6", null],
    ["Committing murder", "1d4/1d6", null],

    // Unnatural entities
    ["Seeing a minor Mythos creature (Ghoul)", "0/1d6", null],
    ["Seeing a major Mythos creature (Shoggoth)", "1d6/1d20", null],
    ["Seeing a Great Old One (Cthulhu)", "1d10/1d100", null],
    ["Seeing Nyarlathotep", "1d10/1d100", null],
    ["Seeing Yog-Sothoth", "1d10/1d100", null],

    // Mythos magic and artifacts
    ["Witnessing Mythos magic", "0/1d6", null],
    ["Casting Mythos spell (first time)", "1d6", null],
    ["Reading Necronomicon (full)", "1d6/2d6", null],
    ["Reading De Vermis Mysteriis", "1d3/1d6", null],

    // Disturbing situations
    ["Seeing a ghoul feast", "1/1d6", null],
    ["Being buried alive", "1d6/1d10", null],
    ["Experiencing possession", "1d4/1d10", null],
    ["Torture", "1d6/2d6", null],
    ["Experiencing body horror transformation", "1d6/2d10", null],

    // Minor disturbances
    ["Startling surprise", "0/1", null],
    ["Creepy atmosphere", "0/1d3", null],
    ["Strange noises in the dark", "0/1d3", null],
  ];

  triggers.forEach((trigger) => insertTrigger.run(...trigger));
}

/**
 * Seed default admin user
 * Creates test@test.com with password "test" for development/demo purposes
 */
function seedDefaultAdmin(db: any): void {
  // Check if admin already exists
  const existingAdmin = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get("test@test.com");

  if (existingAdmin) {
    console.log("Default admin already exists, skipping...");
    return;
  }

  console.log("Creating default admin user (test@test.com)...");

  const userId = randomUUID();
  const passwordHash = bcrypt.hashSync("test", 10);

  const insertUser = db.prepare(`
    INSERT INTO users (
      id, email, username, password_hash, is_email_verified, is_active, role, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  insertUser.run(
    userId,
    "test@test.com",
    "admin",
    passwordHash,
    1, // is_email_verified: true
    1, // is_active: true
    "ADMIN" // role: ADMIN
  );

  console.log("✅ Default admin user created successfully!");
}
