import type { DynamicGameState } from "../../state/index.js";
import type { GameTurn } from "../memory/turnManager.js";
import {
  type SessionRagChunkInput,
  SessionRagService,
} from "./sessionRagService.js";
import { chunkText } from "./textChunker.js";

const CHUNK_MAX_TOKENS = 300;
const CHUNK_OVERLAP_TOKENS = 60;

function formatActionLogs(actionResults: any[] | null | undefined): string {
  if (!Array.isArray(actionResults) || actionResults.length === 0) {
    return "(none)";
  }

  const lines: string[] = [];
  const capped = actionResults.slice(0, 12);

  for (const [index, result] of capped.entries()) {
    const character =
      typeof result?.character === "string" ? result.character : "Unknown";
    const location =
      typeof result?.location === "string" ? result.location : "Unknown";
    const time = typeof result?.gameTime === "string" ? result.gameTime : "";
    const summary = typeof result?.result === "string" ? result.result : "";
    const cleanedSummary = summary.trim().replace(/\s+/g, " ");
    const summaryText =
      cleanedSummary.length > 240
        ? `${cleanedSummary.slice(0, 240)}...`
        : cleanedSummary;

    lines.push(
      `${index + 1}. [${character}]${time ? ` (${time})` : ""} @ ${location} -> ${summaryText || "(no summary)"}`
    );
  }

  if (actionResults.length > capped.length) {
    lines.push(
      `... (${actionResults.length - capped.length} more action logs omitted)`
    );
  }

  return lines.join("\n");
}

function buildNarrativeText(turn: GameTurn): string {
  const playerInput = (turn.characterInput || "").trim();
  const narrative = (turn.keeperNarrative || "").trim();
  const timeParts = [
    turn.gameDay != null ? `Day ${turn.gameDay}` : null,
    turn.gameTime || null,
  ].filter(Boolean);
  const timeStr = timeParts.length > 0 ? ` (${timeParts.join(" ")})` : "";
  return [
    `Turn #${turn.turnNumber}${timeStr}`,
    `Player: ${playerInput || "(empty)"}`,
    `Keeper: ${narrative || "(empty)"}`,
  ].join("\n");
}

function buildActionLogText(turn: GameTurn): string {
  return [
    `Turn #${turn.turnNumber} Action Logs`,
    formatActionLogs((turn as any).characterActions ?? (turn as any).actionResults),
  ].join("\n");
}

export class TurnRagAgent {
  private ragService: SessionRagService;

  constructor(ragService?: SessionRagService) {
    this.ragService = ragService || new SessionRagService();
  }

  async recordTurn(params: {
    turn: GameTurn;
    dynamicGameState: DynamicGameState;
    language?: "en" | "zh";
  }): Promise<void> {
    const { turn } = params;
    const language = params.language === "en" ? "en" : "zh";

    if (!turn?.sessionId || !turn?.turnId) {
      return;
    }

    const chunks: SessionRagChunkInput[] = [];
    const meta = {
      sceneName: turn.sceneName || null,
      location: turn.location || null,
      gameDay: turn.gameDay ?? null,
      gameTime: turn.gameTime ?? null,
    };

    // input + narrative chunks
    const narrativeSegments = chunkText(
      buildNarrativeText(turn),
      CHUNK_MAX_TOKENS,
      CHUNK_OVERLAP_TOKENS
    );
    for (const [i, segment] of narrativeSegments.entries()) {
      chunks.push({
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        turnNumber: turn.turnNumber,
        chunkType: "turn",
        sceneRoomId: turn.sceneRoomId ?? null,
        role: "system",
        content: segment,
        metadata: { ...meta, segmentType: "narrative", segmentIndex: i },
        sourceKey: `turn:${turn.turnId}:narrative:${i}`,
        language,
      });
    }

    // action log chunks
    const actionLogText = buildActionLogText(turn);
    if (actionLogText.trim()) {
      const actionSegments = chunkText(
        actionLogText,
        CHUNK_MAX_TOKENS,
        CHUNK_OVERLAP_TOKENS
      );
      for (const [i, segment] of actionSegments.entries()) {
        chunks.push({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          turnNumber: turn.turnNumber,
          chunkType: "turn",
          sceneRoomId: turn.sceneRoomId ?? null,
          role: "system",
          content: segment,
          metadata: { ...meta, segmentType: "actionlog", segmentIndex: i },
          sourceKey: `turn:${turn.turnId}:actionlog:${i}`,
          language,
        });
      }
    }

    await this.ragService.upsertChunks(chunks);
  }
}
