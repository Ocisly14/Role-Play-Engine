/**
 * Multiplayer Dynamic Graph
 *
 * Processes one sceneRoom's round at a time.
 * All player inputs must be collected before the graph runs.
 *
 * Pipeline: entry → orchestrator → memory → action → character → director → keeper
 * Combat:   entry → memory → combatActionA → [combatActionB] → battleKeeper → gameEndCheck
 *
 * No isSimulatedQuery, no simulatedQueryCount, no messages[].
 */

import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../shared/agents/memory/database/index.js";
import { ScenarioLoader } from "../../shared/agents/memory/scenarioloader/index.js";
import type { ActionResult, GameEndingInfo } from "../../shared/state/index.js";
import {
  MultiplayerDynamicGameStateManager,
} from "../multiplayerState/MultiplayerDynamicGameState.js";
import { generateSceneRoomImage } from "../multiplayerVisual/sceneImage.js";
import type { MultiplayerDynamicGameState } from "../multiplayerState/MultiplayerDynamicGameState.js";
import { ActionAgent } from "../multiplayerAgent/action/actionAgent.js";
import { CharacterAgent } from "../multiplayerAgent/character/characterAgent.js";
import { BattleKeeperAgent } from "../multiplayerAgent/combat/battleKeeperAgent.js";
import { CombatActionAgentA } from "../multiplayerAgent/combat/combatActionAgentA.js";
import { CombatActionAgentB } from "../multiplayerAgent/combat/combatActionAgentB.js";
import { DirectorAgent } from "../multiplayerAgent/director/directorAgent.js";
import { HeartbeatAgent } from "../multiplayerAgent/heartbeat/heartbeatAgent.js";
import { KeeperAgent } from "../multiplayerAgent/keeper/keeperAgent.js";
import { enrichMemoryContextForSceneRoom } from "../multiplayerAgent/memory/memoryAgent.js";
import { MultiplayerOrchestratorAgent } from "../multiplayerAgent/orchestrator/orchestratorAgent.js";
import type { MultiplayerGraphState } from "./MultiplayerGraphState.js";

// =============================================
// Helpers
// =============================================

function buildMultiplayerGameEndingInfo(
  manager: MultiplayerDynamicGameStateManager,
  endingType: GameEndingInfo["endingType"],
  fallbackReason: string
): GameEndingInfo {
  const state = manager.getState();
  const summary = state.endState?.summary?.trim();
  const trigger =
    state.pointOfNoReturnTrigger || state.endState?.pointOfNoReturn?.trigger;
  const reasonParts = [fallbackReason];
  if (summary) reasonParts.push(`终局概述：${summary}`);
  if (trigger) reasonParts.push(`触发点：${trigger}`);
  return {
    isEnded: true,
    endingType,
    reason: reasonParts.join(" "),
    timestamp: new Date(),
  };
}

// =============================================
// Build graph
// =============================================

