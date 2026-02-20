import { randomUUID } from "crypto";
/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";

/**
 * List memos for a session
 * GET /api/memos?sessionId=...
 */
export async function listMemos(req: Request, res: Response): Promise<void> {
  try {
    const sessionId =
      typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    const email = req.user!.email;

    if (!sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    const prisma = getPrismaClient();
    const memos = await prisma.playerMemo.findMany({
      where: { sessionId, emailId: email },
      orderBy: { createdAt: "asc" },
      select: {
        memoId: true,
        text: true,
        gameDay: true,
        gameTime: true,
        location: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({
      success: true,
      memos: memos.map((memo) => ({
        id: memo.memoId,
        text: memo.text,
        gameDay: memo.gameDay ?? null,
        gameTime: memo.gameTime ?? null,
        location: memo.location ?? null,
        createdAt: memo.createdAt,
        updatedAt: memo.updatedAt,
      })),
    });
  } catch (error) {
    console.error("Error listing memos:", error);
    res.status(500).json({ error: "Failed to fetch memos" });
  }
}

/**
 * Create memo
 * POST /api/memos
 */
export async function createMemo(req: Request, res: Response): Promise<void> {
  try {
    const { sessionId, text, gameDay, gameTime, location } = req.body ?? {};
    const email = req.user!.email;

    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    if (!text || typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const memoId = `memo-${randomUUID()}`;
    const prisma = getPrismaClient();
    const sessionScope = await prisma.session.findUnique({
      where: { sessionId },
      select: { moduleId: true },
    });

    const memo = await prisma.playerMemo.create({
      data: {
        memoId,
        sessionId,
        moduleId: sessionScope?.moduleId || null,
        emailId: email,
        text: text.trim(),
        gameDay: typeof gameDay === "number" ? gameDay : null,
        gameTime: typeof gameTime === "string" ? gameTime : null,
        location: typeof location === "string" ? location : null,
      },
    });

    res.json({
      success: true,
      memo: {
        id: memo.memoId,
        text: memo.text,
        gameDay: memo.gameDay ?? null,
        gameTime: memo.gameTime ?? null,
        location: memo.location ?? null,
        createdAt: memo.createdAt,
        updatedAt: memo.updatedAt,
      },
    });
  } catch (error) {
    console.error("Error creating memo:", error);
    res.status(500).json({ error: "Failed to create memo" });
  }
}

/**
 * Update memo
 * PUT /api/memos/:memoId
 */
export async function updateMemo(req: Request, res: Response): Promise<void> {
  try {
    const { memoId } = req.params;
    const { text } = req.body ?? {};
    const email = req.user!.email;

    if (!memoId) {
      res.status(400).json({ error: "memoId is required" });
      return;
    }

    if (typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const prisma = getPrismaClient();
    const existing = await prisma.playerMemo.findFirst({
      where: { memoId, emailId: email },
    });

    if (!existing) {
      res.status(404).json({ error: "Memo not found" });
      return;
    }

    await prisma.playerMemo.update({
      where: { memoId },
      data: { text: text.trim(), updatedAt: new Date() },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error updating memo:", error);
    res.status(500).json({ error: "Failed to update memo" });
  }
}

/**
 * Delete memo
 * DELETE /api/memos/:memoId
 */
export async function deleteMemo(req: Request, res: Response): Promise<void> {
  try {
    const { memoId } = req.params;
    const email = req.user!.email;

    if (!memoId) {
      res.status(400).json({ error: "memoId is required" });
      return;
    }

    const prisma = getPrismaClient();
    const existing = await prisma.playerMemo.findFirst({
      where: { memoId, emailId: email },
    });

    if (!existing) {
      res.status(404).json({ error: "Memo not found" });
      return;
    }

    await prisma.playerMemo.delete({ where: { memoId } });

    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting memo:", error);
    res.status(500).json({ error: "Failed to delete memo" });
  }
}
