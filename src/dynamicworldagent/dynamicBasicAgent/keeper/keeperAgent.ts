import { getKeeperTemplate } from "./keeperTemplate.js";
import { composeTemplateWithImages } from "../../../template.js";
import type { ActionResult, ActionAnalysis, DiscoveredClue } from "../../../state.js";
import type { CharacterProfile, NPCProfile, ActionLogEntry } from "../../../coc_multiagents_system/agents/models/gameTypes.js";
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
    
    // 5. Detect scene changes, if changed then get previous scene information
    const isTransition = dynamicState.temporaryInfo.transition;
    const previousScenarioInfo = isTransition ? this.extractPreviousScenarioInfo(dynamicState) : null;
    
    // 6. Detect scene transition rejection
    const sceneTransitionRejection = dynamicState.temporaryInfo.sceneTransitionRejection;
    
    // 7. Get conversation history (from contextualData)
    const conversationHistory = (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
      turnNumber: number;
      characterInput: string;
      keeperNarrative: string | null;
    }>) || [];
    
    // 8. Get RAG retrieval results, keep only needed fields
    // TODO: Temporarily commented out RAG injection, as RAG section is being modified
    // const rawRagResults = (dynamicState.temporaryInfo.ragResults as any[]) || [];
    // const ragResults = rawRagResults.map((evidence: any) => ({
    //   type: evidence.type,
    //   title: evidence.title,
    //   snippet: evidence.snippet,
    //   visibility: evidence.visibility,
    // }));
    const ragResults: any[] = []; // Temporarily set to empty array
    
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
    
    const gameEnding = dynamicState.gameEnding || null;

    const templateContext = {
      characterInput,
      allActionResults,  // All action results (for {{#each}} loop)
      fullGameTime: fullGameTime,  // Complete display: "Day 1, 08:00 (Morning)"
      tension: dynamicState.tension,
      phase: dynamicState.phase,
      isTransition,
      sceneTransitionRejection,  // Object (for accessing .reasoning property)
      conversationHistory,  // Recent conversation history (for {{#each}} loop)
      // ragResults,  // TODO: Temporarily commented out RAG retrieval results, as RAG section is being modified
      ragResults: [],  // Temporarily set to empty array
      // JSON string version (used directly in template)
      scenarioContextJson: this.safeStringify(completeScenarioInfo),
      playerCharacterJson: this.safeStringify(playerCharacterComplete),
      actionRelatedNpcsJson: this.safeStringify(actionRelatedNpcs),
      previousScenarioJson: previousScenarioInfo
        ? this.safeStringify(previousScenarioInfo)
        : "null",
      gameEnding: gameEnding,
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

    // Clear transition flag (already processed in narrative)
    if (dynamicState.temporaryInfo.transition) {
      gameStateManager.clearTransitionFlag();
    }

    // Clear scene transition rejection flag (already processed in narrative)
    if (dynamicState.temporaryInfo.sceneTransitionRejection) {
      gameStateManager.clearSceneTransitionRejection();
    }

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
    
    // Clear temporary rules and RAG results
    const updatedState = gameStateManager.getState();
    updatedState.temporaryInfo.rules = [];
    updatedState.temporaryInfo.ragResults = [];
    console.log("   ✓ Cleared temporary rules and RAG results");
    
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

    // Simplified scenario info - keep essential dynamic state
    // Include clue text so Keeper can decide what to reveal
    return {
      hasScenario: true,
      id: currentScenario.id,
      name: currentScenario.name,
      location: currentScenario.location,
      // Characters present in the scene (dynamic state)
      characters: currentScenario.characters || [],
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
   */
  private extractPreviousScenarioInfo(dynamicState: DynamicGameState) {
    const visitedScenarios = dynamicState.visitedScenarios;
    
    if (!visitedScenarios || visitedScenarios.length === 0) {
      return {
        hasPreviousScenario: false,
        message: "No previous scenario available"
      };
    }

    // Get most recently visited scenario (first element is the latest)
    const previousScenario = visitedScenarios[0];

    return {
      hasPreviousScenario: true,
      id: previousScenario.id,
      name: previousScenario.name,
      location: previousScenario.location
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
    character: CharacterProfile,
    currentLocation: string | null = null,
    interactionPartnerName: string | null = null
  ) {
    const npcData = character as NPCProfile;

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
      
      // Complete attributes
      attributes: {
        STR: character.attributes.STR,
        CON: character.attributes.CON,
        DEX: character.attributes.DEX,
        APP: character.attributes.APP,
        POW: character.attributes.POW,
        SIZ: character.attributes.SIZ,
        INT: character.attributes.INT,
        EDU: character.attributes.EDU
      },
      
      // Complete status
      status: {
        hp: character.status.hp,
        maxHp: character.status.maxHp,
        sanity: character.status.sanity,
        maxSanity: character.status.maxSanity,
        luck: character.status.luck,
        mp: character.status.mp || 0,
        conditions: character.status.conditions || [],
        damageBonus: character.status.damageBonus || "0",
        build: character.status.build || 0,
        mov: character.status.mov || 7
      },
      
      // Items
      inventory: character.inventory || [],
      
      // Action Log (only includes current location)
      actionLog: filteredActionLog,
      
      // Clues (if NPC)
      clues: npcData.clues || [],
      
      // Relationships (if NPC)
      relationships: npcData.relationships || [],
      
      // Current location
      currentLocation: npcData.currentLocation || null,
      
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
    player: CharacterProfile,
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