export const buildMultiplayerGraph = (
  db: CoCDatabase | CoCDatabaseAdapter
) => {
  const scenarioLoader = new ScenarioLoader(db);

  const orchestrator = new MultiplayerOrchestratorAgent();
  const actionAgent = new ActionAgent(scenarioLoader);
  const characterAgent = new CharacterAgent();
  const keeperAgent = new KeeperAgent();
  const directorAgent = new DirectorAgent(scenarioLoader, db);
  const heartbeatAgent = new HeartbeatAgent();
  const combatAgentA = new CombatActionAgentA();
  const combatAgentB = new CombatActionAgentB();
  const battleKeeper = new BattleKeeperAgent();

  const checkpointer = new MemorySaver();

  // Helper: wrap state.dynamicGameState in the manager
  const mgr = (state: MultiplayerGraphState) =>
    new MultiplayerDynamicGameStateManager(state.dynamicGameState);

  // ---- State graph channels ----

  const initialState: MultiplayerDynamicGameState = {
    roomId: "",
    moduleName: "",
    players: {},
    sceneRooms: {},
    roundInputs: [],
    sessionId: "",
    gameDay: 1,
    timeOfDay: "08:00",
    scenarioTimeState: { sceneStartTime: "08:00", playerTimeConsumption: {} },
    defeatedNpcHistory: [],
    heartbeatActions: [],
    gameEnding: null,
    keeperGuidance: null,
    moduleLimitations: null,
    npcCharacters: [],
    discoveredClues: [],
    moduleDigest: null,
    macroScene: null,
    truthTimeline: [],
    knowledgeMatrix: [],
    redHerrings: [],
    mythosEvents: [],
    endState: null,
    scenarioOutlines: [],
    revealedTruthEvents: new Set(),
    activatedKnowledgeHolders: new Set(),
    deployedRedHerrings: new Set(),
    mythosRevelations: new Set(),
    pointOfNoReturnReached: false,
    pointOfNoReturnTrigger: null,
    updatedDynamicScenarioSnapshots: new Map(),
    globalTrigger: null,
    loadedAt: new Date(),
    lastUpdated: new Date(),
  };

  const graph = new StateGraph<MultiplayerGraphState>({
    channels: {
      dynamicGameState: {
        value: (
          left: MultiplayerDynamicGameState | undefined,
          right?: MultiplayerDynamicGameState
        ) => (right !== undefined ? right : left ?? initialState),
      },
      sceneRoomId: {
        value: (l: string | undefined, r?: string) =>
          r !== undefined ? r : l ?? "",
      },
      roundInputs: {
        value: (l: any, r?: any) => (r !== undefined ? r : l ?? []),
      },
      roundTurnId: {
        value: (l: string | undefined, r?: string) =>
          r !== undefined ? r : l ?? "",
      },
      language: {
        value: (l: any, r?: any) => (r !== undefined ? r : l),
      },
      stream: {
        value: (l: any, r?: any) => (r !== undefined ? r : l),
      },
    },
  });

  // ---- ENTRY ----

  graph.addNode("entry", async (state: MultiplayerGraphState) => {
    const m = mgr(state);
    const sceneRoom = m.getSceneRoom(state.sceneRoomId);
    const roomTime = sceneRoom
      ? `Day ${sceneRoom.gameDay}, ${sceneRoom.timeOfDay}`
      : "(unknown)";
    console.log(`🎭 [MP Entry] sceneRoom=${state.sceneRoomId} round start (${roomTime})`);
    if (!sceneRoom) {
      console.error(`[MP Entry] sceneRoom ${state.sceneRoomId} not found`);
      return state;
    }

    // Clear per-round temporary info for this sceneRoom
    m.clearSceneRoomTemporaryInfo(state.sceneRoomId);

    // Heartbeat evaluation
    try {
      await heartbeatAgent.evaluateTurnStart(
        m,
        state.sceneRoomId,
        { db }
      );
    } catch (e) {
      console.warn("[MP Entry] heartbeat failed:", e);
    }

    // Increment turn counter for this sceneRoom
    m.incrementSceneRoomRound(state.sceneRoomId);

    return { ...state, dynamicGameState: m.getState() };
  });

  const routeFromEntry = (state: MultiplayerGraphState): string => {
    const scr = state.dynamicGameState.sceneRooms[state.sceneRoomId];
    if (scr?.isBattle) return "memory";
    return "orchestrator";
  };

  graph.addConditionalEdges("entry" as any, routeFromEntry, {
    orchestrator: "orchestrator" as any,
    memory: "memory" as any,
    [END]: END,
  });

  // ---- ORCHESTRATOR ----

  graph.addNode("orchestrator", async (state: MultiplayerGraphState) => {
    console.log("🎯 [MP Orchestrator] Analyzing all player inputs...");
    const m = mgr(state);
    const language =
      state.language === "en" || state.language === "zh" ? state.language : "zh";

    const result = await orchestrator.processRound(
      state.roundInputs,
      m,
      state.sceneRoomId,
      db,
      language
    );

    console.log(`✅ [MP Orchestrator] Validation: ${result.validation.status}`);
    return { ...state, dynamicGameState: m.getState() };
  });

  graph.addEdge("orchestrator" as any, "memory" as any);

  // ---- MEMORY ----

  graph.addNode("memory", async (state: MultiplayerGraphState) => {
    console.log("🧠 [MP Memory] Enriching context...");
    const m = mgr(state);
    const sceneRoom = m.getSceneRoom(state.sceneRoomId);
    const language =
      state.language === "en" || state.language === "zh" ? state.language : "zh";

    if (sceneRoom) {
      try {
        // Build combined character input for context enrichment (sceneRoom-scoped, skip/no-content omitted)
        const combinedInput = state.roundInputs
          .filter((i) => i.inputType === "input" && Boolean(i.content?.trim()))
          .map((i) => {
            const player = m.getState().players[i.playerId];
            return `${player?.characterName ?? i.playerId}: ${i.content?.trim() ?? ""}`;
          })
          .join("\n");

        await enrichMemoryContextForSceneRoom(
          m,
          state.sceneRoomId,
          db,
          combinedInput,
          language
        );
      } catch (e) {
        console.warn("[MP Memory] enrichMemoryContext failed:", e);
      }
    }

    return { ...state, dynamicGameState: m.getState() };
  });

  // Route memory → combatActionA (combat) or action (normal)
  const routeFromMemory = (state: MultiplayerGraphState): string => {
    const scr = state.dynamicGameState.sceneRooms[state.sceneRoomId];
    if (scr?.isBattle) return "combatActionA";
    return "action";
  };

  graph.addConditionalEdges("memory" as any, routeFromMemory, {
    combatActionA: "combatActionA" as any,
    action: "action" as any,
  });

  // ---- ACTION ----

  graph.addNode("action", async (state: MultiplayerGraphState) => {
    console.log("⚡ [MP Action] Processing all player actions...");
    const m = mgr(state);
    const sceneRoom = m.getSceneRoom(state.sceneRoomId);
    if (!sceneRoom) return state;

    const language =
      state.language === "en" || state.language === "zh" ? state.language : "zh";

    try {
      await actionAgent.processSceneRoomRound(
        m,
        state.sceneRoomId,
        state.roundInputs,
        language,
        state.roundTurnId
      );
    } catch (e) {
      console.error(`[MP Action] Error processing sceneRoom ${state.sceneRoomId}:`, e);
      // Best-effort: record a scene-level error result so keeper can surface it
      const scr = m.getSceneRoom(state.sceneRoomId);
      if (scr) {
        const errResult: ActionResult = {
          timestamp: new Date(),
          gameTime: scr.timeOfDay,
          timeElapsedMinutes: 0,
          location: scr.currentScenario?.location ?? "Unknown",
          character: "System",
          result: `[错误] ${e instanceof Error ? e.message : String(e)}`,
          diceRolls: [],
          timeConsumption: "instant",
        };
        m.addActionResult(state.sceneRoomId, errResult);
      }
    }

    return { ...state, dynamicGameState: m.getState() };
  });

  graph.addEdge("action" as any, "character" as any);

  // ---- CHARACTER ----

  graph.addNode("character", async (state: MultiplayerGraphState) => {
    console.log("👥 [MP Character] Determining NPC responses...");
    const m = mgr(state);
    const sceneRoom = m.getSceneRoom(state.sceneRoomId);
    if (!sceneRoom) return state;

    const language =
      state.language === "en" || state.language === "zh" ? state.language : "zh";

    try {
      const npcAnalyses = await characterAgent.analyzeNPCResponses(
        {},
        m,
        state.sceneRoomId,
        language
      );
      // Store NPC response analyses
      const scr = m.getSceneRoom(state.sceneRoomId);
      if (scr && Array.isArray(npcAnalyses)) {
        m.updateSceneRoom(state.sceneRoomId, {
          temporaryInfo: {
            ...scr.temporaryInfo,
            npcResponseAnalyses: npcAnalyses,
          },
        });
      }
    } catch (e) {
      console.warn("[MP Character] NPC analysis failed:", e);
    }

    return { ...state, dynamicGameState: m.getState() };
  });

  graph.addEdge("character" as any, "director" as any);

  // ---- DIRECTOR ----

  graph.addNode("director", async (state: MultiplayerGraphState) => {
    console.log("🎬 [MP Director] Evaluating scene progression...");
    const m = mgr(state);
    const sceneRoom = m.getSceneRoom(state.sceneRoomId);
    if (!sceneRoom) return state;

    try {
      // 1. Check point of no return (use room-local time, not global time)
      const reached = m.checkPointOfNoReturn(
        sceneRoom.gameDay,
        sceneRoom.timeOfDay
      );
      if (reached) {
        console.log(
          "⚠️  [MP Director] Point of no return reached!",
          m.getState().pointOfNoReturnTrigger
        );
      }

      // 2. Scene snapshot generation is now handled by processUnifiedSceneChanges
      //    in the turn service (after all rooms finish their rounds).

      // 3. Check story progression (existing)
      await directorAgent.checkStoryProgression(m, state.sceneRoomId);
    } catch (e) {
      console.warn("[MP Director] evaluation failed:", e);
    }

    return { ...state, dynamicGameState: m.getState() };
  });

  graph.addEdge("director" as any, "gameEndCheck" as any);

  // ---- GAME END CHECK ----

  graph.addNode("gameEndCheck", async (state: MultiplayerGraphState) => {
    console.log("\n🎯 [MP Game End Check] Checking if game should end...");
    const m = mgr(state);
    const gameState = m.getState();
    const sceneRoom = m.getSceneRoom(state.sceneRoomId);
    const stream = state.stream;

    if (!sceneRoom) return state;

    // Check 1: Per-player HP/Sanity — ALL players across ALL active rooms must be incapacitated
    const allActiveRooms = m.getActiveSceneRooms();
    let allIncapacitated = true;
    let incapReason = "";
    let totalPlayers = 0;

    for (const room of allActiveRooms) {
      for (const pid of room.memberPlayerIds) {
        totalPlayers++;
        const player = gameState.players[pid];
        if (!player) continue;
        const hp = player.profile.status?.hp ?? 1;
        const sanity = player.profile.status?.sanity ?? 1;
        if (hp > 0 && sanity > 0) {
          allIncapacitated = false;
          break;
        }
        if (hp <= 0) incapReason = "death";
        else if (sanity <= 0) incapReason = "failure";
      }
      if (!allIncapacitated) break;
    }

    if (allIncapacitated && totalPlayers > 0) {
      console.log(
        `\n🏁 [MP Game End] All players across all active rooms incapacitated (${incapReason})`
      );
      m.setGameEnding(
        buildMultiplayerGameEndingInfo(
          m,
          incapReason === "death" ? "death" : "failure",
          incapReason === "death"
            ? "所有调查员生命值归零，已无法继续行动。"
            : "所有调查员理智值归零，已无法继续调查。"
        )
      );
      return { ...state, dynamicGameState: m.getState() };
    }

    // Combat path: only HP/Sanity check needed, skip remaining checks
    const currentRoom = m.getSceneRoom(state.sceneRoomId);
    if (currentRoom?.isBattle) {
      console.log("   ✓ [MP Game End Check] Combat path — skipping trigger/victory checks");
      return { ...state, dynamicGameState: m.getState() };
    }

    // Check 2: Rest-freeze guard — defer trigger check when resting in multi-room games
    const isRestRound =
      sceneRoom.temporaryInfo?.contextualData?.isRestRound === true;
    const activeRooms = m.getActiveSceneRooms();

    if (isRestRound && activeRooms.length > 1) {
      console.log(
        `💤 [MP Game End Check] Rest round detected with ${activeRooms.length} active rooms — deferring trigger check, rest-freezing sceneRoom ${state.sceneRoomId}`
      );
      m.restFreezeSceneRoom(state.sceneRoomId);
      return { ...state, dynamicGameState: m.getState() };
    }

    // Check 3: Global trigger + victory
    try {
      const triggerResult =
        await directorAgent.checkGlobalTriggerAndGameEnd(m, state.sceneRoomId);

      if (triggerResult.victoryAchieved) {
        console.log(`\n🏆 [MP Victory] Victory conditions achieved!`);
        const victoryReason = triggerResult.achievedVictoryCondition
          ? `调查员成功阻止了灾难，达成胜利条件：${triggerResult.achievedVictoryCondition}`
          : "调查员成功阻止了灾难，完成了胜利条件。";
        m.setGameEnding(
          buildMultiplayerGameEndingInfo(m, "victory", victoryReason)
        );
        return { ...state, dynamicGameState: m.getState() };
      }

      if (triggerResult.triggered) {
        console.log(`\n🎯 [MP Global Trigger] Triggered!`);

        if (triggerResult.causesGameEnd) {
          console.log(`\n🏁 [MP Game End] Global trigger causes game end`);
          m.setGlobalTrigger(null);
          m.setContextualData(
            state.sceneRoomId,
            "globalTriggerEnded",
            true
          );
          m.setGameEnding(
            buildMultiplayerGameEndingInfo(
              m,
              gameState.endState?.pointOfNoReturn?.type === "time"
                ? "time_limit"
                : "failure",
              "全局触发器已推进到不可逆阶段，游戏结束。"
            )
          );
          return { ...state, dynamicGameState: m.getState() };
        }

        // Triggered but does NOT cause game end → worldline update
        console.log(
          `   ✓ Trigger fired but game continues — running worldline update`
        );

        stream?.onWorldlineUpdateStart?.();
        try {
          await directorAgent.updateNonPlayerScenarios(m);

          const finalState = m.getState();
          if (finalState.globalTrigger) {
            console.log(
              `   ✓ [Worldline] Update complete, new global trigger generated`
            );
          } else {
            console.log(
              `   ✓ [Worldline] Update complete, no new global trigger`
            );
          }

          // Fire-and-forget scene image for ALL active rooms that received worldline updates
          for (const room of m.getActiveSceneRooms()) {
            const worldlineSceneUpdate =
              room.temporaryInfo.contextualData?.worldlineSceneUpdate as
                | { updatedSnapshot?: unknown }
                | undefined;
            if (!worldlineSceneUpdate?.updatedSnapshot || !room.currentScenario) {
              continue;
            }
            const currentScenario = room.currentScenario;
            const moduleName = finalState.moduleName;
            void generateSceneRoomImage(currentScenario, moduleName)
              .then((result) => {
                if (!result) return;
                currentScenario.sceneImage = {
                  path: result.path,
                  mimeType: result.mimeType,
                  generatedAt: new Date().toISOString(),
                };
                stream?.onSceneImage?.({
                  imagePath: result.path,
                  mimeType: result.mimeType,
                  sceneName: currentScenario.name,
                  location: currentScenario.location,
                  gameDay: finalState.gameDay ?? null,
                  gameTime: finalState.timeOfDay ?? null,
                  timestamp: new Date().toISOString(),
                });
              })
              .catch((error) => {
                console.warn(
                  `[MP GameEndCheck] Worldline scene image failed for room ${room.sceneRoomId}:`,
                  error
                );
              });
          }
        } catch (error) {
          console.error(`   ❌ [MP Worldline] Update failed:`, error);
        } finally {
          stream?.onWorldlineUpdateEnd?.();
        }

        return { ...state, dynamicGameState: m.getState() };
      }

      console.log(`   ✓ No trigger fired, game continues`);
    } catch (e) {
      console.error("[MP GameEndCheck] Global trigger check failed:", e);
    }

    return { ...state, dynamicGameState: m.getState() };
  });

  // Conditional routing: gameEndCheck → epilogueKeeper | keeper | END
  graph.addConditionalEdges(
    "gameEndCheck" as any,
    (state: MultiplayerGraphState) => {
      const m = mgr(state);
      const gameState = m.getState();

      if (gameState.gameEnding?.isEnded) {
        console.log(
          "🔀 [MP Game End Router] → epilogueKeeper (gameEnding set)"
        );
        return "epilogueKeeper";
      }

      const scr = m.getSceneRoom(state.sceneRoomId);
      if (scr?.temporaryInfo.contextualData?.globalTriggerEnded) {
        console.log(
          "🔀 [MP Game End Router] → epilogueKeeper (global trigger ended)"
        );
        return "epilogueKeeper";
      }

      // Combat path: battleKeeper already generated narrative, skip keeper
      const combatRoom = m.getSceneRoom(state.sceneRoomId);
      if (combatRoom?.isBattle) {
        console.log("🔀 [MP Game End Router] → END (combat path, game continues)");
        return END;
      }

      console.log("🔀 [MP Game End Router] → keeper (game continues)");
      return "keeper";
    },
    {
      epilogueKeeper: "epilogueKeeper" as any,
      keeper: "keeper" as any,
      [END]: END,
    }
  );

  // ---- EPILOGUE KEEPER ----

  graph.addNode("epilogueKeeper", async (state: MultiplayerGraphState) => {
    console.log("📜 [MP EpilogueKeeper] Generating epilogue narrative...");
    const m = mgr(state);
    const language =
      state.language === "en" || state.language === "zh" ? state.language : "zh";
    // Include player names (same pattern as keeper node)
    const combinedInput = state.roundInputs
      .filter((i) => i.inputType === "input" && Boolean(i.content?.trim()))
      .map((i) => {
        const player = m.getState().players[i.playerId];
        return `${player?.characterName ?? i.playerId}: ${i.content?.trim() ?? ""}`;
      })
      .join("\n");

    // Store structured inputs for keeper template
    m.setContextualData(state.sceneRoomId, "roundInputsForKeeper", state.roundInputs);

    try {
      const result = await keeperAgent.generateEpilogue(
        combinedInput,
        m,
        state.sceneRoomId,
        language
      );
      // Store narrative + clueRevelations in sceneRoom contextualData
      const scr = m.getSceneRoom(state.sceneRoomId);
      if (scr && result?.narrative) {
        m.updateSceneRoom(state.sceneRoomId, {
          temporaryInfo: {
            ...scr.temporaryInfo,
            contextualData: {
              ...scr.temporaryInfo.contextualData,
              keeperNarrative: result.narrative,
              clueRevelations: result.clueRevelations ?? null,
            },
          },
        });
      }
    } catch (e) {
      console.error("[MP EpilogueKeeper] failed:", e);
    }

    m.clearRoundInputsForSceneRoom(state.sceneRoomId);
    return { ...state, dynamicGameState: m.getState() };
  });

  graph.addEdge("epilogueKeeper" as any, END);

  // ---- KEEPER ----

  graph.addNode("keeper", async (state: MultiplayerGraphState) => {
    console.log("📜 [MP Keeper] Generating narrative...");
    const m = mgr(state);
    const sceneRoom = m.getSceneRoom(state.sceneRoomId);
    if (!sceneRoom) return state;

    const language =
      state.language === "en" || state.language === "zh" ? state.language : "zh";

    try {
      // Include player names (same pattern as memory/combat nodes)
      const combinedInput = state.roundInputs
        .filter((i) => i.inputType === "input" && Boolean(i.content?.trim()))
        .map((i) => {
          const player = m.getState().players[i.playerId];
          return `${player?.characterName ?? i.playerId}: ${i.content?.trim() ?? ""}`;
        })
        .join("\n");

      // Store structured inputs for keeper template
      m.setContextualData(state.sceneRoomId, "roundInputsForKeeper", state.roundInputs);

      const result = await keeperAgent.generateNarrative(
        combinedInput,
        m,
        state.sceneRoomId,
        language,
        state.stream?.onNarrativeDelta
          ? { onNarrativeDelta: state.stream.onNarrativeDelta }
          : undefined
      );
      // Store narrative + clueRevelations in sceneRoom contextualData so service can broadcast/persist
      const scr = m.getSceneRoom(state.sceneRoomId);
      if (scr && result?.narrative) {
        m.updateSceneRoom(state.sceneRoomId, {
          temporaryInfo: {
            ...scr.temporaryInfo,
            contextualData: {
              ...scr.temporaryInfo.contextualData,
              keeperNarrative: result.narrative,
              clueRevelations: result.clueRevelations ?? null,
            },
          },
        });
      }
    } catch (e) {
      console.error("[MP Keeper] Narrative generation failed:", e);
    }

    // Clear round inputs for this sceneRoom after successful processing
    m.clearRoundInputsForSceneRoom(state.sceneRoomId);

    return { ...state, dynamicGameState: m.getState() };
  });

  graph.addEdge("keeper" as any, END);

  // ---- COMBAT NODES ----

  graph.addNode("combatActionA", async (state: MultiplayerGraphState) => {
    console.log("⚔️  [MP CombatActionA] Player combat turn...");
    const m = mgr(state);
    const sceneRoom = m.getSceneRoom(state.sceneRoomId);
    if (!sceneRoom) return state;

    const language =
      state.language === "en" || state.language === "zh" ? state.language : "zh";

    // Store roundInputs in contextualData so combat agent adapters can access them
    m.setContextualData(state.sceneRoomId, "roundInputs", state.roundInputs);

    // Combine all player combat inputs, marking skip vs acting
    const combinedCombatInput = state.roundInputs
      .map((i) => {
        const player = m.getState().players[i.playerId];
        const name = player?.characterName ?? i.playerId;
        if (i.inputType === "skip" || !i.content?.trim()) {
          return `${name}: [skipped this round]`;
        }
        return `${name}: ${i.content}`;
      })
      .join("\n");

    try {
      const result = await combatAgentA.resolvePlayerAttack(
        m,
        state.sceneRoomId,
        combinedCombatInput,
        null,
        language
      );
      if (result) {
        // Apply state updates (HP deltas, conditions, action logs, time)
        combatAgentA.applyResultForSceneRoom(m, state.sceneRoomId, result);
        // Store result for downstream agents (routeFromCombatA, combatActionB, battleKeeper)
        m.setContextualData(state.sceneRoomId, "combatActionAResult", result);
        if (result.combatEnded) {
          m.setContextualData(state.sceneRoomId, "combatEnded", true);
        }
      }
    } catch (e) {
      console.error("[MP CombatActionA] failed:", e);
    }

    return { ...state, dynamicGameState: m.getState() };
  });

  const routeFromCombatA = (state: MultiplayerGraphState): string => {
    const contextualData =
      mgr(state).getSceneRoom(state.sceneRoomId)?.temporaryInfo.contextualData ?? {};
    if (contextualData.combatEnded) return "battleKeeper";
    return "combatActionB";
  };

  graph.addConditionalEdges("combatActionA" as any, routeFromCombatA, {
    combatActionB: "combatActionB" as any,
    battleKeeper: "battleKeeper" as any,
  });

  graph.addNode("combatActionB", async (state: MultiplayerGraphState) => {
    console.log("⚔️  [MP CombatActionB] NPC combat turn...");
    const m = mgr(state);
    const sceneRoom = m.getSceneRoom(state.sceneRoomId);
    if (!sceneRoom) return state;

    const language =
      state.language === "en" || state.language === "zh" ? state.language : "zh";

    const combinedCombatInput = state.roundInputs
      .map((i) => {
        const player = m.getState().players[i.playerId];
        const name = player?.characterName ?? i.playerId;
        if (i.inputType === "skip" || !i.content?.trim()) {
          return `${name}: [skipped this round]`;
        }
        return `${name}: ${i.content}`;
      })
      .join("\n");

    try {
      // Use the narrative from CombatActionA if available
      const prevNarrative =
        (sceneRoom.temporaryInfo.contextualData?.combatNarrative as string) ?? "";
      // Pass combatAResult from contextualData
      const combatAResult =
        (m.getContextualData(state.sceneRoomId, "combatActionAResult") as import("../multiplayerAgent/combat/combatActionAgentA.js").CombatActionAResult) ?? null;
      await combatAgentB.generateNpcActions(
        m,
        state.sceneRoomId,
        combinedCombatInput,
        prevNarrative,
        language,
        combatAResult
      );
    } catch (e) {
      console.error("[MP CombatActionB] failed:", e);
    }

    return { ...state, dynamicGameState: m.getState() };
  });

  graph.addEdge("combatActionB" as any, "battleKeeper" as any);

  graph.addNode("battleKeeper", async (state: MultiplayerGraphState) => {
    console.log("📜 [MP BattleKeeper] Generating combat narrative...");
    const m = mgr(state);
    const sceneRoom = m.getSceneRoom(state.sceneRoomId);
    if (!sceneRoom) return state;

    const language =
      state.language === "en" || state.language === "zh" ? state.language : "zh";

    const combinedCombatInput = state.roundInputs
      .map((i) => {
        const player = m.getState().players[i.playerId];
        const name = player?.characterName ?? i.playerId;
        if (i.inputType === "skip" || !i.content?.trim()) {
          return `${name}: [skipped this round]`;
        }
        return `${name}: ${i.content}`;
      })
      .join("\n");

    try {
      const actionResults = sceneRoom.temporaryInfo.actionResults;
      const narrative = await battleKeeper.generateEntryNarrative(
        m,
        state.sceneRoomId,
        actionResults,
        combinedCombatInput,
        language,
        state.stream?.onNarrativeDelta
      );
      // Store narrative in contextualData
      const scr = m.getSceneRoom(state.sceneRoomId);
      if (scr && narrative) {
        m.updateSceneRoom(state.sceneRoomId, {
          temporaryInfo: {
            ...scr.temporaryInfo,
            contextualData: {
              ...scr.temporaryInfo.contextualData,
              keeperNarrative: narrative,
            },
          },
        });
      }
    } catch (e) {
      console.error("[MP BattleKeeper] failed:", e);
    }

    m.clearRoundInputsForSceneRoom(state.sceneRoomId);
    return { ...state, dynamicGameState: m.getState() };
  });

  graph.addEdge("battleKeeper" as any, "gameEndCheck" as any);

  // ---- Wire start ----
  graph.addEdge(START, "entry" as any);

  return graph.compile({ checkpointer });
};
