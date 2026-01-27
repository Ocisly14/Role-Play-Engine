import { getKeeperTemplate } from "./keeperTemplate.js";
import { composeTemplateWithImages } from "../../../template.js";
import type { ActionResult, ActionAnalysis, DiscoveredClue } from "../../../coc_multiagents_system/state/index.js";
import type { ActionLogEntry } from "../../../coc_multiagents_system/agents/models/gameTypes.js";
import type { DynamicCharacterProfile } from "../../world_builder/types.js";
import type { DynamicNPCProfile } from "../../world_builder/types.js";
import type { DynamicGameState, DynamicGameStateManager } from "../../state/index.js";
import {
  ModelProviderName,
  ModelClass,
  generateText,
} from "../../../models/index.js";

interface KeeperRuntime {
  modelProvider: ModelProviderName;
  getSetting: (key: string) => string | undefined;
}

const createRuntime = (): KeeperRuntime => ({
  modelProvider: (process.env.MODEL_PROVIDER as ModelProviderName) || ModelProviderName.OPENAI,
  getSetting: (key: string) => process.env[key],
});

/**
 * Keeper Agent - Game master for narrative generation and storytelling
 */
export class KeeperAgent {

  /**
   * Generate narrative description with clue revelation based on current game state and user query
   */
  async generateNarrative(characterInput: string, gameStateManager: DynamicGameStateManager): Promise<{narrative: string, clueRevelations: any, updatedGameState: DynamicGameState}> {
    const runtime = createRuntime();
    const dynamicState = gameStateManager.getState();
    
    // 1. Get complete scenario information
    const completeScenarioInfo = this.extractCompleteScenarioInfo(dynamicState);

    // 2. Get all action results (including player and NPC actions)
    const allActionResultsRaw = this.getAllActionResults(dynamicState);

    // Filter out diceRolls field (not used in template)
    const allActionResults: Omit<ActionResult, 'diceRolls'>[] = allActionResultsRaw.map(({ diceRolls, ...result }) => result);

    // 2.1. Get the latest complete action result (for backward compatibility)
    const latestCompleteActionResult = allActionResults.length > 0 ? allActionResults[allActionResults.length - 1] : null;

    // 2.2. Get interaction partner name (if action targets an NPC)
    const actionAnalysis = dynamicState.temporaryInfo.currentActionAnalysis;
    const interactionPartnerName = actionAnalysis?.target?.name || null;

    // 3. Get complete attributes of NPCs involved in action results
    const actionRelatedNpcs = this.extractActionRelatedNpcs(dynamicState, allActionResults, interactionPartnerName);
    
    // 5. Detect scene changes - check if sceneChangeRequest indicates a transition
    const sceneChangeRequest = dynamicState.temporaryInfo.sceneChangeRequest;
    const isTransition = sceneChangeRequest?.shouldChange === true;
    const previousScenarioInfo = isTransition ? this.extractPreviousScenarioInfo(dynamicState) : null;
    
    // 7. Get conversation history (from contextualData)
    const conversationHistory = (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
      turnNumber: number;
      characterInput: string;
      keeperNarrative: string | null;
    }>) || [];

    // 8. Calculate current turn number
    // Current turn is the next turn after the latest in history
    const currentTurnNumber = conversationHistory.length > 0
      ? Math.max(...conversationHistory.map(h => h.turnNumber)) + 1
      : 1;
    
    // 9. Detect if this is the first real player turn (only true when loading module for the first time)
    // Simple check: if there's no conversation history, this is the first turn
    const isFirstRealTurn = conversationHistory.length === 0;

    // Note: RAG is not used in Dynamic World system
    
    // 获取模板
    const template = getKeeperTemplate();
    
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
    const sceneChangeRequestForNarrative = sceneChangeRequest ? {
      shouldChange: sceneChangeRequest.shouldChange,
      targetSceneName: sceneChangeRequest.targetSceneName,
      reason: sceneChangeRequest.reason
    } : null;

    // Extract connections from completeScenarioInfo (already extracted there, reuse it)
    // Connections are scenario-level data from scenarioOutlines
    const connections = (completeScenarioInfo as any).connections || [];

