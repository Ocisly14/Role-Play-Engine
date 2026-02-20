import { HumanMessage } from "@langchain/core/messages";
/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { TurnManager as DynamicTurnManager } from "../../../src/dynamicworldagent/dynamicBasicAgent/memory/turnManager.js";
import type { DynamicGameState } from "../../../src/dynamicworldagent/state/index.js";
import {
  getCurrentUsageTotals,
  runWithTokenContext,
} from "../../../src/models/index.js";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import type { DiceRollInfo } from "../../../src/shared/state/index.js";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { GraphManager } from "../core/GraphManager.js";
import { ServerState } from "../core/ServerState.js";
import { WebSocketManager } from "../websocket/WebSocketManager.js";
import { notifyClients } from "../websocket/notifier.js";

type NarrativeStreamHandlers = {
  onDiceRolls?: (diceRolls: DiceRollInfo[]) => void;
  onSceneImage?: (payload: {
    imagePath: string;
    mimeType: string;
    sceneName: string;
    location: string;
    gameDay?: number | null;
    gameTime?: string | null;
    timestamp?: string;
  }) => void;
  onSceneChangeStart?: () => void;
  onSceneChangeEnd?: () => void;
  onWorldlineUpdateStart?: () => void;
  onWorldlineUpdateEnd?: () => void;
  onNarrativeStart?: () => void;
  onNarrativeDelta?: (delta: string) => void;
  onNarrativeEnd?: () => void;
  onMapUpdate?: (payload: { macroMapPath: string; mimeType: string }) => void;
};

/**
 * Create a new turn and start processing
 * POST /api/turns
 */
