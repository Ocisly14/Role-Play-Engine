/**
 * Dynamic Graph
 * Independent graph for DynamicWorld modules
 * Uses DynamicWorld-specific agents and includes DynamicGameState
 */

import type { BaseMessage } from "@langchain/core/messages";
import {
  END,
  MemorySaver,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../shared/agents/memory/database/index.js";
import type { ScenarioLoader } from "../../shared/agents/memory/scenarioloader/index.js";
import type {
  GameEndingInfo,
} from "../../shared/state/index.js";
import { getPrismaClient } from "../../shared/agents/memory/database/prismaClient.js";
import { latestHumanMessage } from "../../shared/utils/index.js";
import { enrichMemoryContext } from "../dynamicBasicAgent/memory/memoryAgent.js";
import { TurnManager } from "../dynamicBasicAgent/memory/turnManager.js";
import { loadDynamicGameState } from "../state/DynamicGameStateLoader.js";
import type { DynamicGameState } from "../state/index.js";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../state/index.js";

import { DirectorAgent } from "../dynamicBasicAgent/director/directorAgent.js";
import { KeeperAgent } from "../dynamicBasicAgent/keeper/keeperAgent.js";
import { PlayerPlanAgent } from "../dynamicBasicAgent/npcPlanning/PlayerPlanAgent.js";
import { NPCPlanningAgent } from "../dynamicBasicAgent/npcPlanning/NPCPlanningAgent.js";
import { runTick, resumeTick } from "../dynamicBasicAgent/npcPlanning/tickProcessor.js";
import { ACTION_TYPE_SKILL_MAP } from "../dynamicBasicAgent/npcPlanning/actionTypeSkillMap.js";
import type { PlanNode, TickResult } from "../dynamicBasicAgent/npcPlanning/types.js";
import { TurnRagAgent } from "../dynamicBasicAgent/knowledge/turnRagAgent.js";
// Import DynamicWorld agents
import { OrchestratorAgent } from "../dynamicBasicAgent/orchestrator/orchestratorAgent.js";
import { generateMapOnSceneSwitch } from "../visual/mapImage.js";
import { generateSceneImage } from "../visual/sceneImage.js";

/**
 * Dynamic Graph State - Uses only DynamicGameState (no GameState)
 */
export interface DynamicGraphState {
  messages: BaseMessage[];
  dynamicGameState: DynamicGameState; // DynamicWorld state (required, not null)
  turnId?: string; // Current turn being processed
  resumeFromInterrupt?: boolean; // True only when resuming a skill-selection interruption
  language?: "en" | "zh"; // User-selected output language
  selectedSkill?: string | null; // Optional player-selected skill for this turn
  stream?: {
    onDiceRolls?: (diceRolls: unknown[]) => void;
    onSceneImage?: (payload: {
      imagePath: string;
      mimeType: string;
      sceneName: string;
      location: string;
      gameDay?: number | null;
      gameTime?: string | null;
      timestamp?: string;
    }) => void;
    onSceneChangeStart?: () => void;
    onSceneChangeEnd?: () => void;
    onWorldlineUpdateStart?: () => void;
    onWorldlineUpdateEnd?: () => void;
    onNarrativeStart?: () => void;
    onNarrativeDelta?: (delta: string) => void;
    onNarrativeEnd?: () => void;
    onMapUpdate?: (payload: { macroMapPath: string; mimeType: string }) => void;
  };
}

function buildGameEndingInfo(
  currentState: DynamicGameState,
  endingType: GameEndingInfo["endingType"],
  fallbackReason: string
): GameEndingInfo {
  const summary = currentState.endState?.summary?.trim();
  const trigger =
    currentState.pointOfNoReturnTrigger ||
    currentState.endState?.pointOfNoReturn?.trigger;
  const reasonParts = [fallbackReason];

  if (summary) {
    reasonParts.push(`终局概述：${summary}`);
  }
  if (trigger) {
    reasonParts.push(`触发点：${trigger}`);
  }

  return {
    isEnded: true,
    endingType,
    reason: reasonParts.join(" "),
    timestamp: new Date(),
  };
}

/**
 * Build Dynamic Graph for DynamicWorld modules
 */
export const buildDynamicGraph = (
  db: CoCDatabase | CoCDatabaseAdapter,
  scenarioLoader: ScenarioLoader
) => {
  const orchestrator = new OrchestratorAgent();
  const keeperAgent = new KeeperAgent();
  const directorAgent = new DirectorAgent(scenarioLoader, db);
  const prisma = getPrismaClient();
  const npcPlanningAgent = new NPCPlanningAgent(prisma, {});
  const playerPlanAgent = new PlayerPlanAgent({});
  const turnManager = new TurnManager(db);
  const turnRagAgent = new TurnRagAgent();

  // Create checkpointer for saving/resuming graph state
  const checkpointer = new MemorySaver();

  const graph = new StateGraph<DynamicGraphState>({
    channels: {
      messages: {
        value: (left: BaseMessage[] | undefined, right?: BaseMessage[]) =>
          right !== undefined ? right : left || [],
      },
      dynamicGameState: {
        value: (
          left: DynamicGameState | undefined,
          right?: DynamicGameState | undefined
        ) =>
          right !== undefined
            ? right
            : left ||
              initialDynamicGameState({
                sessionId: "",
                moduleName: "",
                playerCharacter: {
                  id: "placeholder",
                  name: "Placeholder",
                  attributes: {
                    STR: 50,
                    CON: 50,
                    DEX: 50,
                    APP: 50,
                    POW: 50,
                    SIZ: 50,
                    INT: 50,
                    EDU: 50,
                  },
                  status: {
                    hp: 10,
                    maxHp: 10,
                    sanity: 60,
                    maxSanity: 99,
                    luck: 50,
                    mp: 10,
                    conditions: [],
                  },
                  skills: {},
                  inventory: [],
                  notes: "",
                  actionLog: [],
                },
              }),
      },
      turnId: {
        value: (left: string | undefined, right?: string | undefined) =>
          right !== undefined ? right : left,
      },
      resumeFromInterrupt: {
        value: (left: boolean | undefined, right?: boolean | undefined) =>
          right !== undefined ? right : left,
      },
      language: {
        value: (
          left: DynamicGraphState["language"] | undefined,
          right?: DynamicGraphState["language"]
        ) => (right !== undefined ? right : left),
      },
      selectedSkill: {
        value: (
          left: string | null | undefined,
          right?: string | null | undefined
        ) => (right !== undefined ? right : left),
      },
      stream: {
        value: (
          left: DynamicGraphState["stream"] | undefined,
          right?: DynamicGraphState["stream"]
        ) => (right !== undefined ? right : left),
      },
    },
  });

  // Entry node: clears temporary state for new player turn
  graph.addNode("entry", async (state: DynamicGraphState) => {
    try {
      const dgsm = new DynamicGameStateManager(state.dynamicGameState);

      // Check if this is resuming from a skill-selection interrupt
      const isResuming = state.resumeFromInterrupt === true;

      if (isResuming) {
        console.log(
          "[Dynamic Entry] Resuming from interrupt - preserving state"
        );
        // Don't clear state when resuming, just return as-is
        return state;
      }

      // Real player input (new turn) - clear temporary state from previous round
      console.log(
        "[Dynamic Entry] Real player input - clearing temporary state"
      );

      dgsm.setCharacterActions([]);
      console.log("   Cleared character actions");

      dgsm.setPlayerNodes([]);
      console.log("   Cleared player nodes");

      dgsm.clearPreviousScenario();
      console.log("   Cleared previous scenario");

      // Clear per-turn contextual data to prevent stale values bleeding across turns
      dgsm.setContextualData("relevantHistory", []);
      dgsm.setContextualData("relevantHistoryThreshold", null);
      dgsm.setContextualData("relevantHistoryQuery", null);
      console.log("   Cleared per-turn contextual data");

      // Update timestamp and increment turn counter (only for real input)
      dgsm.updatePlayerInputTime();
      console.log(
        `   Updated player input timestamp: ${new Date().toISOString()}`
      );

      dgsm.incrementTurnCounter();
      const currentTurn = dgsm.getTurnsInCurrentScene();
      console.log(`   Turn counter incremented to: ${currentTurn}`);

      console.log(
        "[Dynamic Entry] Temporary state cleared for new player turn"
      );

      return {
        ...state,
        dynamicGameState: dgsm.getState(),
      };
    } catch (error) {
      console.error(`[Dynamic Entry] Failed to clear state:`, error);
      // Return state as-is on error to allow graph to continue
      return state;
    }
  });

  // Conditional routing from entry
  const routeFromEntry = (state: DynamicGraphState): string => {
    // When resuming from skill-selection interrupt, skip orchestrator and go to memory
    if (state.resumeFromInterrupt === true) {
      console.log(
        "[Dynamic Entry Router] -> memory (resuming from interrupt, skip orchestrator)"
      );
      return "memory";
    }

    console.log("[Dynamic Entry Router] -> orchestrator (full pipeline)");
    return "orchestrator";
  };

  graph.addConditionalEdges("entry" as any, routeFromEntry, {
    orchestrator: "orchestrator" as any,
    memory: "memory" as any,
  });

  // Orchestrator: analyze user input and write actionAnalysis into state
  graph.addNode("orchestrator", async (state: DynamicGraphState) => {
    console.log("🎯 [Dynamic Orchestrator Agent] 开始分析用户输入...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const userInput = latestHumanMessage(state.messages);
    const selectedSkill = state.selectedSkill ?? null;
    const language =
      state.language === "en" || state.language === "zh"
        ? state.language
        : "zh";
    console.log(
      `🎯 [Dynamic Orchestrator Agent] 用户输入: "${userInput.substring(0, 100)}${userInput.length > 100 ? "..." : ""}"`
    );
    if (selectedSkill) {
      console.log(
        `🎯 [Dynamic Orchestrator Agent] 玩家已选择技能: ${selectedSkill}`
      );
    }
    const result = await orchestrator.processInput(
      userInput,
      dgsm,
      db,
      selectedSkill,
      language
    );

    console.log("✅ [Dynamic Orchestrator Agent] 分析完成");

    // Log orchestrator output
    const orchestratorOutput = dgsm.getState().temporaryInfo.contextualData?.orchestratorOutput;
    if (orchestratorOutput) {
      console.log("\n📋 [Dynamic Orchestrator Output]:");
      console.log(`   targetScenarioName: ${orchestratorOutput.targetScenarioName ?? "(none)"}`);
      console.log(`   targetNpcId: ${orchestratorOutput.targetNpcId ?? "(none)"}`);
      console.log(`   impact: ${orchestratorOutput.impact}`);
    }

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  // Memory: load and enrich DynamicGameState context
  graph.addNode("memory", async (state: DynamicGraphState) => {
    console.log(
      "🧠 [Dynamic Memory Agent] 开始加载和丰富 DynamicGameState 上下文..."
    );

    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    let currentState = dgsm.getState();

    // Load DynamicGameState if not already loaded
    if (!currentState.moduleName || !currentState.macroScene) {
      console.log(
        `🧠 [Memory Agent] DynamicGameState 未完全加载，尝试加载模块: ${currentState.moduleName || "unknown"}`
      );
      if (currentState.moduleName) {
        const loadedState = await loadDynamicGameState(
          db,
          currentState.moduleName
        );
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
    const language =
      state.language === "en" || state.language === "zh"
        ? state.language
        : "zh";

    const enrichedState = await enrichMemoryContext(
      currentState,
      db,
      characterInput,
      language
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

  graph.addEdge("orchestrator" as any, "memory" as any);

  // PlayerPlanAgent: generate structured PlanNode[] from player input
  graph.addNode("playerPlanAgent", async (state: DynamicGraphState) => {
    console.log("[PlayerPlanAgent] Generating player plan nodes...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const userInput = latestHumanMessage(state.messages);
    const language = state.language ?? "zh";
    const selectedSkill = state.selectedSkill ?? null;

    const orchestratorOutput = dgsm.getState().temporaryInfo.contextualData?.orchestratorOutput ?? {
      targetScenarioName: null,
      targetNpcId: null,
      impact: 0,
    };

    try {
      const playerNodes = await playerPlanAgent.generatePlayerNodes(
        userInput,
        dgsm,
        orchestratorOutput,
        selectedSkill,
        language
      );

      dgsm.setPlayerNodes(playerNodes);
      console.log(`[PlayerPlanAgent] Generated ${playerNodes.length} player node(s)`);
    } catch (error) {
      console.error("[PlayerPlanAgent] Failed:", error);
      dgsm.setPlayerNodes([]);
    }

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  graph.addEdge("memory" as any, "playerPlanAgent" as any);

  // TickExecutionLoop: execute all player + NPC nodes via TickProcessor
  graph.addNode("tickExecutionLoop", async (state: DynamicGraphState) => {
    console.log("[TickExecutionLoop] Executing tick...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const language = state.language ?? "zh";
    const selectedSkill = state.selectedSkill ?? null;
    const playerNodes = dgsm.getPlayerNodes();

    if (playerNodes.length === 0) {
      console.log("[TickExecutionLoop] No player nodes to execute");
      return { ...state, dynamicGameState: dgsm.getState() };
    }

    // Find first pending player node that needs skill selection
    const nextNodeNeedingSkill = playerNodes.find(
      (n: PlanNode) => n.status === "pending" && n.actionType
    );

    if (nextNodeNeedingSkill && !selectedSkill) {
      // Interrupt for skill selection
      const candidates = ACTION_TYPE_SKILL_MAP[nextNodeNeedingSkill.actionType!] ?? [];
      const playerSkills = dgsm.getState().playerCharacter?.skills ?? {};
      const skillEntries = candidates
        .filter((s: string) => playerSkills[s] !== undefined)
        .map((s: string) => ({ name: s, value: playerSkills[s] }));

      console.log(`[TickExecutionLoop] Interrupting for skill selection on node: ${nextNodeNeedingSkill.action}`);
      interrupt({
        action: nextNodeNeedingSkill.action,
        actionType: nextNodeNeedingSkill.actionType,
        difficulty: nextNodeNeedingSkill.difficulty,
        availableSkills: skillEntries,
        requiresSkillSelection: true,
      });
      // Graph will resume with selectedSkill populated
    }

    // Execute all player + NPC nodes via TickProcessor
    const pendingPlayerNodes = playerNodes.filter((n: PlanNode) => n.status === "pending");

    try {
      // Check if we're resuming from a player witness interrupt
      const pendingInterrupt = dgsm.getContextualData("pendingTickInterrupt") as {
        remainingBuckets: Array<{ bucketKey: number; nodes: PlanNode[] }>;
        previousActions: any[];
      } | null;
      const playerContinueChoice = dgsm.getContextualData("playerWitnessChoice") as string | null;

      let tickResult: TickResult;

      if (pendingInterrupt && playerContinueChoice === "continue") {
        // Player chose to continue — resume tick from where we left off
        dgsm.setContextualData("pendingTickInterrupt", null);
        dgsm.setContextualData("playerWitnessChoice", null);
        console.log("[TickExecutionLoop] Resuming tick after player chose to continue");
        tickResult = await resumeTick(
          pendingInterrupt.remainingBuckets,
          pendingInterrupt.previousActions,
          dgsm,
          npcPlanningAgent,
          dgsm.getState().sessionId,
          pendingPlayerNodes,
          language
        );
      } else if (pendingInterrupt && playerContinueChoice === "interrupt") {
        // Player chose to interrupt — stop here, use actions so far
        dgsm.setContextualData("pendingTickInterrupt", null);
        dgsm.setContextualData("playerWitnessChoice", null);
        console.log("[TickExecutionLoop] Player chose to interrupt, stopping tick");
        tickResult = { type: "completed", actions: pendingInterrupt.previousActions };
      } else {
        // Normal execution
        tickResult = await runTick(
          pendingPlayerNodes,
          dgsm,
          npcPlanningAgent,
          dgsm.getState().sessionId,
          language
        );
      }

      // Store executed actions
      const existingActions = dgsm.getCharacterActions() || [];
      dgsm.setCharacterActions([...existingActions, ...tickResult.actions]);
      console.log(`[TickExecutionLoop] ${tickResult.actions.length} character action(s) executed`);

      // Handle player interrupt — generate witness narrative via Keeper, then pause
      if (tickResult.type === "player_interrupt") {
        // Save interrupt state for resume
        dgsm.setContextualData("pendingTickInterrupt", {
          remainingBuckets: tickResult.remainingBuckets,
          previousActions: tickResult.actions,
        });

        // Generate witness narrative via KeeperAgent (full template)
        const userInput = latestHumanMessage(state.messages);
        const witnessResult = await keeperAgent.generateNarrative(
          userInput,
          dgsm,
          language,
          state.selectedSkill ?? null,
          {
            onNarrativeDelta: state.stream?.onNarrativeDelta,
            witnessEvents: tickResult.witnessEvents,
            isWitnessInterrupt: true,
          }
        );

        console.log(`[TickExecutionLoop] Player witness interrupt — ${tickResult.witnessEvents.length} event(s)`);
        interrupt({
          type: "player_witness",
          witnessEvents: tickResult.witnessEvents,
          witnessNarrative: witnessResult.narrative,
          requiresPlayerChoice: true,
        });
      }
    } catch (error) {
      console.error("[TickExecutionLoop] Error:", error);
    }

    // Check if more player nodes need skill selection (multi-node interrupt)
    const remainingNodes = dgsm.getPlayerNodes().filter(
      (n: PlanNode) => n.status === "pending" && n.actionType
    );

    // If there are remaining nodes that need skill, the next invocation will handle them
    // Clear selectedSkill so next iteration can ask again
    const updatedState = { ...state, dynamicGameState: dgsm.getState() };
    if (remainingNodes.length > 0) {
      updatedState.selectedSkill = null; // Reset for next interrupt
    }

    return updatedState;
  });

  graph.addEdge("playerPlanAgent" as any, "tickExecutionLoop" as any);
  graph.addEdge("tickExecutionLoop" as any, "director" as any);

  // Director: handle scene changes and narrative direction
  graph.addNode("director", async (state: DynamicGraphState) => {
    console.log("🎬 [Dynamic Director Agent] 处理场景转换和叙事方向...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const currentState = dgsm.getState();
    const stream = state.stream;
    const beforeScenarioId = currentState.currentScenario?.id;

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

      // Detect scene change from characterActions (movement nodes executed by TickProcessor)
      const afterState = dgsm.getState();
      const currentScenario = afterState.currentScenario;
      const sceneChanged =
        currentScenario &&
        currentScenario.id &&
        currentScenario.id !== beforeScenarioId;

      if (sceneChanged) {
        stream?.onSceneChangeStart?.();
        stream?.onSceneChangeEnd?.();

        void generateSceneImage(currentScenario, afterState)
          .then((result) => {
            if (!result) return;
            if (currentScenario) {
              currentScenario.sceneImage = {
                path: result.path,
                mimeType: result.mimeType,
                generatedAt: new Date().toISOString(),
              };
            }
            stream?.onSceneImage?.({
              imagePath: result.path,
              mimeType: result.mimeType,
              sceneName: currentScenario.name,
              location: currentScenario.location,
              gameDay: afterState.gameDay ?? null,
              gameTime: afterState.timeOfDay ?? null,
              timestamp: new Date().toISOString(),
            });
          })
          .catch((error) => {
            console.warn(
              "[Dynamic Director] Scene image generation failed:",
              error
            );
          });

        // Incrementally update the macro map
        const prevScenario = afterState.temporaryInfo.previousScenario;
        const moduleDigest = afterState.moduleDigest;
        const resolveScenarioIdFromSnapshot = (
          snapshotId: string
        ): string | null => {
          for (const [
            scenarioId,
            snapshots,
          ] of afterState.updatedDynamicScenarioSnapshots.entries()) {
            if (
              (snapshots || []).some((snapshot) => snapshot.id === snapshotId)
            ) {
              return scenarioId;
            }
          }
          return null;
        };

        const getConns = (id: string, name?: string) => {
          const byIdOrName = afterState.scenarioOutlines.find(
            (outline) => outline.id === id || (name && outline.name === name)
          );
          if (byIdOrName) {
            return byIdOrName.connections || [];
          }
          const scenarioId = resolveScenarioIdFromSnapshot(id);
          if (!scenarioId) return [];
          return (
            afterState.scenarioOutlines.find(
              (outline) => outline.id === scenarioId
            )?.connections || []
          );
        };

        if (prevScenario && currentScenario) {
          void generateMapOnSceneSwitch(
            afterState.moduleName,
            {
              name: prevScenario.name,
              description: prevScenario.description,
              connections: getConns(prevScenario.id, prevScenario.name),
            },
            {
              name: currentScenario.name,
              description: currentScenario.description,
              connections: getConns(currentScenario.id, currentScenario.name),
            },
            moduleDigest?.macroMapPath
          )
            .then((mapResult) => {
              if (!mapResult) return;
              if (moduleDigest) {
                moduleDigest.macroMapPath = mapResult.path;
              }
              stream?.onMapUpdate?.({
                macroMapPath: mapResult.path,
                mimeType: mapResult.mimeType,
              });
            })
            .catch((err) => {
              console.warn("[Dynamic Director] Map update failed:", err);
            });
        }
      }

      console.log("✅ [Dynamic Director Agent] 处理完成");
    } catch (error) {
      console.error(`❌ [Dynamic Director Agent] 处理失败:`, error);
    }

    return { ...state, dynamicGameState: dgsm.getState() };
  });

  graph.addEdge("director" as any, "gameEndCheck" as any);

  // Game End Check: check character status and global trigger
  graph.addNode("gameEndCheck", async (state: DynamicGraphState) => {
    console.log("\n🎯 [Dynamic Game End Check] 检查游戏是否结束...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const currentState = dgsm.getState();
    const stream = state.stream;

    // Check 1: Character HP/Sanity
    const playerStatus = currentState.playerCharacter.status;
    const hp = playerStatus.hp || 0;
    const sanity = playerStatus.sanity || 0;

    console.log(`   Player Status: HP=${hp}, Sanity=${sanity}`);

    if (hp <= 0 || sanity <= 0) {
      console.log(
        `\n🏁 [Game End] 角色状态导致游戏结束！(${hp <= 0 ? "HP归零" : "Sanity归零"})`
      );
      dgsm.setGameEnding(
        buildGameEndingInfo(
          currentState,
          hp <= 0 ? "death" : "failure",
          hp <= 0
            ? "调查员生命值归零，已无法继续行动。"
            : "调查员理智值归零，已无法继续调查。"
        )
      );
      return { ...state, dynamicGameState: currentState };
    }

    // Check 2: Global Trigger and Victory Trigger
    const triggerResult =
      await directorAgent.checkGlobalTriggerAndGameEnd(dgsm);

    if (triggerResult.victoryAchieved) {
      console.log(`\n🏆 [Victory] 调查员达成了胜利条件！`);
      const victoryReason = triggerResult.achievedVictoryCondition
        ? `调查员成功阻止了灾难，达成胜利条件：${triggerResult.achievedVictoryCondition}`
        : "调查员成功阻止了灾难，完成了胜利条件。";
      dgsm.setGameEnding(
        buildGameEndingInfo(
          dgsm.getState(),
          "victory",
          victoryReason
        )
      );
      return { ...state, dynamicGameState: dgsm.getState() };
    }

    if (triggerResult.triggered) {
      console.log(`\n🎯 [Global Trigger] 全局触发器已触发！`);

      if (triggerResult.causesGameEnd) {
        console.log(`\n🏁 [Game End] 全局触发器导致游戏结束！`);

        // Clear the trigger and mark game end for router
        dgsm.setGlobalTrigger(null);
        const gs = dgsm.getState();
        gs.temporaryInfo.contextualData = gs.temporaryInfo.contextualData || {};
        gs.temporaryInfo.contextualData.globalTriggerEnded = true;
        dgsm.setGameEnding(
          buildGameEndingInfo(
            gs,
            gs.endState?.pointOfNoReturn.type === "time"
              ? "time_limit"
              : "failure",
            "全局触发器已推进到不可逆阶段，游戏结束。"
          )
        );

        return { ...state, dynamicGameState: gs };
      } else {
        console.log(
          `   ✓ 全局触发器触发但未导致游戏结束，继续叙事`
        );
        // NPC scene updates now handled by TickProcessor
        return { ...state, dynamicGameState: dgsm.getState() };
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

      if (currentState.gameEnding?.isEnded) {
        console.log(
          "🔀 [Game End Router] → epilogueKeeper (gameEnding 已标记)"
        );
        return "epilogueKeeper";
      }

      // Check if character status caused game end
      if (hp <= 0 || sanity <= 0) {
        console.log("🔀 [Game End Router] → epilogueKeeper (角色状态)");
        return "epilogueKeeper";
      }

      // Check if global trigger caused game end (globalTrigger cleared when causesGameEnd=true)
      if (currentState.temporaryInfo.contextualData?.globalTriggerEnded) {
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
    const language =
      state.language === "en" || state.language === "zh"
        ? state.language
        : "zh";

    try {
      // Use epilogue generation method
      const result = await keeperAgent.generateEpilogue(
        userInput,
        dgsm,
        language
      );

      // Complete turn with epilogue narrative if turnId exists
      if (state.turnId) {
        try {
          turnManager.completeTurn(
            state.turnId,
            {
              keeperNarrative: result.narrative,
              clueRevelations: null,
              gameDay: currentState.gameDay ?? null,
              gameTime: currentState.timeOfDay ?? null,
            },
            state.language
          );
          console.log(
            `📝 [Dynamic Epilogue Keeper] Turn ${state.turnId} (真实输入) 已完成 - 游戏结束`
          );
          console.log(
            `   Epilogue length: ${result.narrative.length} characters`
          );
        } catch (error) {
          console.error(
            "❌ [Dynamic Epilogue Keeper] Failed to complete turn:",
            error
          );
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
          console.error(
            "❌ [Dynamic Epilogue Keeper] Failed to mark turn error:",
            markError
          );
        }
      }
    }

    return {
      ...state,
      dynamicGameState: dgsm.getState(),
    };
  });

  // Keeper: generate narrative
  graph.addNode("keeper", async (state: DynamicGraphState) => {
    console.log("[Dynamic Keeper Agent] Generating narrative...");
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const userInput = latestHumanMessage(state.messages);
    const language =
      state.language === "en" || state.language === "zh"
        ? state.language
        : "zh";
    const stream = state.stream;
    const shouldStream = Boolean(stream?.onNarrativeDelta);

    let updatedGameState = state.dynamicGameState;

    try {
      if (shouldStream) {
        stream?.onNarrativeStart?.();
      }

      // Inject player witness events from tick processor (if any, non-interrupt)
      const playerWitnessEvents = (dgsm.getContextualData("playerWitnessEvents") as any[]) ?? [];

      const result = await keeperAgent.generateNarrative(
        userInput,
        dgsm,
        language,
        state.selectedSkill ?? null,
        {
          onNarrativeDelta: shouldStream ? stream?.onNarrativeDelta : undefined,
          witnessEvents: playerWitnessEvents.length > 0 ? playerWitnessEvents : undefined,
          isWitnessInterrupt: false,
        }
      );

      updatedGameState = result.updatedGameState;

      // Complete turn with keeper narrative if turnId exists
      if (state.turnId) {
        try {
          turnManager.completeTurn(
            state.turnId,
            {
              keeperNarrative: result.narrative,
              clueRevelations: null,
              gameDay: updatedGameState?.gameDay ?? null,
              gameTime: updatedGameState?.timeOfDay ?? null,
            },
            state.language
          );
          console.log(
            `📝 [Dynamic Keeper Agent] Turn ${state.turnId} (真实输入) 已完成并保存到数据库`
          );
          console.log(
            `   Keeper narrative length: ${result.narrative.length} characters`
          );
        } catch (error) {
          console.error(
            "❌ [Dynamic Keeper Agent] Failed to complete turn:",
            error
          );
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
          console.error(
            "❌ [Dynamic Keeper Agent] Failed to mark turn error:",
            markError
          );
        }
      }
    } finally {
      if (shouldStream) {
        stream?.onNarrativeEnd?.();
      }
    }

    return {
      ...state,
      dynamicGameState: updatedGameState,
    };
  });

  graph.addNode("ragRecorder", async (state: DynamicGraphState) => {
    const dgsm = new DynamicGameStateManager(state.dynamicGameState);
    const clearTriggerCheckContext = () => {
      dgsm.setContextualData("triggerCheckEvidence", []);
      dgsm.setContextualData("triggerCheckCurrentTurnActionLogs", []);
      dgsm.setContextualData("triggerCheckAchievedVictoryCondition", null);
      dgsm.setContextualData("triggerCheckResult", null);
    };

    if (!state.turnId) {
      clearTriggerCheckContext();
      return { ...state, dynamicGameState: dgsm.getState() };
    }

    const turn = turnManager.getTurn(state.turnId);
    if (!turn) {
      clearTriggerCheckContext();
      return { ...state, dynamicGameState: dgsm.getState() };
    }

    void turnRagAgent
      .recordTurn({
        turn,
        dynamicGameState: state.dynamicGameState,
        language: state.language,
      })
      .catch((error) => {
        console.warn("[Dynamic RAG Recorder] Failed to record turn RAG:", {
          turnId: state.turnId,
          sessionId: state.dynamicGameState?.sessionId,
            error,
        });
      });

    clearTriggerCheckContext();
    return { ...state, dynamicGameState: dgsm.getState() };
  });

  graph.addEdge("epilogueKeeper" as any, "ragRecorder" as any);
  graph.addEdge("keeper" as any, "ragRecorder" as any);
  graph.addEdge("ragRecorder" as any, END);

  graph.addEdge(START, "entry" as any);

  return graph.compile({ checkpointer });
};
