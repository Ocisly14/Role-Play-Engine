/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { DatabaseManager } from "../core/DatabaseManager.js";

/**
 * List memos for a session
 * GET /api/memos?sessionId=...
 */
export function listMemos(req: Request, res: Response): void {
  try {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    const userId = req.user!.userId;

    if (!sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();

    const memos = database.prepare(`
      SELECT memo_id, text, game_day, game_time, location, created_at, updated_at
      FROM player_memos
      WHERE session_id = ? AND user_id = ?
      ORDER BY created_at ASC
    `).all(sessionId, userId);

    res.json({
      success: true,
      memos: memos.map((memo: any) => ({
        id: memo.memo_id,
        text: memo.text,
        gameDay: memo.game_day ?? null,
        gameTime: memo.game_time ?? null,
        location: memo.location ?? null,
        createdAt: memo.created_at,
        updatedAt: memo.updated_at,
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
export function createMemo(req: Request, res: Response): void {
  try {
    const { sessionId, text, gameDay, gameTime, location } = req.body ?? {};
    const userId = req.user!.userId;

    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    if (!text || typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const memoId = `memo-${randomUUID()}`;
    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();

    database.prepare(`
      INSERT INTO player_memos (memo_id, session_id, user_id, text, game_day, game_time, location)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      memoId,
      sessionId,
      userId,
      text.trim(),
      typeof gameDay === "number" ? gameDay : null,
      typeof gameTime === "string" ? gameTime : null,
      typeof location === "string" ? location : null
    );

    const memo = database.prepare(`
      SELECT memo_id, text, game_day, game_time, location, created_at, updated_at
      FROM player_memos
      WHERE memo_id = ? AND user_id = ?
    `).get(memoId, userId) as any;

    res.json({
      success: true,
      memo: {
        id: memo.memo_id,
        text: memo.text,
        gameDay: memo.game_day ?? null,
        gameTime: memo.game_time ?? null,
        location: memo.location ?? null,
        createdAt: memo.created_at,
        updatedAt: memo.updated_at,
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
export function updateMemo(req: Request, res: Response): void {
  try {
    const { memoId } = req.params;
    const { text } = req.body ?? {};
    const userId = req.user!.userId;

    if (!memoId) {
      res.status(400).json({ error: "memoId is required" });
      return;
    }

    if (typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();

    const result = database.prepare(`
      UPDATE player_memos
      SET text = ?, updated_at = CURRENT_TIMESTAMP
      WHERE memo_id = ? AND user_id = ?
    `).run(text.trim(), memoId, userId);

    if (result.changes === 0) {
      res.status(404).json({ error: "Memo not found" });
      return;
    }

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
export function deleteMemo(req: Request, res: Response): void {
  try {
    const { memoId } = req.params;
    const userId = req.user!.userId;

    if (!memoId) {
      res.status(400).json({ error: "memoId is required" });
      return;
    }

    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();

    const result = database.prepare(`
      DELETE FROM player_memos
      WHERE memo_id = ? AND user_id = ?
    `).run(memoId, userId);

    if (result.changes === 0) {
      res.status(404).json({ error: "Memo not found" });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting memo:", error);
    res.status(500).json({ error: "Failed to delete memo" });
  }
}
