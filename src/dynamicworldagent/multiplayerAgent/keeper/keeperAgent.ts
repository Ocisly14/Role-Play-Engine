import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../../models/index.js";
import type {
  ActionLogEntry,
  NPCClue,
} from "../../../shared/agents/models/gameTypes.js";
import type { ScenarioClue } from "../../../shared/agents/models/scenarioTypes.js";
import type {
  ActionResult,
  DiscoveredClue,
} from "../../../shared/state/index.js";
import { composeTemplateWithImages } from "../../../template.js";
import type {
  DynamicGameState,
  DynamicGameStateManager,
  HeartbeatActivatedNarrative,
} from "../../state/index.js";
import type { MultiplayerDynamicGameStateManager } from "../../multiplayerState/MultiplayerDynamicGameState.js";
import type { DynamicCharacterProfile } from "../../world_builder/types.js";
import type { DynamicNPCProfile } from "../../world_builder/types.js";
import { getEpilogueTemplate, getKeeperTemplate } from "./keeperTemplate.js";

interface KeeperRuntime {
  modelProvider: ModelProviderName;
  getSetting: (key: string) => string | undefined;
}

const createRuntime = (): KeeperRuntime => ({
  modelProvider:
    (process.env.MODEL_PROVIDER as ModelProviderName) ||
    ModelProviderName.OPENAI,
  getSetting: (key: string) => process.env[key],
});

/**
 * Keeper Agent - Game master for narrative generation and storytelling
 */
export class KeeperAgent {
  private static readonly SUCCESSFUL_OR_FUMBLE_LEVELS = new Set([
    "regular",
    "hard",
    "extreme",
    "critical",
    "fumble",
  ]);

  private deriveClueAccessFromTurn(
    detailedResultsRaw: Array<Record<string, unknown>>
  ): { allowRegularPlus: boolean; hasFumble: boolean } {
    const levels: string[] = [];

    const collectFromActionLogs = (entry: unknown) => {
      if (!Array.isArray(entry)) return;
      for (const log of entry) {
        if (!log || typeof log !== "object") continue;
        const level = (log as Record<string, unknown>).successLevel;
        if (typeof level === "string") {
          levels.push(level.toLowerCase());
        }
      }
    };

    for (const detail of detailedResultsRaw) {
      collectFromActionLogs(detail.actionLog);
      if (Array.isArray(detail.npcResponses)) {
        for (const npcResponse of detail.npcResponses) {
          if (!npcResponse || typeof npcResponse !== "object") continue;
          collectFromActionLogs(
            (npcResponse as Record<string, unknown>).actionLog
          );
        }
      }
    }

    const allowRegularPlus = levels.some((level) =>
      KeeperAgent.SUCCESSFUL_OR_FUMBLE_LEVELS.has(level)
    );
    const hasFumble = levels.includes("fumble");
    return { allowRegularPlus, hasFumble };
  }

  private filterScenarioCluesForKeeper(
    clues: ScenarioClue[] | undefined,
    allowRegularPlus: boolean
  ): ScenarioClue[] {
    if (!Array.isArray(clues)) return [];
    return clues
      .filter((clue) => {
        if (!clue) return false;
        if (clue.discovered) return true;
        if (clue.damaged) return false;
        if (clue.difficulty === "automatic") return true;
        return allowRegularPlus;
      })
      .map((clue) => ({ ...clue }));
  }

  private filterNpcCluesForKeeper(
    clues: NPCClue[] | undefined,
    allowRegularPlus: boolean
  ): NPCClue[] {
    if (!Array.isArray(clues)) return [];
    return clues
      .filter((clue) => {
        if (!clue) return false;
        if (clue.revealed) return true;
        return allowRegularPlus;
      })
      .map((clue) => ({ ...clue }));
  }

  /**
   * Generate narrative description with clue revelation based on current game state and user query
   */
  /**
   * Build a DynamicGameStateManager-compatible adapter from MultiplayerDynamicGameStateManager.
   * Internal helper — not exported.
   */
  private buildManagerAdapter(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string
  ): DynamicGameStateManager {
    const getView = (): any => {
      const s = manager.getState();
      const scr = manager.getSceneRoom(sceneRoomId);
      const playerIds = scr?.memberPlayerIds ?? [];
      const aggregatedActionLog: ActionLogEntry[] = playerIds
        .flatMap((id) => ((s.players[id]?.profile as any)?.actionLog ?? []) as ActionLogEntry[]);
      const firstPlayer = s.players[playerIds[0]];
      return {
        ...s,
        currentScenario: scr?.currentScenario ?? null,
        temporaryInfo: scr?.temporaryInfo ?? {
          rules: [],
          contextualData: {},
          actionResults: [],
          actionResultsDetailed: [],
          currentActionAnalysis: null,
          npcResponseAnalyses: [],
          sceneChangeRequest: null,
          previousScenario: null,
        },
        turnsInCurrentScene: scr?.turnsInCurrentScene ?? 0,
        playerCharacter: {
          ...(firstPlayer?.profile ?? {}),
          id: firstPlayer?.characterId ?? "",
          name: playerIds
            .map((id) => s.players[id]?.characterName)
            .filter(Boolean)
            .join(", "),
          actionLog: aggregatedActionLog,
        },
      };
    };

    return {
      getState: getView,
      getFullGameTime: () => manager.getFullGameTime(),
      updateTension: (level: number) => manager.updateTension(level),
      clearActionResults: () => manager.clearActionResults(sceneRoomId),
      clearNPCResponseAnalyses: () => manager.clearNPCResponseAnalyses(sceneRoomId),
      clearActionAnalysis: () => manager.clearActionAnalysis(sceneRoomId),
      addDiscoveredClue: (clue: any) => manager.addDiscoveredClue(clue),
      setContextualData: (key: string, value: any) =>
        manager.setContextualData(sceneRoomId, key, value),
      getContextualData: (key: string) =>
        manager.getContextualData(sceneRoomId, key),
    } as unknown as DynamicGameStateManager;
  }

