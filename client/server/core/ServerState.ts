import type { GameState } from "../../../src/coc_multiagents_system/state/gameState.js";
import type { DynamicGameState } from "../../../src/dynamicworldagent/state/index.js";

/**
 * Singleton class to manage global server state
 * Centralizes persistentGameState management
 */
export class ServerState {
  private static instance: ServerState | null = null;
  private gameStatesByUser = new Map<string, GameState>();
  private gameStatesBySession = new Map<string, GameState>();
  private dynamicGameStatesByUser = new Map<string, DynamicGameState | null>();
  private dynamicGameStatesBySession = new Map<string, DynamicGameState | null>();

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
  public setGameState(userId: string, gameState: GameState | null, dynamicGameState?: DynamicGameState | null): void {
    if (gameState) {
      this.gameStatesByUser.set(userId, gameState);
      if (gameState.sessionId) {
        this.gameStatesBySession.set(gameState.sessionId, gameState);
      }
    }
    if (dynamicGameState !== undefined) {
      this.dynamicGameStatesByUser.set(userId, dynamicGameState);
      if (dynamicGameState?.sessionId) {
        this.dynamicGameStatesBySession.set(dynamicGameState.sessionId, dynamicGameState);
      }
    }
  }

  /**
   * Set game state by session (keeps user index in sync if found)
   */
  public setGameStateBySession(sessionId: string, gameState: GameState | null, dynamicGameState?: DynamicGameState | null): void {
    if (gameState) {
      this.gameStatesBySession.set(sessionId, gameState);
      const userId = this.findUserIdBySession(sessionId);
      if (userId) {
        this.gameStatesByUser.set(userId, gameState);
      }
    }
    if (dynamicGameState !== undefined) {
      this.dynamicGameStatesBySession.set(sessionId, dynamicGameState);
      const userId = this.findUserIdBySession(sessionId);
      if (userId) {
        this.dynamicGameStatesByUser.set(userId, dynamicGameState);
      }
    }
  }

  /**
   * Get DynamicGameState for a user
   */
  public getDynamicGameState(userId: string): DynamicGameState | null {
    return this.dynamicGameStatesByUser.get(userId) ?? null;
  }

  /**
   * Get DynamicGameState by session
   */
  public getDynamicGameStateBySession(sessionId: string): DynamicGameState | null {
    return this.dynamicGameStatesBySession.get(sessionId) ?? null;
  }

  /**
   * Clear game state for a user
   */
  public clearGameState(userId: string): void {
    const existing = this.gameStatesByUser.get(userId);
    if (existing?.sessionId) {
      this.gameStatesBySession.delete(existing.sessionId);
      this.dynamicGameStatesBySession.delete(existing.sessionId);
    }
    this.gameStatesByUser.delete(userId);
    this.dynamicGameStatesByUser.delete(userId);
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

  /**
   * Get user ID for a session if tracked
   */
  public getUserIdBySession(sessionId: string): string | null {
    return this.findUserIdBySession(sessionId);
  }

  private findUserIdBySession(sessionId: string): string | null {
    // Check GameState first
    for (const [userId, state] of this.gameStatesByUser.entries()) {
      if (state?.sessionId === sessionId) {
        return userId;
      }
    }
    // Check DynamicGameState
    for (const [userId, dynamicState] of this.dynamicGameStatesByUser.entries()) {
      if (dynamicState?.sessionId === sessionId) {
        return userId;
      }
    }
    return null;
  }
}