    const templateContext = {
      characterInput,
      allActionResults,  // All action results (for {{#each}} loop)
      fullGameTime: fullGameTime,  // Complete display: "Day 1, 08:00 (Morning)"
      tension: dynamicState.tension,
      isTransition,
      sceneChangeRequest: sceneChangeRequestForNarrative,  // Scene change request (without timestamp)
      conversationHistory,  // Recent conversation history (for {{#each}} loop)
      currentTurnNumber,  // Current turn number
      isFirstRealTurn,  // Boolean flag for turn 1 detection
      keeperGuidance: dynamicState.keeperGuidance || null,  // Module-specific keeper guidance
      // Connections as separate variable for easier template access (scenario-level from scenarioOutlines)
      connections: connections,
      // JSON string version (used directly in template)
      scenarioContextJson: this.safeStringify(completeScenarioInfo),
      playerCharacterJson: this.safeStringify(playerCharacterComplete),
      actionRelatedNpcsJson: this.safeStringify(actionRelatedNpcs),
      previousScenarioJson: previousScenarioInfo
        ? this.safeStringify(previousScenarioInfo)
        : "null",
    };

    // Use template and LLM to generate narrative and clue revelations
    const { content: prompt, images } = composeTemplateWithImages(
      template,
      { dynamicGameState: dynamicState },
      templateContext,
      "handlebars"
    );

    let response: string = "";
    let parsedResponse: any;
    const maxAttempts = 2; // Try up to 2 times

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await generateText({
          runtime,
          context: prompt,
          images,
          modelClass: ModelClass.MEDIUM,
        });

        // Extract JSON from response (in case LLM wraps it in markdown code blocks)
        const jsonText =
          response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ||
          response.match(/\{[\s\S]*\}/)?.[0];

        if (!jsonText) {
          if (attempt < maxAttempts) {
            console.warn(`⚠️ Failed to extract JSON from keeper response (attempt ${attempt}/${maxAttempts}), retrying...`);
            continue;
          }
          console.warn("Failed to extract JSON from keeper response");
          console.warn("Response content:", response);
          return {
            narrative: response,
            clueRevelations: { scenarioClues: [], npcClues: [], npcSecrets: [] },
            updatedGameState: dynamicState
          };
        }

