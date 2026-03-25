import fs from "fs";
import path from "path";
import type { Request, Response } from "express";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";

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

    const occupationsData = JSON.parse(
      fs.readFileSync(occupationsFile, "utf-8")
    );

    res.json({
      success: true,
      occupations: occupationsData,
    });
  } catch (error) {
    console.error("Error fetching occupations:", error);
    res.status(500).json({
      error: "Failed to fetch occupations: " + (error as Error).message,
    });
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
    res
      .status(500)
      .json({ error: "Failed to fetch weapons: " + (error as Error).message });
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

    // Read directly from data/Mods/ directory
    const fs = await import("node:fs");
    if (!fs.existsSync(modsDir)) {
      res.json({ success: true, mods: [] });
      return;
    }
    const entries = fs.readdirSync(modsDir, { withFileTypes: true });
    const mods = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({
        name: e.name,
        path: path.join(modsDir, e.name),
      }));

    res.json({
      success: true,
      mods,
    });
  } catch (error) {
    console.error("Error fetching mods:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch mods: " + (error as Error).message });
  }
}
