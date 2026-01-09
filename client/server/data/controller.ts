import type { Request, Response } from "express";
import { DatabaseManager } from "../core/DatabaseManager.js";
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
      "coc_multiagents_system",
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
export function getWeapons(req: Request, res: Response): void {
  try {
    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();

    const weapons = database.prepare(`
      SELECT name, skill, damage, range, attacks_per_round, ammo
      FROM weapons
      ORDER BY name
    `).all();

    res.json({
      success: true,
      weapons: weapons,
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
export function getMods(req: Request, res: Response): void {
  try {
    const modsDir = path.join(process.cwd(), "data", "Mods");

    if (!fs.existsSync(modsDir)) {
      res.json({ success: true, mods: [] });
      return;
    }

    const dirs = fs.readdirSync(modsDir, { withFileTypes: true });
    const mods = dirs
      .filter(dirent => dirent.isDirectory())
      .map(dirent => ({
        name: dirent.name,
        path: path.join(modsDir, dirent.name),
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