export async function createTurn(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const userEmail = req.user!.email;
    const serverState = ServerState.getInstance();

    const dynamicGameState = serverState.getDynamicGameState(userId);

    if (!dynamicGameState) {
      res.status(400).json({
        error:
          "DynamicWorld game not started. Please start the game first by calling /api/game/start",
      });
      return;
    }

    const playerStatus = dynamicGameState.playerCharacter?.status;
    const legacyEndedByStatus =
      (playerStatus?.hp ?? 0) <= 0 || (playerStatus?.sanity ?? 0) <= 0;
    const legacyEndedByTrigger =
      dynamicGameState.temporaryInfo?.contextualData?.globalTriggerEnded ===
      true;
    if (
      dynamicGameState.gameEnding?.isEnded ||
      legacyEndedByStatus ||
      legacyEndedByTrigger
    ) {
      res.status(409).json({
        success: false,
        error: "Game has ended. Please start a new game session.",
        gameEnding: dynamicGameState.gameEnding,
      });
      return;
    }

    const graphManager = GraphManager.getInstance();

    // Initialize graph if needed
    if (!graphManager.isInitialized()) {
      const db = DatabaseManager.getInstance().getDatabase();
      await graphManager.initialize(db);
    }

    const {
      message,
      selectedSkill: rawSelectedSkill,
      skillSelectionMode: rawSkillSelectionMode,
      language: rawLanguage,
      isCombatResponse: rawIsCombatResponse,
    } = req.body ?? {};
    const isCombatResponse =
      rawIsCombatResponse === true || rawIsCombatResponse === "true";
    const selectedSkill =
      typeof rawSelectedSkill === "string" ? rawSelectedSkill.trim() : null;
    const normalizedSkill =
      selectedSkill && selectedSkill.length > 0 ? selectedSkill : null;
    const normalizedSkillSelectionMode =
      typeof rawSkillSelectionMode === "string"
        ? rawSkillSelectionMode.trim().toLowerCase()
        : null;
    const skillSelectionMode =
      normalizedSkillSelectionMode === "auto" ||
      normalizedSkillSelectionMode === "manual"
        ? normalizedSkillSelectionMode
        : null;
    const effectiveSkillSelectionMode = normalizedSkill
      ? "manual"
      : skillSelectionMode === "auto"
        ? "auto"
        : "manual";
    const language =
      rawLanguage === "en" || rawLanguage === "zh" ? rawLanguage : "zh";

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "Message is required" });
      return;
    }

    const db = DatabaseManager.getInstance().getDatabase();
    const prisma = getPrismaClient();
    const dynamicTurnManager = new DynamicTurnManager(db);
    await db.preloadSessionTurns(dynamicGameState.sessionId);

    // Check if this is resuming an interrupted turn (skill selection or combat response)
    let turnId: string | undefined;
    let isResumingTurn = false;
    let isResumingCombatTurn = false;

    if (normalizedSkill) {
      // Look for a recent turn with requires_skill_selection status for this session
      const skillSelectionTurn = await prisma.gameTurn.findFirst({
        where: {
          sessionId: dynamicGameState.sessionId,
          status: "requires_skill_selection",
        },
        orderBy: { turnNumber: "desc" },
      });

      if (skillSelectionTurn) {
        console.log(
          `🔄 [${new Date().toISOString()}] Resuming interrupted turn ${skillSelectionTurn.turnId} with selected skill: ${normalizedSkill}`
        );
        isResumingTurn = true;
        turnId = skillSelectionTurn.turnId;

        // Move the interrupted turn back to processing before resuming graph execution.
        await prisma.gameTurn.update({
          where: { turnId },
          data: { status: "processing", errorMessage: null },
        });
      }
    }

    if (!turnId && isCombatResponse) {
      // Look for a recent turn with requires_combat_response status for this session
      const combatTurn = await prisma.gameTurn.findFirst({
        where: {
          sessionId: dynamicGameState.sessionId,
          status: "requires_combat_response",
        },
        orderBy: { turnNumber: "desc" },
      });

      if (combatTurn) {
        console.log(
          `⚔️  [${new Date().toISOString()}] Resuming combat turn ${combatTurn.turnId} with player response`
        );
        isResumingCombatTurn = true;
        turnId = combatTurn.turnId;

        // Move back to processing
        await prisma.gameTurn.update({
          where: { turnId },
          data: { status: "processing", errorMessage: null },
        });
      }
    }

    // Create new turn if not resuming
    if (!turnId) {
      turnId = await dynamicTurnManager.createTurnFromGameState(
        dynamicGameState.sessionId,
        message,
        dynamicGameState
      );
      console.log(
        `[${new Date().toISOString()}] Turn created: ${turnId} for message: ${message} (DynamicWorld)`
      );
    }

    if (normalizedSkill) {
      console.log(
        `[${new Date().toISOString()}] Selected skill: ${normalizedSkill}`
      );
    }
    if (effectiveSkillSelectionMode === "auto") {
      console.log(`[${new Date().toISOString()}] Skill selection mode: auto`);
    }

    // Start async processing (don't wait for it)
    // Pass the appropriate state type to processGameTurnAsync
    const stateToProcess = dynamicGameState;
    runWithTokenContext(
      {
        email: userEmail,
        turnId,
        usageTotals: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
      () => {
        processGameTurnAsync(
          turnId,
          message,
          stateToProcess,
          userId,
          normalizedSkill,
          effectiveSkillSelectionMode,
          language,
          isResumingTurn,
          isResumingCombatTurn
        ).catch((error) => {
          console.error(`Error processing turn ${turnId}:`, error);
          const dynamicTurnManager = new DynamicTurnManager(db);
          dynamicTurnManager.markError(turnId, error);
        });
      }
    );

    // Immediately return the turnId
    res.json({
      success: true,
      turnId: turnId,
      status: "processing",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error creating turn:", error);
    res
      .status(500)
      .json({ error: "Failed to create turn: " + (error as Error).message });
  }
}

function buildNarrativeStreamHandlers(params: {
  sessionId: string;
  turnId: string;
  turnNumber?: number | null;
  isSimulated?: boolean | null;
  gameDay?: number | null;
  gameTime?: string | null;
  timestamp?: string | null;
}): NarrativeStreamHandlers | null {
  const modelProvider = (process.env.MODEL_PROVIDER || "").toLowerCase();
  const enableStreaming = modelProvider === "google";

  const wsManager = WebSocketManager.getInstance();
  if (!wsManager) {
    return null;
  }

  const clients = wsManager.getClients();
  if (!clients.has(params.sessionId)) {
    return null;
  }

  let started = false;
  let pending = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (message: Record<string, unknown>) => {
    notifyClients(params.sessionId, clients, message);
  };

  const flush = () => {
    if (!pending) return;
    send({
      type: "keeper_stream_delta",
      turnId: params.turnId,
      delta: pending,
    });
    pending = "";
  };

  const start = () => {
    if (started) return;
    started = true;
    send({
      type: "keeper_stream_start",
      turnId: params.turnId,
      turnNumber: params.turnNumber ?? null,
      isSimulated: params.isSimulated ?? null,
      timestamp: params.timestamp || new Date().toISOString(),
      gameDay: params.gameDay ?? null,
      gameTime: params.gameTime ?? null,
    });
  };

  return {
    onDiceRolls: (diceRolls: DiceRollInfo[]) => {
      if (!Array.isArray(diceRolls) || diceRolls.length === 0) return;
      send({
        type: "keeper_dice_rolls",
        turnId: params.turnId,
        turnNumber: params.turnNumber ?? null,
        diceRolls,
        timestamp: params.timestamp || new Date().toISOString(),
        gameDay: params.gameDay ?? null,
        gameTime: params.gameTime ?? null,
      });
    },
    onSceneImage: (payload) => {
      send({
        type: "scene_image",
        turnId: params.turnId,
        turnNumber: params.turnNumber ?? null,
        timestamp: payload.timestamp || new Date().toISOString(),
        gameDay: payload.gameDay ?? params.gameDay ?? null,
        gameTime: payload.gameTime ?? params.gameTime ?? null,
        sceneName: payload.sceneName,
        location: payload.location,
        imagePath: payload.imagePath,
        mimeType: payload.mimeType,
      });
    },
    onSceneChangeStart: () => {
      send({
        type: "scene_change_start",
        turnId: params.turnId,
        timestamp: new Date().toISOString(),
      });
    },
    onSceneChangeEnd: () => {
      send({
        type: "scene_change_end",
        turnId: params.turnId,
        timestamp: new Date().toISOString(),
      });
    },
    onWorldlineUpdateStart: () => {
      send({
        type: "worldline_update_start",
        turnId: params.turnId,
        timestamp: new Date().toISOString(),
      });
    },
    onWorldlineUpdateEnd: () => {
      send({
        type: "worldline_update_end",
        turnId: params.turnId,
        timestamp: new Date().toISOString(),
      });
    },
    onNarrativeStart: enableStreaming
      ? () => {
          start();
        }
      : undefined,
    onNarrativeDelta: enableStreaming
      ? (delta: string) => {
          if (!delta) return;
          start();
          pending += delta;

          if (pending.length >= 48) {
            flush();
            return;
          }

          if (!flushTimer) {
            flushTimer = setTimeout(() => {
              flush();
              flushTimer = null;
            }, 50);
          }
        }
      : undefined,
    onNarrativeEnd: enableStreaming
      ? () => {
          if (!started) return;
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          flush();
          send({
            type: "keeper_stream_end",
            turnId: params.turnId,
            timestamp: new Date().toISOString(),
          });
        }
      : undefined,
    onMapUpdate: (payload) => {
      send({
        type: "map_update",
        turnId: params.turnId,
        macroMapPath: payload.macroMapPath,
        mimeType: payload.mimeType,
        timestamp: new Date().toISOString(),
      });
    },
  };
}

/**
 * Helper function to process a game turn asynchronously
 */
async function processGameTurnAsync(
  turnId: string,
  userInput: string,
  gameState: DynamicGameState,
  userId: string,
  selectedSkill?: string | null,
  skillSelectionMode?: "auto" | "manual",
  language?: "en" | "zh",
  resumeFromInterrupt = false,
  resumeFromCombatInterrupt = false
) {
  try {
    console.log(`[${new Date().toISOString()}] Processing turn ${turnId}...`);

    const serverState = ServerState.getInstance();
    const graphManager = GraphManager.getInstance();

    const dynamicGameState = gameState;
    const graph = graphManager.getGraph(true);
    const initialMessages = [new HumanMessage(userInput)];
    const db = DatabaseManager.getInstance().getDatabase();
    let streamHandlers: NarrativeStreamHandlers | null = null;

    const dynamicTurnManager = new DynamicTurnManager(db);
    const turn = dynamicTurnManager.getTurn(turnId);
    streamHandlers = buildNarrativeStreamHandlers({
      sessionId: dynamicGameState.sessionId,
      turnId,
      turnNumber: turn?.turnNumber ?? null,
      isSimulated: turn?.isSimulated ?? null,
      gameDay: turn?.gameDay ?? dynamicGameState.gameDay ?? null,
      gameTime: turn?.gameTime ?? dynamicGameState.timeOfDay ?? null,
      timestamp: turn?.startedAt ?? null,
    });

    const isResumingTurn = resumeFromInterrupt;

    // Prepare graph state
    let graphState: any;

    graphState = {
      messages: initialMessages,
      dynamicGameState: dynamicGameState,
      turnId: turnId,
      stream: streamHandlers ?? undefined,
      language: language || "zh",
      selectedSkill: selectedSkill ?? null,
      skillSelectionMode,
      resumeFromInterrupt: isResumingTurn,
      resumeFromCombatInterrupt: resumeFromCombatInterrupt,
    };

    // Invoke the graph with checkpoint support
    // Use turnId as thread_id to enable resume functionality
    const graphConfig = {
      configurable: {
        thread_id: turnId,
      },
    };

    if (isResumingTurn) {
      console.log(
        `   🔄 Resuming graph execution from checkpoint (thread_id: ${turnId})`
      );
    } else {
      console.log(`   ▶️  Starting new graph execution (thread_id: ${turnId})`);
    }

    const result = await graph.invoke(graphState, graphConfig);

    // Update the persistent state
    // Note: Skill selection check is now handled inside the graph
    // If skill selection is required, the graph will mark the turn and end early
    // In that case, we should NOT update the game state
    const updatedTurn = dynamicTurnManager.getTurn(turnId);
    if (
      updatedTurn &&
      (updatedTurn.status === "requires_skill_selection" ||
        updatedTurn.status === "requires_combat_response")
    ) {
      console.log(
        `⏸️  [${new Date().toISOString()}] Turn ${turnId} requires ${updatedTurn.status} - game state not updated`
      );
      // Don't update game state, wait for player to select skill
      return;
    }

    if (result.dynamicGameState) {
      serverState.setGameState(userId, result.dynamicGameState);
    }

    const totals = getCurrentUsageTotals();
    if (totals && totals.total_tokens > 0) {
      console.log(
        `🧮 [Token Usage] Turn ${turnId} total: ${totals.total_tokens} (input ${totals.input_tokens}, output ${totals.output_tokens})`
      );
    }

    console.log(
      `[${new Date().toISOString()}] Turn ${turnId} completed successfully (DynamicWorld graph)`
    );
  } catch (error) {
    const totals = getCurrentUsageTotals();
    if (totals && totals.total_tokens > 0) {
      console.warn(
        `🧮 [Token Usage] Turn ${turnId} partial: ${totals.total_tokens} (input ${totals.input_tokens}, output ${totals.output_tokens})`
      );
    }
    console.error(
      `[${new Date().toISOString()}] Turn ${turnId} failed:`,
      error
    );
    throw error;
  }
}

/**
 * Get turn status and result
 * GET /api/turns/:turnId
 */
export async function getTurnStatus(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { turnId } = req.params;

    if (!(await isTurnOwnedByUser(turnId, req.user!.email))) {
      res.status(404).json({ error: "Turn not found" });
      return;
    }

    let turn: any = await getTurnById(turnId);

    const waitForCompletion = req.query.wait === "true";
    const maxWaitTime = 60000; // 60 seconds
    const checkInterval = 500; // 500ms
    const startTime = Date.now();

    // Long polling
    if (waitForCompletion) {
      while (Date.now() - startTime < maxWaitTime) {
        // Re-fetch turn to get latest status
        turn = await getTurnById(turnId);

        if (!turn) {
          res.status(404).json({ error: "Turn not found" });
          return;
        }

        if (
          turn.status === "completed" ||
          turn.status === "error" ||
          turn.status === "requires_skill_selection" ||
          turn.status === "requires_combat_response"
        ) {
          console.log(`[getTurnStatus] Turn ${turnId} completed:`, {
            status: turn.status,
            hasKeeperNarrative: !!turn.keeperNarrative,
            keeperNarrativeLength: turn.keeperNarrative?.length || 0,
            hasActionResults: !!turn.actionResults,
            actionResultsCount: Array.isArray(turn.actionResults)
              ? turn.actionResults.length
              : 0,
            requiresSkillSelection: turn.status === "requires_skill_selection",
            hasActionAnalysis: !!turn.actionAnalysis,
          });
          res.json({ success: true, turn: turn });
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, checkInterval));
      }
    }

    // Immediate return or timeout
    if (!turn) {
      res.status(404).json({ error: "Turn not found" });
      return;
    }

    console.log(`[getTurnStatus] Returning turn ${turnId}:`, {
      status: turn.status,
      hasKeeperNarrative: !!turn.keeperNarrative,
      keeperNarrativeLength: turn.keeperNarrative?.length || 0,
      hasActionResults: !!turn.actionResults,
      actionResultsCount: Array.isArray(turn.actionResults)
        ? turn.actionResults.length
        : 0,
    });

    res.json({ success: true, turn: turn });
  } catch (error) {
    console.error("Error fetching turn:", error);
    res.status(500).json({ error: "Failed to fetch turn" });
  }
}

