/**
 * Dynamic Graph
 * Independent graph for DynamicWorld modules
 * Uses DynamicWorld-specific agents and includes DynamicGameState
 */

import { END, START, StateGraph } from "@langchain/langgraph";
import type { CoCDatabase } from "../../coc_multiagents_system/agents/memory/database/index.js";
import type { RagManager } from "../../coc_multiagents_system/agents/memory/RagManager.js";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { ScenarioLoader } from "../../coc_multiagents_system/agents/memory/scenarioloader/index.js";
import type {
  ActionAnalysis,
  ActionResult,
} from "../../coc_multiagents_system/state/index.js";
import type { ActionLogEntry } from "../../coc_multiagents_system/agents/models/gameTypes.js";
import type { DynamicGameState } from "../state/index.js";
import { DynamicGameStateManager, initialDynamicGameState } from "../state/index.js";
import { contentToString, latestHumanMessage } from "../../coc_multiagents_system/utils/index.js";
import { loadDynamicGameState } from "../state/DynamicGameStateLoader.js";
import { enrichMemoryContext } from "../dynamicBasicAgent/memory/memoryAgent.js";
import { TurnManager } from "../dynamicBasicAgent/memory/turnManager.js";

// Import DynamicWorld agents
import { OrchestratorAgent } from "../dynamicBasicAgent/orchestrator/orchestratorAgent.js";
import { ActionAgent } from "../dynamicBasicAgent/action/actionAgent.js";
import { CharacterAgent } from "../dynamicBasicAgent/character/characterAgent.js";
import { KeeperAgent } from "../dynamicBasicAgent/keeper/keeperAgent.js";
import { DirectorAgent } from "../dynamicBasicAgent/director/directorAgent.js";

/**
 * Dynamic Graph State - Uses only DynamicGameState (no GameState)
 */
export interface DynamicGraphState {
  messages: BaseMessage[];
  dynamicGameState: DynamicGameState;  // DynamicWorld state (required, not null)
  turnId?: string;  // Current turn being processed
  isSimulatedQuery?: boolean;  // Track if input is simulated by Director Agent
  simulatedQueryCount?: number;  // Safety counter for continuous loop (max 5)
}

/**
 * Build Dynamic Graph for DynamicWorld modules
 */
