/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { generateRandomAttributes } from "../../../src/shared/agents/character/characterBuilder.js";
import { prepareCharacterForDB, parseCharacterFromDB } from "./service.js";

/**
 * Generate random character attributes
 * POST /api/character/random-attributes
 */
export function generateRandomAttrs(req: Request, res: Response): void {
  try {
    const { age } = req.body;

    // Generate random attributes
    const attributes = generateRandomAttributes(age);

    console.log(
      `[${new Date().toISOString()}] Generated random attributes${age ? ` for age ${age}` : ""}`
    );

    res.json({
      success: true,
      attributes: attributes,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error generating random attributes:", error);
    res
      .status(500)
      .json({
        error:
          "Failed to generate random attributes: " + (error as Error).message,
      });
  }
}

/**
 * Create/save a new character
 * POST /api/character
 */
export function createCharacter(req: Request, res: Response): void {
  try {
    const characterData = req.body;

    if (!characterData || !characterData.identity?.name) {
      res.status(400).json({ error: "Character name is required" });
      return;
    }

    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();

    // Prepare character data for database
    const dbCharacter = prepareCharacterForDB(characterData);
    dbCharacter.email_id = req.user!.email;

    // Insert into database
    const insertStmt = database.prepare(`
      INSERT INTO characters (
        character_id, name, attributes, status, inventory, skills, notes,
        is_npc, occupation, age, appearance, personality, background, goals, secrets, email_id
      ) VALUES (
        @character_id, @name, @attributes, @status, @inventory, @skills, @notes,
        @is_npc, @occupation, @age, @appearance, @personality, @background, @goals, @secrets, @email_id
      )
    `);

    insertStmt.run(dbCharacter);

    console.log(
      `[${new Date().toISOString()}] Character created: ${characterData.identity.name} (${dbCharacter.character_id})`
    );

    res.json({
      success: true,
      characterId: dbCharacter.character_id,
      message: `Character ${characterData.identity.name} created successfully.`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error creating character:", error);
    res
      .status(500)
      .json({
        error: "Failed to create character: " + (error as Error).message,
      });
  }
}

/**
 * Get all characters
 * GET /api/characters
 */
export function getAllCharacters(req: Request, res: Response): void {
  try {
    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();

    const characters = database
      .prepare(`
      SELECT character_id, name, occupation, age, is_npc, appearance
      FROM characters
      WHERE (is_npc = 0 OR is_npc IS NULL) AND email_id = ?
      ORDER BY updated_at DESC
    `)
      .all(req.user!.email);

    res.json({
      success: true,
      characters: characters,
    });
  } catch (error) {
    console.error("Error fetching characters:", error);
    res.status(500).json({ error: "Failed to fetch characters" });
  }
}

/**
 * Get a single character by ID
 * GET /api/character/:characterId
 */
export function getCharacterById(req: Request, res: Response): void {
  try {
    const { characterId } = req.params;

    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();

    // Get character from database
    const character = database
      .prepare(`
      SELECT *
      FROM characters
      WHERE character_id = ? AND email_id = ?
    `)
      .get(characterId, req.user!.email);

    if (!character) {
      res.status(404).json({
        success: false,
        error: "Character not found",
      });
      return;
    }

    // Parse character data
    const parsedCharacter = parseCharacterFromDB(character);

    res.json({
      success: true,
      character: parsedCharacter,
    });
  } catch (error) {
    console.error("Error fetching character:", error);
    res
      .status(500)
      .json({
        error: "Failed to fetch character: " + (error as Error).message,
      });
  }
}
