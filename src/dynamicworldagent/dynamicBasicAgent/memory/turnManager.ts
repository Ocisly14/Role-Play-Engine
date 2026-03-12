/**
 * Turn Manager - Manages game turn records for character-keeper interactions
 *
 * This module provides a high-level interface for managing game turns,
 * which record each complete interaction cycle from character input to keeper narrative.
 */

import { randomUUID } from "crypto";
import { GameHistoryRag } from "../../../rag/gameHistoryRag.js";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../../shared/agents/memory/database/index.js";
import type { ActionLogEntry } from "../../../shared/agents/models/gameTypes.js";
import {
  buildDiceRollInfos,
  type DiceRollInfo,
} from "../../../shared/state/index.js";
import type { DynamicGameState } from "../../state/index.js";

export interface TurnInput {
  sessionId: string;
  characterInput: string;
  characterId?: string;
  characterName?: string;
  sceneRoomId?: string;
  sceneId?: string;
  sceneName?: string;
  location?: string;
  gameDay?: number | null;
  gameTime?: string | null;
}

export interface TurnProcessing {
  characterActions?: import("../../dynamicBasicAgent/npcPlanning/types.js").CharacterAction[];
}

export interface TurnOutput {
  keeperNarrative: string;
  gameDay?: number | null;
  gameTime?: string | null;
}

export interface GameTurn {
  turnId: string;
  sessionId: string;
  turnNumber: number;

  // Input
  characterInput: string;
  characterId: string | null;
  characterName: string | null;
  sceneRoomId?: string | null;

  // Processing
  characterActions: any[] | null;

  // Output
  keeperNarrative: string | null;

  // Context
  sceneId: string | null;
  sceneName: string | null;
  location: string | null;

  // Status
  status:
    | "processing"
    | "completed"
    | "error"
    | "requires_skill_selection";
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;

  // Game time when turn completed
  gameDay?: number | null;
  gameTime?: string | null;
}

export class TurnManager {
  private db: CoCDatabase | CoCDatabaseAdapter;
  private ragManager: GameHistoryRag;

  constructor(db: CoCDatabase | CoCDatabaseAdapter) {
    this.db = db;
    this.ragManager = new GameHistoryRag(db);
  }

