/**
 * Turn Manager - Manages game turn records for character-keeper interactions
 * 
 * This module provides a high-level interface for managing game turns,
 * which record each complete interaction cycle from character input to keeper narrative.
 */

import type { CoCDatabase } from "../../../shared/agents/memory/database/index.js";
import type { DynamicGameState } from "../../state/index.js";
import { randomUUID } from "crypto";
import { GameHistoryRag } from "../../../rag/gameHistoryRag.js";
import type { ActionLogEntry } from "../../../shared/agents/models/gameTypes.js";

export interface TurnInput {
  sessionId: string;
  characterInput: string;
  characterId?: string;
  characterName?: string;
  sceneId?: string;
  sceneName?: string;
  location?: string;
  isSimulated?: boolean;
  gameDay?: number | null;
  gameTime?: string | null;
}

export interface TurnProcessing {
  actionAnalysis?: any;
  actionResults?: any[];
}

export interface TurnOutput {
  keeperNarrative: string;
  clueRevelations?: any;
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
  
  // Processing
  actionAnalysis: any | null;
  actionResults: any[] | null;
  
  // Output
  keeperNarrative: string | null;
  clueRevelations: any | null;
  
  // Context
  sceneId: string | null;
  sceneName: string | null;
  location: string | null;
  
  // Status
  status: 'processing' | 'completed' | 'error';
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  
  // Simulation flag
  isSimulated?: boolean;
  
  // Game time when turn completed
  gameDay?: number | null;
  gameTime?: string | null;
}

export class TurnManager {
  private db: CoCDatabase;
  private ragManager: GameHistoryRag;

  constructor(db: CoCDatabase) {
    this.db = db;
    this.ragManager = new GameHistoryRag(db);
  }