  async generateNarrative(
    characterInput: string,
    managerOrDgsm: MultiplayerDynamicGameStateManager | DynamicGameStateManager,
    sceneRoomIdOrLanguage: string,
    languageOrOptions?: "en" | "zh" | { onNarrativeDelta?: (delta: string) => void },
    options?: { onNarrativeDelta?: (delta: string) => void }
  ): Promise<{
    narrative: string;
    clueRevelations: any;
    updatedGameState: DynamicGameState;
  }> {
    // Overload resolution
    let gameStateManager: DynamicGameStateManager;
    let language: "en" | "zh" = "zh";
    let selectedSkill: string | null = null;

    if ("getSceneRoom" in managerOrDgsm) {
      // New multiplayer signature: (characterInput, manager, sceneRoomId, language?, options?)
      const manager = managerOrDgsm as MultiplayerDynamicGameStateManager;
      const sceneRoomId = sceneRoomIdOrLanguage;
      language = (typeof languageOrOptions === "string" ? languageOrOptions : "zh") as "en" | "zh";
      options = typeof languageOrOptions === "object" && !Array.isArray(languageOrOptions)
        ? languageOrOptions
        : options;
      gameStateManager = this.buildManagerAdapter(manager, sceneRoomId);
    } else {
      // Old single-player signature: (characterInput, dgsm, language?, selectedSkill?, options?)
      gameStateManager = managerOrDgsm as DynamicGameStateManager;
      language = (typeof sceneRoomIdOrLanguage === "string" && (sceneRoomIdOrLanguage === "en" || sceneRoomIdOrLanguage === "zh"))
        ? sceneRoomIdOrLanguage as "en" | "zh"
        : "zh";
      options = typeof languageOrOptions === "object" && !Array.isArray(languageOrOptions)
        ? languageOrOptions
        : options;
      // Note: selectedSkill is not passed in the new multiplayer API; remains null
    }

    const runtime = createRuntime();
    const dynamicState = gameStateManager.getState();

    // 2. Get all action results (player first, then NPCs in executionOrder; same round fed from character → npcAction flow)
    const allActionResultsRaw = this.getAllActionResults(dynamicState);

    // Filter out fields not used in template (diceRolls, location)
    const allActionResults: Omit<ActionResult, "diceRolls" | "location">[] =
      allActionResultsRaw.map(({ diceRolls, location, ...result }) => result);

    // 2.1 Get full action outputs for keeper prompt
    const detailedResultsRaw = this.getAllActionResultsDetailed(dynamicState);
    const allActionResultsDetailed =
      detailedResultsRaw.length > 0
        ? detailedResultsRaw.map((detail, index) => {
            const character =
              typeof detail.character === "string"
                ? detail.character
                : `Action ${index}`;
            return {
              character,
              actionResultJson: this.safeStringify(detail),
            };
          })
        : null;

    const clueAccess = this.deriveClueAccessFromTurn(
      detailedResultsRaw as Array<Record<string, unknown>>
    );

    // 1. Get complete scenario information (with clue filtering by current turn outcomes)
    const completeScenarioInfo = this.extractCompleteScenarioInfo(
      dynamicState,
      clueAccess.allowRegularPlus
    );

    // 2.1. Get the latest complete action result (for backward compatibility)
    const latestCompleteActionResult =
      allActionResults.length > 0
        ? allActionResults[allActionResults.length - 1]
        : null;

    // 2.2. Get interaction partner name (if action targets an NPC)
    const actionAnalysis = dynamicState.temporaryInfo.currentActionAnalysis;
    const actionTargetName = actionAnalysis?.target?.name || null;
    const actionTargetIntent = actionAnalysis?.target?.intent?.trim()
      ? actionAnalysis.target.intent.trim()
      : null;
    const hasActionTargetInfo = Boolean(actionTargetName || actionTargetIntent);
    const interactionPartnerName = actionTargetName;

    // 3. Get complete attributes of NPCs involved in action results
    const actionRelatedNpcs = this.extractActionRelatedNpcs(
      dynamicState,
      allActionResults,
      interactionPartnerName,
      clueAccess.allowRegularPlus
    );

    // 5. Detect scene changes - check if sceneChangeRequest indicates a transition
    const sceneChangeRequest = dynamicState.temporaryInfo.sceneChangeRequest;
    const isTransition = sceneChangeRequest?.shouldChange === true;
    const previousScenarioInfo = isTransition
      ? this.extractPreviousScenarioInfo(dynamicState)
      : null;

    // 7. Get conversation history (from contextualData)
    const conversationHistory =
      (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
        turnNumber: number;
        characterInput: string;
        keeperNarrative: string | null;
      }>) || [];