  /**
   * Create a new turn when character sends input
   */
  async createTurn(input: TurnInput): Promise<string> {
    const turnId = `turn-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const turnNumber = this.db.getNextTurnNumber(input.sessionId);

    await this.db.createTurn(
      turnId,
      input.sessionId,
      turnNumber,
      input.characterInput,
      input.characterId,
      input.characterName,
      input.sceneId,
      input.sceneName,
      input.location,
      input.gameDay,
      input.gameTime,
      input.sceneRoomId
    );

    console.log(`✓ Turn created: ${turnId} (Turn #${turnNumber})`);
    return turnId;
  }

  /**
   * Create turn from current game state
   */
  async createTurnFromGameState(
    sessionId: string,
    characterInput: string,
    gameState: DynamicGameState
  ): Promise<string> {
    return this.createTurn({
      sessionId,
      characterInput,
      characterId: gameState.playerCharacter?.id,
      characterName: gameState.playerCharacter?.name,
      sceneId: gameState.currentSceneId ?? undefined,
      sceneName: gameState.scenes.get(gameState.currentSceneId ?? "")?.name,
      location: gameState.scenes.get(gameState.currentSceneId ?? "")?.name,
      gameDay: gameState.gameDay ?? null,
      gameTime: gameState.timeOfDay ?? null,
    });
  }

  /**
   * Update turn with processing results from agents
   */
  updateProcessing(turnId: string, processing: TurnProcessing): void {
    this.db.updateTurnProcessing(
      turnId,
      null, // actionAnalysis (legacy, no longer used)
      (processing.characterActions as any[] | undefined) ?? undefined
    );
  }

  /**
   * Update in-progress turn with latest narrative text (without completing turn)
   */
  updateNarrative(turnId: string, keeperNarrative: string): void {
    const current = this.getTurn(turnId);
    const mergedNarrative = this.mergeNarrative(
      current?.keeperNarrative,
      keeperNarrative
    );
    this.db.updateTurnNarrative(turnId, mergedNarrative);
  }

  /**
   * Update turn with processing results from game state
   */
  updateProcessingFromGameState(
    turnId: string,
    gameState: DynamicGameState
  ): void {
    this.updateProcessing(turnId, {
      characterActions: gameState.temporaryInfo.characterActions,
    });
  }

  /**
   * Complete a turn with Keeper's narrative
   */
  completeTurn(
    turnId: string,
    output: TurnOutput,
    language?: "en" | "zh"
  ): void {
    const current = this.getTurn(turnId);
    const mergedNarrative = this.mergeNarrative(
      current?.keeperNarrative,
      output.keeperNarrative
    );

    this.db.completeTurn(
      turnId,
      mergedNarrative,
      output.gameDay,
      output.gameTime
    );

    console.log(`✓ Turn completed: ${turnId}`);

    // Trigger embedding asynchronously (non-blocking)
    this.embedTurnAsync(turnId, mergedNarrative, language).catch(
      (error) => {
        console.error(`[TurnManager] Failed to embed turn ${turnId}:`, error);
      }
    );
  }

  private mergeNarrative(
    existing: string | null | undefined,
    incoming: string | null | undefined
  ): string {
    const currentText =
      typeof existing === "string" ? existing.trim() : "";
    const incomingText =
      typeof incoming === "string" ? incoming.trim() : "";

    if (!incomingText) return currentText;
    if (!currentText) return incomingText;

    if (currentText === incomingText) return currentText;
    if (currentText.endsWith(incomingText)) return currentText;
    if (incomingText.includes(currentText)) return incomingText;

    return `${currentText}\n\n${incomingText}`;
  }

  /**
   * Embed turn data for RAG retrieval (async, non-blocking)
   * Embeds action logs and turn (user input + narrative) pair
   */
  private async embedTurnAsync(
    turnId: string,
    narrative: string,
    language?: "en" | "zh"
  ): Promise<void> {
    try {
      // Get turn data from database
      const turn = this.getTurn(turnId);
      if (!turn) {
        console.warn(`[TurnManager] Turn ${turnId} not found for embedding`);
        return;
      }

      const userInput = turn.characterInput;
      const sessionId = turn.sessionId;
      const effectiveLanguage = language || "zh";

      // Embed turn (user input + narrative) with correct language model
      await this.ragManager.embedTurn(
        sessionId,
        turnId,
        userInput,
        narrative,
        undefined, // emailId
        effectiveLanguage
      );

      // Embed action logs from characterActions if available
      if (turn.characterActions && Array.isArray(turn.characterActions)) {
        for (const charAction of turn.characterActions) {
          const actionLog: ActionLogEntry = {
            time: charAction.gameTime || turn.gameTime || "",
            location: charAction.location || turn.location || "",
            character: charAction.characterName || turn.characterName || undefined,
            summary: charAction.outcome || charAction.action || "",
            successLevel: charAction.status === "completed" ? "regular" : "failure",
          };

          await this.ragManager.embedActionLog(
            sessionId,
            turnId,
            actionLog,
            undefined, // emailId
            effectiveLanguage
          );
        }
      }

      console.log(
        `✓ Turn ${turnId} embedded for RAG retrieval (language: ${effectiveLanguage})`
      );
    } catch (error) {
      console.error(`[TurnManager] Error embedding turn ${turnId}:`, error);
      throw error;
    }
  }

  /**
   * Mark a turn as error
   */
  markError(turnId: string, error: Error | string): void {
    const errorMessage = error instanceof Error ? error.message : error;
    this.db.markTurnError(turnId, errorMessage);

    console.error(`✗ Turn error: ${turnId} - ${errorMessage}`);
  }

  /**
   * Mark turn as requiring skill selection
   */
  markRequiresSkillSelection(turnId: string, actionAnalysis: any): void {
    this.db.markTurnRequiresSkillSelection(turnId, actionAnalysis);
    console.log(`⚠️  Turn ${turnId} marked as requiring skill selection`);
  }

  /**
   * Get a turn by ID
   */
  getTurn(turnId: string): GameTurn | null {
    return this.db.getTurn(turnId) as GameTurn | null;
  }

  /**
   * Get turn history for a session
   */
  getHistory(
    sessionId: string,
    limit = 50,
    afterTurnNumber?: number
  ): GameTurn[] {
    return this.db.getTurnHistory(
      sessionId,
      limit,
      afterTurnNumber
    ) as GameTurn[];
  }

  /**
   * Get the latest turn for a session
   */
  getLatest(sessionId: string): GameTurn | null {
    return this.db.getLatestTurn(sessionId) as GameTurn | null;
  }

  /**
   * Get pending (processing) turns for a session
   */
  getPending(sessionId: string): GameTurn[] {
    return this.db.getPendingTurns(sessionId) as GameTurn[];
  }

  /**
   * Get next turn number for a session
   */
  getNextTurnNumber(sessionId: string): number {
    return this.db.getNextTurnNumber(sessionId);
  }

  /**
   * Print turn history (for CLI/debugging)
   */
  printHistory(sessionId: string, limit = 10): void {
    const turns = this.getHistory(sessionId, limit);

    if (turns.length === 0) {
      console.log("No turn history found.");
      return;
    }

    console.log("\n=== Turn History ===\n");

    turns.reverse().forEach((turn) => {
      const statusIcon =
        turn.status === "completed"
          ? "✓"
          : turn.status === "error"
            ? "✗"
            : "⏳";

      console.log(`${statusIcon} Turn #${turn.turnNumber} (${turn.turnId})`);
      console.log(
        `   Input: ${turn.characterInput.slice(0, 60)}${turn.characterInput.length > 60 ? "..." : ""}`
      );

      if (turn.keeperNarrative) {
        console.log(
          `   Narrative: ${turn.keeperNarrative.slice(0, 60)}${turn.keeperNarrative.length > 60 ? "..." : ""}`
        );
      }

      if (turn.status === "error" && turn.errorMessage) {
        console.log(`   Error: ${turn.errorMessage}`);
      }

      console.log(
        `   Time: ${turn.startedAt} → ${turn.completedAt || "processing..."}`
      );
      console.log();
    });
  }

  /**
   * Get conversation format (for display in frontend)
   */
  private normalizeName(name?: string | null): string | null {
    if (!name || typeof name !== "string") return null;
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed.toLowerCase() : null;
  }

  private isOpposedRoll(roll?: string | null): boolean {
    if (!roll || typeof roll !== "string") return false;
    return /\b1d100_opposed\[\d+\]\s*:/i.test(roll);
  }

  getConversation(
    sessionId: string,
    limit = 50
  ): Array<{
    role: "character" | "keeper";
    content: string;
    timestamp: string;
    turnNumber: number;
    diceRolls?: DiceRollInfo[];
    gameDay?: number | null;
    gameTime?: string | null;
  }> {
    const turns = this.getHistory(sessionId, limit);
    const conversation: Array<{
      role: "character" | "keeper";
      content: string;
      timestamp: string;
      turnNumber: number;
      diceRolls?: DiceRollInfo[];
      gameDay?: number | null;
      gameTime?: string | null;
    }> = [];

    turns.reverse().forEach((turn) => {
      // Extract dice rolls from legacy actionResults if available (backward compatibility)
      // CharacterAction[] (new format) does not carry dice roll data
      const diceRolls: DiceRollInfo[] = [];
      const playerNameNormalized = this.normalizeName(turn.characterName);
      const legacyActionResults = (turn as any).actionResults;
      if (legacyActionResults && Array.isArray(legacyActionResults)) {
        const legacyActionAnalysis = (turn as any).actionAnalysis;
        const opposedRollTarget =
          legacyActionAnalysis &&
          typeof legacyActionAnalysis === "object" &&
          legacyActionAnalysis.target &&
          typeof legacyActionAnalysis.target === "object" &&
          typeof legacyActionAnalysis.target.name === "string"
            ? legacyActionAnalysis.target.name
            : null;

        const allDiceRollInfos = buildDiceRollInfos(legacyActionResults, {
          opposedRollCharacter: opposedRollTarget,
        });

        for (const roll of allDiceRollInfos) {
          if (!playerNameNormalized) {
            diceRolls.push(roll);
            continue;
          }

          const rollNameNormalized = this.normalizeName(roll.character);
          const isPlayerRoll =
            !!rollNameNormalized && rollNameNormalized === playerNameNormalized;
          if (isPlayerRoll || this.isOpposedRoll(roll.roll)) {
            diceRolls.push(roll);
          }
        }
      }

      // For introduction turn (turnNumber 0 with empty characterInput), only add keeper narrative
      if (turn.turnNumber === 0 && !turn.characterInput) {
        if (turn.status === "completed" && turn.keeperNarrative) {
          const keeperMessage: any = {
            role: "keeper",
            content: turn.keeperNarrative,
            timestamp: turn.completedAt || turn.startedAt,
            turnNumber: turn.turnNumber,
            gameDay: turn.gameDay ?? null,
            gameTime: turn.gameTime ?? null,
          };
          if (diceRolls.length > 0) {
            keeperMessage.diceRolls = diceRolls;
          }
          conversation.push(keeperMessage);
        }
      } else {
        // For normal turns, add character input and keeper narrative
        if (turn.characterInput) {
          conversation.push({
            role: "character",
            content: turn.characterInput,
            timestamp: turn.startedAt,
            turnNumber: turn.turnNumber,
            gameDay: turn.gameDay ?? null,
            gameTime: turn.gameTime ?? null,
          });
        }

        // Add keeper narrative if completed
        if (turn.status === "completed" && turn.keeperNarrative) {
          const keeperMessage: any = {
            role: "keeper",
            content: turn.keeperNarrative,
            timestamp: turn.completedAt || turn.startedAt,
            turnNumber: turn.turnNumber,
            gameDay: turn.gameDay ?? null,
            gameTime: turn.gameTime ?? null,
          };
          if (diceRolls.length > 0) {
            keeperMessage.diceRolls = diceRolls;
          }
          conversation.push(keeperMessage);
        }
      }
    });

    return conversation;
  }
}