/**
 * Get conversation history
 * GET /api/sessions/:sessionId/conversation
 */
export async function getConversation(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const db = DatabaseManager.getInstance().getDatabase();
    const turnManager = new DynamicTurnManager(db);

    const { sessionId } = req.params;
    const userId = req.user!.userId;
    const serverState = ServerState.getInstance();

    if (
      !(await isSessionOwnedByUser(
        sessionId,
        userId,
        req.user!.email,
        serverState
      ))
    ) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const limit = Number.parseInt(req.query.limit as string) || 50;
    await db.preloadSessionTurns(sessionId);

    const conversation = turnManager.getConversation(sessionId, limit);

    res.json({ success: true, conversation: conversation });
  } catch (error) {
    console.error("Error fetching conversation:", error);
    res.status(500).json({ error: "Failed to fetch conversation" });
  }
}

/**
 * Get turn history
 * GET /api/sessions/:sessionId/turns
 */
export async function getTurnHistory(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const db = DatabaseManager.getInstance().getDatabase();
    const turnManager = new DynamicTurnManager(db);

    const { sessionId } = req.params;
    const userId = req.user!.userId;
    const serverState = ServerState.getInstance();

    if (
      !(await isSessionOwnedByUser(
        sessionId,
        userId,
        req.user!.email,
        serverState
      ))
    ) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const limit = Number.parseInt(req.query.limit as string) || 20;
    const after = req.query.after
      ? Number.parseInt(req.query.after as string)
      : undefined;
    await db.preloadSessionTurns(sessionId);

    const turns = turnManager.getHistory(sessionId, limit, after);

    res.json({
      success: true,
      turns: turns,
      hasMore: turns.length === limit,
    });
  } catch (error) {
    console.error("Error fetching turns:", error);
    res.status(500).json({ error: "Failed to fetch turns" });
  }
}

