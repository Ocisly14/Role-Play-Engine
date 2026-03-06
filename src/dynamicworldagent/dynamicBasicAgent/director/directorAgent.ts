import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../../models/index.js";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../../shared/agents/memory/database/index.js";
import type { ScenarioLoader } from "../../../shared/agents/memory/scenarioloader/index.js";
import { composeTemplate } from "../../../template.js";
import type { DynamicGameState } from "../../state/index.js";
import type { DynamicGameStateManager } from "../../state/index.js";
import type { DynamicScenarioSnapshot } from "../../world_builder/types.js";
import {
  type RetrievedSessionRagChunk,
  SessionRagService,
} from "../knowledge/sessionRagService.js";
import {
  getGlobalTriggerEventCheckTemplate,
  getStuckHintNarrativeTemplate,
} from "./directorAuxTemplates.js";

interface DirectorRuntime {
  modelProvider: ModelProviderName;
  getSetting: (key: string) => string | undefined;
}

const createRuntime = (): DirectorRuntime => ({
  modelProvider:
    (process.env.MODEL_PROVIDER as ModelProviderName) ||
    ModelProviderName.OPENAI,
  getSetting: (key: string) => process.env[key],
});

const TRIGGER_RAG_MIN_SCORE = 0.7;

type TriggerQueryType = "global_event" | "victory_condition";

interface TriggerEvidenceItem {
  sourceKey: string;
  turnNumber: number | null;
  segmentType: "narrative" | "actionlog";
  score: number;
  content: string;
  matchedBy: Array<{
    queryType: TriggerQueryType;
    query: string;
  }>;
}

interface CurrentTurnActionLogItem {
  character: string;
  time: string;
  location: string;
  summary: string;
  source: "actionResults" | "actionResultsDetailed";
}

/**
 * Director Agent - Story progression and scene transition director
 * Responsible for monitoring game progress and advancing story development
 */
export class DirectorAgent {
  private scenarioLoader: ScenarioLoader;
  private db: CoCDatabase | CoCDatabaseAdapter;
  private sessionRagService: SessionRagService;

  constructor(
    scenarioLoader: ScenarioLoader,
    db: CoCDatabase | CoCDatabaseAdapter
  ) {
    this.scenarioLoader = scenarioLoader;
    this.db = db;
    this.sessionRagService = new SessionRagService();
  }

  /**
   * Execute scene transition (shared logic)
   */
  private async executeSceneTransition(
    targetSnapshot: DynamicScenarioSnapshot,
    scenarioName: string,
    gameStateManager: DynamicGameStateManager
  ): Promise<void> {
    const dynamicState = gameStateManager.getState();

    console.log(`\n🔄 [Executing Scene Transition]:`);
    console.log(`   To: ${targetSnapshot.name}`);
    console.log(`   Location: ${targetSnapshot.location}`);

    try {
      gameStateManager.updateCurrentScenario({
        snapshot: targetSnapshot,
        scenarioName: scenarioName,
      });

      const updatedState = gameStateManager.getState();

      console.log(`   ✓ Scene transition completed successfully`);
      console.log(`\n📍 [Post-Transition State]:`);
      console.log(
        `   Current Scene: ${updatedState.currentScenario?.name || "None"}`
      );
      console.log(`   Scene ID: ${updatedState.currentScenario?.id || "None"}`);
      console.log(
        `   Location: ${updatedState.currentScenario?.location || "None"}`
      );

      console.log(`\n✅ [Director Agent] Scene transition completed`);
      console.log(
        `🎬 [Director Agent] ========================================\n`
      );
    } catch (error) {
      console.error(`   ❌ Scene transition failed:`, error);
      throw error;
    }
  }

