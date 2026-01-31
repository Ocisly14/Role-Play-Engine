/**
 * Player Loader
 * Loads player character data from documents and stores them in the database
 * Simpler than NPC loader - no deduplication needed since players upload their own characters
 */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type { CoCDatabase } from "../../memory/database/schema.js";
import type {
  CharacterAttributes,
  CharacterStatus,
  CharacterProfile,
  InventoryItem,
} from "../../models/gameTypes.js";
import { InventoryUtils } from "../../models/gameTypes.js";
import {
  PlayerDocumentParser,
  type ParsedPlayerData,
} from "./playerDocumentParser.js";

/**
 * Default attributes for players when not specified
 */
const DEFAULT_ATTRIBUTES: CharacterAttributes = {
  STR: 50,
  CON: 50,
  DEX: 50,
  APP: 50,
  POW: 50,
  SIZ: 50,
  INT: 50,
  EDU: 50,
};

/**
 * Calculate default status from attributes
 */
function calculateDefaultStatus(
  attributes: CharacterAttributes
): CharacterStatus {
  const hp = Math.floor((attributes.CON + attributes.SIZ) / 10);
  const maxSanity = attributes.POW * 5;
  const mp = Math.floor(attributes.POW / 5);
  const { damageBonus, build } = calculateDamageBonusAndBuild(
    attributes.STR,
    attributes.SIZ
  );
  const mov = calculateMovement(attributes);

  return {
    hp,
    maxHp: hp,
    sanity: maxSanity,
    maxSanity,
    luck: 50,
    mp,
    damageBonus,
    build,
    mov,
    conditions: [],
  };
}

/**
 * Compute damage bonus and build from STR+SIZ (CoC 7e)
 */
function calculateDamageBonusAndBuild(
  str: number,
  siz: number
): { damageBonus: string; build: number } {
  const total = str + siz;
  if (total <= 64) return { damageBonus: "-1d4", build: -2 };
  if (total <= 84) return { damageBonus: "0", build: -1 };
  if (total <= 124) return { damageBonus: "+1d4", build: 0 };
  if (total <= 164) return { damageBonus: "+1d6", build: 1 };
  if (total <= 204) return { damageBonus: "+2d6", build: 2 };
  return { damageBonus: "+3d6", build: 3 };
}

/**
 * Compute movement (MOV) based on STR/DEX vs SIZ (simplified CoC 7e rules)
 */
function calculateMovement(attributes: CharacterAttributes): number {
  const { STR, DEX, SIZ } = attributes;
  if (STR > SIZ && DEX > SIZ) return 9;
  if (STR < SIZ && DEX < SIZ) return 7;
  return 8;
}

/**
 * Player Loader class
 */
export class PlayerLoader {
  private db: CoCDatabase;
  private parser: PlayerDocumentParser;

  constructor(db: CoCDatabase, parser?: PlayerDocumentParser) {
    this.db = db;
    this.parser = parser || new PlayerDocumentParser();
  }

