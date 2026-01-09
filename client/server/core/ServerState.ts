import type { GameState } from "../../../src/state.js";

/**
 * Singleton class to manage global server state
 * Centralizes persistentGameState management
 */
export class ServerState {
  private static instance: ServerState | null = null;
  private gameStatesByUser = new Map<string, GameState>();
  private gameStatesBySession = new Map<string, GameState>();

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
   * Get current game state for a user
   */
  public getGameState(userId: string): GameState | null {
    return this.gameStatesByUser.get(userId) ?? null;
  }

  /**
   * Get current game state by session
   */
  public getGameStateBySession(sessionId: string): GameState | null {
    return this.gameStatesBySession.get(sessionId) ?? null;
  }

  /**
   * Set game state for a user (updates session index)
   */
  public setGameState(userId: string, gameState: GameState): void {
    this.gameStatesByUser.set(userId, gameState);
    if (gameState.sessionId) {
      this.gameStatesBySession.set(gameState.sessionId, gameState);
    }
  }

  /**
   * Set game state by session (keeps user index in sync if found)
   */
  public setGameStateBySession(sessionId: string, gameState: GameState): void {
    this.gameStatesBySession.set(sessionId, gameState);
    const userId = this.findUserIdBySession(sessionId);
    if (userId) {
      this.gameStatesByUser.set(userId, gameState);
    }
  }

  /**
   * Clear game state for a user
   */
  public clearGameState(userId: string): void {
    const existing = this.gameStatesByUser.get(userId);
    if (existing?.sessionId) {
      this.gameStatesBySession.delete(existing.sessionId);
    }
    this.gameStatesByUser.delete(userId);
  }

  /**
   * Check if there's an active game for a user
   */
  public hasActiveGame(userId: string): boolean {
    return this.gameStatesByUser.has(userId);
  }

  /**
   * Get any active session id (best-effort)
   */
  public getAnySessionId(): string | null {
    const first = this.gameStatesBySession.keys().next();
    return first.done ? null : first.value;
  }

  private findUserIdBySession(sessionId: string): string | null {
    for (const [userId, state] of this.gameStatesByUser.entries()) {
      if (state.sessionId === sessionId) {
        return userId;
      }
    }
    return null;
  }
}
