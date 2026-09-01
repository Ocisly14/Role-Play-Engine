import path from "node:path";
import type { Request, Response } from "express";

/**
 * Get all available mods
 * GET /api/mods
 */
export async function getMods(_req: Request, res: Response): Promise<void> {
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
      .json({ error: `Failed to fetch mods: ${(error as Error).message}` });
  }
}
