/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { ServerState } from "../core/ServerState.js";
import { suggestSkillsFromInput } from "./skillMatcher.js";
import { getSkillNameZh } from "./skillDescriptions.js";

/**
 * Suggest skills based on user input (semantic matching)
 * POST /api/skills/suggest
 */
export async function suggestSkills(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { input, max } = req.body ?? {};

    if (!input || typeof input !== "string" || !input.trim()) {
      res.status(400).json({ error: "input is required" });
      return;
    }

    const maxSuggestions =
      typeof max === "number" && Number.isFinite(max) ? max : undefined;

    const serverState = ServerState.getInstance();
    const dynamicGameState = serverState.getDynamicGameState(userId);
    if (!dynamicGameState?.playerCharacter) {
      res.status(400).json({ error: "Game state not available" });
      return;
    }

    const rawSkills = dynamicGameState.playerCharacter.skills ?? {};
    const skills = Object.entries(rawSkills)
      .map(([name, raw]) => {
        if (typeof raw === "number") {
          return { name, value: raw };
        }
        if (
          raw &&
          typeof raw === "object" &&
          "value" in raw &&
          typeof (raw as { value: unknown }).value === "number"
        ) {
          return { name, value: (raw as { value: number }).value };
        }
        return null;
      })
      .filter(
        (entry): entry is { name: string; value: number } => Boolean(entry)
      );

    if (skills.length === 0) {
      res.json({ success: true, suggestions: [] });
      return;
    }

    const { suggestions, language } = await suggestSkillsFromInput({
      input: input.trim(),
      skills,
      max: maxSuggestions,
    });

    res.json({
      success: true,
      language,
      suggestions: suggestions.map((item) => ({
        ...item,
        displayName: language === "zh" ? getSkillNameZh(item.name) : item.name,
      })),
    });
  } catch (error) {
    console.error("Error suggesting skills:", error);
    res.status(500).json({ error: "Failed to suggest skills" });
  }
}
