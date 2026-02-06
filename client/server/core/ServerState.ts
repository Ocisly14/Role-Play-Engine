import type { DynamicGameState } from "../../../src/dynamicworldagent/state/index.js";

/**
 * Singleton class to manage global server state
 * Centralizes DynamicWorld game state management
 */
export class ServerState {
  private static instance: ServerState | null = null;
  private dynamicGameStatesByUser = new Map<string, DynamicGameState | null>();
  private dynamicGameStatesBySession = new Map<
    string,
    DynamicGameState | null
  >();

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
   * Set DynamicGameState for a user (updates session index)
   */
  public setGameState(
    userId: string,
    dynamicGameState: DynamicGameState | null
  ): void {
    this.dynamicGameStatesByUser.set(userId, dynamicGameState);
    if (dynamicGameState?.sessionId) {
      this.dynamicGameStatesBySession.set(
        dynamicGameState.sessionId,
        dynamicGameState
      );
    }
  }

  /**
   * Set DynamicGameState by session (keeps user index in sync if found)
   */
  public setGameStateBySession(
    sessionId: string,
    dynamicGameState: DynamicGameState | null
  ): void {
    this.dynamicGameStatesBySession.set(sessionId, dynamicGameState);
    const userId = this.findUserIdBySession(sessionId);
    if (userId) {
      this.dynamicGameStatesByUser.set(userId, dynamicGameState);
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
  public getDynamicGameStateBySession(
    sessionId: string
  ): DynamicGameState | null {
    return this.dynamicGameStatesBySession.get(sessionId) ?? null;
  }

  /**
   * Clear game state for a user
   */
  public clearGameState(userId: string): void {
    const dynamicExisting = this.dynamicGameStatesByUser.get(userId);
    const sessionId = dynamicExisting?.sessionId;
    if (sessionId) {
      this.dynamicGameStatesBySession.delete(sessionId);
    }
    this.dynamicGameStatesByUser.delete(userId);
  }

  /**
   * Check if there's an active game for a user
   */
  public hasActiveGame(userId: string): boolean {
    return this.dynamicGameStatesByUser.has(userId);
  }

  /**
   * Get any active session id (best-effort)
   */
  public getAnySessionId(): string | null {
    const dynamicFirst = this.dynamicGameStatesBySession.keys().next();
    if (!dynamicFirst.done) {
      return dynamicFirst.value;
    }
    return null;
  }

  private findUserIdBySession(sessionId: string): string | null {
    // Check DynamicGameState
    for (const [
      userId,
      dynamicState,
    ] of this.dynamicGameStatesByUser.entries()) {
      if (dynamicState?.sessionId === sessionId) {
        return userId;
      }
    }
    return null;
  }
}
