/**
 * Turn Manager - Manages game turn records for character-keeper interactions
 * 
 * This module provides a high-level interface for managing game turns,
 * which record each complete interaction cycle from character input to keeper narrative.
 */

import type { CoCDatabase } from "../../../coc_multiagents_system/agents/memory/database/index.js";
import type { DynamicGameState } from "../../state/index.js";
import { randomUUID } from "crypto";

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

  constructor(db: CoCDatabase) {
    this.db = db;
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
  completeTurn(turnId: string, output: TurnOutput): void {
    this.db.completeTurn(
      turnId,
      output.keeperNarrative,
      output.clueRevelations,
      output.gameDay,
      output.gameTime
    );

    console.log(`✓ Turn completed: ${turnId}`);
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
      if (turn.actionResults && Array.isArray(turn.actionResults)) {
        turn.actionResults.forEach((result: any) => {
          if (result.diceRolls && Array.isArray(result.diceRolls) && result.diceRolls.length > 0) {
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