  /**
   * Load a single player character from a document
   */
  async loadPlayerFromDocument(filePath: string): Promise<CharacterProfile | null> {
    console.log(`\n=== Loading player from document: ${filePath} ===`);

    if (!fs.existsSync(filePath)) {
      console.log(`File does not exist: ${filePath}`);
      return null;
    }

    try {
      const parsedData = await this.parser.parseDocument(filePath);
      if (!parsedData) {
        console.log("Failed to parse player document");
        return null;
      }

      const playerProfile = this.convertToPlayerProfile(parsedData);
      this.savePlayerToDatabase(playerProfile);
      
      console.log(`✓ Loaded player: ${playerProfile.name} (${playerProfile.id})`);
      return playerProfile;
    } catch (error) {
      console.error(`✗ Failed to load player from ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Check if any files in directory have changed since last load
   */
  private checkForChanges(dirPath: string): { hasChanges: boolean; currentFiles: Map<string, number> } {
    if (!fs.existsSync(dirPath)) {
      return { hasChanges: false, currentFiles: new Map() };
    }

    const currentFiles = new Map<string, number>();
    const files = fs.readdirSync(dirPath).filter(file => 
      file.endsWith('.docx') || file.endsWith('.pdf')
    );

    // Get modification times for all relevant files
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      currentFiles.set(file, stats.mtime.getTime());
    }

    // Check if we have existing players
    const existingPlayers = this.getAllPlayers();
    
    // If no players exist, we need to load
    if (existingPlayers.length === 0) {
      return { hasChanges: true, currentFiles };
    }

    // Check timestamp file
    const lastLoadFile = path.join(dirPath, '.last_player_load_timestamp');
    let lastLoadTime = 0;
    
    if (fs.existsSync(lastLoadFile)) {
      try {
        lastLoadTime = parseInt(fs.readFileSync(lastLoadFile, 'utf8'));
      } catch {
        return { hasChanges: true, currentFiles };
      }
    }

    // Check if any file is newer than last load
    const hasChanges = Array.from(currentFiles.values()).some(mtime => mtime > lastLoadTime);
    
    return { hasChanges, currentFiles };
  }

  /**
   * Update the last load timestamp
   */
  private updateLastLoadTimestamp(dirPath: string): void {
    const lastLoadFile = path.join(dirPath, '.last_player_load_timestamp');
    const currentTime = Date.now().toString();
    fs.writeFileSync(lastLoadFile, currentTime, 'utf8');
  }

  /**
   * Load players from a directory (only if files have changed)
   */
  async loadPlayersFromDirectory(dirPath: string, forceReload = false): Promise<CharacterProfile[]> {
    console.log(`\n=== Checking players in directory: ${dirPath} ===`);

    if (!fs.existsSync(dirPath)) {
      console.log(`Directory does not exist, creating: ${dirPath}`);
      fs.mkdirSync(dirPath, { recursive: true });
      return [];
    }

    // Check for file changes unless forced reload
    if (!forceReload) {
      const { hasChanges } = this.checkForChanges(dirPath);
      if (!hasChanges) {
        const existingPlayers = this.getAllPlayers();
        console.log(`No changes detected. Using ${existingPlayers.length} existing players from database.`);
        return existingPlayers;
      }
    }

    console.log(`Loading players from directory: ${dirPath}`);

    // Parse all documents in the directory
    const parsedPlayers = await this.parser.parseDirectory(dirPath);

    if (parsedPlayers.length === 0) {
      console.log("No player documents found in directory.");
      this.updateLastLoadTimestamp(dirPath);
      return [];
    }

    // Convert and store each player
    const playerProfiles: CharacterProfile[] = [];
    for (const parsedData of parsedPlayers) {
      try {
        const playerProfile = this.convertToPlayerProfile(parsedData);
        this.savePlayerToDatabase(playerProfile);
        playerProfiles.push(playerProfile);
        console.log(`✓ Loaded player: ${playerProfile.name} (${playerProfile.id})`);
      } catch (error) {
        console.error(`✗ Failed to load player ${parsedData.name}:`, error);
      }
    }

    // Update timestamp after successful load
    this.updateLastLoadTimestamp(dirPath);

    console.log(`\n=== Successfully loaded ${playerProfiles.length} players ===\n`);
    return playerProfiles;
  }

  /**
   * Convert ParsedPlayerData to CharacterProfile
   */
  private convertToPlayerProfile(parsedData: ParsedPlayerData): CharacterProfile {
    const playerId = this.generatePlayerId(parsedData.name);

    // Merge attributes with defaults
    const attributes: CharacterAttributes = this.normalizeAttributes(
      parsedData.attributes
    );

    // Calculate or use provided status
    const defaultStatus = calculateDefaultStatus(attributes);
    const status: CharacterStatus = {
      ...defaultStatus,
      ...parsedData.status,
    };

    const playerProfile: CharacterProfile = {
      id: playerId,
      name: parsedData.name,
      attributes,
      status,
      inventory: InventoryUtils.normalizeInventory(
        parsedData.inventory?.map((item) => 
          typeof item === 'string' ? { name: item } : item
        ) as InventoryItem[]
      ),
      skills: parsedData.skills || {},
      notes: [
        parsedData.notes,
        parsedData.occupation && `Occupation: ${parsedData.occupation}`,
        parsedData.age && `Age: ${parsedData.age}`,
        parsedData.appearance && `Appearance: ${parsedData.appearance}`,
        parsedData.background && `Background: ${parsedData.background}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    };

    return playerProfile;
  }

  /**
   * Normalize partial attributes into full CharacterAttributes with defaults
   */
  private normalizeAttributes(
    attrs?: Partial<CharacterAttributes>
  ): CharacterAttributes {
    const result: CharacterAttributes = { ...DEFAULT_ATTRIBUTES };

    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (typeof value === "number") {
          result[key] = value;
        }
      }
    }

