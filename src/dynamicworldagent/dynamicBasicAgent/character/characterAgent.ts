import { ModelClass } from "../../../models/types.js";
import { generateText } from "../../../models/index.js";
import { NPCResponseAnalysis, ActionType } from "../../../coc_multiagents_system/state/index.js";
import type { ActionLogEntry } from "../../../coc_multiagents_system/agents/models/gameTypes.js";
import type { DynamicCharacterProfile } from "../../world_builder/types.js";
import type { DynamicNPCProfile } from "../../world_builder/types.js";
import type { DynamicGameState, DynamicGameStateManager } from "../../state/index.js";
import { getCharacterTemplate } from "./characterTemplate.js";
import { getCharacterSimulatedTemplate } from "./characterSimulatedTemplate.js";
import { composeTemplateWithImages } from "../../../template.js";

/**
 * Character Agent class - handles NPC response analysis
 */
export class CharacterAgent {

  /**
   * Analyze NPC responses to recent player actions (from Director Agent)
   * This method is used when the Director detects progression threshold and analyzes recent player actionLog
   * It doesn't require action results or action analysis
   */
  async analyzeNPCResponsesFromRecentActions(
    runtime: any,
    gameStateManager: DynamicGameStateManager,
    recentActionLog: ActionLogEntry[]
  ): Promise<NPCResponseAnalysis[]> {
    const dynamicState = gameStateManager.getState();
    const template = getCharacterSimulatedTemplate();

    // 1. Get current scenario information
    const scenarioInfo = this.extractScenarioInfo(dynamicState);

    // 2. Get player character information
    const playerCharacter = this.extractCharacterInfo(dynamicState.playerCharacter);

    // 3. Get NPCs in current scene location (with full details including goals)
    const sceneNpcs = this.extractSceneNPCs(dynamicState);

    // If no NPCs in scene, return empty array
    if (sceneNpcs.length === 0) {
      console.log("📝 [Character Agent] No NPCs in current scene, skipping analysis");
      return [];
    }

    // If no recent actions, return empty array
    if (recentActionLog.length === 0) {
      console.log("📝 [Character Agent] No recent player actions, skipping analysis");
      return [];
    }

    // Build template context
    const templateContext = {
      recentActionLogJson: JSON.stringify(recentActionLog, null, 2),
      scenarioInfoJson: JSON.stringify(scenarioInfo, null, 2),
      playerCharacterJson: JSON.stringify(playerCharacter, null, 2),
      sceneNpcsJson: JSON.stringify(sceneNpcs, null, 2)
    };

    const { content: context, images } = composeTemplateWithImages(
      template,
      { dynamicGameState: dynamicState },
      templateContext,
      "handlebars"
    );

    console.log("\n🎭 [Character Agent] Analyzing NPC responses to recent player actions...");
    console.log(`   Recent actions: ${recentActionLog.length} entries`);
    console.log(`   Latest actions: ${recentActionLog.slice(-3).map(a => `${a.time}: ${a.summary}`).join("; ")}`);
    console.log(`   Scene: ${scenarioInfo.location || "Unknown"}`);
    console.log(`   NPCs to analyze: ${sceneNpcs.length}`);

    // Call LLM
    const response = await generateText({
      runtime,
      context,
      images,
      modelClass: ModelClass.SMALL,
    });

    // Parse and validate response (reuse existing parsing logic)
    return this.parseNPCResponseAnalyses(response);
  }