  /**
   * Create a new turn when character sends input
   */
  createTurn(input: TurnInput): string {
    const turnId = `turn-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const turnNumber = this.db.getNextTurnNumber(input.sessionId);

    this.db.createTurn(
      turnId,
      input.sessionId,
      turnNumber,
      input.characterInput,
      input.characterId,
      input.characterName,
      input.sceneId,
      input.sceneName,
      input.location,
      input.isSimulated,
      input.gameDay,
      input.gameTime
    );

    const turnType = input.isSimulated ? 'simulated' : 'user';
    console.log(`✓ Turn created: ${turnId} (Turn #${turnNumber}, ${turnType})`);
    return turnId;
  }

  /**
   * Create turn from current game state
   */
  createTurnFromGameState(
    sessionId: string,
    characterInput: string,
    gameState: DynamicGameState,
    isSimulated?: boolean
  ): string {
    return this.createTurn({
      sessionId,
      characterInput,
      characterId: gameState.playerCharacter.id,
      characterName: gameState.playerCharacter.name,
      sceneId: gameState.currentScenario?.id,
      sceneName: gameState.currentScenario?.name,
      location: gameState.currentScenario?.location,
      isSimulated,
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
      processing.actionAnalysis,
      processing.actionResults
    );
  }

  /**
   * Update turn with processing results from game state
   */
  updateProcessingFromGameState(turnId: string, gameState: DynamicGameState): void {
    this.updateProcessing(turnId, {
      actionAnalysis: gameState.temporaryInfo.currentActionAnalysis,
      actionResults: gameState.temporaryInfo.actionResults,
    });
  }

  /**
   * Complete a turn with Keeper's narrative
   */
  completeTurn(turnId: string, output: TurnOutput, language?: 'en' | 'zh'): void {
    this.db.completeTurn(
      turnId,
      output.keeperNarrative,
      output.clueRevelations,
      output.gameDay,
      output.gameTime
    );

    console.log(`✓ Turn completed: ${turnId}`);

    // Trigger embedding asynchronously (non-blocking)
    this.embedTurnAsync(turnId, output.keeperNarrative, language).catch((error) => {
      console.error(`[TurnManager] Failed to embed turn ${turnId}:`, error);
    });
  }

  /**
   * Embed turn data for RAG retrieval (async, non-blocking)
   * Embeds action logs and turn (user input + narrative) pair
   */
  private async embedTurnAsync(turnId: string, narrative: string, language?: 'en' | 'zh'): Promise<void> {
    try {
      // Get turn data from database
      const turn = this.getTurn(turnId);
      if (!turn) {
        console.warn(`[TurnManager] Turn ${turnId} not found for embedding`);
        return;
      }

      // Skip simulated turns
      if (turn.isSimulated) {
        return;
      }

      const userInput = turn.characterInput;
      const sessionId = turn.sessionId;
      const effectiveLanguage = language || 'zh';

      // Embed turn (user input + narrative) with correct language model
      await this.ragManager.embedTurn(
        sessionId,
        turnId,
        userInput,
        narrative,
        undefined, // emailId
        effectiveLanguage
      );

      // Embed action logs if available
      if (turn.actionResults && Array.isArray(turn.actionResults)) {
        for (const actionResult of turn.actionResults) {
          // Extract action log from action result
          const actionLog: ActionLogEntry = {
            time: actionResult.gameTime || turn.gameTime || "",
            location: actionResult.location || turn.location || "",
            character: actionResult.character || turn.characterName || undefined,
            summary: actionResult.result || "",
            successLevel: this.extractSuccessLevel(actionResult),
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

      console.log(`✓ Turn ${turnId} embedded for RAG retrieval (language: ${effectiveLanguage})`);
    } catch (error) {
      console.error(`[TurnManager] Error embedding turn ${turnId}:`, error);
      throw error;
    }
  }

  /**
   * Extract success level from action result
   */
  private extractSuccessLevel(actionResult: any): ActionLogEntry["successLevel"] {
    if (!actionResult.diceRolls || !Array.isArray(actionResult.diceRolls)) {
      return "unknown";
    }

    // Try to parse success level from dice roll strings
    for (const roll of actionResult.diceRolls) {
      if (typeof roll === "string") {
        if (roll.includes("critical")) return "critical";
        if (roll.includes("extreme")) return "extreme";
        if (roll.includes("hard")) return "hard";
        if (roll.includes("success")) return "regular";
        if (roll.includes("failure")) return "failure";
        if (roll.includes("fumble")) return "fumble";
      }
    }

    return "unknown";
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
  getHistory(sessionId: string, limit = 50, afterTurnNumber?: number): GameTurn[] {
    return this.db.getTurnHistory(sessionId, limit, afterTurnNumber) as GameTurn[];
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
      const statusIcon = turn.status === 'completed' ? '✓' : 
                        turn.status === 'error' ? '✗' : '⏳';
      
      console.log(`${statusIcon} Turn #${turn.turnNumber} (${turn.turnId})`);
      console.log(`   Input: ${turn.characterInput.slice(0, 60)}${turn.characterInput.length > 60 ? '...' : ''}`);
      
      if (turn.keeperNarrative) {
        console.log(`   Narrative: ${turn.keeperNarrative.slice(0, 60)}${turn.keeperNarrative.length > 60 ? '...' : ''}`);
      }
      
      if (turn.status === 'error' && turn.errorMessage) {
        console.log(`   Error: ${turn.errorMessage}`);
      }
      
      console.log(`   Time: ${turn.startedAt} → ${turn.completedAt || 'processing...'}`);
      console.log();
    });
  }

  /**
   * Get conversation format (for display in frontend)
   */
  getConversation(sessionId: string, limit = 50): Array<{
    role: 'character' | 'keeper';
    content: string;
    timestamp: string;
    turnNumber: number;
    diceRolls?: string[];
    gameDay?: number | null;
    gameTime?: string | null;
  }> {
    const turns = this.getHistory(sessionId, limit);
    const conversation: Array<{
      role: 'character' | 'keeper';
      content: string;
      timestamp: string;
      turnNumber: number;
      diceRolls?: string[];
      gameDay?: number | null;
      gameTime?: string | null;
    }> = [];

    turns.reverse().forEach((turn) => {
      // Extract dice rolls from actionResults if available
      const diceRolls: string[] = [];
      const playerNameNormalized =
        typeof turn.characterName === 'string' && turn.characterName.trim().length > 0
          ? turn.characterName.trim().toLowerCase()
          : null;
      if (turn.actionResults && Array.isArray(turn.actionResults)) {
        turn.actionResults.forEach((result: any) => {
          if (result.diceRolls && Array.isArray(result.diceRolls) && result.diceRolls.length > 0) {
            const resultNameNormalized =
              typeof result.character === 'string' && result.character.trim().length > 0
                ? result.character.trim().toLowerCase()
                : null;
            if (playerNameNormalized) {
              if (!resultNameNormalized || resultNameNormalized !== playerNameNormalized) {
                return;
              }
            }
            diceRolls.push(...result.diceRolls);
          }
        });
      }

      // For introduction turn (turnNumber 0 with empty characterInput), only add keeper narrative
      if (turn.turnNumber === 0 && !turn.characterInput) {
        if (turn.status === 'completed' && turn.keeperNarrative) {
          const keeperMessage: any = {
            role: 'keeper',
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
        // Skip character input for simulated queries (only show user input)
        if (turn.characterInput && !turn.isSimulated) {
          conversation.push({
            role: 'character',
            content: turn.characterInput,
            timestamp: turn.startedAt,
            turnNumber: turn.turnNumber,
            gameDay: turn.gameDay ?? null,
            gameTime: turn.gameTime ?? null,
          });
        }

        // Add keeper narrative if completed (show for both real and simulated turns)
        if (turn.status === 'completed' && turn.keeperNarrative) {
          const keeperMessage: any = {
            role: 'keeper',
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