/**
 * Get the latest session for the current user
 * GET /api/sessions/latest
 */
export async function getLatestSession(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const serverState = ServerState.getInstance();
    const activeState = serverState.getDynamicGameState(userId);

    if (activeState?.sessionId) {
      res.json({
        success: true,
        session: {
          sessionId: activeState.sessionId,
          characterId: activeState.playerCharacter?.id ?? null,
          characterName: activeState.playerCharacter?.name ?? null,
        },
      });
      return;
    }

    const prisma = getPrismaClient();
    const ownedCharacterIds = await getOwnedCharacterIds(req.user!.email);
    if (ownedCharacterIds.length === 0) {
      res.json({ success: true, session: null });
      return;
    }

    // Find the most recent turn for this user across all sessions
    const latestTurn = await prisma.gameTurn.findFirst({
      where: { characterId: { in: ownedCharacterIds } },
      orderBy: { createdAt: "desc" },
      select: {
        sessionId: true,
        characterId: true,
        characterName: true,
        createdAt: true,
      },
    });

    const row = latestTurn
      ? {
          sessionId: latestTurn.sessionId,
          characterId: latestTurn.characterId,
          characterName: latestTurn.characterName,
          lastTurnAt: latestTurn.createdAt.toISOString(),
        }
      : null;

    res.json({
      success: true,
      session: row,
    });
  } catch (error) {
    console.error("Error fetching latest session:", error);
    res.status(500).json({ error: "Failed to fetch latest session" });
  }
}