  /**
   * Analyze NPC responses to character actions
   */
  async analyzeNPCResponses(
    runtime: any,
    gameStateManager: DynamicGameStateManager,
    characterInput: string
  ): Promise<NPCResponseAnalysis[]> {
    const dynamicState = gameStateManager.getState();
    const template = getCharacterTemplate();
    
    // 1. Get latest action result
    const latestActionResult = this.getLatestActionResult(dynamicState);
    
    // 2. Get current scenario information
    const scenarioInfo = this.extractScenarioInfo(dynamicState);
    
    // 3. Get player character information
    const playerCharacter = this.extractCharacterInfo(dynamicState.playerCharacter);
    
    // 4. Get NPCs in current scene location
    const sceneNpcs = this.extractSceneNPCs(dynamicState);
    
    // If no NPCs in scene, return empty array
    if (sceneNpcs.length === 0) {
      console.log("📝 [Character Agent] No NPCs in current scene, skipping response analysis");
      return [];
    }
    
    // 5. Get target information from action analysis to determine if action is targeted
    const actionAnalysis = dynamicState.temporaryInfo.currentActionAnalysis;
    const actionTarget = actionAnalysis?.target || null;
    
    // Build template context
    const templateContext = {
      characterInput,
      latestActionResultJson: latestActionResult ? JSON.stringify(latestActionResult, null, 2) : "No action result available yet.",
      scenarioInfoJson: JSON.stringify(scenarioInfo, null, 2),
      playerCharacterJson: JSON.stringify(playerCharacter, null, 2),
      sceneNpcsJson: JSON.stringify(sceneNpcs, null, 2),
      actionTargetJson: actionTarget ? JSON.stringify(actionTarget, null, 2) : null
    };
    
    const { content: context, images } = composeTemplateWithImages(
      template,
      { dynamicGameState: dynamicState },
      templateContext,
      "handlebars"
    );
    
    console.log("\n🎭 [Character Agent] Analyzing NPC responses...");
    console.log(`   Scene: ${scenarioInfo.location || "Unknown"}`);
    console.log(`   NPCs to analyze: ${sceneNpcs.length}`);
    
    // Call LLM
    const response = await generateText({
      runtime,
      context,
      images,
      modelClass: ModelClass.SMALL,
    });

    // Parse and validate response
    return this.parseNPCResponseAnalyses(response);
  }
  
  /**
   * Get latest action result
   */
  private getLatestActionResult(dynamicState: DynamicGameState): any | null {
    const actionResults = dynamicState.temporaryInfo.actionResults;
    
    if (!actionResults || actionResults.length === 0) {
      return null;
    }
    
    const latest = actionResults[actionResults.length - 1];
    
    return {
      gameTime: latest.gameTime,
      timeElapsedMinutes: latest.timeElapsedMinutes,
      location: latest.location,
      character: latest.character,
      result: latest.result,
      timeConsumption: latest.timeConsumption,
      scenarioChanges: latest.scenarioChanges || []
    };
  }
  
  /**
   * Extract scenario information
   */
  private extractScenarioInfo(dynamicState: DynamicGameState): any {
    const currentScenario = dynamicState.currentScenario;
    
    if (!currentScenario) {
      return {
        hasScenario: false,
        message: "No current scenario loaded"
      };
    }
    
    // Find the corresponding scenario outline to get connections
    const scenarioOutline = dynamicState.scenarioOutlines.find(
      outline => outline.id === currentScenario.id
    );
    
    return {
      id: currentScenario.id,
      name: currentScenario.name,
      location: currentScenario.location,
      description: currentScenario.description,
      characters: currentScenario.characters || [],
      clues: currentScenario.clues || [],
      conditions: currentScenario.conditions || [],
      connections: scenarioOutline?.connections || []
    };
  }
  
  /**
   * Extract character information (basic attributes)
   */
  private extractCharacterInfo(character: DynamicCharacterProfile): any {
    return {
      id: character.id,
      name: character.name,
      attributes: character.attributes,
      status: character.status,
      skills: character.skills,
      inventory: character.inventory || [],
      notes: character.notes || ""
    };
  }
  
