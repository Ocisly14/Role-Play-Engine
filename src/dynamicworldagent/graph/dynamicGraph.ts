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
} from "../../state.js";
import type { DynamicGameState } from "../state/index.js";
import { DynamicGameStateManager, initialDynamicGameState } from "../state/index.js";
import { contentToString, latestHumanMessage } from "../../utils.js";
import {
  loadModuleDynamicState,
  enrichMemoryContext,
  formatMemoryContextForPrompt,
  type DynamicMemoryContext,
} from "../dynamicBasicAgent/memory/memoryAgent.js";
import { TurnManager } from "../../coc_multiagents_system/agents/memory/index.js";

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

    // Real player input - clear temporary state from previous round
    console.log("👤 [Dynamic Entry] Real player input - clearing temporary state");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);

    dgsm.clearActionResults();
    console.log("   ✓ Cleared action results");

    dgsm.clearNPCResponseAnalyses();
    console.log("   ✓ Cleared NPC response analyses");

    dgsm.clearActionAnalysis();
    console.log("   ✓ Cleared action analysis");

    dgsm.clearNarrativeDirection();
    console.log("   ✓ Cleared narrative direction");

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
    if (actionAnalysis) {
      console.log("\n📋 [Dynamic Action Analysis] 详细分析结果:");
      console.log(`   Character: ${actionAnalysis.character}`);
      console.log(`   Action: ${actionAnalysis.action}`);
      console.log(`   Action Type: ${actionAnalysis.actionType}`);
      console.log(`   Target: ${actionAnalysis.target.name || "N/A"}`);
      console.log(`   Target Intent: ${actionAnalysis.target.intent || "N/A"}`);
      console.log(`   Requires Dice: ${actionAnalysis.requiresDice ? "Yes" : "No"}`);
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
        const loadedState = await loadModuleDynamicState(db, currentState.moduleName);
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
    const contextHints = {
      currentLocation: currentState.currentScenario?.location,
      currentNPCs: currentState.npcCharacters.map(npc => npc.name),
      playerQuery: characterInput,
    };

    const memoryContext = enrichMemoryContext(
      currentState,
      dgsm,
      contextHints
    );

    // Store enriched memory context in dynamic state temporary info for downstream agents
    if (memoryContext) {
      const formattedContext = formatMemoryContextForPrompt(memoryContext);
      console.log(`📋 [Memory Agent] Memory context formatted (${formattedContext.length} chars)`);

      // Store in temporary contextual data so other agents can access it
      dgsm.setContextualData("memoryContext", formattedContext);
      dgsm.setContextualData("dynamicMemoryContext", memoryContext);
    }

    console.log("✅ [Dynamic Memory Agent] DynamicGameState 上下文丰富完成");

    return {
      ...state,
      dynamicGameState: dgsm.getState(),
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
      await actionAgent.processAction(runtime, dgsm as any, userInput);
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
        dgsm as any,
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

  graph.addEdge("character" as any, "keeper" as any);

  // Keeper: generate narrative
  graph.addNode("keeper", async (state: DynamicGraphState) => {
    console.log("📖 [Dynamic Keeper Agent] 开始生成叙述...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const userInput = latestHumanMessage(state.messages);

    try {
      const result = await keeperAgent.generateNarrative(userInput, dgsm as any);

      // TODO: Update dynamicGameState based on keeper narrative
      // For example, mark truth events as revealed, deploy red herrings, etc.
      if (result.clueRevelations) {
        // Process clue revelations and update dynamic state
        // This would need to be implemented based on specific requirements
      }

      console.log("✅ [Dynamic Keeper Agent] 叙述生成完成");
    } catch (error) {
      console.error(`❌ [Dynamic Keeper Agent] 生成失败:`, error);
    }

    return {
      ...state,
      dynamicGameState: dgsm.getState(),
    };
  });

  graph.addEdge("keeper" as any, "director" as any);

  // Director: handle scene changes and narrative direction
  graph.addNode("director", async (state: DynamicGraphState) => {
    console.log("🎬 [Dynamic Director Agent] 处理场景转换和叙事方向...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const currentState = dgsm.getState();

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
        dgsm as any,
        sceneChangeRequest.targetSceneName,
        sceneChangeRequest.reason,
        currentCharacterInput
      );
    }

    dgsm.clearSceneChangeRequest();

    const characterInput = latestHumanMessage(state.messages);
    const actionResults = currentState.temporaryInfo.actionResults || [];

    try {
      const narrativeDirection =
        await directorAgent.generateNarrativeDirection(
          dgsm as any,
          characterInput,
          actionResults
        );
      dgsm.setNarrativeDirection(narrativeDirection);
    } catch (error) {
      console.error(`❌ [Dynamic Director Agent] 生成叙事方向失败:`, error);
    }

    console.log("✅ [Dynamic Director Agent] 处理完成");

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  graph.addEdge("director" as any, END);

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
      return {
        ...state,
        messages: [...(state.messages || []), new HumanMessage(characterInput)],
        isSimulatedQuery: true,
        simulatedQueryCount: (state.simulatedQueryCount || 0) + 1,
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
    console.log("👥 [Dynamic Listener Character Agent] 开始分析 NPC 响应...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const userInput = latestHumanMessage(state.messages);
    const runtime = {}; // CharacterAgent expects runtime but only passes through generateText; keep empty placeholder

    try {
      const npcResponseAnalyses = await characterAgent.analyzeNPCResponses(
        runtime,
        dgsm as any,
        userInput
      );
      
      // Update dynamic state with NPC response analyses
      dgsm.setNPCResponseAnalyses(npcResponseAnalyses);
      
      console.log("✅ [Dynamic Listener Character Agent] NPC 响应分析完成");
    } catch (error) {
      console.error(`❌ [Dynamic Listener Character Agent] 分析失败:`, error);
    }

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  listenerGraph.addEdge("character" as any, "npcAction" as any);

  // NPC Action node
  listenerGraph.addNode("npcAction", async (state: DynamicGraphState) => {
    console.log("🤖 [Dynamic Listener NPC Action Agent] 开始执行 NPC 响应...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const runtime = {};

    try {
      await actionAgent.processNPCActions(runtime, dgsm as any);
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
      "\n🎬 [Dynamic Listener Director Agent] 处理场景转换请求和生成叙事方向..."
    );
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const currentState = dgsm.getState();
    const sceneChangeRequest = currentState.temporaryInfo.sceneChangeRequest;

    if (
      sceneChangeRequest?.shouldChange &&
      sceneChangeRequest.targetSceneName
    ) {
      const currentCharacterInput = latestHumanMessage(state.messages);

      await directorAgent.handleActionDrivenSceneChange(
        dgsm as any,
        sceneChangeRequest.targetSceneName,
        sceneChangeRequest.reason,
        currentCharacterInput
      );
    }

    dgsm.clearSceneChangeRequest();

    const characterInput = latestHumanMessage(state.messages);
    const actionResults = currentState.temporaryInfo.actionResults || [];

    try {
      const narrativeDirection =
        await directorAgent.generateNarrativeDirection(
          dgsm as any,
          characterInput,
          actionResults
        );
      dgsm.setNarrativeDirection(narrativeDirection);
    } catch (error) {
      console.error(
        `❌ [Dynamic Listener Director Agent] 生成叙事方向失败:`,
        error
      );
    }

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  listenerGraph.addEdge("director" as any, END);
  listenerGraph.addEdge(START, "entry" as any);

  return listenerGraph.compile();
};