  /**
   * Handle scene change request initiated by Action Agent.
   * Looks up existing snapshot for the target scene and executes the transition.
   */
  async handleActionDrivenSceneChange(
    gameStateManager: DynamicGameStateManager,
    targetSceneName: string,
    reason: string,
    currentCharacterInput?: string
  ): Promise<void> {
    console.log(
      `\n🎬 [Director Agent] ========================================`
    );
    console.log(
      `🎬 [Director Agent] Starting to process Action-driven scene transition`
    );
    console.log(`🎬 [Director Agent] ========================================`);

    const dynamicState = gameStateManager.getState();
    const currentScenario = dynamicState.currentScenario;
    const sceneChangeRequest = dynamicState.temporaryInfo.sceneChangeRequest;

    // Save current scenario as previousScenario for Keeper to access
    if (currentScenario) {
      dynamicState.temporaryInfo.previousScenario = { ...currentScenario };
      console.log(
        `\n💾 [Director Agent] Saved previous scenario: ${currentScenario.name}`
      );
    }

    if (!sceneChangeRequest?.shouldChange) {
      console.log(`   ⚠️  No scene change request found, skipping transition`);
      return;
    }

    console.log(`\n🎯 [Scene Transition Request]:`);
    console.log(`   Target Scene Name: ${targetSceneName}`);
    console.log(`   Transition Reason: ${reason}`);

    // Find target scenario from outlines
    const targetScenarioOutline = dynamicState.scenarioOutlines.find(
      (outline) =>
        outline.name === targetSceneName || outline.id === targetSceneName
    );

    if (!targetScenarioOutline) {
      console.error(
        `   ❌ Target scenario not found in outlines: ${targetSceneName}`
      );
      gameStateManager.clearSceneChangeRequest();
      return;
    }

    // Get existing snapshot for target scene
    const targetSnapshot = await this.getLatestScenarioSnapshot(
      targetScenarioOutline.id,
      dynamicState
    );

    if (!targetSnapshot) {
      console.error(
        `   ❌ No snapshot found for target scenario: ${targetSceneName}`
      );
      gameStateManager.clearSceneChangeRequest();
      return;
    }

    console.log(`   ✓ Found target snapshot: ${targetScenarioOutline.name}`);

    // Save snapshot to state
    gameStateManager.setDb(this.db);
    await gameStateManager.setUpdatedDynamicScenarioSnapshot(
      targetScenarioOutline.id,
      targetSnapshot
    );

    // Execute scene transition
    await this.executeSceneTransition(
      targetSnapshot,
      targetScenarioOutline.name,
      gameStateManager
    );

    // Clean up scene change request
    gameStateManager.clearSceneChangeRequest();

    console.log(`✅ [Director Agent] Scene change completed successfully`);
    console.log(
      `🎬 [Director Agent] ========================================\n`
    );
  }

  /**
   * Parse game time from snapshot gameTime string or actionLog time
   * Format: "Day N, HH:MM" or "initial" or other formats
   */
  private parseGameTimeFromSnapshot(
    gameTime?: string
  ): { gameDay: number; timeOfDay: string } | null {
    if (!gameTime) return null;

    if (gameTime.toLowerCase() === "initial" || !gameTime.includes("Day")) {
      return null;
    }

    const match = gameTime.match(/Day\s*(\d+),\s*(\d{2}:\d{2})/i);
    if (match) {
      return {
        gameDay: Number.parseInt(match[1], 10),
        timeOfDay: match[2],
      };
    }

    return null;
  }

  private async getLatestScenarioSnapshot(
    scenarioId: string,
    dynamicState: DynamicGameState
  ): Promise<DynamicScenarioSnapshot | null> {
    const updatedSnapshots =
      dynamicState.updatedDynamicScenarioSnapshots.get(scenarioId);
    if (updatedSnapshots && updatedSnapshots.length > 0) {
      return updatedSnapshots[updatedSnapshots.length - 1];
    }

    const scenarioProfile =
      await this.scenarioLoader.getScenarioById(scenarioId);
    return scenarioProfile?.snapshot || null;
  }

