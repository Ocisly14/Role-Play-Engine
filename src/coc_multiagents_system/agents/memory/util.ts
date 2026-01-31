/**
 * Unified Memory Agent with SQLite Database
 * Session historian, context manager, and rules database
 * Combines game history tracking with CoC 7e rules reference
 */

import type Database from "better-sqlite3";
type DBInstance = InstanceType<typeof Database>;
import type { CoCDatabase } from "./database/schema.js";
import type {
  CharacterAttributes,
  CharacterProfile,
  CharacterStatus,
  InventoryItem,
  Skill,
  WeaponData,
} from "../models/gameTypes.js";
import { InventoryUtils } from "../models/gameTypes.js";
import type { ModuleBackground } from "../models/moduleTypes.js";
import type { ScenarioSnapshot } from "../models/scenarioTypes.js";



export interface Discovery {
  id?: number;
  clueId: string;
  sessionId: string;
  discoverer: string;
  method: string;
  timestamp: Date;
  description?: string;
}

export interface Relationship {
  id?: number;
  characterId: string;
  npcId: string;
  value: number;
  sessionId: string;
  lastUpdated: Date;
  notes?: string;
}

export class MemoryAgent {
  private db: DBInstance;

  constructor(cocDB: CoCDatabase) {
    this.db = cocDB.getDatabase();
  }