        parsedResponse = JSON.parse(jsonText);
        console.log(`✅ Successfully parsed keeper response on attempt ${attempt}`);
        break; // Success, exit retry loop

      } catch (error) {
        if (attempt < maxAttempts) {
          console.warn(`⚠️ Failed to parse keeper response as JSON (attempt ${attempt}/${maxAttempts}), retrying...`);
          continue;
        }

        // Final attempt failed
        console.error("Failed to parse keeper response as JSON:", error);
        console.warn("Response content:", response);

        // Try to extract narrative from incomplete JSON
        let fallbackNarrative = response;
        const narrativeMatch = response.match(/"narrative"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (narrativeMatch && narrativeMatch[1]) {
          fallbackNarrative = narrativeMatch[1]
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
          console.log("✓ Extracted narrative from incomplete JSON");
        }

        return {
          narrative: fallbackNarrative,
          clueRevelations: { scenarioClues: [], npcClues: [], npcSecrets: [] },
          updatedGameState: dynamicState
        };
      }
    }

    // Update clue states in game state
    const updatedGameState = this.updateClueStates(dynamicState, parsedResponse.clueRevelations, gameStateManager);

    // Update tension (if provided by LLM)
    if (parsedResponse.tensionLevel && typeof parsedResponse.tensionLevel === 'number') {
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

    return {
      narrative: parsedResponse.narrative || response,
      clueRevelations: parsedResponse.clueRevelations || { scenarioClues: [], npcClues: [], npcSecrets: [] },
      updatedGameState: finalGameState
    };
  }

  /**
   * Clear temporary state content
   * @deprecated Cleanup now happens in entry node for real player input.
   * Temporary state is preserved across simulated queries during listening loop.
   * Kept for backward compatibility but no longer called.
   */
  private clearTemporaryState(dynamicState: DynamicGameState, gameStateManager: DynamicGameStateManager): DynamicGameState {
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
  private extractCompleteScenarioInfo(dynamicState: DynamicGameState) {
    const currentScenario = dynamicState.currentScenario;

    if (!currentScenario) {
      return {
        hasScenario: false,
        message: "No current scenario loaded"
      };
    }

    // Find connections for current scenario from scenarioOutlines
    const currentScenarioOutline = dynamicState.scenarioOutlines.find(
      outline => outline.id === currentScenario.id || outline.name === currentScenario.name
    );
    const connections = currentScenarioOutline?.connections || [];

    // Simplified scenario info - keep essential dynamic state
    // Include clue text so Keeper can decide what to reveal
    return {
      hasScenario: true,
      id: currentScenario.id,
      name: currentScenario.name,
      location: currentScenario.location,
      // Characters present in the scene (dynamic state)
      characters: currentScenario.characters || [],
      // Connections to other scenarios
      connections: connections.map(conn => {
        // Find target scenario to get proper name and id
        const targetScenario = dynamicState.scenarioOutlines.find(
          outline => outline.name === conn.scenarioName || outline.id === conn.scenarioName
        );
        return {
          scenarioName: targetScenario?.name || conn.scenarioName,
          scenarioId: targetScenario?.id || conn.scenarioName,
          relationshipType: conn.relationshipType,
          description: conn.description,
          blocked: conn.blocked,
          blockReason: conn.blockReason
        };
      }),
      // Provide clue details for Keeper decision-making
      clues: (currentScenario.clues || []).map(clue => ({
        id: clue.id,
        clueText: clue.clueText,
        location: clue.location,
        category: clue.category,
        difficulty: clue.difficulty,
        reveals: clue.reveals,
        discovered: clue.discovered,
        // Keep discovery details if the clue was discovered
        ...(clue.discovered && clue.discoveryDetails ? { discoveryDetails: clue.discoveryDetails } : {})
      }))
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
      outline => outline.id === previousScenario.id || outline.name === previousScenario.name
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
      connections: connections.map(conn => {
        // Find target scenario to get proper name and id
        const targetScenario = dynamicState.scenarioOutlines.find(
          outline => outline.name === conn.scenarioName || outline.id === conn.scenarioName
        );
        return {
          scenarioName: targetScenario?.name || conn.scenarioName,
          scenarioId: targetScenario?.id || conn.scenarioName,
          relationshipType: conn.relationshipType,
          description: conn.description,
          blocked: conn.blocked,
          blockReason: conn.blockReason
        };
      }),
      clues: (previousScenario.clues || []).map(clue => ({
        id: clue.id,
        clueText: clue.clueText,
        location: clue.location,
        category: clue.category,
        difficulty: clue.difficulty,
        reveals: clue.reveals,
        discovered: clue.discovered,
        ...(clue.discovered && clue.discoveryDetails ? { discoveryDetails: clue.discoveryDetails } : {})
      }))
    };
  }

  /**
   * 2. Get all action results (including player and NPC actions)
   */
  private getAllActionResults(dynamicState: DynamicGameState): ActionResult[] {
    const actionResults = dynamicState.temporaryInfo.actionResults || [];
    
    // Return complete information for all action results
    return actionResults.map(result => ({
      ...result,
      diceRolls: result.diceRolls || []
    }));
  }

  /**
   * 3. Extract complete attributes of NPCs involved in all action results
   * @param interactionPartnerName If provided, NPCs will include their interaction history with this character
   */
  private extractActionRelatedNpcs(
    dynamicState: DynamicGameState,
    allActionResults: Omit<ActionResult, 'diceRolls'>[],
    interactionPartnerName: string | null = null
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
        dynamicState.npcCharacters.forEach(npc => {
          if (actionResult.result.toLowerCase().includes(npc.name.toLowerCase())) {
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
      const npc = dynamicState.npcCharacters.find(n =>
        n.name.toLowerCase() === npcName.toLowerCase() ||
        n.name.toLowerCase().includes(npcName.toLowerCase())
      );

      if (npc && !addedNpcIds.has(npc.id)) {
        // Avoid adding the same NPC twice
        addedNpcIds.add(npc.id);
        const currentLocation = dynamicState.currentScenario?.location || null;

        // If this NPC is the interaction partner, include player's name to get interaction history
        // Otherwise just use current location filtering
        const partnerForThisNpc = (interactionPartnerName &&
          npc.name.toLowerCase().includes(interactionPartnerName.toLowerCase()))
          ? playerName
          : null;

        actionRelatedNpcs.push({
          source: 'action_related',
          character: this.extractCompleteCharacterAttributes(npc, currentLocation, partnerForThisNpc)
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
    interactionPartnerName: string | null = null
  ) {
    const npcData = character as DynamicNPCProfile;

    // Filter action log: keep current location logs + interaction history with partner
    let filteredActionLog: ActionLogEntry[] = [];
    if (character.actionLog && character.actionLog.length > 0) {
      if (currentLocation || interactionPartnerName) {
        filteredActionLog = character.actionLog.filter(log => {
          // Include if in current location
          const isCurrentLocation = currentLocation &&
            log.location &&
            log.location.toLowerCase() === currentLocation.toLowerCase();

          // Include if involves interaction with partner (check if partner name appears in summary)
          const involvesPartner = interactionPartnerName &&
            log.summary &&
            log.summary.toLowerCase().includes(interactionPartnerName.toLowerCase());

          return isCurrentLocation || involvesPartner;
        });
      } else {
        // If no current scene location and no partner, don't include any action log
        filteredActionLog = [];
      }
    }
    
    return {
      // Basic information
      id: character.id,
      name: character.name,
      isNPC: npcData.isNPC || true,

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
        conditions: character.status.conditions || []
      },

      // Items
      inventory: character.inventory || [],

      // Action Log (only includes current location)
      actionLog: filteredActionLog,

      // Clues (if NPC)
      clues: npcData.clues || [],

      // Relationships (if NPC)
      relationships: npcData.relationships || [],

      // Notes
      notes: character.notes || ""
    };
  }

  /**
   * Extract complete player character information
   * @param player Player character information
   * @param currentLocation Current scene location (for filtering action log)
   * @param interactionPartnerName Optional: NPC name to include interaction history with
   */
  private extractCompletePlayerCharacter(
    player: DynamicCharacterProfile,
    currentLocation: string | null = null,
    interactionPartnerName: string | null = null
  ) {
    return this.extractCompleteCharacterAttributes(player, currentLocation, interactionPartnerName);
  }

  /**
   * Update clue states in game state
   */
  private updateClueStates(dynamicState: DynamicGameState, clueRevelations: any, gameStateManager: DynamicGameStateManager): DynamicGameState {
    const newDiscoveredClues: DiscoveredClue[] = [];

    // Update scenario clue states
    if (clueRevelations.scenarioClues && clueRevelations.scenarioClues.length > 0) {
      const currentScenario = dynamicState.currentScenario;
      if (currentScenario && currentScenario.clues) {
        clueRevelations.scenarioClues.forEach((item: string | { clueId: string }) => {
          const clueId = typeof item === "string" ? item : item?.clueId;
          if (!clueId) return;
          const clue = currentScenario.clues.find(c => c.id === clueId);
          if (clue && !clue.discovered) {
            const discoveredAt = new Date().toISOString();
            clue.discovered = true;
            clue.discoveryDetails = {
              discoveredBy: dynamicState.playerCharacter.name,
              discoveredAt,
              method: "Keeper revelation"
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
              method: "Keeper revelation"
            });
          }
        });
      }
    }

    // Update NPC clue states
    if (clueRevelations.npcClues && clueRevelations.npcClues.length > 0) {
      clueRevelations.npcClues.forEach((item: {npcId: string, clueId: string}) => {
        const npc = dynamicState.npcCharacters.find(n => n.id === item.npcId);
        if (npc && npc.clues) {
          const clue = npc.clues.find(c => c.id === item.clueId);
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
              method: "Social interaction"
            });
          }
        }
      });
    }

    // Handle NPC secret revelations (secrets are string arrays, identified by index)
    if (clueRevelations.npcSecrets && clueRevelations.npcSecrets.length > 0) {
      clueRevelations.npcSecrets.forEach((item: {npcId: string, secretIndex: number}) => {
        const npc = dynamicState.npcCharacters.find(n => n.id === item.npcId);
        if (npc && npc.secrets && npc.secrets[item.secretIndex]) {
          const secret = npc.secrets[item.secretIndex];

          // Create detailed secret info
          newDiscoveredClues.push({
            text: `Secret: ${secret}`,
            type: "secret",
            sourceName: npc.name,
            discoveredBy: dynamicState.playerCharacter.name,
            discoveredAt: new Date().toISOString(),
            method: "Secret revelation"
          });
        }
      });
    }

    // Add newly discovered clues to global discovery list
    newDiscoveredClues.forEach(discoveredClue => {
      // Check if clue text already exists
      const exists = dynamicState.discoveredClues.some(c => c.text === discoveredClue.text);
      if (!exists) {
        dynamicState.discoveredClues.push(discoveredClue);
      }
    });

    return gameStateManager.getState();
  }

  /**
   * Process input and generate appropriate narrative response
   */
  async processInput(input: string, gameStateManager: DynamicGameStateManager): Promise<{narrative: string, clueRevelations: any, updatedGameState: DynamicGameState}> {
    try {
      const result = await this.generateNarrative(input, gameStateManager);
      return result;
    } catch (error) {
      console.error("Error generating narrative:", error);
      return {
        narrative: "The shadows seem to obscure the scene, making it difficult to discern what transpires... [Keeper Agent Error]",
        clueRevelations: { scenarioClues: [], npcClues: [], npcSecrets: [] },
        updatedGameState: gameStateManager.getState()
      };
    }
  }

  private safeStringify(obj: any): string {
    try {
      return JSON.stringify(obj, null, 2);
    } catch (error) {
      return typeof obj === "string" ? obj : "";
    }
  }
}
