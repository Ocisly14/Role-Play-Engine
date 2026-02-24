/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { generateRandomAttributes } from "../../../src/shared/agents/character/characterBuilder.js";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import { parseCharacterFromDB, prepareCharacterForDB } from "./service.js";

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
    res.status(500).json({
      error:
        "Failed to generate random attributes: " + (error as Error).message,
    });
  }
}

/**
 * Create/save a new character
 * POST /api/character
 */
export async function createCharacter(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const characterData = req.body;

    if (!characterData || !characterData.identity?.name) {
      res.status(400).json({ error: "Character name is required" });
      return;
    }

    const prisma = getPrismaClient();

    // Prepare character data for database
    const dbCharacter = prepareCharacterForDB(characterData);
    dbCharacter.email_id = req.user!.email;

    // Insert into database using Prisma
    await prisma.character.create({
      data: {
        characterId: dbCharacter.character_id,
        name: dbCharacter.name,
        attributes: dbCharacter.attributes
          ? JSON.parse(dbCharacter.attributes)
          : {},
        status: dbCharacter.status ? JSON.parse(dbCharacter.status) : {},
        inventory: dbCharacter.inventory
          ? JSON.parse(dbCharacter.inventory)
          : null,
        skills: dbCharacter.skills ? JSON.parse(dbCharacter.skills) : null,
        notes: dbCharacter.notes,
        isNpc: Boolean(dbCharacter.is_npc),
        occupation: dbCharacter.occupation,
        age: dbCharacter.age ? Number(dbCharacter.age) : null,
        appearance: dbCharacter.appearance,
        personality: dbCharacter.personality,
        background: dbCharacter.background,
        goals: dbCharacter.goals ? JSON.parse(dbCharacter.goals) : null,
        secrets: dbCharacter.secrets ? JSON.parse(dbCharacter.secrets) : null,
        emailId: dbCharacter.email_id,
      },
    });

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
    res.status(500).json({
      error: "Failed to create character: " + (error as Error).message,
    });
  }
}

/**
 * Update an existing character
 * PUT /api/character/:characterId
 */
export async function updateCharacter(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { characterId } = req.params;
    const characterData = req.body;

    if (!characterData || !characterData.identity?.name) {
      res.status(400).json({ error: "Character name is required" });
      return;
    }

    const prisma = getPrismaClient();
    const existingCharacter = await prisma.character.findFirst({
      where: {
        characterId,
        emailId: req.user!.email,
        isNpc: false,
      },
      select: { characterId: true },
    });

    if (!existingCharacter) {
      res.status(404).json({
        success: false,
        error: "Character not found",
      });
      return;
    }

    // Reuse the existing mapper and keep the same characterId for updates.
    const dbCharacter = prepareCharacterForDB({
      ...characterData,
      characterId,
    });
    dbCharacter.email_id = req.user!.email;

    await prisma.character.update({
      where: { characterId },
      data: {
        name: dbCharacter.name,
        attributes: dbCharacter.attributes
          ? JSON.parse(dbCharacter.attributes)
          : {},
        status: dbCharacter.status ? JSON.parse(dbCharacter.status) : {},
        inventory: dbCharacter.inventory
          ? JSON.parse(dbCharacter.inventory)
          : null,
        skills: dbCharacter.skills ? JSON.parse(dbCharacter.skills) : null,
        notes: dbCharacter.notes,
        isNpc: Boolean(dbCharacter.is_npc),
        occupation: dbCharacter.occupation,
        age: dbCharacter.age ? Number(dbCharacter.age) : null,
        appearance: dbCharacter.appearance,
        personality: dbCharacter.personality,
        background: dbCharacter.background,
        goals: dbCharacter.goals ? JSON.parse(dbCharacter.goals) : null,
        secrets: dbCharacter.secrets ? JSON.parse(dbCharacter.secrets) : null,
        emailId: dbCharacter.email_id,
        updatedAt: new Date(),
      },
    });

    console.log(
      `[${new Date().toISOString()}] Character updated: ${characterData.identity.name} (${characterId})`
    );

    res.json({
      success: true,
      characterId,
      message: `Character ${characterData.identity.name} updated successfully.`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error updating character:", error);
    res.status(500).json({
      error: "Failed to update character: " + (error as Error).message,
    });
  }
}

/**
 * Get all characters
 * GET /api/characters
 */
export async function getAllCharacters(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const prisma = getPrismaClient();

    const characters = await prisma.character.findMany({
      where: {
        isNpc: false,
        emailId: req.user!.email,
      },
      select: {
        characterId: true,
        name: true,
        occupation: true,
        age: true,
        isNpc: true,
        appearance: true,
      },
      orderBy: { updatedAt: "desc" },
    });

    // Map to match original column names for frontend compatibility
    res.json({
      success: true,
      characters: characters.map((c) => ({
        character_id: c.characterId,
        name: c.name,
        occupation: c.occupation,
        age: c.age,
        is_npc: c.isNpc ? 1 : 0,
        appearance: c.appearance,
      })),
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
export async function getCharacterById(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { characterId } = req.params;

    const prisma = getPrismaClient();

    const character = await prisma.character.findFirst({
      where: { characterId, emailId: req.user!.email },
    });

    if (!character) {
      res.status(404).json({
        success: false,
        error: "Character not found",
      });
      return;
    }

    // Convert Prisma result to match the format parseCharacterFromDB expects
    const dbRow: any = {
      character_id: character.characterId,
      name: character.name,
      attributes: JSON.stringify(character.attributes),
      status: JSON.stringify(character.status),
      inventory: character.inventory
        ? JSON.stringify(character.inventory)
        : null,
      skills: character.skills ? JSON.stringify(character.skills) : null,
      notes: character.notes,
      is_npc: character.isNpc ? 1 : 0,
      occupation: character.occupation,
      age: character.age,
      gender: character.gender,
      appearance: character.appearance,
      personality: character.personality,
      background: character.background,
      goals: character.goals ? JSON.stringify(character.goals) : null,
      secrets: character.secrets ? JSON.stringify(character.secrets) : null,
      current_location: character.currentLocation,
      email_id: character.emailId,
      updated_at: character.updatedAt?.toISOString(),
      instantiated_from: character.instantiatedFrom,
      inherits_knowledge: character.inheritsKnowledge
        ? JSON.stringify(character.inheritsKnowledge)
        : null,
    };

    // Parse character data
    const parsedCharacter = parseCharacterFromDB(dbRow);

    res.json({
      success: true,
      character: parsedCharacter,
    });
  } catch (error) {
    console.error("Error fetching character:", error);
    res.status(500).json({
      error: "Failed to fetch character: " + (error as Error).message,
    });
  }
}
