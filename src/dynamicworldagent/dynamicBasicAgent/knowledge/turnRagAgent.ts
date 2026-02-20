import { createHash } from "crypto";
import type { DynamicGameState } from "../../state/index.js";
import type { GameTurn } from "../memory/turnManager.js";
import {
  SessionRagService,
  type SessionRagChunkInput,
} from "./sessionRagService.js";
import { chunkText } from "./textChunker.js";

const CHUNK_MAX_TOKENS = 300;
const CHUNK_OVERLAP_TOKENS = 60;

type ClueChunkDraft = {
  sourceName: string;
  clueType: "scenario" | "npc" | "secret";
  text: string;
  method?: string;
  discoveredAt?: string;
};

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function hasRevealUpdates(clueRevelations: any): boolean {
  if (!clueRevelations || typeof clueRevelations !== "object") return false;
  return (
    Array.isArray(clueRevelations.scenarioClues) && clueRevelations.scenarioClues.length > 0
  ) || (
    Array.isArray(clueRevelations.npcClues) && clueRevelations.npcClues.length > 0
  ) || (
    Array.isArray(clueRevelations.npcSecrets) && clueRevelations.npcSecrets.length > 0
  );
}

function formatActionLogs(actionResults: any[] | null | undefined): string {
  if (!Array.isArray(actionResults) || actionResults.length === 0) {
    return "(none)";
  }

  const lines: string[] = [];
  const capped = actionResults.slice(0, 12);

  for (const [index, result] of capped.entries()) {
    const character = typeof result?.character === "string" ? result.character : "Unknown";
    const location = typeof result?.location === "string" ? result.location : "Unknown";
    const time = typeof result?.gameTime === "string" ? result.gameTime : "";
    const summary = typeof result?.result === "string" ? result.result : "";
    const cleanedSummary = summary.trim().replace(/\s+/g, " ");
    const summaryText = cleanedSummary.length > 240
      ? `${cleanedSummary.slice(0, 240)}...`
      : cleanedSummary;

    lines.push(
      `${index + 1}. [${character}]${time ? ` (${time})` : ""} @ ${location} -> ${summaryText || "(no summary)"}`
    );
  }

  if (actionResults.length > capped.length) {
    lines.push(`... (${actionResults.length - capped.length} more action logs omitted)`);
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
    formatActionLogs(turn.actionResults),
  ].join("\n");
}

function collectClueChunkDrafts(
  turn: GameTurn,
  dynamicGameState: DynamicGameState
): ClueChunkDraft[] {
  const clueRevelations = turn.clueRevelations;
  if (!hasRevealUpdates(clueRevelations)) {
    return [];
  }

  const drafts: ClueChunkDraft[] = [];
  const dedupe = new Set<string>();

  const pushDraft = (draft: ClueChunkDraft) => {
    const normalizedText = draft.text?.trim();
    if (!normalizedText) return;

    const dedupeKey = `${draft.clueType}|${draft.sourceName}|${normalizedText}`;
    if (dedupe.has(dedupeKey)) return;
    dedupe.add(dedupeKey);

    drafts.push({
      ...draft,
      text: normalizedText,
    });
  };

  const scenarioClues = Array.isArray(clueRevelations?.scenarioClues)
    ? clueRevelations.scenarioClues
    : [];
  for (const item of scenarioClues) {
    const clueId = typeof item === "string" ? item : item?.clueId;
    if (!clueId) continue;

    const clue = dynamicGameState.currentScenario?.clues?.find((c) => c.id === clueId);
    pushDraft({
      sourceName: dynamicGameState.currentScenario?.name || "Unknown Scenario",
      clueType: "scenario",
      text: clue?.clueText || `Scenario clue ${clueId}`,
      method: clue?.discoveryDetails?.method || "Keeper revelation",
      discoveredAt: clue?.discoveryDetails?.discoveredAt,
    });
  }

  const npcClues = Array.isArray(clueRevelations?.npcClues)
    ? clueRevelations.npcClues
    : [];
  for (const item of npcClues) {
    const npcId = item?.npcId;
    const clueId = item?.clueId;
    if (!npcId || !clueId) continue;

    const npc = dynamicGameState.npcCharacters.find((n) => n.id === npcId);
    const clue = npc?.clues?.find((c) => c.id === clueId);

    pushDraft({
      sourceName: npc?.name || "Unknown NPC",
      clueType: "npc",
      text: clue?.clueText || `NPC clue ${clueId}`,
      method: "Social interaction",
      discoveredAt: new Date().toISOString(),
    });
  }

  const npcSecrets = Array.isArray(clueRevelations?.npcSecrets)
    ? clueRevelations.npcSecrets
    : [];
  for (const item of npcSecrets) {
    const npcId = item?.npcId;
    const secretIndex = typeof item?.secretIndex === "number" ? item.secretIndex : -1;
    if (!npcId || secretIndex < 0) continue;

    const npc = dynamicGameState.npcCharacters.find((n) => n.id === npcId);
    const secret = npc?.secrets?.[secretIndex];
    if (!secret || typeof secret !== "string") continue;

    pushDraft({
      sourceName: npc?.name || "Unknown NPC",
      clueType: "secret",
      text: secret,
      method: "Secret revelation",
      discoveredAt: new Date().toISOString(),
    });
  }

  return drafts;
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
    const { turn, dynamicGameState } = params;
    const language = params.language === "en" ? "en" : "zh";

    if (!turn?.sessionId || !turn?.turnId) {
      return;
    }

    // Hard requirement: only record real player turns.
    if (turn.isSimulated) {
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
          role: "system",
          content: segment,
          metadata: { ...meta, segmentType: "actionlog", segmentIndex: i },
          sourceKey: `turn:${turn.turnId}:actionlog:${i}`,
          language,
        });
      }
    }

    const clueDrafts = collectClueChunkDrafts(turn, dynamicGameState);
    for (const draft of clueDrafts) {
      const sourceKey = `clue:${shortHash(`${draft.clueType}|${draft.sourceName}|${draft.text}`)}`;
      chunks.push({
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        turnNumber: turn.turnNumber,
        chunkType: "clue",
        role: "system",
        content: [
          `Reveal Clue`,
          `Type: ${draft.clueType}`,
          `Source: ${draft.sourceName}`,
          `Method: ${draft.method || "unknown"}`,
          `Content: ${draft.text}`,
        ].join("\n"),
        metadata: {
          clueType: draft.clueType,
          sourceName: draft.sourceName,
          method: draft.method || null,
          discoveredAt: draft.discoveredAt || new Date().toISOString(),
        },
        sourceKey,
        language,
      });
    }

    await this.ragService.upsertChunks(chunks);
  }
}