  /**
   * Normalize name (for fuzzy matching)
   */
  private normalizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
      .trim();
  }

  /**
   * Calculate Levenshtein distance (edit distance) between two strings
   */
  private levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      Array(n + 1).fill(0)
    );

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    return dp[m][n];
  }

  /**
   * Determine if two names are similar (similarity >= 80%)
   */
  private isNameSimilar(name1: string, name2: string): boolean {
    const na = this.normalizeName(name1);
    const nb = this.normalizeName(name2);
    if (!na || !nb) return false;
    if (na === nb) return true;

    // If first word is the same, consider similar
    const tokensA = na.split(/\s+/);
    const tokensB = nb.split(/\s+/);
    if (tokensA[0] && tokensA[0] === tokensB[0]) return true;

    // Calculate Levenshtein distance and convert to similarity
    const dist = this.levenshtein(na, nb);
    const maxLen = Math.max(na.length, nb.length);
    if (maxLen === 0) return false;
    const similarity = 1 - dist / maxLen;
    return similarity >= 0.8; // 80% similarity threshold
  }

  /**
   * Extract NPCs in current scene location
   */
  private extractSceneNPCs(dynamicState: DynamicGameState): any[] {
    const currentScenario = dynamicState.currentScenario;
    
    if (!currentScenario || !currentScenario.location) {
      return [];
    }
    
    const scenarioLocation = currentScenario.location;
    const sceneNpcs: any[] = [];

    // Get NPCs from scenario characters list
    const scenarioCharacterNames = new Set(
      (currentScenario.characters || []).map(c => c.name.toLowerCase())
    );

    console.log(`\n🔍 [Extract Scene NPCs] Current location: "${scenarioLocation}"`);
    console.log(`🔍 [Extract Scene NPCs] Scenario characters list: ${currentScenario.characters?.map(c => c.name).join(', ') || 'none'}`);
    console.log(`🔍 [Extract Scene NPCs] Total NPCs in game: ${dynamicState.npcCharacters.length}`);

    // First, add NPCs explicitly listed in scenario (using 80% similarity fuzzy matching)
    for (const scenarioChar of currentScenario.characters || []) {
      const matchingNpc = dynamicState.npcCharacters.find(npc =>
        this.isNameSimilar(npc.name, scenarioChar.name)
      );

      if (matchingNpc) {
        sceneNpcs.push(this.extractNPCInfo(matchingNpc));
        console.log(`   ✓ Added from scenario.characters: "${matchingNpc.name}" (matched "${scenarioChar.name}")`);
      } else {
        console.log(`   ⚠️  No match found for scenario character: "${scenarioChar.name}"`);
      }
    }

    // Then, add NPCs with matching location from actionLog
    let addedByLocation = 0;
    for (const npc of dynamicState.npcCharacters) {
      const npcProfile = npc as DynamicNPCProfile;

      // Get current location from actionLog
      const currentLocation = this.getCurrentLocationFromActionLog(npcProfile.actionLog);
      
      if (currentLocation &&
          currentLocation.toLowerCase() === scenarioLocation.toLowerCase()) {

        // Check if already added (avoid duplicates using fuzzy matching for consistency)
        const alreadyAdded = sceneNpcs.some(sn =>
          this.isNameSimilar(sn.name, npc.name)
        );

        if (!alreadyAdded) {
          sceneNpcs.push(this.extractNPCInfo(npc));
          console.log(`   ✓ Added by actionLog location: "${npc.name}" (location: "${currentLocation}")`);
          addedByLocation++;
        } else {
          console.log(`   - Skipped duplicate: "${npc.name}" (already in scene)`);
        }
      }
    }

    console.log(`\n📊 [Extract Scene NPCs] Summary:`);
    console.log(`   From scenario.characters: ${sceneNpcs.length - addedByLocation}`);
    console.log(`   From actionLog location match: ${addedByLocation}`);
    console.log(`   Total NPCs in scene: ${sceneNpcs.length}\n`);

    return sceneNpcs;
  }
  
  /**
   * Get current location from actionLog (latest entry with location)
   */
  private getCurrentLocationFromActionLog(actionLog?: ActionLogEntry[]): string | null {
    if (!actionLog || actionLog.length === 0) {
      return null;
    }
    
    // Find the latest entry with a location (iterate backwards)
    for (let i = actionLog.length - 1; i >= 0; i--) {
      if (actionLog[i].location) {
        return actionLog[i].location;
      }
    }
    
    return null;
  }

  /**
   * Extract NPC information (basic attributes)
   */
  private extractNPCInfo(npc: DynamicCharacterProfile): any {
    const npcProfile = npc as DynamicNPCProfile;
    
    // Get recent actionLog (last 15 entries, roughly 3 turns)
    const npcActionLog = npc.actionLog || [];
    const recentActionLog = npcActionLog.slice(-15);
    
    return {
      id: npc.id,
      name: npc.name,
      occupation: npcProfile.occupation || "Unknown",
      age: npcProfile.age || "Unknown",
      appearance: npcProfile.appearance || "No description",
      personality: npcProfile.personality || "Unknown personality",
      background: npcProfile.background || "Unknown background",
      goals: npcProfile.goals || [],
      secrets: npcProfile.secrets || [],
      attributes: npc.attributes,
      status: npc.status,
      skills: npc.skills,
      inventory: npc.inventory || [],
      clues: npcProfile.clues || [],
      relationships: npcProfile.relationships || [],
      notes: npc.notes || "",
      recentActionLog: recentActionLog
    };
  }

  /**
   * Parse and validate NPC response analyses from LLM response
   * Shared by both analyzeNPCResponses and analyzeNPCResponsesFromRecentActions
   */
  private parseNPCResponseAnalyses(response: string): NPCResponseAnalysis[] {
    // Parse JSON response
    let parsed;
    try {
      // Extract JSON from markdown code blocks if present
      let jsonText = response.trim();

      // Try to extract JSON from markdown code blocks
      const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (codeBlockMatch) {
        jsonText = codeBlockMatch[1].trim();
        console.log(`📝 [Character Agent] Detected markdown code block, extracted JSON content`);
      }

      // Try to extract JSON object if wrapped in other text
      if (!jsonText.startsWith('{') && !jsonText.startsWith('[')) {
        const jsonObjectMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonObjectMatch) {
          jsonText = jsonObjectMatch[0];
          console.log(`📝 [Character Agent] Extracted JSON object from text`);
        }
      }

      parsed = JSON.parse(jsonText);
    } catch (error) {
      console.error(`❌ [Character Agent] JSON parsing error:`, error);
      console.error(`   Original response (first 500 chars): ${response.substring(0, 500)}${response.length > 500 ? '...' : ''}`);
      return [];
    }

    // Extract and validate NPC response analyses
    const analyses: NPCResponseAnalysis[] = [];

    // Valid action types
    const validActionTypes: ActionType[] = [
      "exploration", "social", "stealth", "combat",
      "chase", "mental", "environmental", "narrative"
    ];

    if (parsed.npcResponseAnalyses && Array.isArray(parsed.npcResponseAnalyses)) {
      for (const analysis of parsed.npcResponseAnalyses) {
        // Validate required fields
        if (analysis.npcName && typeof analysis.willRespond === 'boolean') {
          // Validate responseType
          let responseType: ActionType | "none" | null = null;
          if (analysis.willRespond) {
            if (analysis.responseType === "none") {
              responseType = "none";
            } else if (analysis.responseType && validActionTypes.includes(analysis.responseType as ActionType)) {
              responseType = analysis.responseType as ActionType;
            } else {
              console.warn(`⚠️ [Character Agent] Invalid responseType for ${analysis.npcName}: ${analysis.responseType}, defaulting to null`);
              responseType = null;
            }
          }

          const validated: NPCResponseAnalysis = {
            npcName: analysis.npcName,
            willRespond: analysis.willRespond,
            responseType: responseType,
            responseDescription: analysis.responseDescription || "",
            executionOrder: typeof analysis.executionOrder === 'number' ? analysis.executionOrder : 999,
            targetCharacter: analysis.targetCharacter || null
          };

          analyses.push(validated);

          console.log(`   ✓ ${validated.npcName}: ${validated.willRespond ? validated.responseType : 'no response'}`);
        }
      }
    }

    console.log(`\n✅ [Character Agent] Analyzed ${analyses.length} NPC responses`);

    return analyses;
  }
}