async function isTurnOwnedByUser(
  turnId: string,
  email: string
): Promise<boolean> {
  const prisma = getPrismaClient();
  const ownedCharacterIds = await getOwnedCharacterIds(email);
  if (ownedCharacterIds.length === 0) {
    return false;
  }

  const turn = await prisma.gameTurn.findFirst({
    where: { turnId, characterId: { in: ownedCharacterIds } },
    select: { turnId: true },
  });
  return Boolean(turn);
}

async function getTurnById(turnId: string): Promise<any | null> {
  const prisma = getPrismaClient();
  const turn = await prisma.gameTurn.findUnique({
    where: { turnId },
  });
  if (!turn) {
    return null;
  }

  return {
    turnId: turn.turnId,
    sessionId: turn.sessionId,
    turnNumber: turn.turnNumber,
    characterInput: turn.characterInput,
    characterId: turn.characterId,
    characterName: turn.characterName,
    actionAnalysis: turn.actionAnalysis,
    actionResults: turn.actionResults,
    directorDecision: turn.directorDecision,
    keeperNarrative: turn.keeperNarrative,
    clueRevelations: turn.clueRevelations,
    sceneId: turn.sceneId,
    sceneName: turn.sceneName,
    location: turn.location,
    status: turn.status,
    errorMessage: turn.errorMessage,
    startedAt: turn.startedAt.toISOString(),
    completedAt: turn.completedAt?.toISOString() ?? null,
    createdAt: turn.createdAt.toISOString(),
    isSimulated: turn.isSimulated,
    gameDay: turn.gameDay,
    gameTime: turn.gameTime,
  };
}

async function isSessionOwnedByUser(
  sessionId: string,
  userId: string,
  email: string,
  serverState: ServerState
): Promise<boolean> {
  const active = serverState.getDynamicGameState(userId);
  if (active?.sessionId === sessionId) {
    return true;
  }

  const prisma = getPrismaClient();
  const ownedCharacterIds = await getOwnedCharacterIds(email);
  if (ownedCharacterIds.length === 0) {
    return false;
  }

  const turn = await prisma.gameTurn.findFirst({
    where: { sessionId, characterId: { in: ownedCharacterIds } },
    select: { turnId: true },
  });
  return Boolean(turn);
}

async function getOwnedCharacterIds(email: string): Promise<string[]> {
  const prisma = getPrismaClient();
  const rows = await prisma.character.findMany({
    where: {
      emailId: email,
      isNpc: false,
    },
    select: { characterId: true },
  });
  return rows.map((row) => row.characterId);
}
