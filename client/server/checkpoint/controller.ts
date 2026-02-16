/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { GraphManager } from "../core/GraphManager.js";
import { ServerState } from "../core/ServerState.js";
import { saveDynamicGameStateCheckpoint } from "../../../src/dynamicworldagent/dynamicBasicAgent/memory/checkpoint.js";
import { randomUUID } from "crypto";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";

/**
 * Save current game state as checkpoint
 * POST /api/checkpoints/save
 */
export async function saveCheckpoint(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const serverState = ServerState.getInstance();
    const requestedType =
      typeof req.body?.checkpointType === "string"
        ? req.body.checkpointType
        : undefined;
    const checkpointType =
      requestedType === "auto" ||
      requestedType === "manual" ||
      requestedType === "scene_transition"
        ? requestedType
        : "manual";
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const descriptionOverride =
      typeof req.body?.description === "string"
        ? req.body.description
        : undefined;

    const dynamicGameState = serverState.getDynamicGameState(userId);
    const db = DatabaseManager.getInstance().getDatabase();
    const prisma = getPrismaClient();

    console.log(
      `[${new Date().toISOString()}] [Checkpoint Save] User ${userId} requesting save`
    );

    if (!dynamicGameState) {
      console.log(
        `[${new Date().toISOString()}] [Checkpoint Save] ERROR: No game state found for user ${userId}`
      );
      res
        .status(400)
        .json({
          error: "DynamicWorld game not started. Please start the game first.",
        });
      return;
    }

    // Extract character info from the appropriate state type
    const characterId = dynamicGameState.playerCharacter?.id;
    const characterName = dynamicGameState.playerCharacter?.name;
    const sessionId = dynamicGameState.sessionId;

    console.log(
      `[${new Date().toISOString()}] [Checkpoint Save] Game state found - Type: DynamicWorld, Character: ${characterName} (ID: ${characterId}), Session: ${sessionId}`
    );

    if (!characterId) {
      console.log(
        `[${new Date().toISOString()}] [Checkpoint Save] ERROR: No character ID in game state. playerCharacter: ${JSON.stringify(dynamicGameState.playerCharacter)}`
      );
      res
        .status(400)
        .json({ error: "No character in game state. Cannot save checkpoint." });
      return;
    }

    // Check if character is owned by the current user
    const ownedCharacter = await prisma.character.findFirst({
      where: {
        characterId: characterId,
        emailId: req.user!.email,
        isNpc: false,
      },
      select: { characterId: true },
    });

    if (!ownedCharacter) {
      // If character exists but is unassigned (emailId is NULL), claim it for this user.
      const unassigned = await prisma.character.findFirst({
        where: {
          characterId: characterId,
          emailId: null,
          isNpc: false,
        },
        select: { characterId: true },
      });

      if (unassigned) {
        await prisma.character.updateMany({
          where: {
            characterId: characterId,
            emailId: null,
            isNpc: false,
          },
          data: {
            emailId: req.user!.email,
          },
        });
        console.log(
          `[${new Date().toISOString()}] [Checkpoint Save] Claimed unassigned character ${characterId} for user ${req.user!.email}`
        );
      } else {
        console.log(
          `[${new Date().toISOString()}] [Checkpoint Save] ERROR: Character ${characterId} not found in database for user ${req.user!.email}`
        );
        // Check if character exists at all
        const charExists = await prisma.character.findUnique({
          where: { characterId: characterId },
          select: { characterId: true, emailId: true, name: true },
        });
        if (charExists) {
          console.log(
            `[${new Date().toISOString()}] [Checkpoint Save] Character exists but belongs to different user: ${JSON.stringify(charExists)}`
          );
          res
            .status(403)
            .json({
              error: `Character not found. Character ${characterName || characterId} may belong to a different user.`,
            });
        } else {
          console.log(
            `[${new Date().toISOString()}] [Checkpoint Save] Character does not exist in database at all`
          );
          res
            .status(403)
            .json({
              error: `Character not found. Character ${characterName || characterId} does not exist in database.`,
            });
        }
        return;
      }
    }

    console.log(
      `[${new Date().toISOString()}] [Checkpoint Save] Character verified, proceeding with save...`
    );

    let checkpointId: string;
    let checkpointName: string;
    let description: string;

    const currentScenario = dynamicGameState.currentScenario;
    if (!currentScenario) {
      res
        .status(400)
        .json({ error: "No current scenario. Cannot save checkpoint." });
      return;
    }

    if (checkpointType === "manual") {
      // Generate checkpoint name
      const currentDate = new Date().toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      checkpointName = `${currentScenario.name} - ${currentDate}`;
      description =
        descriptionOverride || `Manual save at ${currentScenario.location}`;

      // Save DynamicGameState checkpoint (includes all snapshots)
      const savedCheckpointId = await saveDynamicGameStateCheckpoint(
        db,
        dynamicGameState,
        "manual",
        description
      );

      if (!savedCheckpointId) {
        res.status(500).json({ error: "Failed to save checkpoint" });
        return;
      }

      checkpointId = savedCheckpointId;
    } else {
      const gameDay = dynamicGameState.gameDay ?? 1;
      const timeOfDay = dynamicGameState.timeOfDay ?? "Unknown time";
      const timeLabel = timeOfDay
        ? ` (Day ${gameDay}, ${timeOfDay})`
        : ` (Day ${gameDay})`;
      checkpointName = `${checkpointType === "scene_transition" ? "Scene Transition" : "Auto Save"} - ${currentScenario.name}${timeLabel}`;
      description =
        descriptionOverride ||
        `Auto save${reason ? ` (${reason})` : ""} at ${currentScenario.location}`;

      const savedCheckpointId = await saveDynamicGameStateCheckpoint(
        db,
        dynamicGameState,
        checkpointType,
        description
      );

      if (!savedCheckpointId) {
        res.status(500).json({ error: "Failed to save checkpoint" });
        return;
      }

      checkpointId = savedCheckpointId;

      if (checkpointType === "auto") {
        db.cleanupAutoCheckpoints(dynamicGameState.sessionId, 10);
      }
    }

    console.log(
      `[${new Date().toISOString()}] Checkpoint saved: ${checkpointName} (${checkpointId})`
    );

    res.json({
      success: true,
      checkpointId: checkpointId,
      checkpointName: checkpointName,
      message: checkpointType === "auto" ? "Auto save successful" : "Save successful",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error saving checkpoint:", error);
    res
      .status(500)
      .json({
        error: "Failed to save checkpoint: " + (error as Error).message,
      });
  }
}

/**
 * List all available checkpoints
 * GET /api/checkpoints/list
 */
export async function listCheckpoints(req: Request, res: Response): Promise<void> {
  try {
    const prisma = getPrismaClient();
    const sessionId = req.query.sessionId as string;
    const limit = parseInt(req.query.limit as string) || 50;

    let checkpoints: any[] = [];

    if (sessionId && sessionId !== "all") {
      // Verify the user owns this session via character ownership
      // Session.characterId -> Character.characterId where Character.emailId = user email
      const session = await prisma.session.findUnique({
        where: { sessionId },
        select: { sessionId: true, characterId: true },
      });

      if (!session || !session.characterId) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const character = await prisma.character.findFirst({
        where: {
          characterId: session.characterId,
          emailId: req.user!.email,
        },
        select: { characterId: true },
      });

      if (!character) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      // Fetch checkpoints for this session (module_name comes from moduleId relation first).
      const rawCheckpoints = await prisma.gameCheckpoint.findMany({
        where: { sessionId },
        include: {
          session: {
            select: {
              modName: true,
              module: { select: { moduleName: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      checkpoints = rawCheckpoints.map((cp) => ({
        checkpointId: cp.checkpointId,
        checkpointName: cp.checkpointName,
        currentSceneName: cp.currentSceneName,
        isAutoCheckpoint: cp.isAutoCheckpoint,
        createdAt: cp.createdAt,
        sessionId: cp.sessionId,
        gameState: cp.gameState,
        modName:
          cp.session?.module?.moduleName ||
          cp.session?.modName ||
          "Unknown Module",
      }));
    } else {
      // Find all sessions owned by the user (via character)
      const userCharacters = await prisma.character.findMany({
        where: { emailId: req.user!.email },
        select: { characterId: true },
      });

      const userCharacterIds = userCharacters.map((c) => c.characterId);

      if (userCharacterIds.length === 0) {
        res.json({ success: true, checkpoints: [] });
        return;
      }

      // Find all sessions that belong to the user (email scope first, character scope fallback).
      const userSessions = await prisma.session.findMany({
        where: {
          OR: [
            { emailId: req.user!.email },
            ...(userCharacterIds.length > 0
              ? [{ characterId: { in: userCharacterIds } }]
              : []),
          ],
        },
        select: { sessionId: true },
      });

      const userSessionIds = userSessions.map((s) => s.sessionId);

      if (userSessionIds.length === 0) {
        res.json({ success: true, checkpoints: [] });
        return;
      }

      // Fetch checkpoints for all user's sessions
      const rawCheckpoints = await prisma.gameCheckpoint.findMany({
        where: {
          sessionId: { in: userSessionIds },
        },
        include: {
          session: {
            select: {
              modName: true,
              module: { select: { moduleName: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      checkpoints = rawCheckpoints.map((cp) => ({
        checkpointId: cp.checkpointId,
        checkpointName: cp.checkpointName,
        currentSceneName: cp.currentSceneName,
        isAutoCheckpoint: cp.isAutoCheckpoint,
        createdAt: cp.createdAt,
        sessionId: cp.sessionId,
        gameState: cp.gameState,
        modName:
          cp.session?.module?.moduleName ||
          cp.session?.modName ||
          "Unknown Module",
      }));
    }

    // Extract metadata from gameState JSON and normalize to camelCase
    const normalizedCheckpoints = checkpoints.map((cp: any) => {
      const gs = cp.gameState as any;
      return {
        checkpointId: cp.checkpointId,
        checkpointName: cp.checkpointName,
        checkpointType: cp.isAutoCheckpoint ? "auto" : "manual",
        description: null,
        gameDay: gs?.gameDay ?? null,
        gameTime: gs?.timeOfDay ?? null,
        currentSceneName: cp.currentSceneName ?? gs?.currentScenario?.name ?? null,
        currentLocation: gs?.currentScenario?.location ?? null,
        playerHp: gs?.playerCharacter?.status?.hp ?? null,
        playerSanity: gs?.playerCharacter?.status?.sanity ?? null,
        createdAt: cp.createdAt,
        sessionId: cp.sessionId,
        modName: cp.modName || "Unknown Module",
      };
    });

    res.json({
      success: true,
      checkpoints: normalizedCheckpoints,
    });
  } catch (error) {
    console.error("Error listing checkpoints:", error);
    res
      .status(500)
      .json({
        error: "Failed to list checkpoints: " + (error as Error).message,
      });
  }
}

/**
 * Load a checkpoint and restore game state
 * POST /api/checkpoints/load
 */
export async function loadCheckpointData(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const db = DatabaseManager.getInstance().getDatabase();
    const prisma = getPrismaClient();
    const userId = req.user!.userId;
    const { checkpointId } = req.body;

    if (!checkpointId) {
      res.status(400).json({ error: "checkpointId is required" });
      return;
    }

    // Verify checkpoint ownership: checkpoint -> session -> character -> emailId
    const checkpointRecord = await prisma.gameCheckpoint.findUnique({
      where: { checkpointId },
      select: {
        checkpointId: true,
        sessionId: true,
        gameState: true,
        session: {
          select: { characterId: true },
        },
      },
    });

    if (!checkpointRecord || !checkpointRecord.session?.characterId) {
      res.status(404).json({ error: "Checkpoint not found" });
      return;
    }

    const ownerCharacter = await prisma.character.findFirst({
      where: {
        characterId: checkpointRecord.session.characterId,
        emailId: req.user!.email,
      },
      select: { characterId: true },
    });

    if (!ownerCharacter) {
      res.status(404).json({ error: "Checkpoint not found" });
      return;
    }

    const gameState = checkpointRecord.gameState;
    if (!gameState) {
      res.status(404).json({ error: "Checkpoint game state not found" });
      return;
    }

    const gameStateAny = gameState as any;
    if (
      !gameStateAny.moduleName ||
      gameStateAny.updatedDynamicScenarioSnapshots === undefined
    ) {
      res
        .status(400)
        .json({ error: "Only DynamicWorld checkpoints are supported" });
      return;
    }

    // Extract conversation history and memos saved in the checkpoint
    const conversationHistory: any[] = gameStateAny.conversationHistory || [];
    const playerMemos: any[] = gameStateAny.playerMemos || [];

    // Generate new session ID — no parent/child relationship needed
    const newSessionId = `session-${randomUUID()}`;

    // Create session and populate with saved conversation + memos
    await createSessionFromCheckpointData(
      newSessionId,
      gameStateAny,
      conversationHistory,
      playerMemos,
      req.user!.email
    );
    const restoredConversation = conversationHistory;

    console.log(
      `[${new Date().toISOString()}] Created session ${newSessionId} from checkpoint ${checkpointId} (${conversationHistory.length} messages, ${playerMemos.length} memos)`
    );

    // Restore language from checkpoint's game state (saved when checkpoint was created)
    let restoredLanguage: "en" | "zh" = "zh";
    try {
      console.log(`[Checkpoint Load] gameStateAny.language:`, gameStateAny.language);

      // First try to get language from checkpoint's game state
      if (gameStateAny.language === "en" || gameStateAny.language === "zh") {
        restoredLanguage = gameStateAny.language;
        console.log(`[Checkpoint Load] Language from checkpoint: ${restoredLanguage}`);
      } else {
        console.log(`[Checkpoint Load] No valid language in checkpoint, trying original session`);
        // Fallback: try to get from original session metadata
        const originalSession = await prisma.session.findUnique({
          where: { sessionId: checkpointRecord.sessionId },
          select: { metadata: true },
        });

        console.log(`[Checkpoint Load] Original session metadata:`, originalSession?.metadata);

        if (originalSession?.metadata) {
          const metadata = originalSession.metadata as any;
          console.log(`[Checkpoint Load] Parsed original metadata:`, metadata);
          restoredLanguage =
            metadata.language === "en" || metadata.language === "zh"
              ? metadata.language
              : "zh";
          console.log(`[Checkpoint Load] Language from original session: ${restoredLanguage}`);
        }
      }

      // Save language to new session metadata
      const newMetadata = { language: restoredLanguage };
      await prisma.session.update({
        where: { sessionId: newSessionId },
        data: { metadata: newMetadata },
      });

      console.log(
        `[${new Date().toISOString()}] Restored language setting: ${restoredLanguage} → session ${newSessionId}`
      );
    } catch (error) {
      console.error("Failed to restore language setting:", error);
      // Continue with default language
    }

    // Deserialize DynamicGameState with checkpoint gameTime to filter snapshots
    const { DynamicGameStateManager } = await import(
      "../../../src/dynamicworldagent/state/index.js"
    );
    const checkpointGameDay =
      typeof gameStateAny.gameDay === "number" ? gameStateAny.gameDay : undefined;
    const checkpointTimeOfDay =
      typeof gameStateAny.timeOfDay === "string"
        ? gameStateAny.timeOfDay
        : typeof gameStateAny.gameTime === "string"
          ? gameStateAny.gameTime
          : undefined;

    let restoredDynamicGameState: any;
    if (checkpointGameDay && checkpointTimeOfDay) {
      restoredDynamicGameState = DynamicGameStateManager.deserialize(
        gameStateAny,
        checkpointGameDay,
        checkpointTimeOfDay,
        db
      );
    } else {
      restoredDynamicGameState = DynamicGameStateManager.deserialize(
        gameStateAny,
        undefined,
        undefined,
        db
      );
    }

    // Set new session ID, clean up any stale fields from old checkpoints
    restoredDynamicGameState.sessionId = newSessionId;
    delete (restoredDynamicGameState as any).conversationHistory;
    delete (restoredDynamicGameState as any).playerMemos;
    delete (restoredDynamicGameState as any).parentSessionId;
    delete (restoredDynamicGameState as any).subId;
    delete (restoredDynamicGameState as any).language; // Language is stored in session metadata, not game state

    // Restore game state
    ServerState.getInstance().setGameState(userId, restoredDynamicGameState);

    // Initialize GraphManager if needed
    const graphManager = GraphManager.getInstance();
    if (!graphManager.isInitialized()) {
      await graphManager.initialize(db);
    }

    console.log(
      `[${new Date().toISOString()}] Checkpoint loaded: ${checkpointId} → session ${newSessionId}`
    );

    // Only return necessary data to frontend (reduce network payload)
    res.json({
      success: true,
      sessionId: newSessionId,
      gameState: {
        playerCharacter: {
          name: restoredDynamicGameState.playerCharacter?.name,
        },
        moduleName: restoredDynamicGameState.moduleName,
      },
      conversationHistory: restoredConversation,
      language: restoredLanguage,
      message: "存档加载成功",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error loading checkpoint:", error);
    res
      .status(500)
      .json({
        error: "Failed to load checkpoint: " + (error as Error).message,
      });
  }
}

/**
 * Delete a checkpoint
 * DELETE /api/checkpoints/:checkpointId
 */
export async function deleteCheckpoint(req: Request, res: Response): Promise<void> {
  try {
    const prisma = getPrismaClient();
    const userId = req.user!.userId;
    const { checkpointId } = req.params;

    if (!checkpointId) {
      res.status(400).json({ error: "checkpointId is required" });
      return;
    }

    // Verify checkpoint ownership: checkpoint -> session -> character -> emailId
    const checkpointRecord = await prisma.gameCheckpoint.findUnique({
      where: { checkpointId },
      include: {
        session: {
          select: { characterId: true },
        },
      },
    });

    if (!checkpointRecord || !checkpointRecord.session?.characterId) {
      res
        .status(404)
        .json({
          error:
            "Checkpoint not found or you don't have permission to delete it",
        });
      return;
    }

    const ownerCharacter = await prisma.character.findFirst({
      where: {
        characterId: checkpointRecord.session.characterId,
        emailId: req.user!.email,
      },
      select: { characterId: true },
    });

    if (!ownerCharacter) {
      res
        .status(404)
        .json({
          error:
            "Checkpoint not found or you don't have permission to delete it",
        });
      return;
    }

    // Delete the checkpoint
    await prisma.gameCheckpoint.delete({
      where: { checkpointId },
    });

    console.log(
      `[${new Date().toISOString()}] Checkpoint deleted: ${checkpointId} by user ${userId}`
    );

    res.json({
      success: true,
      message: "Checkpoint deleted successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error deleting checkpoint:", error);
    res
      .status(500)
      .json({
        error: "Failed to delete checkpoint: " + (error as Error).message,
      });
  }
}

/**
 * Batch delete checkpoints
 * POST /api/checkpoints/batch-delete
 */
export async function batchDeleteCheckpoints(req: Request, res: Response): Promise<void> {
  try {
    const prisma = getPrismaClient();
    const userId = req.user!.userId;
    const { checkpointIds } = req.body;

    if (!checkpointIds || !Array.isArray(checkpointIds) || checkpointIds.length === 0) {
      res.status(400).json({ error: "checkpointIds array is required and must not be empty" });
      return;
    }

    // Verify all checkpoints belong to the user:
    // 1. Find all requested checkpoints with their session's characterId
    const requestedCheckpoints = await prisma.gameCheckpoint.findMany({
      where: {
        checkpointId: { in: checkpointIds },
      },
      include: {
        session: {
          select: { characterId: true },
        },
      },
    });

    // 2. Collect unique characterIds from those sessions
    const characterIds = [
      ...new Set(
        requestedCheckpoints
          .map((cp) => cp.session?.characterId)
          .filter((id): id is string => id != null)
      ),
    ];

    // 3. Verify those characters belong to the user
    const ownedCharacters = await prisma.character.findMany({
      where: {
        characterId: { in: characterIds },
        emailId: req.user!.email,
      },
      select: { characterId: true },
    });

    const ownedCharacterIds = new Set(ownedCharacters.map((c) => c.characterId));

    // 4. Filter to only checkpoints whose session character is owned by the user
    const ownedCheckpointIds = requestedCheckpoints
      .filter(
        (cp) =>
          cp.session?.characterId &&
          ownedCharacterIds.has(cp.session.characterId)
      )
      .map((cp) => cp.checkpointId);

    if (ownedCheckpointIds.length !== checkpointIds.length) {
      res.status(403).json({
        error: "Some checkpoints not found or you don't have permission to delete them",
      });
      return;
    }

    // Delete all checkpoints in a single batch operation
    const deleteResult = await prisma.gameCheckpoint.deleteMany({
      where: {
        checkpointId: { in: ownedCheckpointIds },
      },
    });

    const deletedCount = deleteResult.count;

    console.log(
      `[${new Date().toISOString()}] Batch delete: ${deletedCount}/${checkpointIds.length} checkpoints deleted by user ${userId}`
    );

    res.json({
      success: true,
      message: `Successfully deleted ${deletedCount} checkpoint(s)`,
      deletedCount,
      totalRequested: checkpointIds.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error batch deleting checkpoints:", error);
    res.status(500).json({
      error: "Failed to batch delete checkpoints: " + (error as Error).message,
    });
  }
}

function toDateOrNow(value: unknown): Date {
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

async function createSessionFromCheckpointData(
  sessionId: string,
  gameState: any,
  conversationHistory: any[],
  playerMemos: any[],
  ownerEmail: string
): Promise<void> {
  const prisma = getPrismaClient();

  const characterId =
    typeof gameState?.playerCharacter?.id === "string"
      ? gameState.playerCharacter.id
      : null;
  const characterName =
    typeof gameState?.playerCharacter?.name === "string"
      ? gameState.playerCharacter.name
      : null;
  const modName =
    typeof gameState?.moduleName === "string" ? gameState.moduleName : null;
  const modNameNormalized =
    typeof modName === "string" ? modName.trim().toLowerCase() : null;

  let moduleId: string | null = null;
  if (modNameNormalized) {
    const owned = await prisma.module.findFirst({
      where: {
        ownerEmailId: ownerEmail,
        moduleNameNormalized: modNameNormalized,
      },
      select: { moduleId: true },
    });
    moduleId = owned?.moduleId || null;
  }
  if (!moduleId && modNameNormalized) {
    const shared = await prisma.module.findFirst({
      where: {
        moduleNameNormalized: modNameNormalized,
        status: "active",
      },
      select: { moduleId: true },
      orderBy: { createdAt: "desc" },
    });
    moduleId = shared?.moduleId || null;
  }

  const turnsByNumber = new Map<
    number,
    {
      turnNumber: number;
      characterInput: string;
      keeperNarrative: string | null;
      startedAt: Date;
      completedAt: Date | null;
      gameDay: number | null;
      gameTime: string | null;
    }
  >();

  for (const message of conversationHistory) {
    if (!message || typeof message !== "object") continue;

    const turnNumber =
      typeof message.turnNumber === "number" && Number.isFinite(message.turnNumber)
        ? message.turnNumber
        : 0;
    const existing = turnsByNumber.get(turnNumber) ?? {
      turnNumber,
      characterInput: "",
      keeperNarrative: null,
      startedAt: toDateOrNow(message.timestamp),
      completedAt: null,
      gameDay:
        typeof message.gameDay === "number" && Number.isFinite(message.gameDay)
          ? message.gameDay
          : null,
      gameTime: typeof message.gameTime === "string" ? message.gameTime : null,
    };

    const role = message.role;
    const content = typeof message.content === "string" ? message.content : "";
    const timestamp = toDateOrNow(message.timestamp);

    if (role === "character") {
      existing.characterInput = content;
      existing.startedAt = timestamp;
    } else if (role === "keeper") {
      existing.keeperNarrative = content;
      existing.completedAt = timestamp;
    }

    if (existing.gameDay === null && typeof message.gameDay === "number") {
      existing.gameDay = message.gameDay;
    }
    if (!existing.gameTime && typeof message.gameTime === "string") {
      existing.gameTime = message.gameTime;
    }

    turnsByNumber.set(turnNumber, existing);
  }

  const turnRows = [...turnsByNumber.values()]
    .sort((a, b) => a.turnNumber - b.turnNumber)
    .map((turn) => ({
      turnId: `turn-restore-${sessionId}-${turn.turnNumber}-${randomUUID().slice(0, 8)}`,
      sessionId,
      turnNumber: turn.turnNumber,
      characterInput: turn.characterInput,
      characterId,
      characterName,
      moduleId,
      emailId: ownerEmail,
      keeperNarrative: turn.keeperNarrative,
      status: "completed",
      startedAt: turn.startedAt,
      completedAt: turn.completedAt ?? turn.startedAt,
      gameDay: turn.gameDay,
      gameTime: turn.gameTime,
    }));

  const memoRows = playerMemos
    .filter((memo) => memo && typeof memo === "object")
    .map((memo) => ({
      memoId:
        typeof memo.memoId === "string" && memo.memoId.length > 0
          ? memo.memoId
          : `memo-restore-${randomUUID()}`,
      sessionId,
      moduleId,
      emailId:
        typeof memo.emailId === "string" && memo.emailId.length > 0
          ? memo.emailId
          : ownerEmail,
      text: typeof memo.text === "string" ? memo.text : "",
      gameDay: typeof memo.gameDay === "number" ? memo.gameDay : null,
      gameTime: typeof memo.gameTime === "string" ? memo.gameTime : null,
      location: typeof memo.location === "string" ? memo.location : null,
      createdAt: toDateOrNow(memo.createdAt),
      updatedAt: toDateOrNow(memo.updatedAt),
    }));

  await prisma.$transaction(async (tx) => {
    await tx.session.upsert({
      where: { sessionId },
      update: {
        moduleId,
        emailId: ownerEmail,
        modName,
        characterId,
        characterName,
        status: "active",
        lastActivityAt: new Date(),
      },
      create: {
        sessionId,
        moduleId,
        emailId: ownerEmail,
        modName,
        characterId,
        characterName,
        status: "active",
        metadata: {},
      },
    });

    if (turnRows.length > 0) {
      await tx.gameTurn.createMany({
        data: turnRows,
        skipDuplicates: true,
      });
    }

    if (memoRows.length > 0) {
      await tx.playerMemo.createMany({
        data: memoRows,
        skipDuplicates: true,
      });
    }
  });
}