    // 7.1. Get relevant history from RAG (from contextualData)
    const relevantHistory =
      (dynamicState.temporaryInfo.contextualData?.relevantHistory as Array<{
        type: string;
        content: string;
        score: number;
        metadata: Record<string, any>;
      }>) || [];
    const heartbeatActivatedNarrativesRaw =
      (dynamicState.temporaryInfo.contextualData
        ?.heartbeatActivatedNarratives as HeartbeatActivatedNarrative[]) || [];
    const heartbeatActivatedNarratives = heartbeatActivatedNarrativesRaw.filter(
      (item) =>
        !!item &&
        typeof item.heartbeatId === "string" &&
        item.heartbeatId.trim().length > 0 &&
        typeof item.sourceTurnId === "string" &&
        item.sourceTurnId.trim().length > 0 &&
        typeof item.sourceTurnNarrative === "string" &&
        item.sourceTurnNarrative.trim().length > 0 &&
        (item.status === "due" || item.status === "overdue")
    );
    const hasHeartbeatActivatedNarratives =
      heartbeatActivatedNarratives.length > 0;
    const worldlineSceneUpdate =
      (dynamicState.temporaryInfo.contextualData?.worldlineSceneUpdate as {
        previousSnapshot?: unknown;
        updatedSnapshot?: unknown;
        suddenActionLogs?: Array<{
          id: string;
          name?: string;
          actionLog?: ActionLogEntry[];
        }>;
        reactionNpcActionLogUpdates?: Array<{
          id: string;
          name?: string;
          actionLog?: ActionLogEntry[];
        }>;
      } | null) || null;
    const hasWorldlineSceneUpdate = Boolean(
      worldlineSceneUpdate?.previousSnapshot &&
        worldlineSceneUpdate?.updatedSnapshot
    );
    const suddenActionLogsRaw =
      (dynamicState.temporaryInfo.contextualData?.suddenActionLogs as Array<{
        id: string;
        name?: string;
        actionLog?: ActionLogEntry[];
      }>) || [];
    const suddenActionLogsTurnInScene = Number(
      dynamicState.temporaryInfo.contextualData?.suddenActionLogsTurnInScene
    );
    const hasFreshSuddenActionLogs =
      suddenActionLogsTurnInScene === dynamicState.turnsInCurrentScene;
    const suddenActionLogs = hasFreshSuddenActionLogs
      ? suddenActionLogsRaw
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            actionLog: (entry.actionLog || []).filter(
              (log) => !!log?.location && !!log?.summary
            ),
          }))
          .filter((entry) => entry.id && entry.actionLog.length > 0)
      : [];
    const hasSuddenActionLogs = suddenActionLogs.length > 0;
    const clearSuddenActionLogsContext = () => {
      if (!dynamicState.temporaryInfo.contextualData) {
        dynamicState.temporaryInfo.contextualData = {};
      }
      dynamicState.temporaryInfo.contextualData.suddenActionLogs = [];
      dynamicState.temporaryInfo.contextualData.suddenActionLogsGameTime = null;
      dynamicState.temporaryInfo.contextualData.suddenActionLogsTurnInScene =
        null;
      dynamicState.temporaryInfo.contextualData.worldlineSceneUpdate = null;
    };

    // 8. Calculate current turn number
    // Current turn is the next turn after the latest in history
    const currentTurnNumber =
      conversationHistory.length > 0
        ? Math.max(...conversationHistory.map((h) => h.turnNumber)) + 1
        : 1;

    // 9. Detect if this is the first real player turn (only true when loading module for the first time)
    // Simple check: if there's no conversation history, this is the first turn
    const isFirstRealTurn = conversationHistory.length === 0;

    // 获取模板
    const template = getKeeperTemplate(language);

    // Prepare template context (JSON-packed to keep template concise)
    const currentLocation = dynamicState.currentScenario?.location || null;
    const playerCharacterComplete = this.extractCompletePlayerCharacter(
      dynamicState.playerCharacter,
      currentLocation,
      interactionPartnerName
    );

    // Get full game time
    const fullGameTime = gameStateManager.getFullGameTime();

    // Filter sceneChangeRequest to only include narrative-relevant fields (exclude timestamp)
    const sceneChangeRequestForNarrative = sceneChangeRequest
      ? {
          shouldChange: sceneChangeRequest.shouldChange,
          targetSceneName: sceneChangeRequest.targetSceneName,
          reason: sceneChangeRequest.reason,
        }
      : null;

    const templateContext = {
      characterInput,
      allActionResultsDetailed, // Full action outputs (for {{#each}} loop)
      fullGameTime: fullGameTime, // Complete display: "Day 1, 08:00 (Morning)"
      tension: dynamicState.tension,
      isTransition,
      sceneChangeRequest: sceneChangeRequestForNarrative, // Scene change request (without timestamp)
      conversationHistory, // Recent conversation history (for {{#each}} loop)
      relevantHistory, // RAG-retrieved relevant history (for {{#each}} loop)
      hasHeartbeatActivatedNarratives,
      heartbeatActivatedNarrativesJson: hasHeartbeatActivatedNarratives
        ? this.safeStringify(heartbeatActivatedNarratives)
        : null,
      hasActionTargetInfo,
      actionTargetName,
      actionTargetIntent,
      currentTurnNumber, // Current turn number
      isFirstRealTurn, // Boolean flag for turn 1 detection
      keeperGuidance: dynamicState.keeperGuidance || null, // Module-specific keeper guidance
      allowRegularPlusClues: clueAccess.allowRegularPlus,
      hasFumbleThisTurn: clueAccess.hasFumble,
      // JSON string version (used directly in template)
      scenarioContextJson: this.safeStringify(completeScenarioInfo),
      playerCharacterJson: this.safeStringify(playerCharacterComplete),
      actionRelatedNpcsJson: this.safeStringify(actionRelatedNpcs),
      hasWorldlineSceneUpdate,
      worldlinePreviousSnapshotJson: hasWorldlineSceneUpdate
        ? this.safeStringify(worldlineSceneUpdate?.previousSnapshot || null)
        : null,
      worldlineUpdatedSnapshotJson: hasWorldlineSceneUpdate
        ? this.safeStringify(worldlineSceneUpdate?.updatedSnapshot || null)
        : null,
      worldlineSuddenActionLogsJson: hasWorldlineSceneUpdate
        ? this.safeStringify(worldlineSceneUpdate?.suddenActionLogs || [])
        : null,
      worldlineReactionNpcActionLogsJson: hasWorldlineSceneUpdate
        ? this.safeStringify(
            worldlineSceneUpdate?.reactionNpcActionLogUpdates || []
          )
        : null,
      hasSuddenActionLogs,
      suddenActionLogsJson: hasSuddenActionLogs
        ? this.safeStringify(suddenActionLogs)
        : null,
      previousScenarioJson: previousScenarioInfo
        ? this.safeStringify(previousScenarioInfo)
        : "null",
      selectedSkill: selectedSkill || null,
    };

    // Use template and LLM to generate narrative and clue revelations
    const { content: prompt, images } = composeTemplateWithImages(
      template,
      { dynamicGameState: dynamicState },
      templateContext,
      "handlebars"
    );

    const narrativeStream = options?.onNarrativeDelta
      ? this.createNarrativeStreamParser(options.onNarrativeDelta)
      : null;
    let response = "";
    let parsedResponse: any;
    const maxAttempts = narrativeStream ? 1 : 2; // Avoid duplicate streaming retries

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await generateText({
          runtime,
          context: prompt,
          images,
          modelClass: ModelClass.MEDIUM,
          maxRetries: narrativeStream ? 1 : undefined,
          onToken: narrativeStream
            ? (chunk) => narrativeStream.ingest(chunk)
            : undefined,
        });

        // Extract JSON from response (in case LLM wraps it in markdown code blocks)
        const jsonText =
          response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ||
          response.match(/\{[\s\S]*\}/)?.[0];

        if (!jsonText) {
          if (attempt < maxAttempts) {
            console.warn(
              `⚠️ Failed to extract JSON from keeper response (attempt ${attempt}/${maxAttempts}), retrying...`
            );
            continue;
          }
          console.warn("Failed to extract JSON from keeper response");
          console.warn("Response content:", response);
          clearSuddenActionLogsContext();
          return {
            narrative: response,
            clueRevelations: {
              scenarioClues: [],
              npcClues: [],
              npcSecrets: [],
              damagedScenarioClues: [],
            },
            updatedGameState: dynamicState,
          };
        }

        parsedResponse = JSON.parse(jsonText);
        console.log(
          `✅ Successfully parsed keeper response on attempt ${attempt}`
        );
        break; // Success, exit retry loop
      } catch (error) {
        if (attempt < maxAttempts) {
          console.warn(
            `⚠️ Failed to parse keeper response as JSON (attempt ${attempt}/${maxAttempts}), retrying...`
          );
          continue;
        }

        // Final attempt failed
        console.error("Failed to parse keeper response as JSON:", error);
        console.warn("Response content:", response);

        // Try to extract narrative from incomplete JSON
        let fallbackNarrative = response;
        const narrativeMatch = response.match(
          /"narrative"\s*:\s*"((?:[^"\\]|\\.)*)"/
        );
        if (narrativeMatch && narrativeMatch[1]) {
          fallbackNarrative = narrativeMatch[1]
            .replace(/\\n/g, "\n")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
          console.log("✓ Extracted narrative from incomplete JSON");
        }

        clearSuddenActionLogsContext();
        return {
          narrative: fallbackNarrative,
          clueRevelations: {
            scenarioClues: [],
            npcClues: [],
            npcSecrets: [],
            damagedScenarioClues: [],
          },
          updatedGameState: dynamicState,
        };
      }
    }

    // Update clue states in game state
    const updatedGameState = this.updateClueStates(
      dynamicState,
      parsedResponse.clueRevelations,
      gameStateManager
    );

    // Update tension (if provided by LLM)
    if (
      parsedResponse.tensionLevel &&
      typeof parsedResponse.tensionLevel === "number"
    ) {
      const oldTension = dynamicState.tension;
      gameStateManager.updateTension(parsedResponse.tensionLevel);
      const newTension = gameStateManager.getState().tension;
      if (oldTension !== newTension) {
        console.log(`🎭 Tension changed: ${oldTension} → ${newTension}`);
      }
    }

    // Note: sceneChangeRequest is now cleared by Director Agent (which runs before Keeper)
    // Temporary state is now preserved until next real player input
    // Cleanup happens in entry node for real input only
    const finalGameState = updatedGameState;

    clearSuddenActionLogsContext();
    return {
      narrative: parsedResponse.narrative || response,
      clueRevelations: parsedResponse.clueRevelations || {
        scenarioClues: [],
        npcClues: [],
        npcSecrets: [],
        damagedScenarioClues: [],
      },
      updatedGameState: finalGameState,
    };
  }

  /**
   * Generate epilogue narrative when game ends
   */
  async generateEpilogue(
    characterInput: string,
    gameStateManager: DynamicGameStateManager,
    language: "en" | "zh" = "zh"
  ): Promise<{
    narrative: string;
    clueRevelations: any;
    updatedGameState: DynamicGameState;
  }> {
    const runtime = createRuntime();
    const dynamicState = gameStateManager.getState();

    // Get endState
    const endState = dynamicState.endState;
    if (!endState) {
      throw new Error("Cannot generate epilogue: endState is not defined");
    }

    // Get player character information
    const currentLocation = dynamicState.currentScenario?.location || null;
    const playerCharacter = this.extractCompletePlayerCharacter(
      dynamicState.playerCharacter,
      currentLocation,
      null // No interaction partner for epilogue
    );

    // Get conversation history (last 1 turn for continuity anchor)
    const conversationHistory =
      (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
        turnNumber: number;
        characterInput: string;
        keeperNarrative: string | null;
      }>) || [];

    const recentHistory = conversationHistory.slice(-1);

    // Format full game time
    const fullGameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;

    // Use epilogue template
    const template = getEpilogueTemplate(language);

    // Get macroScene
    const macroScene = dynamicState.macroScene;

    const templateContext = {
      characterInput,
      macroSceneJson: macroScene ? JSON.stringify(macroScene, null, 2) : "null",
      endStateJson: JSON.stringify(endState, null, 2),
      pointOfNoReturnTrigger:
        dynamicState.pointOfNoReturnTrigger || endState.pointOfNoReturn.trigger,
      fullGameTime,
      playerCharacterJson: this.safeStringify(playerCharacter),
      gameHistoryJson: JSON.stringify(recentHistory, null, 2),
      gameEndingJson: this.safeStringify(dynamicState.gameEnding || null),
      achievedVictoryCondition:
        typeof dynamicState.temporaryInfo.contextualData
          ?.triggerCheckAchievedVictoryCondition === "string"
          ? dynamicState.temporaryInfo.contextualData
              .triggerCheckAchievedVictoryCondition
          : null,
      triggerCheckEvidenceJson: this.safeStringify(
        dynamicState.temporaryInfo.contextualData?.triggerCheckEvidence || []
      ),
      triggerCheckCurrentTurnActionLogsJson: this.safeStringify(
        dynamicState.temporaryInfo.contextualData
          ?.triggerCheckCurrentTurnActionLogs || []
      ),
    };

    const { content: prompt, images } = composeTemplateWithImages(
      template,
      { dynamicGameState: dynamicState },
      templateContext,
      "handlebars"
    );

    let response = "";
    let parsedResponse: any;
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await generateText({
          runtime,
          context: prompt,
          images,
          modelClass: ModelClass.LARGE, // Use large model for epilogue quality
        });

        // Parse JSON response
        let jsonText = response.trim();
        const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (codeBlockMatch) {
          jsonText = codeBlockMatch[1].trim();
        }

        if (!jsonText.startsWith("{") && !jsonText.startsWith("[")) {
          const jsonObjectMatch = jsonText.match(/\{[\s\S]*\}/);
          if (jsonObjectMatch) {
            jsonText = jsonObjectMatch[0];
          }
        }

        parsedResponse = JSON.parse(jsonText);

        if (parsedResponse.narrative) {
          break; // Success
        }
      } catch (error) {
        if (attempt === maxAttempts) {
          console.error(
            `❌ [Keeper Agent] Failed to parse epilogue response after ${maxAttempts} attempts:`,
            error
          );
          throw new Error(
            `Failed to generate epilogue: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        console.warn(
          `⚠️  [Keeper Agent] Epilogue parse attempt ${attempt} failed, retrying...`
        );
      }
    }

    return {
      narrative: parsedResponse.narrative || response,
      clueRevelations: null, // Epilogue doesn't reveal new clues
      updatedGameState: dynamicState,
    };
  }

  /**
   * Clear temporary state content
   * @deprecated Cleanup now happens in entry node for real player input.
   * Kept for backward compatibility but no longer called.
   */
  private clearTemporaryState(
    dynamicState: DynamicGameState,
    gameStateManager: DynamicGameStateManager
  ): DynamicGameState {
    console.log("\n🧹 [Keeper Agent] Clearing temporary state content...");

    // Clear action results
    gameStateManager.clearActionResults();
    console.log("   ✓ Cleared action results");

    // Clear NPC response analyses
    gameStateManager.clearNPCResponseAnalyses();
    console.log("   ✓ Cleared NPC response analyses");

    // Clear action analysis
    gameStateManager.clearActionAnalysis();
    console.log("   ✓ Cleared action analysis");

    // Clear temporary rules
    const updatedState = gameStateManager.getState();
    updatedState.temporaryInfo.rules = [];
    console.log("   ✓ Cleared temporary rules");

    console.log("✅ [Keeper Agent] Temporary state content cleared");

    return updatedState;
  }

  /**
   * 1. Extract complete scenario information
   */
  private extractCompleteScenarioInfo(
    dynamicState: DynamicGameState,
    allowRegularPlusClues: boolean
  ) {
    const currentScenario = dynamicState.currentScenario;

    if (!currentScenario) {
      return {
        hasScenario: false,
        message: "No current scenario loaded",
      };
    }

    // Find connections for current scenario from scenarioOutlines
    const currentScenarioOutline = dynamicState.scenarioOutlines.find(
      (outline) =>
        outline.id === currentScenario.id ||
        outline.name === currentScenario.name
    );
    const connections = currentScenarioOutline?.connections || [];

    // Full snapshot minus gameTime and sceneImage, plus scenario-level connections
    const { gameTime, sceneImage, ...snapshot } = currentScenario;

    return {
      ...snapshot,
      clues: this.filterScenarioCluesForKeeper(
        snapshot.clues,
        allowRegularPlusClues
      ),
      connections: connections.map((conn) => {
        // Find target scenario to get proper name and id
        const targetScenario = dynamicState.scenarioOutlines.find(
          (outline) =>
            outline.name === conn.scenarioName ||
            outline.id === conn.scenarioName
        );
        return {
          scenarioName: targetScenario?.name || conn.scenarioName,
          scenarioId: targetScenario?.id || conn.scenarioName,
          relationshipType: conn.relationshipType,
          description: conn.description,
          blocked: conn.blocked,
          blockReason: conn.blockReason,
        };
      }),
    };
  }

  /**
   * Extract previous scenario information (for scene transitions)
   * Reads from temporaryInfo.previousScenario (saved by Director Agent before scene switch)
   */
  private extractPreviousScenarioInfo(dynamicState: DynamicGameState) {
    const previousScenario = dynamicState.temporaryInfo.previousScenario;

    if (!previousScenario) {
      return null;
    }

    // Find connections for previous scenario from scenarioOutlines
    const previousScenarioOutline = dynamicState.scenarioOutlines.find(
      (outline) =>
        outline.id === previousScenario.id ||
        outline.name === previousScenario.name
    );
    const connections = previousScenarioOutline?.connections || [];

    // Return simplified scenario info for previous scene
    return {
      hasScenario: true,
      id: previousScenario.id,
      name: previousScenario.name,
      location: previousScenario.location,
      description: previousScenario.description,
      characters: previousScenario.characters || [],
      connections: connections.map((conn) => {
        // Find target scenario to get proper name and id
        const targetScenario = dynamicState.scenarioOutlines.find(
          (outline) =>
            outline.name === conn.scenarioName ||
            outline.id === conn.scenarioName
        );
        return {
          scenarioName: targetScenario?.name || conn.scenarioName,
          scenarioId: targetScenario?.id || conn.scenarioName,
          relationshipType: conn.relationshipType,
          description: conn.description,
          blocked: conn.blocked,
          blockReason: conn.blockReason,
        };
      }),
      clues: (previousScenario.clues || []).map((clue) => ({
        id: clue.id,
        clueText: clue.clueText,
        location: clue.location,
        category: clue.category,
        difficulty: clue.difficulty,
        reveals: clue.reveals,
        discovered: clue.discovered,
        damaged: clue.damaged,
        ...(clue.damaged && clue.damageDetails
          ? { damageDetails: clue.damageDetails }
          : {}),
        ...(clue.discovered && clue.discoveryDetails
          ? { discoveryDetails: clue.discoveryDetails }
          : {}),
      })),
    };
  }

  /**
   * 2. Get all action results (including player and NPC actions)
   */
  private getAllActionResults(dynamicState: DynamicGameState): ActionResult[] {
    const actionResults = dynamicState.temporaryInfo.actionResults || [];

    // Return complete information for all action results
    return actionResults.map((result) => ({
      ...result,
      diceRolls: result.diceRolls || [],
    }));
  }

  /**
   * Get full action outputs (raw JSON from Action Agent).
   */
  private getAllActionResultsDetailed(
    dynamicState: DynamicGameState
  ): Array<Record<string, unknown>> {
    return dynamicState.temporaryInfo.actionResultsDetailed || [];
  }

  /**
   * 3. Extract complete attributes of NPCs involved in all action results
   * @param interactionPartnerName If provided, NPCs will include their interaction history with this character
   */
  private extractActionRelatedNpcs(
    dynamicState: DynamicGameState,
    allActionResults: Omit<ActionResult, "diceRolls" | "location">[],
    interactionPartnerName: string | null = null,
    allowRegularPlusClues: boolean
  ) {
    if (!allActionResults || allActionResults.length === 0) {
      return [];
    }

    // Collect related NPC names from all action results (deduplicated)
    const relatedNpcNames = new Set<string>();
    const playerName = dynamicState.playerCharacter.name;

    // Extract related NPCs from all action results
    for (const actionResult of allActionResults) {
      // Add character from action result (if it's an NPC)
      if (actionResult.character && actionResult.character !== playerName) {
        relatedNpcNames.add(actionResult.character);
      }

      // Extract possible NPC names from action result text (simple matching)
      if (actionResult.result) {
        dynamicState.npcCharacters.forEach((npc) => {
          if (
            actionResult.result.toLowerCase().includes(npc.name.toLowerCase())
          ) {
            relatedNpcNames.add(npc.name);
          }
        });
      }
    }

    // Get target character from action analysis
    const actionAnalysis = dynamicState.temporaryInfo.currentActionAnalysis;
    if (actionAnalysis?.target?.name) {
      relatedNpcNames.add(actionAnalysis.target.name);
    }

    // Find related NPCs and get complete attributes
    const actionRelatedNpcs = [];
    const addedNpcIds = new Set<string>();

    for (const npcName of relatedNpcNames) {
      // Find NPC
      const npc = dynamicState.npcCharacters.find(
        (n) =>
          n.name.toLowerCase() === npcName.toLowerCase() ||
          n.name.toLowerCase().includes(npcName.toLowerCase())
      );

      if (npc && !addedNpcIds.has(npc.id)) {
        // Avoid adding the same NPC twice
        addedNpcIds.add(npc.id);
        const currentLocation = dynamicState.currentScenario?.location || null;

        // If this NPC is the interaction partner, include player's name to get interaction history
        // Otherwise just use current location filtering
        const partnerForThisNpc =
          interactionPartnerName &&
          npc.name.toLowerCase().includes(interactionPartnerName.toLowerCase())
            ? playerName
            : null;

        actionRelatedNpcs.push({
          source: "action_related",
          character: this.extractCompleteCharacterAttributes(
            npc,
            currentLocation,
            partnerForThisNpc,
            allowRegularPlusClues
          ),
        });
      }
    }

    return actionRelatedNpcs;
  }

  /**
   * Extract complete character attribute information
   * @param character Character information
   * @param currentLocation Current scene location (for filtering action log)
   * @param interactionPartnerName Optional: if provided, also include action logs involving this partner (from any scene)
   */
  private extractCompleteCharacterAttributes(
    character: DynamicCharacterProfile,
    currentLocation: string | null = null,
    interactionPartnerName: string | null = null,
    allowRegularPlusClues = false
  ) {
    const npcData = character as DynamicNPCProfile;

    // NOTE: Action log filtering removed - now handled by RAG semantic search
    // The RAG system (BM25 + Vector) provides more intelligent retrieval
    // of relevant historical actions through temporaryInfo.relevantHistory

    return {
      // Basic information
      id: character.id,
      name: character.name,
      isNPC: npcData.isNPC === true,

      // Personal details
      occupation: npcData.occupation || "Unknown",
      age: npcData.age,
      appearance: npcData.appearance || "No description",
      personality: npcData.personality || "Unknown personality",
      background: npcData.background || "Unknown background",

      // Goals and secrets
      goals: npcData.goals || [],
      secrets: npcData.secrets || [],

      // Status (only essential info for narrative)
      status: {
        hp: character.status.hp,
        maxHp: character.status.maxHp,
        sanity: character.status.sanity,
        maxSanity: character.status.maxSanity,
        conditions: character.status.conditions || [],
      },

      // Items
      inventory: character.inventory || [],

      // Action log filtered to the current scene
      actionLog: currentLocation
        ? (character.actionLog || []).filter(
            (log) => log.location === currentLocation
          )
        : (character.actionLog || []),

      // Clues (if NPC)
      clues: this.filterNpcCluesForKeeper(
        npcData.clues || [],
        allowRegularPlusClues
      ),

      // Relationships (if NPC)
      relationships: npcData.relationships || [],

      // Notes
      notes: character.notes || "",
    };
  }

  /**
   * Extract complete player character information
   * @param player Player character information
   * @param currentLocation Current scene location (retained for backward compatibility)
   * @param interactionPartnerName Optional: NPC name (retained for backward compatibility)
   *
   * NOTE: currentLocation and interactionPartnerName are no longer used for action log filtering
   * Action history is now provided by RAG semantic search via relevantHistory
   */
  private extractCompletePlayerCharacter(
    player: DynamicCharacterProfile,
    currentLocation: string | null = null,
    interactionPartnerName: string | null = null
  ) {
    return this.extractCompleteCharacterAttributes(
      player,
      currentLocation,
      interactionPartnerName
    );
  }

  /**
   * Update clue states in game state
   */
  private updateClueStates(
    dynamicState: DynamicGameState,
    clueRevelations: any,
    gameStateManager: DynamicGameStateManager
  ): DynamicGameState {
    const newDiscoveredClues: DiscoveredClue[] = [];
    const damagedScenarioClueIds = new Set<string>();

    // Apply scenario clue damage first: damaged clues cannot be revealed later
    if (
      clueRevelations?.damagedScenarioClues &&
      Array.isArray(clueRevelations.damagedScenarioClues)
    ) {
      const currentScenario = dynamicState.currentScenario;
      if (currentScenario?.clues) {
        clueRevelations.damagedScenarioClues.forEach(
          (item: string | { clueId: string; reason?: string }) => {
            const clueId = typeof item === "string" ? item : item?.clueId;
            const reason =
              typeof item === "object" && item?.reason
                ? item.reason
                : "Clue destroyed by fumble";
            if (!clueId) return;
            const clue = currentScenario.clues.find((c) => c.id === clueId);
            if (!clue || clue.discovered || clue.damaged) return;
            clue.damaged = true;
            clue.damageDetails = {
              damagedBy: dynamicState.playerCharacter.name,
              damagedAt: new Date().toISOString(),
              reason,
            };
            damagedScenarioClueIds.add(clueId);
          }
        );
      }
    }

    // Update scenario clue states
    if (
      clueRevelations?.scenarioClues &&
      clueRevelations.scenarioClues.length > 0
    ) {
      const currentScenario = dynamicState.currentScenario;
      if (currentScenario && currentScenario.clues) {
        clueRevelations.scenarioClues.forEach(
          (item: string | { clueId: string }) => {
            const clueId = typeof item === "string" ? item : item?.clueId;
            if (!clueId) return;
            const clue = currentScenario.clues.find((c) => c.id === clueId);
            if (
              clue &&
              !clue.discovered &&
              !clue.damaged &&
              !damagedScenarioClueIds.has(clueId)
            ) {
              const discoveredAt = new Date().toISOString();
              clue.discovered = true;
              clue.discoveryDetails = {
                discoveredBy: dynamicState.playerCharacter.name,
                discoveredAt,
                method: "Keeper revelation",
              };

              // Create detailed clue info
              newDiscoveredClues.push({
                text: clue.clueText,
                type: "scenario",
                sourceName: currentScenario.name,
                discoveredBy: dynamicState.playerCharacter.name,
                discoveredAt,
                category: clue.category,
                difficulty: clue.difficulty,
                method: "Keeper revelation",
              });
            }
          }
        );
      }
    }

    // Update NPC clue states
    if (clueRevelations?.npcClues && clueRevelations.npcClues.length > 0) {
      clueRevelations.npcClues.forEach(
        (item: { npcId: string; clueId: string }) => {
          const npc = dynamicState.npcCharacters.find(
            (n) => n.id === item.npcId
          );
          if (npc && npc.clues) {
            const clue = npc.clues.find((c) => c.id === item.clueId);
            if (clue && !clue.revealed) {
              clue.revealed = true;

              // Create detailed clue info
              newDiscoveredClues.push({
                text: clue.clueText,
                type: "npc",
                sourceName: npc.name,
                discoveredBy: dynamicState.playerCharacter.name,
                discoveredAt: new Date().toISOString(),
                category: clue.category as any,
                difficulty: clue.difficulty as any,
                method: "Social interaction",
              });
            }
          }
        }
      );
    }

    // Handle NPC secret revelations (secrets are string arrays, identified by index)
    if (clueRevelations?.npcSecrets && clueRevelations.npcSecrets.length > 0) {
      clueRevelations.npcSecrets.forEach(
        (item: { npcId: string; secretIndex: number }) => {
          const npc = dynamicState.npcCharacters.find(
            (n) => n.id === item.npcId
          );
          if (npc && npc.secrets && npc.secrets[item.secretIndex]) {
            const secret = npc.secrets[item.secretIndex];

            // Create detailed secret info
            newDiscoveredClues.push({
              text: `Secret: ${secret}`,
              type: "secret",
              sourceName: npc.name,
              discoveredBy: dynamicState.playerCharacter.name,
              discoveredAt: new Date().toISOString(),
              method: "Secret revelation",
            });
          }
        }
      );
    }

    // Add newly discovered clues to global discovery list
    newDiscoveredClues.forEach((discoveredClue) => {
      // Check if clue text already exists
      const exists = dynamicState.discoveredClues.some(
        (c) => c.text === discoveredClue.text
      );
      if (!exists) {
        dynamicState.discoveredClues.push(discoveredClue);
      }
    });

    return gameStateManager.getState();
  }

  /**
   * Process input and generate appropriate narrative response
   */
  async processInput(
    input: string,
    gameStateManager: DynamicGameStateManager
  ): Promise<{
    narrative: string;
    clueRevelations: any;
    updatedGameState: DynamicGameState;
  }> {
    try {
      const result = await this.generateNarrative(input, gameStateManager, "zh");
      return result;
    } catch (error) {
      console.error("Error generating narrative:", error);
      return {
        narrative:
          "The shadows seem to obscure the scene, making it difficult to discern what transpires... [Keeper Agent Error]",
        clueRevelations: {
          scenarioClues: [],
          npcClues: [],
          npcSecrets: [],
          damagedScenarioClues: [],
        },
        updatedGameState: gameStateManager.getState(),
      };
    }
  }

  private createNarrativeStreamParser(onDelta: (delta: string) => void) {
    let buffer = "";
    let lastNarrative = "";

    return {
      ingest: (chunk: string) => {
        if (!chunk) return;
        buffer += chunk;

        const narrative = this.extractNarrativeFromBuffer(buffer);
        if (narrative === null) return;

        if (narrative.length > lastNarrative.length) {
          const delta = narrative.slice(lastNarrative.length);
          if (delta) {
            onDelta(delta);
          }
          lastNarrative = narrative;
        }
      },
    };
  }

  private extractNarrativeFromBuffer(buffer: string): string | null {
    const keyMatch = /"narrative"\s*:\s*"/.exec(buffer);
    if (!keyMatch || keyMatch.index === undefined) {
      return null;
    }

    let index = keyMatch.index + keyMatch[0].length;
    let result = "";
    let escaped = false;

    for (; index < buffer.length; index++) {
      const char = buffer[index];

      if (escaped) {
        switch (char) {
          case '"':
            result += '"';
            break;
          case "\\":
            result += "\\";
            break;
          case "n":
            result += "\n";
            break;
          case "r":
            result += "\r";
            break;
          case "t":
            result += "\t";
            break;
          case "b":
            result += "\b";
            break;
          case "f":
            result += "\f";
            break;
          case "u": {
            const hex = buffer.slice(index + 1, index + 5);
            if (hex.length < 4) {
              return result;
            }
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              result += String.fromCharCode(Number.parseInt(hex, 16));
              index += 4;
            } else {
              result += "u";
            }
            break;
          }
          default:
            result += char;
            break;
        }
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === '"') {
        return result;
      }

      result += char;
    }

    return result;
  }

  private safeStringify(obj: any): string {
    try {
      return JSON.stringify(obj, null, 2);
    } catch (error) {
      return typeof obj === "string" ? obj : "";
    }
  }
}
