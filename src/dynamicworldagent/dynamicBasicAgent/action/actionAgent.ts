import { ModelClass } from "../../../models/types.js";
import { generateText } from "../../../models/index.js";
import { ActionResult, ActionAnalysis, NPCResponseAnalysis, ActionType, SceneChangeRequest } from "../../../coc_multiagents_system/state/index.js";
import type { ActionLogEntry } from "../../../coc_multiagents_system/agents/models/gameTypes.js";
import type { DynamicCharacterProfile } from "../../world_builder/types.js";
import type { DynamicNPCProfile } from "../../world_builder/types.js";
import { actionTypeTemplates } from "../../../coc_multiagents_system/agents/action/example.js";
import type { ScenarioLoader } from "../../../coc_multiagents_system/agents/memory/scenarioloader/index.js";
import type { DynamicGameState } from "../../state/index.js";
import { DynamicGameStateManager } from "../../state/index.js";


/**
 * Action Agent class - handles action resolution and skill checks
 */
export class ActionAgent {
  private scenarioLoader?: ScenarioLoader;

  constructor(scenarioLoader?: ScenarioLoader) {
    this.scenarioLoader = scenarioLoader;
  }

  /**
   * Unified method to process any character's action (player or NPC)
   */
  private async processCharacterAction(
    runtime: any,
    dynamicState: DynamicGameState,
    character: DynamicCharacterProfile,
    actionDescription: string,
    options: {
      isNPC: boolean;
      npcResponse?: NPCResponseAnalysis;
      targetCharacter?: DynamicCharacterProfile | null;
    },
    gameStateManager: DynamicGameStateManager
  ): Promise<DynamicGameState> {
    const { isNPC, npcResponse, targetCharacter } = options;

    // Check if there's a valid scene change request from orchestrator
    const existingSceneChangeRequest = dynamicState.temporaryInfo.sceneChangeRequest;
    const hasValidSceneChangeRequest = existingSceneChangeRequest?.shouldChange === true && existingSceneChangeRequest?.targetSceneName;

    // Pre-roll dice
    const preRolledDice = this.preRollDice();

    // Build base system prompt - only include scene change detection if there's a valid scene change request
    let sceneChangePrompt = '';
    if (hasValidSceneChangeRequest && !isNPC) {
      sceneChangePrompt = `
SCENE CHANGE REQUEST VALIDATION:
The orchestrator has already validated a scene change request to "${existingSceneChangeRequest.targetSceneName}".
Your task is to determine if the action succeeds in enabling this scene change:
1. If the action is unobstructed (open door, clear path), the scene change will proceed
2. If the player explicitly attempts an action to enable movement (e.g., "I try to unlock the door", "I attempt to climb the wall", "I try to break down the door"):
   * Perform the required skill check using dice
   * If skill check SUCCEEDED, the scene change will proceed (set shouldChange: true)
   * If skill check FAILED, set shouldChange: false and provide reason explaining why (e.g., "Failed to unlock the door", "Failed to climb the wall", "The lock is too difficult")
3. If there's an obstruction and the player doesn't explicitly attempt an action, set shouldChange: false and provide reason (e.g., "The door is locked", "The path is blocked")
`;
    }

    const baseSystemPrompt = `

PRE-ROLLED DICE AVAILABLE:
${JSON.stringify(preRolledDice, null, 2)}

USAGE:
- 1d100: Use for single skill checks, attribute checks, luck rolls (compare against character's skill percentage)
- 1d100_opposed: Use for opposed checks (the second character's roll)
- 1d3, 1d4, 1d6, 2d6, 1d8, 1d10, 1d20: Use for damage, sanity loss, etc.
- Dice with modifiers: You can add modifiers to pre-rolled dice (e.g., 1d3+1, 1d6+2 for damage bonus/STR bonus)
- You can choose to use these dice OR not use any if the action doesn't require dice
- When you use a die, record which die you used and the result in your response
- Examples: "1d3: 2 + 1 (DB) = 3 (unarmed damage)", "1d6: 4 + 2 (STR bonus) = 6 (knife damage)"

!!! Important: Always follow the 7th edition rules of Call of Cthulhu.
When the player's input explicitly mentions using a specific skill (e.g., "I use Spot Hidden", "I try to persuade him", "I listen at the door"), you MUST:
- Perform a dice roll (1d100) for that skill

DiceUsed field:
- Record ONLY the dice you actually used from the pre-rolled dice
- Format: "[dice_name]: [result] ([purpose] = [success/failure])"
- Examples: "1d100: 67 (Brawl 50% = success)", "1d6: 4 (knife damage)", "1d100_opposed: 55 (opposed check)"
- If no dice needed, use empty array: "diceUsed": []

Include "scenarioUpdate" if the action permanently changes the environment. "scenarioUpdate" can include:
- description: updated scene flavor text
- conditions: array of environmental condition objects
- events: array of event strings
${!isNPC ? '' : '\nDo NOT include clues here; the Keeper determines clue revelations.'}

INVENTORY UPDATES:
If the action involves picking up, dropping, receiving, giving, or losing items, include "inventory" in stateUpdate.playerCharacter or stateUpdate.npcCharacters:
- Inventory items are objects with: { name: string, quantity?: number, properties?: Record<string, any> }
- To add items: "inventory": { "add": [{ "name": "item name 1", "quantity": 1 }, { "name": "item name 2" }] }
- To remove items: "inventory": { "remove": [{ "name": "item name", "quantity": 1 }] }
- To replace entire inventory: "inventory": [{ "name": "item1" }, { "name": "item2", "quantity": 3, "properties": { "weight": 2.5 } }]
- For item transfers between characters: update BOTH the giver and receiver
  * Giver: "inventory": { "remove": [{ "name": "item name" }] }
  * Receiver: "inventory": { "add": [{ "name": "item name" }] }

TIME ESTIMATION:
Estimate how many minutes this action realistically takes in game time. Consider the nature and complexity of the action:
- Quick actions: 1-10 minutes (glancing, brief conversation, opening doors)
- Standard actions: 10-30 minutes (searching, examining)
- Extended actions: 30-120 minutes (combat, lengthy conversations, research)
- Long activities: 2-8 hours (travel, surveillance, extended tasks)
- Very long activities: 8+ hours (sleeping, all-day journeys)

Be realistic and use your judgment. Include "timeElapsedMinutes" in your response.
${sceneChangePrompt}

## 📋 ActionLog Requirements

**REQUIRED**: Always include at least ONE actionLog entry for the current action.

**Format**: Each actionLog entry should have:
- "time": Use the current game time (provided in context) in "Day N, HH:MM" format
- "location": The LOCATION NAME (scenario.location), which is the physical location name
  - Use currentScenario.location for current scenario
  - For scene changes, use the target scenario's location name
- "summary": Concise but descriptive summary (1-2 sentences)
- "characterId": The ID of the character (player or NPC) who performed this action
  - Use the acting character's id from the context (Character.id or NPC.id)
  - If the action affects multiple characters, create separate entries with their respective characterIds
  - This field is REQUIRED to properly associate the log with the correct character profile

**For scene changes**: If sceneChange.shouldChange is true, include TWO entries:
1. One entry for the action that enables the scene change (current location)
2. One entry for the scene transition (target location)

## 📋 Output Format

Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "summary": "Brief description of what happened (1-2 sentences)",

  "diceUsed": [
    // Array of dice you actually used (empty array if no dice needed)
    // Format: "[dice_name]: [result] ([purpose/skill] [skill%] = [success/failure/N/A])"
    "1d100: 67 (Fighting (Brawl) 50% = failure)",
    "1d3: 2 + 1 (DB) = 3 (unarmed damage)"
  ],

  "actionLog": [
    {
      "time": "Day 1, 14:30",
      "location": "New York Public Library",
      "summary": "Searched the bookshelf and found a hidden journal",
      "characterId": "character-id-or-npc-id"
    }
  ],

  "stateUpdate": {
    // Optional: Update character states (HP, sanity, inventory, etc.)
    "playerCharacter": {
      "name": "Character Name",  // MUST match the acting character's name
      "status": {
        "hp": -3,              // HP change (negative for damage, positive for healing)
        "sanity": 0,           // Sanity change
        "magic": 0,            // Magic points change
        "luck": 0              // Luck change
      },
      "inventory": {           // Optional: only if inventory changes
        "add": [{"name": "item name", "quantity": 1}],
        "remove": [{"name": "item name", "quantity": 1}]
      }
    },
    "npcCharacters": [         // Optional: only if NPC states change
      {
        "id": "npc-id",        // MUST use exact NPC id
        "name": "NPC Name",
        "status": {"hp": -4, "sanity": 0}
      }
    ]
  },

  "scenarioUpdate": {          // Optional: only if environment permanently changes
    "description": "Updated scene description",
    "conditions": [{"type": "lighting", "description": "...", "mechanicalEffect": "..."}],
    "events": ["Event description"]
  },
${hasValidSceneChangeRequest && !isNPC ? `
  "sceneChange": {
    "shouldChange": false,     // true if action succeeds in enabling scene change to "${existingSceneChangeRequest.targetSceneName}"
    "targetSceneName": "${existingSceneChangeRequest.targetSceneName}",   // Use the target from orchestrator
    "reason": "Reason for scene change success or failure. If blocked, explain why (e.g., 'Door is locked', 'Failed to unlock the door')"
  },
` : ''}
  "timeElapsedMinutes": 5,
  "timeConsumption": "short"
}
\`\`\`
`;

    const actionTypeTemplate = this.getActionTypeTemplate(dynamicState, isNPC, npcResponse);

    const systemPrompt = baseSystemPrompt + actionTypeTemplate;

    // Single call - no tool loop needed with pre-rolled dice
    const context = this.buildContext(dynamicState, character, { isNPC, npcResponse, targetCharacter }, gameStateManager);
    const fullPrompt = systemPrompt + context + `\n\nCharacter action: ${actionDescription}`;

    const response = await generateText({
      runtime,
      context: fullPrompt,
      modelClass: ModelClass.SMALL,
    });

    // Parse JSON response
    let parsed;
    try {
      let jsonText = response.trim();

      const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (codeBlockMatch) {
        jsonText = codeBlockMatch[1].trim();
        console.log(`📝 [Action Agent] Detected markdown code block, extracted JSON content`);
      }

      if (!jsonText.startsWith('{') && !jsonText.startsWith('[')) {
        const jsonObjectMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonObjectMatch) {
          jsonText = jsonObjectMatch[0];
          console.log(`📝 [Action Agent] Extracted JSON object from text`);
        }
      }

      parsed = JSON.parse(jsonText);
    } catch (error) {
      console.error(`❌ [Action Agent] JSON parsing error:`, error);
      console.error(`   Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
      console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`   Original response (first 500 chars): ${response.substring(0, 500)}${response.length > 500 ? '...' : ''}`);
      console.error(`   Original response length: ${response.length} characters`);
      return this.buildErrorResult(dynamicState, character, `Invalid JSON response from model: ${error instanceof Error ? error.message : String(error)}`, [], isNPC, gameStateManager);
    }

    // Extract dice usage from response
    const diceUsed = parsed.diceUsed || [];

    // Return final result
    return this.buildFinalResult(dynamicState, character, parsed, diceUsed, { isNPC, npcResponse }, gameStateManager);
  }

  /**
   * Process character action and resolve with dice rolls and state updates
   */
  async processAction(runtime: any, gameStateManager: DynamicGameStateManager, userMessage: string): Promise<void> {
    const dynamicState = gameStateManager.getState();
    const actionAnalysis = dynamicState.temporaryInfo.currentActionAnalysis;
    const targetCharacter = this.findTargetCharacter(dynamicState, actionAnalysis);

    const updatedState = await this.processCharacterAction(
      runtime,
      dynamicState,
      dynamicState.playerCharacter,
      userMessage,
      {
        isNPC: false,
        targetCharacter
      },
      gameStateManager
    );
    
    // The state has been updated through the manager in buildFinalResult
    // No need to do anything else here
  }

  /**
   * Pre-roll common dice expressions
   */
  private preRollDice() {
    const rollDice = (sides: number, count: number = 1): number[] => {
      return Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
    };

    // Pre-roll all common dice types
    const d100_1 = rollDice(100)[0];
    const d100_2 = rollDice(100)[0];
    const d20 = rollDice(20)[0];
    const d10 = rollDice(10)[0];
    const d8 = rollDice(8)[0];
    const d6_1 = rollDice(6)[0];
    const d6_2 = rollDice(6)[0];
    const d4 = rollDice(4)[0];
    const d3 = rollDice(3)[0];

    return {
      "1d100": d100_1,        // For single skill checks
      "1d100_opposed": d100_2, // For opposed checks (second roll)
      "1d20": d20,
      "1d10": d10,
      "1d8": d8,
      "1d6": d6_1,
      "2d6": d6_1 + d6_2,
      "1d4": d4,
      "1d3": d3
    };
  }

  /**
   * Find target character based on action analysis or NPC response
   */
  private findTargetCharacter(
    dynamicState: DynamicGameState,
    actionAnalysis?: ActionAnalysis | null,
    npcResponse?: NPCResponseAnalysis
  ): DynamicCharacterProfile | null {
    let targetName: string | null = null;

    if (npcResponse?.targetCharacter) {
      targetName = npcResponse.targetCharacter;
    } else if (actionAnalysis?.target?.name) {
      targetName = actionAnalysis.target.name;
    }

    if (!targetName) {
      return null;
    }

    const targetLower = targetName.toLowerCase();

    // Check if target is player
    if (dynamicState.playerCharacter.name.toLowerCase().includes(targetLower)) {
      return dynamicState.playerCharacter;
    }

    // Check NPCs
    const targetNpc = dynamicState.npcCharacters.find(npc =>
      npc.name.toLowerCase().includes(targetLower) ||
      npc.id.toLowerCase().includes(targetLower)
    );

    return targetNpc || null;
  }

  private getActionTypeTemplate(
    dynamicState: DynamicGameState,
    isNPC: boolean = false,
    npcResponse?: NPCResponseAnalysis
  ): string {
    let actionType: string | undefined;

    if (isNPC && npcResponse?.responseType) {
      actionType = npcResponse.responseType;
    } else {
      const actionAnalysis = dynamicState.temporaryInfo.currentActionAnalysis;
      actionType = actionAnalysis?.actionType;
    }

    if (!actionType) {
      return `
{
  "type": "result",
  "summary": "Action completed",
  "stateUpdate": {
    "playerCharacter": {
      "name": "Character Name",
      "status": { "hp": 0 }
    }
  },
  "log": ["Action log entry"]
}`;
    }

    const template =
      actionTypeTemplates[actionType as keyof typeof actionTypeTemplates];
    return template || actionTypeTemplates.exploration; // fallback to exploration
  }

  /**
   * Unified method to build context for any character action
   */
  private buildContext(
    dynamicState: DynamicGameState,
    character: DynamicCharacterProfile,
    options: {
      isNPC: boolean;
      npcResponse?: NPCResponseAnalysis;
      targetCharacter?: DynamicCharacterProfile | null;
    },
    gameStateManager?: DynamicGameStateManager
  ): string {
    const { isNPC, npcResponse } = options;
    let { targetCharacter } = options;

    // Add current game time information for actionLog generation
    const fullGameTime = gameStateManager ? gameStateManager.getFullGameTime() : `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    let context = `\n\n=== CURRENT GAME TIME ===\n${fullGameTime}\n=== END OF GAME TIME ===\n`;
    context += "\n\nCurrent Scenario:\n";
    if (dynamicState.currentScenario) {
      // Find the corresponding scenario outline to get connections
      const scenarioOutline = dynamicState.scenarioOutlines.find(
        outline => outline.id === dynamicState.currentScenario!.id
      );
      
      const scenarioInfo = {
        name: dynamicState.currentScenario.name,
        location: dynamicState.currentScenario.location,
        description: dynamicState.currentScenario.description,
        conditions: dynamicState.currentScenario.conditions,
        connections: scenarioOutline?.connections || [] // Array of {scenarioName, relationshipType, description} - only "leads_to" connections allow scene change
      };
      context += JSON.stringify(scenarioInfo, null, 2);
    } else {
      context += "No current scenario";
    }

    // Add scene change information only if there's a valid scene change request from orchestrator
    const existingSceneChangeRequest = dynamicState.temporaryInfo.sceneChangeRequest;
    const hasValidSceneChangeRequest = existingSceneChangeRequest?.shouldChange === true && existingSceneChangeRequest?.targetSceneName;
    
    if (hasValidSceneChangeRequest && !isNPC) {
      context += `\n\n=== SCENE CHANGE REQUEST ===`;
      context += `\nTarget Scene: ${existingSceneChangeRequest.targetSceneName}`;
      context += `\nReason: ${existingSceneChangeRequest.reason || 'Scene change requested'}`;
      context += `\nYour task: Determine if the current action enables this scene change (check for obstructions, skill requirements, etc.)`;
      context += `\n=== END OF SCENE CHANGE REQUEST ===\n`;
    }

    // Add temporary rules if any
    if (dynamicState.temporaryInfo.rules.length > 0) {
      context += "\n\nTemporary Rules:\n";
      dynamicState.temporaryInfo.rules.forEach((rule, index) => {
        context += `${index + 1}. ${rule}\n`;
      });
    }

    // Add acting character
    context += `\n\n${isNPC ? 'NPC (acting character)' : 'Character'}:\n` + JSON.stringify(character, null, 2);

    // Add target character if applicable
    if (targetCharacter) {
      const isPlayerTarget = targetCharacter.id === dynamicState.playerCharacter.id ||
        targetCharacter.name === dynamicState.playerCharacter.name;
      context += `\n\nTarget ${isPlayerTarget ? 'Character (Player)' : 'NPC'}:\n` + JSON.stringify(targetCharacter, null, 2);
    }

    // Add NPC response context if NPC action
    if (isNPC && npcResponse) {
      context += "\n\nNPC Response Context:\n";
      context += JSON.stringify({
        responseDescription: npcResponse.responseDescription,
        executionOrder: npcResponse.executionOrder
      }, null, 2);
    }

    return context;
  }

  /**
   * Unified method to build final result for any character action
   */
  private buildFinalResult(
    dynamicState: DynamicGameState,
    character: DynamicCharacterProfile,
    parsed: any,
    toolLogs: string[],
    options: {
      isNPC: boolean;
      npcResponse?: NPCResponseAnalysis;
    },
    gameStateManager: DynamicGameStateManager
  ): DynamicGameState {
    const { isNPC, npcResponse } = options;
    
    // Apply the state update from LLM result
    if (parsed.stateUpdate) {
      gameStateManager.applyActionUpdate(parsed.stateUpdate);
    }

    // Handle scene change modification from Action Agent
    // Action Agent modifies the existing sceneChangeRequest from Orchestrator
    const currentSceneChangeRequest = dynamicState.temporaryInfo.sceneChangeRequest;
    if (parsed.sceneChange && currentSceneChangeRequest) {
      // Update the existing sceneChangeRequest based on action result
      const updatedRequest: SceneChangeRequest = {
        shouldChange: parsed.sceneChange.shouldChange,
        targetSceneName: parsed.sceneChange.targetSceneName || currentSceneChangeRequest.targetSceneName,
        reason: parsed.sceneChange.reason || currentSceneChangeRequest.reason,
        timestamp: currentSceneChangeRequest.timestamp
      };
      gameStateManager.setSceneChangeRequest(updatedRequest);
      
      if (!isNPC) {
        // Player scene change: log the result
        if (parsed.sceneChange.shouldChange) {
          console.log(`Action Agent: Action succeeded, scene change to ${updatedRequest.targetSceneName} will proceed`);
        } else {
          console.log(`Action Agent: Action failed, scene change blocked - ${parsed.sceneChange.reason || "Unknown reason"}`);
        }
      }
    } else if (parsed.sceneChange && isNPC && parsed.sceneChange.shouldChange && parsed.sceneChange.targetSceneName) {
      // NPC scene change: create new request for NPC
      const targetSceneName = parsed.sceneChange.targetSceneName;
      console.log(`\n📍 [Action Agent] NPC ${character.name} requested scene transition: ${targetSceneName}`);

      if (this.scenarioLoader) {
        const searchResult = this.scenarioLoader.searchScenarios({ name: targetSceneName });

        if (searchResult.scenarios.length > 0) {
          const currentState = gameStateManager.getState();
          const npcInState = currentState.npcCharacters.find(n => n.id === character.id);

          if (npcInState) {
            // Location is tracked via actionLog
            console.log(`   ✓ NPC ${character.name} scene change requested: ${targetSceneName} (location tracked via actionLog)`);
          } else {
            console.warn(`   ⚠️  NPC ${character.name} (ID: ${character.id}) not found in dynamicState`);
          }
        } else {
          console.warn(`   ⚠️  Scene "${targetSceneName}" not found`);
        }
      } else {
        console.warn(`   ⚠️  ScenarioLoader not initialized, unable to find scene location`);
      }
    }

    // Apply scenario updates if provided (clues handled by Keeper)
    const scenarioChanges: string[] = [];
    const scenarioUpdate = parsed.scenarioUpdate ? { ...parsed.scenarioUpdate } : null;
    if (scenarioUpdate && "clues" in scenarioUpdate) {
      delete scenarioUpdate.clues;
    }
    if (scenarioUpdate) {
      gameStateManager.updateScenarioState(scenarioUpdate);
      
      // Generate scenario change descriptions for action results
      if (scenarioUpdate.description) {
        scenarioChanges.push("Environment description updated");
      }
      
      if (scenarioUpdate.conditions && scenarioUpdate.conditions.length > 0) {
        scenarioChanges.push(`Environmental conditions changed: ${scenarioUpdate.conditions.map((c: any) => c.description).join(', ')}`);
      }
    }
    
    // Create structured action result
    const actionResult: ActionResult = {
      timestamp: new Date(),
      gameTime: dynamicState.timeOfDay || "Unknown time",
      timeElapsedMinutes: parsed.timeElapsedMinutes || 0,
      location: dynamicState.currentScenario?.location || "Unknown location",
      character: character.name,
      result: parsed.summary || (isNPC && npcResponse?.responseDescription) || "performed an action",
      diceRolls: toolLogs.map(log => log), // toolLogs already contain "expression -> result" format
      timeConsumption: parsed.timeConsumption || "instant", // Default to instant if not specified
      scenarioChanges: scenarioChanges.length > 0 ? scenarioChanges : undefined
    };
    
    // Add to action results
    gameStateManager.addActionResult(actionResult);

    // Log detailed action result
    const logPrefix = isNPC ? `📊 [NPC Action Result] ${character.name}` : `📊 [Action Result] Detailed execution result`;
    console.log(`\n${logPrefix}:`);
    if (!isNPC) {
      console.log(`   Character: ${actionResult.character}`);
      console.log(`   Location: ${actionResult.location}`);
      console.log(`   Game Time: ${actionResult.gameTime}`);
      console.log(`   Time Elapsed: ${actionResult.timeElapsedMinutes || 0} minutes`);
      console.log(`   Time Consumption: ${actionResult.timeConsumption}`);
    }
    console.log(`   Result: ${actionResult.result}`);
    if (isNPC && npcResponse) {
      console.log(`   Type: ${npcResponse.responseType}`);
    }
    if (actionResult.diceRolls && actionResult.diceRolls.length > 0) {
      console.log(`   Dice Rolls${isNPC ? '' : ` (${actionResult.diceRolls.length})`}: ${isNPC ? actionResult.diceRolls.join(', ') : ''}`);
      if (!isNPC) {
        actionResult.diceRolls.forEach((roll, index) => {
          console.log(`     [${index + 1}] ${roll}`);
        });
      }
    } else if (!isNPC) {
      console.log(`   Dice Rolls: None`);
    }
    if (actionResult.scenarioChanges && actionResult.scenarioChanges.length > 0 && !isNPC) {
      console.log(`   Scenario Changes (${actionResult.scenarioChanges.length}):`);
      actionResult.scenarioChanges.forEach((change, index) => {
        console.log(`     [${index + 1}] ${change}`);
      });
    }

    // Update game time based on elapsed time
    // IMPORTANT: Only player actions advance game time, NPC reactions do not
    if (actionResult.timeElapsedMinutes && actionResult.timeElapsedMinutes > 0) {
      if (!isNPC) {
        // Only advance time for player actions
        const oldDay = dynamicState.gameDay;
        const oldTime = dynamicState.timeOfDay;
        gameStateManager.updateGameTime(actionResult.timeElapsedMinutes);
        const updatedState = gameStateManager.getState();
        const newDay = updatedState.gameDay;
        const newTime = updatedState.timeOfDay;
        const fullTime = gameStateManager.getFullGameTime();

        console.log(`⏰ Time advanced by ${actionResult.timeElapsedMinutes} minutes (Player action)`);
        if (newDay > oldDay) {
          console.log(`   Day ${oldDay}, ${oldTime} → ${fullTime} 🌅`);
        } else {
          console.log(`   ${oldTime} → ${fullTime}`);
        }
      } else {
        // NPC actions have time elapsed but don't advance game time
        console.log(`⏰ NPC action time: ${actionResult.timeElapsedMinutes} minutes (not counted in game time)`);
      }
    }

    // Append actionLog entries generated by LLM to the corresponding character
    // LLM generates actionLog entries in the response
    const updatedState = gameStateManager.getState();

    // Get actionLog entries from LLM response and add to the corresponding character based on characterId
    if (parsed.actionLog && Array.isArray(parsed.actionLog)) {
      // Process each actionLog entry and add to the corresponding character based on characterId
      for (const logEntry of parsed.actionLog) {
        if (logEntry.time && logEntry.location && logEntry.summary) {
          // Find the character by characterId if provided, otherwise use acting character
          let targetCharacter: DynamicCharacterProfile | undefined;
          
          if (logEntry.characterId) {
            // Find character by ID
            if (logEntry.characterId === updatedState.playerCharacter.id) {
              targetCharacter = updatedState.playerCharacter;
            } else {
              targetCharacter = updatedState.npcCharacters.find(
                npc => npc.id === logEntry.characterId
              );
            }
            
            if (!targetCharacter) {
              console.warn(`   ⚠️  Character with ID "${logEntry.characterId}" not found, skipping actionLog entry`);
              continue;
            }
          } else {
            // Fallback: use acting character if characterId not provided (backward compatibility)
            if (isNPC) {
              targetCharacter = updatedState.npcCharacters.find(npc => npc.id === character.id);
            } else {
              targetCharacter = updatedState.playerCharacter;
            }
            
            if (!targetCharacter) {
              console.warn(`   ⚠️  Acting character not found, skipping actionLog entry`);
              continue;
            }
          }

          // Initialize actionLog array if needed
          if (!targetCharacter.actionLog) {
            targetCharacter.actionLog = [];
          }

          // Create ActionLogEntry without characterId (not stored in the entry)
          const actionLogEntry: ActionLogEntry = {
            time: logEntry.time,
            location: logEntry.location,
            summary: logEntry.summary,
          };
          
          targetCharacter.actionLog.push(actionLogEntry);
        }
      }

      if (parsed.actionLog.length > 0) {
        console.log(`   ✓ Processed ${parsed.actionLog.length} actionLog entries`);
      }
    } else {
      // Fallback: if LLM didn't generate actionLog, create a basic entry
      const fullTime = gameStateManager.getFullGameTime();
      
      // Find the acting character in the current state
      let actorInState: DynamicCharacterProfile | undefined;
      if (isNPC) {
        actorInState = updatedState.npcCharacters.find(npc => npc.id === character.id);
        if (!actorInState) {
          console.warn(`   ⚠️  NPC ${character.name} (ID: ${character.id}) not found in state, cannot add fallback actionLog`);
        }
      } else {
        actorInState = updatedState.playerCharacter;
      }
      
      if (actorInState) {
        if (!actorInState.actionLog) {
          actorInState.actionLog = [];
        }

        // Use location name for actionLog location field
        const locationName = updatedState.currentScenario?.location || "Unknown location";
        
        const fallbackLogEntry: ActionLogEntry = {
          time: fullTime,
          location: locationName,
          summary: actionResult.result,
        };
        actorInState.actionLog.push(fallbackLogEntry);
        console.log(`   ⚠️  LLM did not generate actionLog, added fallback entry to ${isNPC ? 'NPC' : 'player'} ${actorInState.name} with location: ${locationName}`);
      }
    }

    // Note: Target character actionLog should be generated by LLM if the action affects them
    // The LLM can include actionLog entries for target characters in the response if needed
    
    // Return the updated game state
    return gameStateManager.getState();
  }


  /**
   * Unified method to build error result for any character action
   */
  private buildErrorResult(
    dynamicState: DynamicGameState,
    character: DynamicCharacterProfile,
    errorMessage: string,
    toolLogs: string[],
    isNPC: boolean,
    gameStateManager: DynamicGameStateManager
  ): DynamicGameState {
    const logPrefix = isNPC ? `NPC action processing error (${character.name})` : `Error handling`;
    console.error(`\n❌ [Action Agent] ${logPrefix}: ${errorMessage}`);
    console.error(`   Current game state: Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`);
    console.error(`   Location: ${dynamicState.currentScenario?.location || "Unknown"}`);
    console.error(`   Character: ${character.name}`);
    if (toolLogs.length > 0) {
      console.error(`   Executed tool calls (${toolLogs.length}):`);
      toolLogs.forEach((log, index) => {
        console.error(`     [${index + 1}] ${log}`);
      });
    }

    const stateManager = new DynamicGameStateManager(dynamicState);

    // Create an error action result to record the failure
    const errorActionResult: ActionResult = {
      timestamp: new Date(),
      gameTime: dynamicState.timeOfDay || "Unknown time",
      timeElapsedMinutes: 0, // No time elapsed on error
      location: dynamicState.currentScenario?.location || "Unknown location",
      character: character.name,
      result: `[Error] ${isNPC ? 'NPC ' : ''}action processing failed: ${errorMessage}`,
      diceRolls: toolLogs.length > 0 ? toolLogs : [],
      timeConsumption: "instant",
      scenarioChanges: [`Error: ${errorMessage}`]
    };

    // Add error result to action results
    stateManager.addActionResult(errorActionResult);

    console.error(`\n📊 [Action Result] Error result recorded:`);
    console.error(`   Character: ${errorActionResult.character}`);
    console.error(`   Location: ${errorActionResult.location}`);
    console.error(`   Error: ${errorActionResult.result}`);

    // Return valid DynamicGameState with error recorded
    return stateManager.getState();
  }

  /**
   * Process NPC actions based on response analyses
   * Processes all NPCs that have willRespond=true in npcResponseAnalyses
   */
  async processNPCActions(runtime: any, gameStateManager: DynamicGameStateManager): Promise<void> {
    const dynamicState = gameStateManager.getState();
    const npcResponseAnalyses = dynamicState.temporaryInfo.npcResponseAnalyses || [];

    // Filter NPCs that will respond and sort by executionOrder
    const respondingNPCs = npcResponseAnalyses
      .filter(analysis => analysis.willRespond && analysis.responseType && analysis.responseType !== "none")
      .sort((a, b) => a.executionOrder - b.executionOrder);

    if (respondingNPCs.length === 0) {
      console.log("📝 [Action Agent] No NPCs will respond, skipping NPC action processing");
      return;
    }

    console.log(`\n🎭 [Action Agent] Processing ${respondingNPCs.length} NPC actions in order...`);

    // Process each NPC action sequentially in executionOrder
    for (const npcResponse of respondingNPCs) {
      const currentState = gameStateManager.getState();
      const npc = currentState.npcCharacters.find(n => 
        n.name.toLowerCase() === npcResponse.npcName.toLowerCase()
      );
      
      if (!npc) {
        console.warn(`⚠️ [Action Agent] NPC not found: ${npcResponse.npcName}`);
        continue;
      }
      
      console.log(`\n🎭 [Action Agent] Processing NPC action [${npcResponse.executionOrder}]: ${npcResponse.npcName} (${npcResponse.responseType})`);
      
      // Process this NPC's action
      // buildFinalResult will update the manager's state
      await this.processSingleNPCAction(
        runtime,
        currentState,
        npc,
        npcResponse,
        gameStateManager
      );
    }
    
    console.log(`\n✅ [Action Agent] Completed processing ${respondingNPCs.length} NPC actions`);
  }

  /**
   * Process a single NPC action
   */
  private async processSingleNPCAction(
    runtime: any,
    dynamicState: DynamicGameState,
    npc: DynamicCharacterProfile,
    npcResponse: NPCResponseAnalysis,
    gameStateManager: DynamicGameStateManager
  ): Promise<DynamicGameState> {
    const npcActionDescription = npcResponse.responseDescription || `${npc.name} performs a ${npcResponse.responseType} action`;
    const targetCharacter = this.findTargetCharacter(dynamicState, null, npcResponse);

    return this.processCharacterAction(
      runtime,
      dynamicState,
      npc,
      npcActionDescription,
      {
        isNPC: true,
        npcResponse,
        targetCharacter
      },
      gameStateManager
    );
  }
}
