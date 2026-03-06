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
import type { DiscoveredClue } from "../../../shared/state/index.js";
import { composeTemplateWithImages } from "../../../template.js";
import type {
  DynamicGameState,
  DynamicGameStateManager,
} from "../../state/index.js";
import type { DynamicCharacterProfile } from "../../world_builder/types.js";
import type { DynamicNPCProfile } from "../../world_builder/types.js";
import type { CharacterAction, PlayerWitnessEvent } from "../npcPlanning/types.js";
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
  /**
   * Derive clue access from CharacterAction[] results.
   * If any player action completed with an actionType (i.e. a skill check was involved), allow regular+ clues.
   * CharacterAction doesn't track fumble explicitly, so hasFumble is always false.
   */
  private deriveClueAccessFromCharacterActions(
    playerActions: CharacterAction[]
  ): { allowRegularPlus: boolean; hasFumble: boolean } {
    const allowRegularPlus = playerActions.some(
      (a) => a.status === "completed" && a.actionType
    );
    // CharacterAction doesn't have fumble concept
    const hasFumble = false;
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
        if (clue.damaged) return false;
        if (clue.discovered) return false; // Discovered → served via RAG
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
        if (clue.revealed) return false; // Revealed → served via RAG
        return allowRegularPlus;
      })
      .map((clue) => ({ ...clue }));
  }

  /**
   * Generate narrative description with clue revelation based on current game state and user query
   */
  async generateNarrative(
    characterInput: string,
    gameStateManager: DynamicGameStateManager,
    language: "en" | "zh" = "zh",
    selectedSkill?: string | null,
    options?: {
      onNarrativeDelta?: (delta: string) => void;
      witnessEvents?: PlayerWitnessEvent[];
      isWitnessInterrupt?: boolean;
    }
  ): Promise<{
    narrative: string;
    clueRevelations: any;
    updatedGameState: DynamicGameState;
  }> {
    const runtime = createRuntime();
    const dynamicState = gameStateManager.getState();

    // 1. Get CharacterActions from tick processor
    const characterActions = gameStateManager.getCharacterActions();
    const playerCharacterId = dynamicState.playerCharacter?.id ?? "";
    const playerActions = characterActions.filter((a) => a.isPlayer);
    const allNpcActions = characterActions.filter((a) => !a.isPlayer);

    // 2. Derive clue access from player actions
    const clueAccess = this.deriveClueAccessFromCharacterActions(playerActions);

    // 3. Get complete scenario information (with clue filtering by current turn outcomes)
    const completeScenarioInfo = this.extractCompleteScenarioInfo(
      dynamicState,
      clueAccess.allowRegularPlus
    );

    // 4. Extract action target info from player actions
    const targetAction = playerActions.find((a) => a.targetCharacterId);
    const actionTargetName = targetAction
      ? dynamicState.npcCharacters.find(
          (n) => n.id === targetAction.targetCharacterId
        )?.name ?? null
      : null;
    const hasActionTargetInfo = Boolean(actionTargetName);
    const interactionPartnerName = actionTargetName;

    // 5. Get complete attributes of NPCs involved in character actions
    const actionRelatedNpcs = this.extractActionRelatedNpcsFromCharacterActions(
      dynamicState,
      characterActions,
      interactionPartnerName,
      clueAccess.allowRegularPlus
    );

    // 6. Detect scene transition from movement actions
    const isTransition = playerActions.some(
      (a) => a.type === "movement" && a.status === "completed"
    );
    const previousScenarioInfo = isTransition
      ? this.extractPreviousScenarioInfo(dynamicState)
      : null;

    // 7. Filter NPC actions by impact for narrative inclusion
    const playerScene = dynamicState.currentScenario?.id ?? "";
    const relevantNpcActions = allNpcActions.filter((action) => {
      if (action.impact === 3) return true;
      if (
        action.impact === 1 &&
        action.targetCharacterId === playerCharacterId
      )
        return true;
      if (action.impact === 2) {
        const npcScene = action.location;
        const adjacent = (dynamicState.connectionStates ?? []).some(
          (c) =>
            !c.blocked &&
            ((c.fromScenarioId === playerScene &&
              c.toScenarioId === npcScene) ||
              (c.toScenarioId === playerScene &&
                c.fromScenarioId === npcScene))
        );
        return npcScene === playerScene || adjacent;
      }
      return false;
    });
    const hasNpcActions = relevantNpcActions.length > 0;

    // 8. Get conversation history (from contextualData)
    const conversationHistory =
      (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
        turnNumber: number;
        characterInput: string;
        keeperNarrative: string | null;
      }>) || [];

    // 8.1. Get relevant history from RAG (from contextualData)
    const relevantHistory =
      (dynamicState.temporaryInfo.contextualData?.relevantHistory as Array<{
        type: string;
        content: string;
        score: number;
        metadata: Record<string, any>;
      }>) || [];

    // 8.2. Get retrieved clue context from RAG (populated by memory agent)
    const retrievedClueContext =
      (dynamicState.temporaryInfo.contextualData?.retrievedClueContext as Array<{
        content: string;
        score: number;
        metadata: Record<string, unknown> | null;
        sourceKey: string;
      }>) ?? [];

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

    // 9. Calculate current turn number
    // Current turn is the next turn after the latest in history
    const currentTurnNumber =
      conversationHistory.length > 0
        ? Math.max(...conversationHistory.map((h) => h.turnNumber)) + 1
        : 1;

    // 10. Detect if this is the first real player turn (only true when loading module for the first time)
    // Simple check: if there's no conversation history, this is the first turn
    const isFirstRealTurn = conversationHistory.length === 0;

    // Get template
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

    const templateContext = {
      characterInput,
      // Player actions this turn (for {{#each}} loop)
      playerActionsJson: playerActions.length > 0 ? playerActions : null,
      fullGameTime: fullGameTime, // Complete display: "Day 1, 08:00 (Morning)"
      tension: dynamicState.tension,
      isTransition,
      conversationHistory, // Recent conversation history (for {{#each}} loop)
      relevantHistory, // RAG-retrieved relevant history (for {{#each}} loop)
      hasRetrievedClues: retrievedClueContext.length > 0,
      retrievedClueContextJson: retrievedClueContext.length > 0
        ? this.safeStringify(retrievedClueContext)
        : null,
      hasActionTargetInfo,
      actionTargetName,
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
      hasNpcActions,
      npcActionsJson: hasNpcActions
        ? this.safeStringify(relevantNpcActions)
        : null,
      hasPlayerWitnessEvents: (options?.witnessEvents?.length ?? 0) > 0,
      playerWitnessEvents: options?.witnessEvents ?? null,
      isWitnessInterrupt: options?.isWitnessInterrupt ?? false,
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

    // Temporary state is preserved until next real player input
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
   * Extract complete attributes of NPCs involved in CharacterActions
   * Collects NPC IDs from all character actions (both player-targeted and NPC actors)
   * @param interactionPartnerName If provided, NPCs will include their interaction history with this character
   */
  private extractActionRelatedNpcsFromCharacterActions(
    dynamicState: DynamicGameState,
    characterActions: CharacterAction[],
    interactionPartnerName: string | null = null,
    allowRegularPlusClues: boolean
  ) {
    if (!characterActions || characterActions.length === 0) {
      return [];
    }

    const playerName = dynamicState.playerCharacter.name;
    const addedNpcIds = new Set<string>();
    const actionRelatedNpcs = [];

    // Collect NPC IDs from character actions
    for (const action of characterActions) {
      // Add NPC actors (non-player characters performing actions)
      if (!action.isPlayer && !addedNpcIds.has(action.characterId)) {
        addedNpcIds.add(action.characterId);
      }
      // Add target NPCs from player actions
      if (action.isPlayer && action.targetCharacterId) {
        if (!addedNpcIds.has(action.targetCharacterId)) {
          addedNpcIds.add(action.targetCharacterId);
        }
      }
    }

    // Also add interaction partner by name if specified
    if (interactionPartnerName) {
      const partnerNpc = dynamicState.npcCharacters.find(
        (n) =>
          n.name.toLowerCase() === interactionPartnerName.toLowerCase() ||
          n.name.toLowerCase().includes(interactionPartnerName.toLowerCase())
      );
      if (partnerNpc && !addedNpcIds.has(partnerNpc.id)) {
        addedNpcIds.add(partnerNpc.id);
      }
    }

    // Build NPC profiles for all collected IDs
    const currentLocation = dynamicState.currentScenario?.location || null;
    for (const npcId of addedNpcIds) {
      const npc = dynamicState.npcCharacters.find((n) => n.id === npcId);
      if (!npc) continue;

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
      const result = await this.generateNarrative(input, gameStateManager);
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
