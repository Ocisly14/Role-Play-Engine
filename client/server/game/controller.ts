/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { GraphManager } from "../core/GraphManager.js";
import { ServerState } from "../core/ServerState.js";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import { getClientIp, generateSessionIdFromIp } from "../utils/sessionUtils.js";
import { initializeWorldBuilderGameState } from "./service.js";
import type { DynamicGameState } from "../../../src/dynamicworldagent/state/index.js";
import path from "path";
import fs from "fs";

/**
 * Check if a module is a world-builder generated module
 */
function isWorldBuilderModule(modName: string): boolean {
  const modsDir = path.join(process.cwd(), "data", "Mods");
  const modPath = path.join(modsDir, modName);

  const worldBuilderFiles = [
    "truth_timeline.json",
    "knowledge_matrix.json",
    "macro_scene.json",
  ];

  return worldBuilderFiles.every((file) =>
    fs.existsSync(path.join(modPath, file))
  );
}

/**
 * Start game with character
 * POST /api/game/start
 */
export async function startGame(req: Request, res: Response): Promise<void> {
  try {
    const { characterId, modName, language: rawLanguage } = req.body;
    const userId = req.user!.userId;
    const userEmail = req.user!.email;
    const language =
      rawLanguage === "en" || rawLanguage === "zh" ? rawLanguage : "zh";

    console.log(
      `[${new Date().toISOString()}] Starting game with language: ${language}...`
    );

    const db = DatabaseManager.getInstance().getDatabase();
    const graphManager = GraphManager.getInstance();

    // Initialize DynamicWorld system if needed
    if (!graphManager.isInitialized()) {
      await graphManager.initialize(db);
    }

    // Ensure character belongs to user
    if (!characterId) {
      res.status(400).json({ error: "Character ID is required" });
      return;
    }

    const prisma = getPrismaClient();
    const ownedCharacter = await prisma.character.findFirst({
      where: { characterId, emailId: userEmail, isNpc: false },
      select: { characterId: true },
    });

    if (!ownedCharacter) {
      res.status(403).json({ error: "Character not found" });
      return;
    }

    // Generate session
    const clientIp = getClientIp(req);
    const sessionId = generateSessionIdFromIp(clientIp);

    // DynamicWorld only: require WorldBuilder module
    const isWorldBuilder = modName && isWorldBuilderModule(modName);
    if (!isWorldBuilder) {
      res
        .status(400)
        .json({
          error:
            "Only World Builder modules are supported in DynamicWorld mode",
        });
      return;
    }

    // Initialize DynamicWorld game state
    let dynamicGameState: DynamicGameState | null = null;
    let moduleIntroduction: any = null;
    const initResult = await initializeWorldBuilderGameState(
      db,
      characterId,
      sessionId,
      modName,
      userEmail
    );
    dynamicGameState = initResult.dynamicGameState;
    moduleIntroduction = initResult.moduleIntroduction;

    console.log(
      `[${new Date().toISOString()}] Game initialized using DynamicWorld loader`
    );

    // Store in server state
    if (dynamicGameState) {
      ServerState.getInstance().setGameState(userId, dynamicGameState);
    }

    // Create introduction turn if module introduction is available
    if (moduleIntroduction && moduleIntroduction.introduction) {
      try {
        // Check if introduction turn already exists for this session
        const introSessionId = dynamicGameState?.sessionId || "";
        const existingIntro = await prisma.gameTurn.findFirst({
          where: { sessionId: introSessionId, turnNumber: 0, characterInput: "" },
          select: { turnId: true },
        });

        if (!existingIntro) {
          // Generate unique turn ID
          const { randomUUID } = await import("crypto");
          const introTurnId = `turn-intro-${Date.now()}-${randomUUID().slice(0, 8)}`;

          // Get initial game time from state (set from module initialGameTime)
          const initialGameDay = dynamicGameState?.gameDay ?? null;
          const initialGameTime = dynamicGameState?.timeOfDay ?? null;
          const playerCharacterId = dynamicGameState?.playerCharacter.id || "";
          const playerCharacterName =
            dynamicGameState?.playerCharacter.name || "";
          const introSession = await prisma.session.findUnique({
            where: { sessionId: introSessionId },
            select: { moduleId: true, emailId: true },
          });

          // Create a special turn with turnNumber 0 for introduction
          await prisma.gameTurn.create({
            data: {
              turnId: introTurnId,
              sessionId: introSessionId,
              moduleId: introSession?.moduleId || null,
              emailId: introSession?.emailId || userEmail,
              turnNumber: 0,
              characterInput: "",
              characterId: playerCharacterId,
              characterName: playerCharacterName,
              keeperNarrative: moduleIntroduction.introduction,
              status: "completed",
              startedAt: new Date(),
              completedAt: new Date(),
              gameDay: initialGameDay,
              gameTime: initialGameTime,
            },
          });

          console.log(
            `[${new Date().toISOString()}] Introduction turn created: ${introTurnId} with game time: Day ${initialGameDay}, ${initialGameTime}`
          );
        } else {
          console.log(
            `[${new Date().toISOString()}] Introduction turn already exists for this session`
          );
        }
      } catch (error) {
        console.error("Failed to create introduction turn:", error);
        // Don't fail the game start if introduction turn creation fails
      }
    }

    console.log(`[${new Date().toISOString()}] Game started successfully`);

    const finalSessionId = dynamicGameState?.sessionId || "";

    // Save language to session metadata
    if (finalSessionId) {
      try {
        const existingSession = await prisma.session.findUnique({
          where: { sessionId: finalSessionId },
          select: { metadata: true },
        });

        const metadata = existingSession?.metadata
          ? (typeof existingSession.metadata === "string"
              ? JSON.parse(existingSession.metadata)
              : existingSession.metadata)
          : {};
        metadata.language = language;

        await prisma.session.update({
          where: { sessionId: finalSessionId },
          data: { metadata },
        });

        console.log(
          `[${new Date().toISOString()}] Session language saved: ${language}`
        );
      } catch (error) {
        console.error("Failed to save session language:", error);
        // Don't fail game start if metadata update fails
      }
    }
    const finalCharacterId = dynamicGameState?.playerCharacter.id || "";
    const finalCharacterName = dynamicGameState?.playerCharacter.name || "";
    const finalTimeOfDay = dynamicGameState?.timeOfDay || "08:00";
    const finalTension = dynamicGameState?.tension || 1;
    const finalCurrentScenario = dynamicGameState?.currentScenario || null;

    const gameStatePayload: Record<string, unknown> = {
      playerCharacter: dynamicGameState?.playerCharacter || {
        id: "",
        name: "",
        attributes: {
          STR: 50,
          CON: 50,
          DEX: 50,
          APP: 50,
          POW: 50,
          SIZ: 50,
          INT: 50,
          EDU: 50,
        },
        status: {
          hp: 10,
          maxHp: 10,
          sanity: 60,
          maxSanity: 99,
          luck: 50,
          mp: 10,
          conditions: [],
        },
        skills: {},
        inventory: [],
        notes: "",
        actionLog: [],
      },
      timeOfDay: finalTimeOfDay,
      tension: finalTension,
      currentScenario: finalCurrentScenario,
    };

    res.json({
      success: true,
      message: `游戏已开始！`,
      sessionId: finalSessionId,
      characterId: finalCharacterId,
      characterName: finalCharacterName,
      moduleIntroduction: moduleIntroduction,
      gameState: gameStatePayload,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error starting game:", error);
    res
      .status(500)
      .json({ error: "Failed to start game: " + (error as Error).message });
  }
}

/**
 * Stop game and clear state
 * POST /api/game/stop
 */
export function stopGame(req: Request, res: Response): void {
  try {
    const userId = req.user!.userId;
    ServerState.getInstance().clearGameState(userId);

    console.log(`[${new Date().toISOString()}] Game stopped and state cleared`);

    res.json({
      success: true,
      message: "游戏已停止，状态已清空",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error stopping game:", error);
    res.status(500).json({ error: "Failed to stop game" });
  }
}

/**
 * Import game data (legacy endpoint)
 * POST /api/game/import-data
 *
 * Note: In the new architecture, data is loaded via /api/mod/load
 * This endpoint is kept for backward compatibility and returns success
 * if data has already been loaded through the mod system.
 */
export async function importGameData(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const db = DatabaseManager.getInstance().getDatabase();

    // Use loaders to get data counts (same as original code)
    const { ScenarioLoader } = await import(
      "../../../src/shared/agents/memory/scenarioloader/index.js"
    );
    const { NPCLoader } = await import(
      "../../../src/shared/agents/character/npcloader/index.js"
    );
    const { ModuleLoader } = await import(
      "../../../src/shared/agents/memory/moduleloader/index.js"
    );

    const scenarioLoader = new ScenarioLoader(db);
    const npcLoader = new NPCLoader(db);
    const moduleLoader = new ModuleLoader(db);

    const scenarios = await scenarioLoader.getAllScenarios();
    const npcs = await npcLoader.getAllNPCs();
    const modules = await moduleLoader.getAllModules();

    const scenariosLoaded = scenarios.length;
    const npcsLoaded = npcs.length;
    const modulesLoaded = modules.length;

    console.log(
      `[${new Date().toISOString()}] Data import check: ${scenariosLoaded} scenarios, ${npcsLoaded} NPCs, ${modulesLoaded} modules`
    );

    res.json({
      success: true,
      message: `Data already loaded: ${scenariosLoaded} scenarios, ${npcsLoaded} NPCs, ${modulesLoaded} modules`,
      scenariosLoaded,
      npcsLoaded,
      modulesLoaded,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error checking imported data:", error);
    res
      .status(500)
      .json({
        error: "Failed to check imported data: " + (error as Error).message,
      });
  }
}

/**
 * Serialize DynamicGameState for JSON response
 * Converts Set and Map to arrays/objects for JSON compatibility
 */
function serializeDynamicGameState(state: any): any {
  if (!state) return null;

  // Create a deep copy and convert Set/Map to arrays/objects
  const serialized = { ...state };

  // Convert Sets to arrays
  if (serialized.revealedTruthEvents instanceof Set) {
    serialized.revealedTruthEvents = Array.from(serialized.revealedTruthEvents);
  }
  if (serialized.activatedKnowledgeHolders instanceof Set) {
    serialized.activatedKnowledgeHolders = Array.from(
      serialized.activatedKnowledgeHolders
    );
  }
  if (serialized.deployedRedHerrings instanceof Set) {
    serialized.deployedRedHerrings = Array.from(serialized.deployedRedHerrings);
  }
  if (serialized.mythosRevelations instanceof Set) {
    serialized.mythosRevelations = Array.from(serialized.mythosRevelations);
  }

  // Convert Map to object
  if (serialized.updatedDynamicScenarioSnapshots instanceof Map) {
    const snapshotsObj: Record<string, any[]> = {};
    serialized.updatedDynamicScenarioSnapshots.forEach((value: any[], key: string) => {
      snapshotsObj[key] = value;
    });
    serialized.updatedDynamicScenarioSnapshots = snapshotsObj;
  }

  // Convert Date objects to ISO strings
  if (serialized.loadedAt instanceof Date) {
    serialized.loadedAt = serialized.loadedAt.toISOString();
  }
  if (serialized.lastUpdated instanceof Date) {
    serialized.lastUpdated = serialized.lastUpdated.toISOString();
  }
  if (serialized.lastPlayerInputTime instanceof Date) {
    serialized.lastPlayerInputTime =
      serialized.lastPlayerInputTime.toISOString();
  }

  return serialized;
}

/**
 * Get current game state
 * GET /api/gamestate
 */
export function getGameState(req: Request, res: Response): void {
  try {
    const userId = req.user!.userId;
    const serverState = ServerState.getInstance();

    const dynamicGameState = serverState.getDynamicGameState(userId);
    if (!dynamicGameState) {
      res.json({
        success: true,
        gameState: null,
        initialized: false,
        message: "Game not started yet",
      });
      return;
    }

    // Serialize DynamicGameState to handle Set/Map/Date conversion
    const serializedState = serializeDynamicGameState(dynamicGameState);

    res.json({
      success: true,
      gameState: serializedState,
      initialized: true,
    });
  } catch (error) {
    console.error("Error fetching game state:", error);
    res.status(500).json({ error: "Failed to fetch game state" });
  }
}

/**
 * Update session language preference
 * POST /api/game/update-language
 */
export async function updateSessionLanguage(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { language: rawLanguage } = req.body;

    if (rawLanguage !== "en" && rawLanguage !== "zh") {
      res.status(400).json({ error: "Invalid language. Must be 'en' or 'zh'" });
      return;
    }

    const language = rawLanguage as "en" | "zh";
    const serverState = ServerState.getInstance();
    const dynamicGameState = serverState.getDynamicGameState(userId);

    // If there's an active game session, update its metadata
    if (dynamicGameState && dynamicGameState.sessionId) {
      const sessionId = dynamicGameState.sessionId;

      // Update session metadata with new language
      const prisma = getPrismaClient();

      const existingSession = await prisma.session.findUnique({
        where: { sessionId },
        select: { metadata: true },
      });

      const metadata = existingSession?.metadata
        ? (typeof existingSession.metadata === "string"
            ? JSON.parse(existingSession.metadata)
            : existingSession.metadata)
        : {};
      metadata.language = language;

      await prisma.session.update({
        where: { sessionId },
        data: { metadata },
      });

      console.log(
        `[${new Date().toISOString()}] Session language updated: ${language} for session ${sessionId}`
      );
    } else {
      // No active session, but still accept the language change
      // The frontend will store it in localStorage and use it when a session is created
      console.log(
        `[${new Date().toISOString()}] Language preference set to ${language} for user ${userId} (no active session)`
      );
    }

    res.json({
      success: true,
      language,
      message: "Language preference updated",
      hasActiveSession: !!dynamicGameState,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error updating session language:", error);
    res.status(500).json({ error: "Failed to update language preference" });
  }
}