    return result;
  }

  /**
   * Generate a unique ID for a player based on their name
   */
  private generatePlayerId(name: string): string {
    return `player-${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Save player to database
   */
  private savePlayerToDatabase(player: CharacterProfile): void {
    const database = this.db.getDatabase();

    this.db.transaction(() => {
      // Insert or update character
      const stmt = database.prepare(`
        INSERT OR REPLACE INTO characters (
          character_id, name, attributes, status, inventory, skills, notes,
          is_npc, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);

      stmt.run(
        player.id,
        player.name,
        JSON.stringify(player.attributes),
        JSON.stringify(player.status),
        JSON.stringify(player.inventory),
        JSON.stringify(player.skills),
        player.notes || null,
        0 // is_npc = false
      );
    });
  }

  /**
   * Get a player from the database by ID
   */
  getPlayerById(playerId: string): CharacterProfile | null {
    const database = this.db.getDatabase();

    const character = database
      .prepare(`
        SELECT * FROM characters WHERE character_id = ? AND is_npc = 0
      `)
      .get(playerId) as any;

    if (!character) {
      return null;
    }

    const playerProfile: CharacterProfile = {
      id: character.character_id,
      name: character.name,
      attributes: JSON.parse(character.attributes),
      status: JSON.parse(character.status),
      inventory: InventoryUtils.normalizeInventory(JSON.parse(character.inventory || "[]")),
      skills: JSON.parse(character.skills || "{}"),
      notes: character.notes,
    };

    return playerProfile;
  }

  /**
   * Get all players from the database
   */
  getAllPlayers(): CharacterProfile[] {
    const database = this.db.getDatabase();

    const characters = database
      .prepare(`
        SELECT character_id FROM characters WHERE is_npc = 0
      `)
      .all() as any[];

    return characters
      .map((c) => this.getPlayerById(c.character_id))
      .filter((player) => player !== null) as CharacterProfile[];
  }

  /**
   * Check if player already exists in database
   */
  playerExists(playerId: string): boolean {
    const database = this.db.getDatabase();
    const result = database
      .prepare(`
        SELECT COUNT(*) as count FROM characters WHERE character_id = ? AND is_npc = 0
      `)
      .get(playerId) as any;
    return result.count > 0;
  }

  /**
   * Update an existing player's data
   */
  updatePlayer(player: CharacterProfile): void {
    if (!this.playerExists(player.id)) {
      throw new Error(`Player ${player.id} does not exist in database`);
    }
    this.savePlayerToDatabase(player);
    console.log(`Updated player: ${player.name} (${player.id})`);
  }

  /**
   * Delete a player from the database
   */
  deletePlayer(playerId: string): void {
    const database = this.db.getDatabase();
    
    const result = database
      .prepare(`
        DELETE FROM characters WHERE character_id = ? AND is_npc = 0
      `)
      .run(playerId);

    if (result.changes === 0) {
      throw new Error(`Player ${playerId} not found or could not be deleted`);
    }

    console.log(`Deleted player: ${playerId}`);
  }

  /**
   * Find players by name (partial match)
   */
  findPlayersByName(namePattern: string): CharacterProfile[] {
    const database = this.db.getDatabase();

    const characters = database
      .prepare(`
        SELECT character_id FROM characters 
        WHERE is_npc = 0 AND name LIKE ? 
        ORDER BY name
      `)
      .all(`%${namePattern}%`) as any[];

    return characters
      .map((c) => this.getPlayerById(c.character_id))
      .filter((player) => player !== null) as CharacterProfile[];
  }
}