  /**
   * Get module background briefings ordered by recency
   */
  public getModuleBackgrounds(limit = 5): ModuleBackground[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM module_backgrounds LIMIT ?`
      )
      .all(limit) as any[];

    return rows.map((row) => this.rowToModuleBackground(row));
  }

  /**
   * Get the latest module briefing (if any)
   */
  public getLatestModuleBackground(): ModuleBackground | null {
    const row = this.db
      .prepare(
        `SELECT * FROM module_backgrounds LIMIT 1`
      )
      .get() as any;

    if (!row) return null;
    return this.rowToModuleBackground(row);
  }

  /**
   * List known NPC names from the characters table
   */
  public listNpcNames(options: { includePlayers?: boolean } = {}): string[] {
    const hasNpcFlag = this.hasColumn("characters", "is_npc");
    let sql = "SELECT name FROM characters";
    const params: any[] = [];

    if (hasNpcFlag && !options.includePlayers) {
      sql += " WHERE is_npc = 1";
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => r.name as string);
  }

  /**
   * List known scenario locations/names for routing suggestions
   */
  public listScenarioLocations(): {
    scenarioId: string;
    scenarioName: string;
    snapshotId: string;
    snapshotName: string;
    location: string;
  }[] {
    const rows = this.db
      .prepare(
        `
            SELECT ss.snapshot_id, ss.snapshot_name, ss.location, ss.scenario_id, s.name as scenario_name
            FROM scenario_snapshots ss
            JOIN scenarios s ON ss.scenario_id = s.scenario_id
        `
      )
      .all() as any[];

    return rows.map((r) => ({
      scenarioId: r.scenario_id,
      scenarioName: r.scenario_name,
      snapshotId: r.snapshot_id,
      snapshotName: r.snapshot_name,
      location: r.location,
    }));
  }


  private rowToModuleBackground(row: any): ModuleBackground {
    return {
      id: row.module_id,
      title: row.title,
      background: row.background || undefined,
      storyOutline: row.story_outline || undefined,
      moduleNotes: row.module_notes || undefined,
      keeperGuidance: row.keeper_guidance || undefined,
      moduleLimitations: row.module_limitations || undefined,
      initialGameTime: row.initial_game_time || undefined,
      initialScenarioNPCs: row.initial_scenario_npcs ? JSON.parse(row.initial_scenario_npcs) : [],
      tags: row.tags ? JSON.parse(row.tags) : [],
      introduction: row.introduction || undefined,
    };
  }

  // ============================================================
  // RULES DATABASE METHODS
  // Static reference data for Call of Cthulhu 7e
  // ============================================================

  /**
   * Get skill information
   */
  public getSkill(skillName: string): Skill | undefined {
    const row = this.db
      .prepare("SELECT * FROM skills WHERE name = ?")
      .get(skillName) as any;
    if (!row) return undefined;

    return {
      name: row.name,
      baseValue: row.base_value,
      description: row.description,
      category: row.category,
      uncommon: row.uncommon === 1,
      examples: row.examples ? JSON.parse(row.examples) : undefined,
    };
  }

  /**
   * Get all skills
   */
  public getAllSkills(): Skill[] {
    const rows = this.db.prepare("SELECT * FROM skills").all() as any[];
    return rows.map((row) => ({
      name: row.name,
      baseValue: row.base_value,
      description: row.description,
      category: row.category,
      uncommon: row.uncommon === 1,
      examples: row.examples ? JSON.parse(row.examples) : undefined,
    }));
  }

  /**
   * Get skills by category
   */
  public getSkillsByCategory(category: string): Skill[] {
    const rows = this.db
      .prepare("SELECT * FROM skills WHERE category = ?")
      .all(category) as any[];
    return rows.map((row) => ({
      name: row.name,
      baseValue: row.base_value,
      description: row.description,
      category: row.category,
      uncommon: row.uncommon === 1,
      examples: row.examples ? JSON.parse(row.examples) : undefined,
    }));
  }

  /**
   * Get weapon data
   */
  public getWeapon(weaponName: string): WeaponData | undefined {
    const row = this.db
      .prepare("SELECT * FROM weapons WHERE name = ?")
      .get(weaponName) as any;
    if (!row) return undefined;

    return {
      name: row.name,
      skill: row.skill,
      damage: row.damage,
      range: row.range,
      attacksPerRound: row.attacks_per_round,
      ammo: row.ammo,
      malfunction: row.malfunction,
      era: row.era,
    };
  }

  /**
   * Get all weapons
   */
  public getAllWeapons(): WeaponData[] {
    const rows = this.db.prepare("SELECT * FROM weapons").all() as any[];
    return rows.map((row) => ({
      name: row.name,
      skill: row.skill,
      damage: row.damage,
      range: row.range,
      attacksPerRound: row.attacks_per_round,
      ammo: row.ammo,
      malfunction: row.malfunction,
      era: row.era,
    }));
  }


  /**
   * Find characters by name (case-insensitive, fuzzy match)
   */
  public findCharactersByNames(
    names: string[],
    options: { includePCs?: boolean } = {}
  ): CharacterProfile[] {
    if (!names.length) return [];

    const conditions = names
      .map(() => "(LOWER(name) LIKE ?)")
      .join(" OR ");
    const params = names.map((n) => `%${n.toLowerCase()}%`);

    let sql = `SELECT * FROM characters WHERE ${conditions}`;
    const hasNpcFlag = this.hasColumn("characters", "is_npc");

    if (!options.includePCs && hasNpcFlag) {
      sql += " AND is_npc = 1";
    }

    const rows = this.db.prepare(sql).all(...params) as any[];

    const profiles = rows.map((row) => this.rowToCharacterProfile(row));

    // Deduplicate by id to avoid returning multiple fuzzy matches of same row
    const seen = new Set<string>();
    return profiles.filter((p) => {
      const key = p.id.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  // ============================================================
  // PRIVATE HELPER METHODS
  // ============================================================

  private hasColumn(tableName: string, columnName: string): boolean {
    const safeTable = tableName.replace(/[^\w]/g, "");
    const safeColumn = columnName.replace(/[^\w]/g, "");
    const rows = this.db
      .prepare(`PRAGMA table_info(${safeTable});`)
      .all() as { name: string }[];
    return rows.some((row) => row.name === safeColumn);
  }

  private rowToCharacterProfile(row: any): CharacterProfile {
    return {
      id: row.character_id,
      name: row.name,
      attributes: this.safeParse<CharacterAttributes>(
        row.attributes,
        this.buildDefaultAttributes()
      ),
      status: this.safeParse<CharacterStatus>(
        row.status,
        this.buildDefaultStatus()
      ),
      inventory: InventoryUtils.normalizeInventory(this.safeParse<InventoryItem[]>(row.inventory, [])),
      skills: this.safeParse<Record<string, number>>(row.skills, {}),
      notes: row.notes ?? this.buildNpcNotes(row),
    };
  }

  private buildSnapshot(row: any): ScenarioSnapshot {
    const characters =
      (this.db
        .prepare(`SELECT * FROM scenario_characters WHERE snapshot_id = ?`)
        .all(row.snapshot_id) as any[]) || [];
    const clues =
      (this.db
        .prepare(`SELECT * FROM scenario_clues WHERE snapshot_id = ?`)
        .all(row.snapshot_id) as any[]) || [];
    const conditions =
      (this.db
        .prepare(`SELECT * FROM scenario_conditions WHERE snapshot_id = ?`)
        .all(row.snapshot_id) as any[]) || [];

    return {
      id: row.snapshot_id,
      name: row.snapshot_name,
      location: row.location,
      description: row.description,
      characters: characters.map((c) => ({
        id: c.id,
        name: c.character_name,
        role: c.character_role,
        status: c.character_status,
        location: c.character_location ?? undefined,
        notes: c.character_notes ?? undefined,
      })),
      clues: clues.map((c) => ({
        id: c.clue_id,
        clueText: c.clue_text,
        category: c.category,
        difficulty: c.difficulty,
        location: c.clue_location,
        discoveryMethod: c.discovery_method ?? undefined,
        reveals: c.reveals ? JSON.parse(c.reveals) : [],
        discovered: c.discovered === 1,
        discoveryDetails: c.discovery_details
          ? JSON.parse(c.discovery_details)
          : undefined,
      })),
      conditions: conditions.map((cond) => ({
        type: cond.condition_type,
        description: cond.description,
        mechanicalEffect: cond.mechanical_effect ?? undefined,
      })),
      events: this.safeParse<string[]>(row.events, []),
      exits: this.safeParse(row.exits, []),
      keeperNotes: row.keeper_notes ?? undefined,
      timeRestriction: row.time_restriction ?? undefined,
    };
  }

  private buildDefaultAttributes(): CharacterAttributes {
    return {
      STR: 50,
      CON: 50,
      DEX: 50,
      APP: 50,
      POW: 50,
      SIZ: 50,
      INT: 50,
      EDU: 50,
    };
  }

  private buildDefaultStatus(): CharacterStatus {
    return {
      hp: 10,
      maxHp: 10,
      sanity: 60,
      maxSanity: 99,
      luck: 50,
      mp: 10,
      conditions: [],
    };
  }

  private buildNpcNotes(row: any): string | undefined {
    const extras = [
      row.occupation ? `Occupation: ${row.occupation}` : null,
      row.age ? `Age: ${row.age}` : null,
      row.personality ? `Personality: ${row.personality}` : null,
      row.background ? `Background: ${row.background}` : null,
      row.goals ? `Goals: ${row.goals}` : null,
      row.secrets ? `Secrets: ${row.secrets}` : null,
    ].filter(Boolean);

    if (!extras.length) return undefined;
    return extras.join(" | ");
  }

  private safeParse<T>(value: any, fallback: T): T {
    if (!value) return fallback;
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      return parsed as T;
    } catch {
      return fallback;
    }
  }
}