  /**
   * Check if global trigger time restriction has been reached
   * @returns true if current game time >= trigger time, false otherwise
   */
  checkGlobalTriggerTime(gameStateManager: DynamicGameStateManager): boolean {
    const dynamicState = gameStateManager.getState();
    const globalTrigger = dynamicState.globalTrigger;

    if (!globalTrigger || !globalTrigger.timeRestriction) {
      return false;
    }

    const currentGameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    const triggerTime = globalTrigger.timeRestriction;

    const currentTime = this.parseGameTimeFromSnapshot(currentGameTime);
    const targetTime = this.parseGameTimeFromSnapshot(triggerTime);

    if (!currentTime || !targetTime) {
      console.warn(
        `   ⚠️ Failed to parse time: current="${currentGameTime}", trigger="${triggerTime}"`
      );
      return false;
    }

    const timeReached =
      currentTime.gameDay > targetTime.gameDay ||
      (currentTime.gameDay === targetTime.gameDay &&
        this.compareTimeOfDay(currentTime.timeOfDay, targetTime.timeOfDay) >=
          0);

    if (timeReached) {
      console.log(`   ⏰ Global trigger time reached: ${triggerTime}`);
      if (globalTrigger.timeReason) {
        console.log(`      Reason: ${globalTrigger.timeReason}`);
      }
    }

    return timeReached;
  }

