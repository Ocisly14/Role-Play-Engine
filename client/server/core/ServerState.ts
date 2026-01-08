import type { GameState } from "../../../src/state.js";

/**
 * Singleton class to manage global server state
 * Centralizes persistentGameState management
 */
export class ServerState {
  private static instance: ServerState | null = null;
  private persistentGameState: GameState | null = null;

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): ServerState {
    if (!ServerState.instance) {
      ServerState.instance = new ServerState();
    }
    return ServerState.instance;
  }

  /**
   * Get current game state
   */
  public getGameState(): GameState | null {
    return this.persistentGameState;
  }

  /**
   * Set game state
   */
  public setGameState(gameState: GameState): void {
    this.persistentGameState = gameState;
  }

  /**
   * Clear game state
   */
  public clearGameState(): void {
    this.persistentGameState = null;
  }

  /**
   * Check if there's an active game
   */
  public hasActiveGame(): boolean {
    return this.persistentGameState !== null;
  }
}
