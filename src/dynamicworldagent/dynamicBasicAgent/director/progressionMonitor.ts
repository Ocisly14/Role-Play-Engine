import type { GameState, GameStateManager, ActionResult } from "../../../state.js";

/**
 * Progression Monitor - 监听游戏状态变化，判断是否需要启动 Director Agent
 */
export class ProgressionMonitor {
  private gameStateManager: GameStateManager;
  private lastClueCount: number = 0;
  private lastNpcStateHash: string = "";
  private actionsSinceLastClue: number = 0;

  constructor(gameStateManager: GameStateManager) {
    this.gameStateManager = gameStateManager;
    this.initializeBaseline();
  }

  /**
   * 初始化基准状态
   */
  private initializeBaseline(): void {
    const gameState = this.gameStateManager.getGameState();
    this.lastClueCount = gameState.discoveredClues.length;
    this.lastNpcStateHash = this.calculateNpcStateHash(gameState);
    this.actionsSinceLastClue = 0;
  }

  /**
   * 检查是否应该触发 Director Agent
   */
  shouldTriggerDirector(): boolean {
    const gameState = this.gameStateManager.getGameState();
    
    // 检查所有触发条件
    const triggers = {
      allPlayersReachedActionCap: this.checkAllPlayersReachedActionCap(gameState),
      noNewCluesRecently: this.checkNoNewCluesInRecentActions(gameState),
      npcStateUnchanged: this.checkNpcStateUnchanged(gameState)
    };

    // 任何一个条件满足都触发
    const shouldTrigger = Object.values(triggers).some(condition => condition);

    if (shouldTrigger) {
      console.log("ProgressionMonitor: Director Agent trigger conditions met:", triggers);
    }

    return shouldTrigger;
  }

  /**
   * 检查所有玩家是否都达到场景短行动上限
   * 上限规则：短行动计数达到当前场景上限（estimatedShortActions），默认3
   */
  private checkAllPlayersReachedActionCap(gameState: GameState): boolean {
    const playerTimeConsumption = gameState.scenarioTimeState.playerTimeConsumption;
    const shortActionCap = this.getShortActionCap(gameState);
    
    // 如果没有任何玩家行动记录，不触发
    const playerIds = Object.keys(playerTimeConsumption);
    if (playerIds.length === 0) {
      return false;
    }

    // 所有有记录的玩家：短行动达到上限才算达标
    return playerIds.every(playerId => {
      const playerTime = playerTimeConsumption[playerId];
      return playerTime.totalShortActions >= shortActionCap;
    });
  }

  /**
   * 检查最近三轮行动是否没有新线索被揭示
   */
  private checkNoNewCluesInRecentActions(gameState: GameState): boolean {
    const actionResults = gameState.temporaryInfo.actionResults;
    const currentClueCount = gameState.discoveredClues.length;

    // 如果行动数量少于3，不检查此条件
    if (actionResults.length < 3) {
      return false;
    }

    // 检查线索数量是否有变化
    if (currentClueCount > this.lastClueCount) {
      // 有新线索，重置计数器
      this.lastClueCount = currentClueCount;
      this.actionsSinceLastClue = 0;
      return false;
    }

    // 计算自上次线索发现以来的行动数量
    this.actionsSinceLastClue = actionResults.length;

    // 如果连续3个行动都没有新线索，触发
    return this.actionsSinceLastClue >= 3;
  }

  /**
   * 检查NPC状态是否没有变化
   */
  private checkNpcStateUnchanged(gameState: GameState): boolean {
    const currentNpcStateHash = this.calculateNpcStateHash(gameState);
    
    if (currentNpcStateHash !== this.lastNpcStateHash) {
      // NPC状态有变化，更新基准并返回false
      this.lastNpcStateHash = currentNpcStateHash;
      return false;
    }

    // NPC状态没有变化，且有足够的行动历史
    const actionResults = gameState.temporaryInfo.actionResults;
    return actionResults.length >= 3;
  }

  /**
   * 计算NPC状态的哈希值
   */
  private calculateNpcStateHash(gameState: GameState): string {
    const npcStates = gameState.npcCharacters.map(npc => {
      // 只关注可能变化的关键属性
      const relevantData = {
        id: npc.id,
        name: npc.name,
        hp: npc.status.hp,
        sanity: npc.status.sanity,
        conditions: npc.status.conditions?.sort() || [], // 排序确保一致性
        // NPC特有属性
        clues: (npc as any).clues?.filter((c: any) => c.revealed) || [],
        relationships: (npc as any).relationships || []
      };
      return JSON.stringify(relevantData);
    });

    return npcStates.sort().join("|"); // 排序确保顺序一致性
  }

  /**
   * 更新监听状态（在每次行动后调用）
   */
  updateAfterAction(actionResult: ActionResult): void {
    const gameState = this.gameStateManager.getGameState();
    
    // 更新线索计数
    const currentClueCount = gameState.discoveredClues.length;
    if (currentClueCount > this.lastClueCount) {
      this.lastClueCount = currentClueCount;
      this.actionsSinceLastClue = 0;
    } else {
      this.actionsSinceLastClue++;
    }

    // 更新NPC状态哈希
    this.lastNpcStateHash = this.calculateNpcStateHash(gameState);
  }

  /**
   * 重置监听器（场景变化时调用）
   */
  resetOnScenarioChange(): void {
    this.initializeBaseline();
    console.log("ProgressionMonitor: Reset for new scenario");
  }

  /**
   * 获取当前场景的短行动上限，默认3
   */
  private getShortActionCap(gameState: GameState): number {
    return gameState.currentScenario?.estimatedShortActions || 3;
  }

  /**
   * 获取当前监听状态（调试用）
   */
  getMonitorStatus() {
    const gameState = this.gameStateManager.getGameState();
    
    return {
      lastClueCount: this.lastClueCount,
      currentClueCount: gameState.discoveredClues.length,
      actionsSinceLastClue: this.actionsSinceLastClue,
      lastNpcStateHash: this.lastNpcStateHash.slice(0, 20) + "...", // 截断显示
      playerTimeConsumption: gameState.scenarioTimeState.playerTimeConsumption,
      totalActionResults: gameState.temporaryInfo.actionResults.length
    };
  }
}
