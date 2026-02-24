import type { Request, Response } from "express";
import { listUserLibrary } from "../mod/library.js";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import path from "path";
import fs from "fs";

/**
 * Get all available occupations
 * GET /api/occupations
 */
export function getOccupations(req: Request, res: Response): void {
  try {
    const occupationsFile = path.join(
      process.cwd(),
      "src",
      "shared",
      "agents",
      "character",
      "Character occupation.json"
    );

    if (!fs.existsSync(occupationsFile)) {
      res.status(404).json({ error: "Occupations file not found" });
      return;
    }

    const occupationsData = JSON.parse(fs.readFileSync(occupationsFile, "utf-8"));

    res.json({
      success: true,
      occupations: occupationsData,
    });
  } catch (error) {
    console.error("Error fetching occupations:", error);
    res.status(500).json({ error: "Failed to fetch occupations: " + (error as Error).message });
  }
}

/**
 * Get all weapons from database
 * GET /api/weapons
 */
export async function getWeapons(req: Request, res: Response): Promise<void> {
  try {
    const prisma = getPrismaClient();
    const weapons = await prisma.weapon.findMany({
      orderBy: { name: "asc" },
      select: {
        name: true,
        skill: true,
        damage: true,
        range: true,
        attacksPerRound: true,
        ammo: true,
      },
    });

    res.json({
      success: true,
      weapons: weapons.map((w) => ({
        name: w.name,
        skill: w.skill,
        damage: w.damage,
        range: w.range,
        attacks_per_round: w.attacksPerRound,
        ammo: w.ammo,
      })),
    });
  } catch (error) {
    console.error("Error fetching weapons:", error);
    res.status(500).json({ error: "Failed to fetch weapons: " + (error as Error).message });
  }
}

/**
 * Get all available mods
 * GET /api/mods
 */
export async function getMods(req: Request, res: Response): Promise<void> {
  try {
    res.setHeader("Cache-Control", "no-store");
    const modsDir = path.join(process.cwd(), "data", "Mods");
    const email = req.user?.email;
    if (!email) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const library = await listUserLibrary(email);
    const mods = library.map((mod) => ({
      name: mod.name,
      path: path.join(modsDir, mod.name),
      shared: mod.shared,
      ownerEmail: mod.ownerEmail,
      isOwner: mod.isOwner,
    }));

    res.json({
      success: true,
      mods: mods,
    });
  } catch (error) {
    console.error("Error fetching mods:", error);
    res.status(500).json({ error: "Failed to fetch mods: " + (error as Error).message });
  }
}