  private async searchTriggerChunks(
    sessionId: string,
    query: string,
    segmentType: "narrative" | "actionlog",
    topK: number
  ): Promise<RetrievedSessionRagChunk[]> {
    const searches = await Promise.all([
      this.sessionRagService.searchHybrid({
        sessionId,
        ragQuery: query,
        topK,
        semanticWeight: 0.7,
        bm25Weight: 0.3,
        language: "zh",
        chunkType: "turn",
        segmentType,
      }),
      this.sessionRagService.searchHybrid({
        sessionId,
        ragQuery: query,
        topK,
        semanticWeight: 0.7,
        bm25Weight: 0.3,
        language: "en",
        chunkType: "turn",
        segmentType,
      }),
    ]);

    const deduped = new Map<string, RetrievedSessionRagChunk>();
    for (const result of searches.flat()) {
      const key = result.sourceKey || result.id;
      const existing = deduped.get(key);
      if (!existing || result.score > existing.score) {
        deduped.set(key, result);
      }
    }

    return Array.from(deduped.values())
      .filter((item) => item.score >= TRIGGER_RAG_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private async retrieveTriggerEvidenceFromRag(params: {
    sessionId: string;
    globalEvents: string[];
    victoryConditions: string[];
  }): Promise<TriggerEvidenceItem[]> {
    const { sessionId, globalEvents, victoryConditions } = params;
    const evidenceMap = new Map<string, TriggerEvidenceItem>();

    const queryDefs: Array<{ queryType: TriggerQueryType; query: string }> = [
      ...globalEvents.map((query) => ({ queryType: "global_event" as const, query })),
      ...victoryConditions.map((query) => ({
        queryType: "victory_condition" as const,
        query,
      })),
    ].filter((item) => typeof item.query === "string" && item.query.trim().length > 0);

    for (const def of queryDefs) {
      const query = def.query.trim();
      const [narrativeChunks, actionLogChunks] = await Promise.all([
        this.searchTriggerChunks(sessionId, query, "narrative", 3),
        this.searchTriggerChunks(sessionId, query, "actionlog", 3),
      ]);

      const combined = [
        ...narrativeChunks.map((chunk) => ({
          chunk,
          segmentType: "narrative" as const,
        })),
        ...actionLogChunks.map((chunk) => ({
          chunk,
          segmentType: "actionlog" as const,
        })),
      ];

      for (const entry of combined) {
        const key = entry.chunk.sourceKey || entry.chunk.id;
        const existing = evidenceMap.get(key);

        if (!existing) {
          evidenceMap.set(key, {
            sourceKey: entry.chunk.sourceKey,
            turnNumber: entry.chunk.turnNumber,
            segmentType: entry.segmentType,
            score: entry.chunk.score,
            content: entry.chunk.content,
            matchedBy: [{ queryType: def.queryType, query }],
          });
          continue;
        }

        if (entry.chunk.score > existing.score) {
          existing.score = entry.chunk.score;
          existing.content = entry.chunk.content;
          existing.turnNumber = entry.chunk.turnNumber;
          existing.segmentType = entry.segmentType;
        }

        if (
          !existing.matchedBy.some(
            (m) => m.queryType === def.queryType && m.query === query
          )
        ) {
          existing.matchedBy.push({ queryType: def.queryType, query });
        }
      }
    }

    return Array.from(evidenceMap.values()).sort((a, b) => b.score - a.score);
  }

  private collectCurrentTurnActionLogs(
    dynamicState: DynamicGameState
  ): CurrentTurnActionLogItem[] {
    const rows: CurrentTurnActionLogItem[] = [];
    const dedupe = new Set<string>();

    const push = (row: CurrentTurnActionLogItem): void => {
      const summary = row.summary.trim();
      if (!summary) return;
      const key = `${row.character}|${row.time}|${row.location}|${summary}`;
      if (dedupe.has(key)) return;
      dedupe.add(key);
      rows.push({
        ...row,
        summary,
      });
    };

    const actionResults = dynamicState.temporaryInfo.actionResults || [];
    for (const result of actionResults) {
      push({
        character: result.character || "Unknown",
        time: result.gameTime || `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`,
        location:
          result.location || dynamicState.currentScenario?.location || "Unknown",
        summary: result.result || "",
        source: "actionResults",
      });
    }

    const detailed = dynamicState.temporaryInfo.actionResultsDetailed || [];
    for (const item of detailed) {
      const actor =
        typeof item.character === "string" && item.character.trim().length > 0
          ? item.character
          : "Unknown";
      const defaultTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
      const defaultLocation = dynamicState.currentScenario?.location || "Unknown";

      const collectFromLogs = (logs: unknown): void => {
        if (!Array.isArray(logs)) return;
        for (const rawLog of logs) {
          if (!rawLog || typeof rawLog !== "object") continue;
          const log = rawLog as Record<string, unknown>;
          if (typeof log.summary !== "string" || !log.summary.trim()) continue;

          push({
            character:
              typeof log.character === "string" && log.character.trim().length > 0
                ? log.character
                : actor,
            time:
              typeof log.time === "string" && log.time.trim().length > 0
                ? log.time
                : defaultTime,
            location:
              typeof log.location === "string" && log.location.trim().length > 0
                ? log.location
                : defaultLocation,
            summary: log.summary,
            source: "actionResultsDetailed",
          });
        }
      };

      collectFromLogs(item.actionLog);

      if (Array.isArray(item.npcResponses)) {
        for (const npcResponse of item.npcResponses) {
          if (!npcResponse || typeof npcResponse !== "object") continue;
          const response = npcResponse as Record<string, unknown>;
          collectFromLogs(response.actionLog);
        }
      }
    }

    return rows;
  }

  /**
   * Check global trigger and victory trigger simultaneously
   * Combines time check and event check for doom, and checks victory conditions
   * @returns { triggered: boolean, causesGameEnd: boolean, victoryAchieved: boolean }
   */
  async checkGlobalTriggerAndGameEnd(
    gameStateManager: DynamicGameStateManager
  ): Promise<{
    triggered: boolean;
    causesGameEnd: boolean;
    victoryAchieved: boolean;
    achievedVictoryCondition: string | null;
  }> {
    const dynamicState = gameStateManager.getState();
    const globalTrigger = dynamicState.globalTrigger;
    const endState = dynamicState.endState;
    const victoryTrigger = dynamicState.moduleDigest?.victoryTrigger;

    // Reset trigger-check context every time to avoid stale epilogue evidence.
    gameStateManager.setContextualData("triggerCheckEvidence", []);
    gameStateManager.setContextualData("triggerCheckCurrentTurnActionLogs", []);
    gameStateManager.setContextualData("triggerCheckAchievedVictoryCondition", null);
    gameStateManager.setContextualData("triggerCheckResult", null);

    // If no global trigger, return early
    if (!globalTrigger) {
      return {
        triggered: false,
        causesGameEnd: false,
        victoryAchieved: false,
        achievedVictoryCondition: null,
      };
    }

    console.log(
      `\n🔍 [Director Agent] Checking global trigger and game end conditions...`
    );

    let triggered = false;

    // Check 1: Time restriction
    const timeReached = this.checkGlobalTriggerTime(gameStateManager);
    if (timeReached) {
      triggered = true;
    }

    // Check 2: Event/condition evidence via RAG
    const globalEvents = (globalTrigger.events || []).filter(
      (event): event is string => typeof event === "string" && event.trim().length > 0
    );
    const victoryConditions = (victoryTrigger?.conditions || []).filter(
      (condition): condition is string =>
        typeof condition === "string" && condition.trim().length > 0
    );

    const shouldRunEvidenceCheck =
      (!triggered && globalEvents.length > 0) || victoryConditions.length > 0;

    if (shouldRunEvidenceCheck) {
      const triggerEvidence = await this.retrieveTriggerEvidenceFromRag({
        sessionId: dynamicState.sessionId,
        globalEvents,
        victoryConditions,
      });
      const currentTurnActionLogs = this.collectCurrentTurnActionLogs(dynamicState);
      gameStateManager.setContextualData("triggerCheckEvidence", triggerEvidence);
      gameStateManager.setContextualData(
        "triggerCheckCurrentTurnActionLogs",
        currentTurnActionLogs
      );

      if (triggerEvidence.length > 0 || currentTurnActionLogs.length > 0) {
        console.log(
          `   📚 Retrieved ${triggerEvidence.length} deduped trigger evidence chunks from RAG`
        );
        console.log(
          `   🕒 Collected ${currentTurnActionLogs.length} current-turn action logs`
        );

        const runtime = createRuntime();
        const template = getGlobalTriggerEventCheckTemplate();

        const templateContext = {
          globalTriggerJson: JSON.stringify(globalTrigger, null, 2),
          endStateJson: endState ? JSON.stringify(endState, null, 2) : "null",
          victoryTriggerJson: victoryTrigger
            ? JSON.stringify(victoryTrigger, null, 2)
            : null,
          triggerEvidenceJson: JSON.stringify(triggerEvidence, null, 2),
          currentTurnActionLogsJson: JSON.stringify(currentTurnActionLogs, null, 2),
        };

        const prompt = composeTemplate(
          template,
          { dynamicGameState: dynamicState },
          templateContext,
          "handlebars"
        );

        try {
          const response = await generateText({
            runtime,
            context: prompt,
            modelClass: ModelClass.SMALL,
          });

          let parsed: {
            triggered: boolean;
            causesGameEnd: boolean;
            victoryAchieved: boolean;
            achievedVictoryCondition?: string | null;
          };
          try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            parsed = JSON.parse(jsonMatch ? jsonMatch[0] : response);
          } catch (error) {
            console.error(
              "   ❌ Failed to parse trigger check response:",
              error
            );
            return {
              triggered: false,
              causesGameEnd: false,
              victoryAchieved: false,
              achievedVictoryCondition: null,
            };
          }

          if (parsed.victoryAchieved) {
            console.log(`   🏆 Victory conditions achieved!`);
            gameStateManager.setContextualData(
              "triggerCheckAchievedVictoryCondition",
              parsed.achievedVictoryCondition ?? null
            );
            gameStateManager.setContextualData("triggerCheckResult", parsed);
            return {
              triggered: parsed.triggered || triggered,
              causesGameEnd: false,
              victoryAchieved: true,
              achievedVictoryCondition: parsed.achievedVictoryCondition ?? null,
            };
          }

          if (parsed.triggered) {
            console.log(
              `   ✅ Global trigger triggered${parsed.causesGameEnd ? " AND causes game end" : " but does NOT cause game end"}`
            );
            gameStateManager.setContextualData("triggerCheckResult", parsed);
            return {
              triggered: true,
              causesGameEnd: parsed.causesGameEnd,
              victoryAchieved: false,
              achievedVictoryCondition: null,
            };
          }
        } catch (error) {
          console.error("   ❌ Error checking global trigger events:", error);
          return {
            triggered: false,
            causesGameEnd: false,
            victoryAchieved: false,
            achievedVictoryCondition: null,
          };
        }
      }
    }

    // If time reached, check if it causes game end
    if (triggered && timeReached) {
      if (endState && endState.pointOfNoReturn.type === "time") {
        const pointOfNoReturnReached = gameStateManager.checkPointOfNoReturn(
          dynamicState.gameDay,
          dynamicState.timeOfDay
        );
        if (pointOfNoReturnReached) {
          console.log(
            `   ✅ Global trigger time reached AND causes game end (point of no return)`
          );
          return {
            triggered: true,
            causesGameEnd: true,
            victoryAchieved: false,
            achievedVictoryCondition: null,
          };
        }
      }
      console.log(
        `   ✅ Global trigger time reached but does NOT cause game end`
      );
      return {
        triggered: true,
        causesGameEnd: false,
        victoryAchieved: false,
        achievedVictoryCondition: null,
      };
    }

    return {
      triggered: false,
      causesGameEnd: false,
      victoryAchieved: false,
      achievedVictoryCondition: null,
    };
  }

  /**
   * Generate a stuck-hint narrative when the player appears stuck.
   * Builds context (game time, tension, current scene snapshot, connections, last 3 inputs/narratives),
   * calls the stuck-hint template and LLM, parses { "narrative": string } and returns the narrative.
   * @returns The hint narrative string, or null if no current scenario, parse failure, or LLM error.
   */
  async generateStuckHintNarrative(
    gameStateManager: DynamicGameStateManager
  ): Promise<string | null> {
    const dynamicState = gameStateManager.getState();
    const currentScenario = dynamicState.currentScenario;

    if (!currentScenario) {
      return null;
    }

    const gameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    const tension = dynamicState.tension;

    const currentSceneSnapshotJson = JSON.stringify(currentScenario, null, 2);

    const currentScenarioOutline = dynamicState.scenarioOutlines.find(
      (outline) =>
        outline.id === currentScenario.id ||
        outline.name === currentScenario.name
    );
    const rawConnections = currentScenarioOutline?.connections || [];
    const connections = rawConnections.map((conn) => {
      const targetScenario = dynamicState.scenarioOutlines.find(
        (outline) =>
          outline.name === conn.scenarioName || outline.id === conn.scenarioName
      );
      return {
        scenarioName: targetScenario?.name ?? conn.scenarioName,
        relationshipType: conn.relationshipType,
        description: conn.description,
        blocked: conn.blocked,
        blockReason: conn.blockReason,
      };
    });
    const scenarioConnectionsJson = JSON.stringify(connections, null, 2);

    const conversationHistory =
      (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
        turnNumber: number;
        characterInput: string;
        keeperNarrative: string | null;
      }>) ?? [];
    const recentTurns = conversationHistory.slice(-3).map((t) => ({
      turnNumber: t.turnNumber,
      characterInput: t.characterInput,
      keeperNarrative: t.keeperNarrative,
    }));

    const runtime = createRuntime();
    const template = getStuckHintNarrativeTemplate();
    const templateContext = {
      gameTime,
      tension,
      currentSceneSnapshotJson,
      scenarioConnectionsJson,
      recentTurns,
    };

    const prompt = composeTemplate(
      template,
      { dynamicGameState: dynamicState },
      templateContext,
      "handlebars"
    );

    try {
      const response = await generateText({
        runtime,
        context: prompt,
        modelClass: ModelClass.SMALL,
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      const raw = jsonMatch ? jsonMatch[0] : response;
      const parsed = JSON.parse(raw) as { narrative?: string };
      if (typeof parsed.narrative === "string") {
        return parsed.narrative;
      }
      return null;
    } catch (error) {
      console.error(
        "[Director Agent] generateStuckHintNarrative failed:",
        error
      );
      return null;
    }
  }

  /**
   * Compare two time-of-day strings (HH:MM format)
   * @returns negative if time1 < time2, 0 if equal, positive if time1 > time2
   */
  private compareTimeOfDay(time1: string, time2: string): number {
    const [h1, m1] = time1.split(":").map(Number);
    const [h2, m2] = time2.split(":").map(Number);

    const minutes1 = h1 * 60 + m1;
    const minutes2 = h2 * 60 + m2;

    return minutes1 - minutes2;
  }
}
