/**
 * Multiplayer Dynamic Graph
 *
 * Processes one sceneRoom's round at a time.
 * All player inputs must be collected before the graph runs.
 *
 * Pipeline: entry → orchestrator → memory → action → character → director → keeper
 * Combat:   entry → memory → combatActionA → combatEndCheck → combatActionB → battleKeeper
 *
 * No isSimulatedQuery, no simulatedQueryCount, no messages[].
 */

import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../shared/agents/memory/database/index.js";
import { ScenarioLoader } from "../../shared/agents/memory/scenarioloader/index.js";
import type { ActionResult } from "../../shared/state/index.js";
import {
  MultiplayerDynamicGameStateManager,
} from "../multiplayerState/MultiplayerDynamicGameState.js";
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
    restConsensusBySceneRoom: {},
    sessionId: "",
    gameDay: 1,
    timeOfDay: "08:00",
    scenarioTimeState: { sceneStartTime: "08:00", playerTimeConsumption: {} },
    tension: 0,
    isBattle: false,
    combatState: null,
    defeatedNpcHistory: [],
    heartbeatActions: [],
    gameEnding: null,
    keeperGuidance: null,
    moduleLimitations: null,
    npcCharacters: [],
    discoveredClues: [],
    consecutiveProgressionTriggers: 0,
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
    console.log(`🎭 [MP Entry] sceneRoom=${state.sceneRoomId} round start`);
    const m = mgr(state);
    const sceneRoom = m.getSceneRoom(state.sceneRoomId);
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
    const gs = state.dynamicGameState;
    if (gs.isBattle) return "memory";
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
    if (state.dynamicGameState.isBattle) return "combatActionA";
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
          gameTime: m.getState().timeOfDay,
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

    const language =
      state.language === "en" || state.language === "zh" ? state.language : "zh";

    try {
      await directorAgent.checkStoryProgression(m, state.sceneRoomId);
    } catch (e) {
      console.warn("[MP Director] evaluation failed:", e);
    }

    return { ...state, dynamicGameState: m.getState() };
  });

  graph.addEdge("director" as any, "keeper" as any);

  // ---- KEEPER ----

  graph.addNode("keeper", async (state: MultiplayerGraphState) => {
    console.log("📜 [MP Keeper] Generating narrative...");
    const m = mgr(state);
    const sceneRoom = m.getSceneRoom(state.sceneRoomId);
    if (!sceneRoom) return state;

    const language =
      state.language === "en" || state.language === "zh" ? state.language : "zh";

    try {
      const combinedInput = state.roundInputs
        .filter((i) => i.inputType === "input" && Boolean(i.content?.trim()))
        .map((i) => i.content?.trim() ?? "")
        .join("\n");
      const result = await keeperAgent.generateNarrative(
        combinedInput,
        m,
        state.sceneRoomId,
        language,
        state.stream?.onNarrativeDelta
          ? { onNarrativeDelta: state.stream.onNarrativeDelta }
          : undefined
      );
      // Store narrative in sceneRoom contextualData so service can broadcast it
      const scr = m.getSceneRoom(state.sceneRoomId);
      if (scr && result?.narrative) {
        m.updateSceneRoom(state.sceneRoomId, {
          temporaryInfo: {
            ...scr.temporaryInfo,
            contextualData: {
              ...scr.temporaryInfo.contextualData,
              keeperNarrative: result.narrative,
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

    // Combine all player combat inputs into a single combined input
    const combinedCombatInput = state.roundInputs
      .map((i) => {
        const player = m.getState().players[i.playerId];
        return `${player?.characterName ?? i.playerId}: ${i.content ?? ""}`;
      })
      .join("\n");

    try {
      await combatAgentA.resolvePlayerAttackForSceneRoom(
        m,
        state.sceneRoomId,
        combinedCombatInput,
        null,
        language
      );
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
        return `${player?.characterName ?? i.playerId}: ${i.content ?? ""}`;
      })
      .join("\n");

    try {
      // Use the narrative from CombatActionA if available
      const prevNarrative =
        (sceneRoom.temporaryInfo.contextualData?.combatNarrative as string) ?? "";
      await combatAgentB.generateNpcActionsForSceneRoom(
        m,
        state.sceneRoomId,
        combinedCombatInput,
        prevNarrative,
        language,
        null
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
        return `${player?.characterName ?? i.playerId}: ${i.content ?? ""}`;
      })
      .join("\n");

    try {
      const actionResults = sceneRoom.temporaryInfo.actionResults;
      const narrative = await battleKeeper.generateEntryNarrativeForSceneRoom(
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

  graph.addEdge("battleKeeper" as any, END);

  // ---- Wire start ----
  graph.addEdge(START, "entry" as any);

  return graph.compile({ checkpointer });
};
