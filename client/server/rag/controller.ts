/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { ServerState } from "../core/ServerState.js";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import {
  SessionRagQaService,
  type RecentTurn,
} from "../../../src/dynamicworldagent/dynamicBasicAgent/knowledge/sessionRagQaService.js";

const qaService = new SessionRagQaService();

/**
 * Ask question against session RAG memory.
 * POST /api/rag/ask
 */
export async function askRag(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const email = req.user!.email;
    const {
      sessionId,
      question,
      topK: rawTopK,
      language: rawLanguage,
    } = req.body ?? {};

    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ success: false, error: "sessionId is required" });
      return;
    }

    if (!question || typeof question !== "string" || !question.trim()) {
      res.status(400).json({ success: false, error: "question is required" });
      return;
    }

    const topK =
      typeof rawTopK === "number" && Number.isFinite(rawTopK)
        ? Math.max(1, Math.min(20, Math.floor(rawTopK)))
        : 8;

    const language = rawLanguage === "en" ? "en" : "zh";

    const allowed = await isSessionOwnedByUser(sessionId, userId, email);
    if (!allowed) {
      res.status(404).json({ success: false, error: "Session not found" });
      return;
    }

    const serverState = ServerState.getInstance();
    const dynamicState = serverState.getDynamicGameStateBySession(sessionId);

    const sceneName = dynamicState?.currentScenario?.name || null;
    const sceneLocation = dynamicState?.currentScenario?.location || null;
    const npcNames = Array.from(
      new Set(
        (dynamicState?.npcCharacters || [])
          .map((npc) => npc?.name)
          .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      )
    ).slice(0, 30);
    const allScenes = (dynamicState?.scenarioOutlines || [])
      .filter((s) => s?.name && s?.description)
      .map((s) => ({ name: s.name, description: s.description }))
      .slice(0, 50);

    // Fetch last 5 turns for recent context
    let recentTurns: RecentTurn[] = [];
    try {
      const prisma = getPrismaClient();
      const rows = await prisma.gameTurn.findMany({
        where: { sessionId, status: "completed" },
        orderBy: { turnNumber: "desc" },
        take: 5,
        select: {
          turnNumber: true,
          characterInput: true,
          keeperNarrative: true,
        },
      });
      recentTurns = rows
        .reverse()
        .filter((r) => r.characterInput && r.keeperNarrative)
        .map((r) => ({
          turnNumber: r.turnNumber,
          playerInput: r.characterInput!,
          keeperNarrative: r.keeperNarrative!,
        }));
    } catch (err) {
      console.warn("[RAG] Failed to fetch recent turns:", err);
    }

    const result = await qaService.ask({
      sessionId,
      question: question.trim(),
      topK,
      language,
      sceneName,
      sceneLocation,
      npcNames,
      recentTurns,
      allScenes,
    });

    res.json({
      success: true,
      answer: result.answer,
      citations: result.citations,
      retrievedCount: result.retrievedCount,
      ragQuery: result.ragQuery,
      rewrite: result.rewrite,
    });
  } catch (error) {
    console.error("Error in RAG ask endpoint:", error);
    res.status(500).json({ success: false, error: "Failed to answer question" });
  }
}

async function isSessionOwnedByUser(
  sessionId: string,
  userId: string,
  email: string
): Promise<boolean> {
  const serverState = ServerState.getInstance();
  const active = serverState.getDynamicGameState(userId);
  if (active?.sessionId === sessionId) {
    return true;
  }

  const prisma = getPrismaClient();

  const ownedSession = await prisma.session.findFirst({
    where: { sessionId, emailId: email },
    select: { sessionId: true },
  });
  if (ownedSession) {
    return true;
  }

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