export const buildDynamicGraph = (
  db: CoCDatabase,
  scenarioLoader: ScenarioLoader,
  rag?: RagManager
) => {
  const orchestrator = new OrchestratorAgent();
  const actionAgent = new ActionAgent(scenarioLoader);
  const characterAgent = new CharacterAgent();
  const keeperAgent = new KeeperAgent();
  const directorAgent = new DirectorAgent(scenarioLoader, db);
  const turnManager = new TurnManager(db);
  
  // Helper function to create DynamicGameStateManager with db for snapshot management
  const createDGSMWithDb = (state: DynamicGameState) => new DynamicGameStateManager(state, db);

  const graph = new StateGraph<DynamicGraphState>({
    channels: {
      messages: {
        value: (left: BaseMessage[] | undefined, right?: BaseMessage[]) =>
          right !== undefined ? right : (left || []),
      },
      dynamicGameState: {
        value: (
          left: DynamicGameState | undefined,
          right?: DynamicGameState | undefined
        ) => (right !== undefined ? right : (left || initialDynamicGameState({
          sessionId: "",
          moduleName: "",
          playerCharacter: {
            id: "placeholder",
            name: "Placeholder",
            attributes: { STR: 50, CON: 50, DEX: 50, APP: 50, POW: 50, SIZ: 50, INT: 50, EDU: 50 },
            status: { hp: 10, maxHp: 10, sanity: 60, maxSanity: 99, luck: 50, mp: 10, conditions: [] },
            skills: {},
            inventory: [],
            notes: "",
            actionLog: [],
          },
        }))),
      },
      turnId: {
        value: (left: string | undefined, right?: string | undefined) =>
          right !== undefined ? right : left,
      },
      isSimulatedQuery: {
        value: (left: boolean | undefined, right?: boolean | undefined) =>
          right !== undefined ? right : left,
      },
      simulatedQueryCount: {
        value: (left: number | undefined, right?: number | undefined) =>
          right !== undefined ? right : left,
      },
    },
  });

  // Entry node: routes based on input type and handles cleanup
  graph.addNode("entry", async (state: DynamicGraphState) => {
    const isSimulated = state.isSimulatedQuery ?? false;

    if (isSimulated) {
      console.log(
        "🔄 [Dynamic Entry] Simulated query detected - skipping orchestrator & memory"
      );
      return state;
    }

    try {
      // Real player input - clear temporary state from previous round
      console.log("👤 [Dynamic Entry] Real player input - clearing temporary state");
      const dgsm = new DynamicGameStateManager(state.dynamicGameState);

      dgsm.clearActionResults();
      console.log("   ✓ Cleared action results");

      dgsm.clearNPCResponseAnalyses();
      console.log("   ✓ Cleared NPC response analyses");

      dgsm.clearActionAnalysis();
      console.log("   ✓ Cleared action analysis");

      dgsm.clearPreviousScenario();
      console.log("   ✓ Cleared previous scenario");

      // Update timestamp and increment turn counter (only for real input)
      dgsm.updatePlayerInputTime();
      console.log(`   ✓ Updated player input timestamp: ${new Date().toISOString()}`);

      dgsm.incrementTurnCounter();
      const currentTurn = dgsm.getTurnsInCurrentScene();
      console.log(`   ✓ Turn counter incremented to: ${currentTurn}`);

      console.log("✅ [Dynamic Entry] Temporary state cleared for new player turn");

      return {
        ...state,
        dynamicGameState: dgsm.getState(),
        simulatedQueryCount: 0, // Reset loop counter on real input
      };
    } catch (error) {
      console.error(`❌ [Dynamic Entry] 清理状态失败:`, error);
      // Return state as-is on error to allow graph to continue
      return {
        ...state,
        simulatedQueryCount: 0,
      };
    }
  });

  // Conditional routing from entry
  const routeFromEntry = (state: DynamicGraphState): string => {
    const isSimulated = state.isSimulatedQuery ?? false;
    if (isSimulated) {
      console.log("🔀 [Dynamic Entry Router] → character (skip orchestrator & memory)");
      return "character";
    } else {
      console.log("🔀 [Dynamic Entry Router] → orchestrator (full pipeline)");
      return "orchestrator";
    }
  };

  graph.addConditionalEdges(
    "entry" as any,
    routeFromEntry,
    {
      orchestrator: "orchestrator" as any,
      character: "character" as any,
    }
  );

  // Orchestrator: analyze user input and write actionAnalysis into state
  graph.addNode("orchestrator", async (state: DynamicGraphState) => {
    console.log("🎯 [Dynamic Orchestrator Agent] 开始分析用户输入...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const userInput = latestHumanMessage(state.messages);
    console.log(
      `🎯 [Dynamic Orchestrator Agent] 用户输入: "${userInput.substring(0, 100)}${userInput.length > 100 ? "..." : ""}"`
    );
    const result = await orchestrator.processInput(userInput, dgsm, db);
    
    console.log("✅ [Dynamic Orchestrator Agent] 分析完成");

    // Log detailed action analysis
    const actionAnalysis = dgsm.getState().temporaryInfo.currentActionAnalysis;
    const sceneChangeRequest = dgsm.getState().temporaryInfo.sceneChangeRequest;
    if (actionAnalysis) {
      console.log("\n📋 [Dynamic Action Analysis] 详细分析结果:");
      console.log(`   Character: ${actionAnalysis.character}`);
      console.log(`   Action: ${actionAnalysis.action}`);
      console.log(`   Action Type: ${actionAnalysis.actionType}`);
      console.log(`   Target: ${actionAnalysis.target.name || "N/A"}`);
      console.log(`   Target Intent: ${actionAnalysis.target.intent || "N/A"}`);
      if (sceneChangeRequest) {
        console.log(`   SceneChangeRequest: ${sceneChangeRequest.shouldChange ? "Yes" : "No"}${sceneChangeRequest.targetSceneName ? ` -> ${sceneChangeRequest.targetSceneName}` : ""}`);
      } else {
        console.log(`   SceneChangeRequest: No`);
      }
    } else {
      console.log("⚠️  [Dynamic Action Analysis] 未生成分析结果");
    }

    // Update turn with action analysis if turnId exists
    if (state.turnId) {
      try {
        turnManager.updateProcessing(state.turnId, {
          actionAnalysis: actionAnalysis,
        });
      } catch (error) {
        console.error("Failed to update turn with action analysis:", error);
      }
    }

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  // Memory: load and enrich DynamicGameState context
  graph.addNode("memory", async (state: DynamicGraphState) => {
    console.log("🧠 [Dynamic Memory Agent] 开始加载和丰富 DynamicGameState 上下文...");

    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    let currentState = dgsm.getState();

    // Load DynamicGameState if not already loaded
    if (!currentState.moduleName || !currentState.macroScene) {
      console.log(`🧠 [Memory Agent] DynamicGameState 未完全加载，尝试加载模块: ${currentState.moduleName || "unknown"}`);
      if (currentState.moduleName) {
        const loadedState = await loadDynamicGameState(db, currentState.moduleName);
        if (loadedState) {
          dgsm.loadWorldData({
            moduleDigest: loadedState.moduleDigest || undefined,
            macroScene: loadedState.macroScene || undefined,
            truthTimeline: loadedState.truthTimeline,
            knowledgeMatrix: loadedState.knowledgeMatrix,
            redHerrings: loadedState.redHerrings,
            mythosEvents: loadedState.mythosEvents,
            endState: loadedState.endState || undefined,
            scenarioOutlines: loadedState.scenarioOutlines,
          });
          currentState = dgsm.getState(); // Update currentState after loading
        }
      }
    }

    // Enrich memory context with DynamicGameState information
    const characterInput = latestHumanMessage(state.messages);
    const actionAnalysis = currentState.temporaryInfo.currentActionAnalysis;
    
    const enrichedState = await enrichMemoryContext(
      currentState,
      actionAnalysis,
      db,
      characterInput
    );
    
    // Update manager with enriched state by creating a new manager
    const enrichedDgsm = new DynamicGameStateManager(enrichedState);
    
    // Use enriched state for return
    currentState = enrichedState;

    console.log("✅ [Dynamic Memory Agent] DynamicGameState 上下文丰富完成");

    return {
      ...state,
      dynamicGameState: enrichedState,
    };
  });

  // Action: execute action agent using current game state
  graph.addNode("action", async (state: DynamicGraphState) => {
    console.log("⚡ [Dynamic Action Agent] 开始执行动作...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const runtime = {}; // ActionAgent expects runtime but only passes through generateText; keep empty placeholder
    const userInput = latestHumanMessage(state.messages);

    // Log input context
    const actionAnalysis = dgsm.getState().temporaryInfo.currentActionAnalysis;
    if (actionAnalysis) {
      console.log(
        `⚡ [Dynamic Action Agent] 动作分析: ${actionAnalysis.action} (类型: ${actionAnalysis.actionType})`
      );
      console.log(
        `⚡ [Dynamic Action Agent] 角色: ${actionAnalysis.character}, 目标: ${actionAnalysis.target.name || "N/A"}`
      );
    }

    try {
      await actionAgent.processAction(runtime, dgsm, userInput);
    } catch (error) {
      console.error(`\n❌ [Dynamic Action Agent] 执行过程中抛出异常:`, error);
      const currentState = dgsm.getState();
      const errorActionResult: ActionResult = {
        timestamp: new Date(),
        gameTime: currentState.timeOfDay || "Unknown time",
        timeElapsedMinutes: 0,
        location: currentState.currentScenario?.location || "Unknown location",
        character: actionAnalysis?.character || currentState.playerCharacter.name,
        result: `[异常] Action Agent 执行失败: ${error instanceof Error ? error.message : String(error)}`,
        diceRolls: [],
        timeConsumption: "instant",
        scenarioChanges: [
          `异常: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
      dgsm.addActionResult(errorActionResult);
    }

    console.log("✅ [Dynamic Action Agent] 动作执行完成");

    // Update turn with action results if turnId exists
    if (state.turnId) {
      try {
        const actionResults = dgsm.getState().temporaryInfo.actionResults;
        if (actionResults && actionResults.length > 0) {
          turnManager.updateProcessing(state.turnId, {
            actionResults: actionResults,
          });
        }
      } catch (error) {
        console.error(`❌ [Dynamic Action Agent] 更新 turn 失败:`, error);
      }
    }

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  graph.addEdge("orchestrator" as any, "memory" as any);
  graph.addEdge("memory" as any, "action" as any);
  graph.addEdge("action" as any, "character" as any);

  // Character: analyze NPC responses
  graph.addNode("character", async (state: DynamicGraphState) => {
    console.log("👥 [Dynamic Character Agent] 开始分析 NPC 响应...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const userInput = latestHumanMessage(state.messages);
    const runtime = {}; // CharacterAgent expects runtime but only passes through generateText; keep empty placeholder

    try {
      const npcResponseAnalyses = await characterAgent.analyzeNPCResponses(
        runtime,
        dgsm,
        userInput
      );

      // Update dynamic state with NPC response analyses
      dgsm.setNPCResponseAnalyses(npcResponseAnalyses);

      console.log("✅ [Dynamic Character Agent] NPC 响应分析完成");
    } catch (error) {
      console.error(`❌ [Dynamic Character Agent] 分析失败:`, error);
    }

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  graph.addEdge("character" as any, "director" as any);

  // Director: handle scene changes and narrative direction
  graph.addNode("director", async (state: DynamicGraphState) => {
    console.log("🎬 [Dynamic Director Agent] 处理场景转换和叙事方向...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const currentState = dgsm.getState();

    try {
      // Check point of no return
      const reached = dgsm.checkPointOfNoReturn(
        currentState.gameDay,
        currentState.timeOfDay
      );
      if (reached) {
        console.log(
          "⚠️  [Dynamic Director] Point of no return reached!",
          currentState.pointOfNoReturnTrigger
        );
      }

      const sceneChangeRequest = currentState.temporaryInfo.sceneChangeRequest;

      if (sceneChangeRequest?.shouldChange && sceneChangeRequest.targetSceneName) {
        const currentCharacterInput = latestHumanMessage(state.messages);

        await directorAgent.handleActionDrivenSceneChange(
          dgsm,
          sceneChangeRequest.targetSceneName,
          sceneChangeRequest.reason,
          currentCharacterInput
        );
      }

      dgsm.clearSceneChangeRequest();

      console.log("✅ [Dynamic Director Agent] 处理完成");
    } catch (error) {
      console.error(`❌ [Dynamic Director Agent] 处理失败:`, error);
      // Clear scene change request even on error to prevent stuck state
      dgsm.clearSceneChangeRequest();
    }

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  graph.addEdge("director" as any, "gameEndCheck" as any);

  // Game End Check: check character status and global trigger
  graph.addNode("gameEndCheck", async (state: DynamicGraphState) => {
    console.log("\n🎯 [Dynamic Game End Check] 检查游戏是否结束...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const currentState = dgsm.getState();

    // Check 1: Character HP/Sanity
    const playerStatus = currentState.playerCharacter.status;
    const hp = playerStatus.hp || 0;
    const sanity = playerStatus.sanity || 0;

    console.log(`   Player Status: HP=${hp}, Sanity=${sanity}`);

    if (hp <= 0 || sanity <= 0) {
      const reason = hp <= 0 ? "HP归零" : "Sanity归零";
      console.log(`\n🏁 [Game End] 角色状态导致游戏结束！`);
      console.log(`   原因: ${reason}`);
      
      // Store game end reason in state for epilogue
      currentState.temporaryInfo.contextualData = currentState.temporaryInfo.contextualData || {};
      currentState.temporaryInfo.contextualData.gameEndReason = reason;
      
      return { ...state, dynamicGameState: currentState };
    }

    // Check 2: Global Trigger and Game End
    const triggerResult = await directorAgent.checkGlobalTriggerAndGameEnd(dgsm);
    
    if (triggerResult.triggered) {
      console.log(`\n🎯 [Global Trigger] 全局触发器已触发！`);
      console.log(`   原因: ${triggerResult.reason || "未知"}`);
      
      if (triggerResult.causesGameEnd) {
        console.log(`\n🏁 [Game End] 全局触发器导致游戏结束！`);
        
        // Store game end reason
        currentState.temporaryInfo.contextualData = currentState.temporaryInfo.contextualData || {};
        currentState.temporaryInfo.contextualData.gameEndReason = triggerResult.reason || "全局触发器触发";
        
        // Clear the trigger since it has been fulfilled
        dgsm.setGlobalTrigger(null);
        
        return { ...state, dynamicGameState: dgsm.getState() };
      } else {
        console.log(`   ✓ 全局触发器触发但未导致游戏结束，将在后台更新场景`);
        
        // 不要清除 global trigger！保留它供 updateNonPlayerScenarios 使用作为 previousGlobalTrigger
        // updateNonPlayerScenarios 会生成新的 global trigger 并替换旧的
        const updatedState = dgsm.getState();
        
        // Start background scenario update (non-blocking, parallel with keeper generation)
        console.log(`\n🔄 [Global Trigger] 启动后台场景更新任务（与 keeper 并行处理）...`);
        console.log(`   ℹ️  保留当前 global trigger 作为 previousGlobalTrigger 供场景更新参考`);
        console.log(`   ℹ️  场景更新完成后，如果生成新的 global trigger，将自动替换旧的`);
        
        directorAgent.updateNonPlayerScenarios(dgsm).then(() => {
          // updateNonPlayerScenarios 内部会处理新的 global trigger 替换
          // 如果生成了新的 global trigger，它已经通过 gameStateManager.setGlobalTrigger() 设置了
          const finalState = dgsm.getState();
          if (finalState.globalTrigger) {
            console.log(`   ✓ [后台任务] 场景更新完成，已生成新的 global trigger`);
          } else {
            console.log(`   ✓ [后台任务] 场景更新完成，未生成新的 global trigger（已清除旧的）`);
          }
        }).catch((error) => {
          console.error(`   ❌ [后台任务] 场景更新失败:`, error);
        });
        
        // Return immediately without waiting for scenario update
        // Keeper will generate narrative in parallel with scenario update
        return { ...state, dynamicGameState: updatedState };
      }
    } else {
      console.log(`   ✓ 全局触发器未触发，游戏继续`);
    }

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  // Conditional routing: gameEndCheck -> epilogueKeeper or keeper
  graph.addConditionalEdges(
    "gameEndCheck" as any,
    (state: DynamicGraphState) => {
      const currentState = state.dynamicGameState;
      const playerStatus = currentState.playerCharacter.status;
      const hp = playerStatus.hp || 0;
      const sanity = playerStatus.sanity || 0;
      
      // Check if character status caused game end
      if (hp <= 0 || sanity <= 0) {
        console.log("🔀 [Game End Router] → epilogueKeeper (角色状态)");
        return "epilogueKeeper";
      }
      
      // Check if global trigger caused game end
      const gameEndReason = currentState.temporaryInfo.contextualData?.gameEndReason;
      if (gameEndReason) {
        console.log("🔀 [Game End Router] → epilogueKeeper (全局触发器)");
        return "epilogueKeeper";
      }
      
      console.log("🔀 [Game End Router] → keeper (游戏继续)");
      return "keeper";
    },
    {
      epilogueKeeper: "epilogueKeeper" as any,
      keeper: "keeper" as any,
    }
  );

  // Epilogue Keeper: generate ending narrative (后日谈)
  graph.addNode("epilogueKeeper", async (state: DynamicGraphState) => {
    console.log("📜 [Dynamic Epilogue Keeper] 开始生成后日谈叙事...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const currentState = dgsm.getState();
    const userInput = latestHumanMessage(state.messages);

    try {
      // Use epilogue generation method
      const result = await keeperAgent.generateEpilogue(userInput, dgsm);

      // Complete turn with epilogue narrative if turnId exists
      if (state.turnId) {
        const isSimulated = state.isSimulatedQuery ?? false;
        try {
          turnManager.completeTurn(state.turnId, {
            keeperNarrative: result.narrative,
            clueRevelations: result.clueRevelations || null,
            gameDay: currentState.gameDay ?? null,
            gameTime: currentState.timeOfDay ?? null,
          });
          const inputType = isSimulated ? '模拟查询' : '真实输入';
          console.log(`📝 [Dynamic Epilogue Keeper] Turn ${state.turnId} (${inputType}) 已完成 - 游戏结束`);
          console.log(`   Epilogue length: ${result.narrative.length} characters`);
        } catch (error) {
          console.error("❌ [Dynamic Epilogue Keeper] Failed to complete turn:", error);
          turnManager.markError(state.turnId, error as Error);
        }
      }

      console.log("✅ [Dynamic Epilogue Keeper] 后日谈叙事生成完成");
    } catch (error) {
      console.error(`❌ [Dynamic Epilogue Keeper] 生成失败:`, error);
      if (state.turnId) {
        try {
          turnManager.markError(state.turnId, error as Error);
        } catch (markError) {
          console.error("❌ [Dynamic Epilogue Keeper] Failed to mark turn error:", markError);
        }
      }
    }

    return {
      ...state,
      dynamicGameState: dgsm.getState(),
    };
  });

  graph.addEdge("epilogueKeeper" as any, END);

  // Keeper: generate narrative
  graph.addNode("keeper", async (state: DynamicGraphState) => {
    console.log("📖 [Dynamic Keeper Agent] 开始生成叙述...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const userInput = latestHumanMessage(state.messages);

    let updatedGameState = state.dynamicGameState;

    try {
      const result = await keeperAgent.generateNarrative(userInput, dgsm);

      // TODO: Update dynamicGameState based on keeper narrative
      // For example, mark truth events as revealed, deploy red herrings, etc.
      if (result.clueRevelations) {
        // Process clue revelations and update dynamic state
        // This would need to be implemented based on specific requirements
      }

      // Use the updated state from result (which includes all keeper updates)
      updatedGameState = result.updatedGameState;

      // Complete turn with keeper narrative if turnId exists
      if (state.turnId) {
        const isSimulated = state.isSimulatedQuery ?? false;
        try {
          turnManager.completeTurn(state.turnId, {
            keeperNarrative: result.narrative,
            clueRevelations: result.clueRevelations,
            gameDay: updatedGameState?.gameDay ?? null,
            gameTime: updatedGameState?.timeOfDay ?? null,
          });
          const inputType = isSimulated ? '模拟查询' : '真实输入';
          console.log(`📝 [Dynamic Keeper Agent] Turn ${state.turnId} (${inputType}) 已完成并保存到数据库`);
          console.log(`   Keeper narrative length: ${result.narrative.length} characters`);
        } catch (error) {
          console.error("❌ [Dynamic Keeper Agent] Failed to complete turn:", error);
          turnManager.markError(state.turnId, error as Error);
        }
      }

      console.log("✅ [Dynamic Keeper Agent] 叙述生成完成");
    } catch (error) {
      console.error(`❌ [Dynamic Keeper Agent] 生成失败:`, error);
      // Mark turn as error if turnId exists
      if (state.turnId) {
        try {
          turnManager.markError(state.turnId, error as Error);
        } catch (markError) {
          console.error("❌ [Dynamic Keeper Agent] Failed to mark turn error:", markError);
        }
      }
    }

    return {
      ...state,
      dynamicGameState: updatedGameState,
    };
  });

  graph.addEdge("keeper" as any, END);

  graph.addEdge(START, "entry" as any);

  return graph.compile();
};

/**
 * Build a separate listener graph for DynamicWorld modules
 * This graph is used by WebSocket periodic checks to trigger simulate queries
 */
export const buildDynamicListenerGraph = (
  db: CoCDatabase,
  scenarioLoader: ScenarioLoader,
  rag?: RagManager
) => {
  const directorAgent = new DirectorAgent(scenarioLoader, db);
  const turnManager = new TurnManager(db);
  const characterAgent = new CharacterAgent();
  const actionAgent = new ActionAgent(scenarioLoader);
  const keeperAgent = new KeeperAgent();

  const listenerGraph = new StateGraph<DynamicGraphState>({
    channels: {
      messages: {
        value: (left: BaseMessage[] | undefined, right?: BaseMessage[]) =>
          right !== undefined ? right : (left || []),
      },
      dynamicGameState: {
        value: (
          left: DynamicGameState | undefined,
          right?: DynamicGameState | undefined
        ) => (right !== undefined ? right : (left || initialDynamicGameState({
          sessionId: "",
          moduleName: "",
          playerCharacter: {
            id: "placeholder",
            name: "Placeholder",
            attributes: { STR: 50, CON: 50, DEX: 50, APP: 50, POW: 50, SIZ: 50, INT: 50, EDU: 50 },
            status: { hp: 10, maxHp: 10, sanity: 60, maxSanity: 99, luck: 50, mp: 10, conditions: [] },
            skills: {},
            inventory: [],
            notes: "",
            actionLog: [],
          },
        }))),
      },
      turnId: {
        value: (left: string | undefined, right?: string | undefined) =>
          right !== undefined ? right : left,
      },
      isSimulatedQuery: {
        value: (left: boolean | undefined, right?: boolean | undefined) =>
          right !== undefined ? right : left,
      },
      simulatedQueryCount: {
        value: (left: number | undefined, right?: number | undefined) =>
          right !== undefined ? right : left,
      },
    },
  });

  // Entry node for listener graph: check progression and trigger if needed
  listenerGraph.addNode("entry", async (state: DynamicGraphState) => {
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);

    if (dgsm.shouldTriggerProgression()) {
      console.log("⏰ [Dynamic Listener] Progression trigger conditions met");
      const currentState = dgsm.getState();
      const characterInput = `[系统] 场景推进检查 - 当前场景: ${currentState.currentScenario?.name || "未知"}`;
      
      // Create a new turn record for the simulated query
      const newTurnId = turnManager.createTurnFromGameState(
        currentState.sessionId || '',
        characterInput,
        currentState,
        true // Mark as simulated query
      );
      console.log(`📝 [Dynamic Listener] Created turn ${newTurnId} for simulated query`);

      return {
        ...state,
        messages: [...(state.messages || []), new HumanMessage(characterInput)],
        isSimulatedQuery: true,
        simulatedQueryCount: (state.simulatedQueryCount || 0) + 1,
        turnId: newTurnId,
      };
    }

    return { ...state, messages: state.messages || [] };
  });

  listenerGraph.addConditionalEdges(
    "entry" as any,
    (state: DynamicGraphState) => {
      const shouldProceed = state.isSimulatedQuery ?? false;
      return shouldProceed ? "character" : END;
    },
    {
      character: "character" as any,
      [END]: END,
    }
  );

  // Character node
  listenerGraph.addNode("character", async (state: DynamicGraphState) => {
    console.log("👥 [Dynamic Listener Character Agent] 开始分析 NPC 响应 (Recent Actions)...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const runtime = {}; // CharacterAgent expects runtime but only passes through generateText; keep empty placeholder

    try {
      // Get recent player actionLog (last 15 entries, roughly 3 turns)
      const dynamicState = dgsm.getState();
      const playerActionLog = dynamicState.playerCharacter.actionLog || [];
      const recentActionLog = playerActionLog.slice(-15);

      if (recentActionLog.length === 0) {
        console.log("   ⚠️ No recent player actions found, skipping NPC response analysis");
        dgsm.setNPCResponseAnalyses([]);
        const currentState = dgsm.getState();
        currentState.temporaryInfo.contextualData = currentState.temporaryInfo.contextualData || {};
        currentState.temporaryInfo.contextualData.hasRespondingNPCs = false;
        return { ...state, dynamicGameState: dgsm.getState() };
      }

      const npcResponseAnalyses = await characterAgent.analyzeNPCResponsesFromRecentActions(
        runtime,
        dgsm,
        recentActionLog
      );
      
      // Update dynamic state with NPC response analyses
      dgsm.setNPCResponseAnalyses(npcResponseAnalyses);
      
      // Check if any NPCs need to respond
      const hasRespondingNPCs = npcResponseAnalyses.some(
        analysis => analysis.willRespond && analysis.responseType && analysis.responseType !== "none"
      );
      
      // Store flag in state to indicate if NPCs need to act
      const currentState = dgsm.getState();
      currentState.temporaryInfo.contextualData = currentState.temporaryInfo.contextualData || {};
      currentState.temporaryInfo.contextualData.hasRespondingNPCs = hasRespondingNPCs;
      
      if (npcResponseAnalyses.length > 0) {
        npcResponseAnalyses.forEach(analysis => {
          if (analysis.willRespond) {
            console.log(`   ✓ ${analysis.npcName}: ${analysis.responseType}`);
          } else {
            console.log(`   - ${analysis.npcName}: 无响应`);
          }
        });
      }
      
      if (hasRespondingNPCs) {
        console.log(`\n📋 [Dynamic Listener Character Agent] 检测到 ${npcResponseAnalyses.filter(a => a.willRespond && a.responseType && a.responseType !== "none").length} 个 NPC 需要执行动作`);
      } else {
        console.log(`\n📋 [Dynamic Listener Character Agent] 没有 NPC 需要执行动作，直接进入 Director`);
      }
      
      console.log("✅ [Dynamic Listener Character Agent] NPC 响应分析完成");
    } catch (error) {
      console.error(`❌ [Dynamic Listener Character Agent] 分析失败:`, error);
      // Continue with empty analyses on error
      dgsm.setNPCResponseAnalyses([]);
      const currentState = dgsm.getState();
      currentState.temporaryInfo.contextualData = currentState.temporaryInfo.contextualData || {};
      currentState.temporaryInfo.contextualData.hasRespondingNPCs = false;
    }

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  // Conditional routing: character -> npcAction or director
  listenerGraph.addConditionalEdges(
    "character" as any,
    (state: DynamicGraphState) => {
      const currentState = state.dynamicGameState;
      const hasRespondingNPCs = currentState.temporaryInfo.contextualData?.hasRespondingNPCs === true;
      
      if (hasRespondingNPCs) {
        console.log("\n🔄 [Dynamic Listener Router] 路由到 NPC Action Agent");
        return "npcAction";
      } else {
        console.log("\n🔄 [Dynamic Listener Router] 跳过 NPC Action，直接进入 Director");
        return "director";
      }
    },
    {
      "npcAction": "npcAction" as any,
      "director": "director" as any
    }
  );

  // NPC Action node
  listenerGraph.addNode("npcAction", async (state: DynamicGraphState) => {
    console.log("🤖 [Dynamic Listener NPC Action Agent] 开始执行 NPC 响应...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const runtime = {};

    try {
      await actionAgent.processNPCActions(runtime, dgsm);
      console.log("✅ [Dynamic Listener NPC Action Agent] NPC 动作处理完成");
    } catch (error) {
      console.error(`❌ [Dynamic Listener NPC Action Agent] 处理 NPC 动作时出错:`, error);
    }

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  listenerGraph.addEdge("npcAction" as any, "director" as any);

  // Director node
  listenerGraph.addNode("director", async (state: DynamicGraphState) => {
    console.log(
      "\n🎬 [Dynamic Listener Director Agent] 处理场景转换请求..."
    );
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const currentState = dgsm.getState();
    const sceneChangeRequest = currentState.temporaryInfo.sceneChangeRequest;

    try {
      if (
        sceneChangeRequest?.shouldChange &&
        sceneChangeRequest.targetSceneName
      ) {
        const currentCharacterInput = latestHumanMessage(state.messages);

        await directorAgent.handleActionDrivenSceneChange(
          dgsm,
          sceneChangeRequest.targetSceneName,
          sceneChangeRequest.reason,
          currentCharacterInput
        );
      } else {
        console.log("   ℹ️  无场景转换请求，跳过场景转换处理");
      }

      dgsm.clearSceneChangeRequest();

      console.log("✅ [Dynamic Listener Director Agent] 处理完成");
    } catch (error) {
      console.error(`❌ [Dynamic Listener Director Agent] 处理失败:`, error);
      // Clear scene change request even on error to prevent stuck state
      dgsm.clearSceneChangeRequest();
    }

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  listenerGraph.addEdge("director" as any, "gameEndCheck" as any);

  // Game End Check: check character status and global trigger
  listenerGraph.addNode("gameEndCheck", async (state: DynamicGraphState) => {
    console.log("\n🎯 [Dynamic Listener Game End Check] 检查游戏是否结束...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const currentState = dgsm.getState();

    // Check 1: Character HP/Sanity
    const playerStatus = currentState.playerCharacter.status;
    const hp = playerStatus.hp || 0;
    const sanity = playerStatus.sanity || 0;

    console.log(`   Player Status: HP=${hp}, Sanity=${sanity}`);

    if (hp <= 0 || sanity <= 0) {
      const reason = hp <= 0 ? "HP归零" : "Sanity归零";
      console.log(`\n🏁 [Game End] 角色状态导致游戏结束！`);
      console.log(`   原因: ${reason}`);
      
      // Store game end reason in state for epilogue
      currentState.temporaryInfo.contextualData = currentState.temporaryInfo.contextualData || {};
      currentState.temporaryInfo.contextualData.gameEndReason = reason;
      
      return { ...state, dynamicGameState: currentState };
    }

    // Check 2: Global Trigger and Game End
    const triggerResult = await directorAgent.checkGlobalTriggerAndGameEnd(dgsm);
    
    if (triggerResult.triggered) {
      console.log(`\n🎯 [Global Trigger] 全局触发器已触发！`);
      console.log(`   原因: ${triggerResult.reason || "未知"}`);
      
      if (triggerResult.causesGameEnd) {
        console.log(`\n🏁 [Game End] 全局触发器导致游戏结束！`);
        
        // Store game end reason
        currentState.temporaryInfo.contextualData = currentState.temporaryInfo.contextualData || {};
        currentState.temporaryInfo.contextualData.gameEndReason = triggerResult.reason || "全局触发器触发";
        
        // Clear the trigger since it has been fulfilled
        dgsm.setGlobalTrigger(null);
        
        return { ...state, dynamicGameState: dgsm.getState() };
      } else {
        console.log(`   ✓ 全局触发器触发但未导致游戏结束，将在后台更新场景`);
        
        // 不要清除 global trigger！保留它供 updateNonPlayerScenarios 使用作为 previousGlobalTrigger
        // updateNonPlayerScenarios 会生成新的 global trigger 并替换旧的
        const updatedState = dgsm.getState();
        
        // Start background scenario update (non-blocking, parallel with keeper generation)
        console.log(`\n🔄 [Global Trigger] 启动后台场景更新任务（与 keeper 并行处理）...`);
        console.log(`   ℹ️  保留当前 global trigger 作为 previousGlobalTrigger 供场景更新参考`);
        console.log(`   ℹ️  场景更新完成后，如果生成新的 global trigger，将自动替换旧的`);
        
        directorAgent.updateNonPlayerScenarios(dgsm).then(() => {
          // updateNonPlayerScenarios 内部会处理新的 global trigger 替换
          // 如果生成了新的 global trigger，它已经通过 gameStateManager.setGlobalTrigger() 设置了
          const finalState = dgsm.getState();
          if (finalState.globalTrigger) {
            console.log(`   ✓ [后台任务] 场景更新完成，已生成新的 global trigger`);
          } else {
            console.log(`   ✓ [后台任务] 场景更新完成，未生成新的 global trigger（已清除旧的）`);
          }
        }).catch((error) => {
          console.error(`   ❌ [后台任务] 场景更新失败:`, error);
        });
        
        // Return immediately without waiting for scenario update
        // Keeper will generate narrative in parallel with scenario update
        return { ...state, dynamicGameState: updatedState };
      }
    } else {
      console.log(`   ✓ 全局触发器未触发，游戏继续`);
    }

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  // Conditional routing: gameEndCheck -> epilogueKeeper or keeper
  listenerGraph.addConditionalEdges(
    "gameEndCheck" as any,
    (state: DynamicGraphState) => {
      const currentState = state.dynamicGameState;
      const playerStatus = currentState.playerCharacter.status;
      const hp = playerStatus.hp || 0;
      const sanity = playerStatus.sanity || 0;
      
      // Check if character status caused game end
      if (hp <= 0 || sanity <= 0) {
        console.log("🔀 [Listener Game End Router] → epilogueKeeper (角色状态)");
        return "epilogueKeeper";
      }
      
      // Check if global trigger caused game end
      const gameEndReason = currentState.temporaryInfo.contextualData?.gameEndReason;
      if (gameEndReason) {
        console.log("🔀 [Listener Game End Router] → epilogueKeeper (全局触发器)");
        return "epilogueKeeper";
      }
      
      console.log("🔀 [Listener Game End Router] → keeper (游戏继续)");
      return "keeper";
    },
    {
      epilogueKeeper: "epilogueKeeper" as any,
      keeper: "keeper" as any,
    }
  );

  // Epilogue Keeper: generate ending narrative (后日谈)
  listenerGraph.addNode("epilogueKeeper", async (state: DynamicGraphState) => {
    console.log("📜 [Dynamic Listener Epilogue Keeper] 开始生成后日谈叙事...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const currentState = dgsm.getState();
    const userInput = latestHumanMessage(state.messages);

    try {
      // Use epilogue generation method
      const result = await keeperAgent.generateEpilogue(userInput, dgsm);

      // Complete turn with epilogue narrative if turnId exists
      if (state.turnId) {
        const isSimulated = state.isSimulatedQuery ?? false;
        try {
          turnManager.completeTurn(state.turnId, {
            keeperNarrative: result.narrative,
            clueRevelations: result.clueRevelations || null,
            gameDay: currentState.gameDay ?? null,
            gameTime: currentState.timeOfDay ?? null,
          });
          const inputType = isSimulated ? '模拟查询' : '真实输入';
          console.log(`📝 [Dynamic Listener Epilogue Keeper] Turn ${state.turnId} (${inputType}) 已完成 - 游戏结束`);
          console.log(`   Epilogue length: ${result.narrative.length} characters`);
        } catch (error) {
          console.error("❌ [Dynamic Listener Epilogue Keeper] Failed to complete turn:", error);
          turnManager.markError(state.turnId, error as Error);
        }
      }

      console.log("✅ [Dynamic Listener Epilogue Keeper] 后日谈叙事生成完成");
    } catch (error) {
      console.error(`❌ [Dynamic Listener Epilogue Keeper] 生成失败:`, error);
      if (state.turnId) {
        try {
          turnManager.markError(state.turnId, error as Error);
        } catch (markError) {
          console.error("❌ [Dynamic Listener Epilogue Keeper] Failed to mark turn error:", markError);
        }
      }
    }

    return {
      ...state,
      dynamicGameState: dgsm.getState(),
    };
  });

  listenerGraph.addEdge("epilogueKeeper" as any, END);

  // Keeper node
  listenerGraph.addNode("keeper", async (state: DynamicGraphState) => {
    console.log("📖 [Dynamic Listener Keeper Agent] 开始生成叙述...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const userInput = latestHumanMessage(state.messages);

    let updatedGameState = state.dynamicGameState;

    try {
      const result = await keeperAgent.generateNarrative(userInput, dgsm);

      // Use the updated state from result (which includes all keeper updates)
      updatedGameState = result.updatedGameState;

      // Complete turn with keeper narrative if turnId exists
      if (state.turnId) {
        const isSimulated = state.isSimulatedQuery ?? false;
        try {
          turnManager.completeTurn(state.turnId, {
            keeperNarrative: result.narrative,
            clueRevelations: result.clueRevelations,
            gameDay: updatedGameState?.gameDay ?? null,
            gameTime: updatedGameState?.timeOfDay ?? null,
          });
          const inputType = isSimulated ? '模拟查询' : '真实输入';
          console.log(`📝 [Dynamic Listener Keeper Agent] Turn ${state.turnId} (${inputType}) 已完成并保存到数据库`);
          console.log(`   Keeper narrative length: ${result.narrative.length} characters`);
        } catch (error) {
          console.error("❌ [Dynamic Listener Keeper Agent] Failed to complete turn:", error);
          turnManager.markError(state.turnId, error as Error);
        }
      }

      console.log("✅ [Dynamic Listener Keeper Agent] 叙述生成完成");
    } catch (error) {
      console.error(`❌ [Dynamic Listener Keeper Agent] 生成失败:`, error);
      // Mark turn as error if turnId exists
      if (state.turnId) {
        try {
          turnManager.markError(state.turnId, error as Error);
        } catch (markError) {
          console.error("❌ [Dynamic Listener Keeper Agent] Failed to mark turn error:", markError);
        }
      }
    }

    return {
      ...state,
      dynamicGameState: updatedGameState,
    };
  });

  listenerGraph.addEdge("keeper" as any, END);
  listenerGraph.addEdge(START, "entry" as any);

  return listenerGraph.compile();
};
