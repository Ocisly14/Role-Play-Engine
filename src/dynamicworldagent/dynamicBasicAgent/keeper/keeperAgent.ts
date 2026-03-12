import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../../models/index.js";
import type {
  ActionLogEntry,
} from "../../../shared/agents/models/gameTypes.js";
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
   * Generate narrative based on current game state and user query
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
    updatedGameState: DynamicGameState;
  }> {
    const runtime = createRuntime();
    const dynamicState = gameStateManager.getState();

    // 1. Get CharacterActions from tick processor
    const characterActions = gameStateManager.getCharacterActions();
    const playerCharacterId = dynamicState.playerCharacter?.id ?? "";
    const playerActions = characterActions.filter((a) => a.isPlayer);
    const allNpcActions = characterActions.filter((a) => !a.isPlayer);

    // 2. Get current scene from state manager
    const currentScene = gameStateManager.getCurrentScene();

    // 3. Get complete scenario information
    const completeScenarioInfo = this.extractCompleteScenarioInfo(dynamicState);

    // 4. Extract action target name (used for NPC profile extraction)
    const targetAction = playerActions.find((a) => a.targetCharacterId);
    const interactionPartnerName = targetAction
      ? dynamicState.npcCharacters.find(
          (n) => n.id === targetAction.targetCharacterId
        )?.name ?? null
      : null;

    // 5. Get complete attributes of NPCs involved in character actions
    const actionRelatedNpcs = this.extractActionRelatedNpcsFromCharacterActions(
      dynamicState,
      characterActions,
      interactionPartnerName
    );

    // 6. Detect scene transition by comparing player action location vs current scene
    const playerActionLocation =
      playerActions.length > 0 ? playerActions[0].location : null;
    const isTransition =
      playerActionLocation != null &&
      playerActionLocation !== dynamicState.currentSceneId;
    const previousSceneInfo = isTransition
      ? this.extractPreviousSceneInfo(dynamicState, playerActionLocation!)
      : null;

    // 7. Filter NPC actions by impact for narrative inclusion
    const playerScene = dynamicState.currentSceneId ?? "";
    const relevantNpcActions = allNpcActions.filter((action) => {
      if (action.impact === 3) return true;
      if (
        action.impact === 1 &&
        action.targetCharacterId === playerCharacterId
      )
        return true;
      if (action.impact === 2) {
        const npcScene = action.location;
        const playerSceneObj = dynamicState.scenes.get(playerScene);
        const adjacent = playerSceneObj?.connections?.includes(npcScene) ?? false;
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

    // 8.2. Get retrieved discovery context from RAG (populated by memory agent)
    const retrievedDiscoveryContext =
      (dynamicState.temporaryInfo.contextualData?.retrievedDiscoveryContext as Array<{
        content: string;
        score: number;
        metadata: Record<string, unknown> | null;
        sourceKey: string;
      }>) ?? [];

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
    };

    // 9. Extract discoveries from player actions (tick processor already handled discovery)
    const discoveriesThisTurn = playerActions
      .flatMap((a) => (a.discoveries ?? []).map((d) => ({ ...d, sourceName: d.sourceName })))
      .filter((d) => d.text);

    // 10. Extract damaged evidence from fumble (if any)
    const damagedEvidenceAction = playerActions.find((a) => a.damagedEvidence);
    const hasDamagedEvidenceThisTurn = Boolean(damagedEvidenceAction?.damagedEvidence);

    // Get template
    const template = getKeeperTemplate(language);

    // Prepare template context (JSON-packed to keep template concise)
    const currentLocation = currentScene?.name || null;
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
      isTransition,
      conversationHistory, // Recent conversation history (for {{#each}} loop)
      relevantHistory, // RAG-retrieved relevant history (for {{#each}} loop)
      hasRetrievedDiscoveries: retrievedDiscoveryContext.length > 0,
      retrievedDiscoveryContextJson: retrievedDiscoveryContext.length > 0
        ? this.safeStringify(retrievedDiscoveryContext)
        : null,
      // Discoveries this turn by tick processor
      hasDiscoveriesThisTurn: discoveriesThisTurn.length > 0,
      discoveriesThisTurn,
      hasDamagedEvidenceThisTurn,
      // JSON string version (used directly in template)
      scenarioContextJson: this.safeStringify(completeScenarioInfo),
      playerCharacterJson: this.safeStringify(playerCharacterComplete),
      actionRelatedNpcsJson: this.safeStringify(actionRelatedNpcs),
      hasSuddenActionLogs,
      suddenActionLogsJson: hasSuddenActionLogs
        ? this.safeStringify(suddenActionLogs)
        : null,
      previousSceneJson: previousSceneInfo
        ? this.safeStringify(previousSceneInfo)
        : "null",
      selectedSkill: selectedSkill || null,
      hasNpcActions,
      npcActionsJson: hasNpcActions
        ? this.safeStringify(relevantNpcActions)
        : null,
      hasPlayerWitnessEvents: (options?.witnessEvents?.length ?? 0) > 0,
      playerWitnessEvents: options?.witnessEvents ?? null,
      isWitnessInterrupt: options?.isWitnessInterrupt ?? false,
      hasSceneEvents: (currentScene?.events?.length ?? 0) > 0,
      sceneEvents: currentScene?.events ?? [],
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
          updatedGameState: dynamicState,
        };
      }
    }

    clearSuddenActionLogsContext();
    return {
      narrative: parsedResponse.narrative || response,
      updatedGameState: dynamicState,
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
    const currentScene = gameStateManager.getCurrentScene();
    const currentLocation = currentScene?.name || null;
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
      updatedGameState: dynamicState,
    };
  }


  /**
   * 1. Extract complete scenario information
   */
  private extractCompleteScenarioInfo(dynamicState: DynamicGameState) {
    const scene = dynamicState.scenes.get(dynamicState.currentSceneId ?? "");
    if (!scene) {
      return { hasScenario: false, message: "No current scene loaded" };
    }

    const connections = (scene.connections || []).map(connId => {
      const connScene = dynamicState.scenes.get(connId);
      return {
        sceneId: connId,
        sceneName: connScene?.name || connId,
        description: connScene?.description || "",
      };
    });

    const presentNpcs = dynamicState.npcCharacters
      .filter(npc => dynamicState.npcLocations[npc.id] === scene.id)
      .map(npc => ({ id: npc.id, name: npc.name }));

    return {
      id: scene.id,
      name: scene.name,
      description: scene.description,
      parentLocationId: scene.parentLocationId,
      conditions: scene.conditions,
      items: scene.items,
      events: scene.events,
      connections,
      presentNpcs,
    };
  }

  /**
   * Extract previous scenario information (for scene transitions)
   * Looks up scenario by ID from scenarioOutlines
   */
  private extractPreviousSceneInfo(
    dynamicState: DynamicGameState,
    previousSceneId: string
  ) {
    const prevScene = dynamicState.scenes.get(previousSceneId);
    if (!prevScene) return null;

    const connections = (prevScene.connections || []).map(connId => {
      const connScene = dynamicState.scenes.get(connId);
      return {
        sceneId: connId,
        sceneName: connScene?.name || connId,
      };
    });

    return { id: prevScene.id, name: prevScene.name, description: prevScene.description, connections };
  }

  /**
   * Extract complete attributes of NPCs involved in CharacterActions
   * Collects NPC IDs from all character actions (both player-targeted and NPC actors)
   * @param interactionPartnerName If provided, NPCs will include their interaction history with this character
   */
  private extractActionRelatedNpcsFromCharacterActions(
    dynamicState: DynamicGameState,
    characterActions: CharacterAction[],
    interactionPartnerName: string | null = null
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
    const currentScene = dynamicState.scenes.get(dynamicState.currentSceneId ?? "");
    const currentLocation = currentScene?.name || null;
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
          partnerForThisNpc
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
    interactionPartnerName: string | null = null
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
   * Process input and generate appropriate narrative response
   */
  async processInput(
    input: string,
    gameStateManager: DynamicGameStateManager
  ): Promise<{
    narrative: string;
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
