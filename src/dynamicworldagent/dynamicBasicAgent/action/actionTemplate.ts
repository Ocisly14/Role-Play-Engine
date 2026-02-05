import type { DynamicGameState } from "../../state/index.js";
import type { NPCResponseAnalysis, SceneChangeRequest } from "../../../shared/state/index.js";
import { actionTypeTemplates } from "../../../shared/agents/action/example.js";

/**
 * Build the base system prompt for action resolution
 */
export function buildActionSystemPrompt(
  originalUserInput: string | null | undefined,
  actionDescription: string,
  preRolledDice: Record<string, number[]>,
  isNPC: boolean,
  existingSceneChangeRequest?: SceneChangeRequest | null,
  sceneNPCs?: any[] | null,
  selectedSkill?: string | null,
  skillSelectionMode?: "auto" | "manual",
  outputLanguage: "en" | "zh" = "zh"
): string {
  // Check if there's a valid scene change request from orchestrator
  const hasValidSceneChangeRequest = existingSceneChangeRequest?.shouldChange === true && existingSceneChangeRequest?.targetSceneName;

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

  const usagePolicy = isNPC
    ? `SKILL POLICY:
- Analyze the NPC action and decide whether a skill check is required.
- If no check is needed, do not use any dice.
- If a skill check is required, choose the appropriate skill and use dice.
`
    : selectedSkill
      ? `SKILL POLICY:
- A player-selected skill is provided; treat the action as using that skill.
- If no check is needed, keep diceUsed empty.
`
      : skillSelectionMode === "auto"
        ? `SKILL POLICY:
- No player-selected skill is provided.
- Analyze the user input to determine whether it is normal behavior or a specific skill use.
- If it is normal behavior, do not use any dice.
- If it implies a specific skill, choose the appropriate skill and use dice.
`
        : `SKILL POLICY:
- No player-selected skill is provided.
- Do NOT select or infer a skill on the player's behalf.
- Do NOT perform any skill checks and do NOT use any dice.
***IMPORTANT: If the input does NOT involve a scene change and does NOT cause major impact on the scene or any NPC, do NOT mention any skill and do NOT output any dice rolls.***
- Always use empty array: "diceUsed": [].
`;
  const targetLanguageLabel = outputLanguage === "en" ? "English" : "Chinese";

  return `
${originalUserInput && !isNPC ? `## User Input
User input: ${originalUserInput}

` : ''}## Character Action
Character action: ${actionDescription}

${!isNPC && selectedSkill ? `## Player-Selected Skill
Player selected skill: ${selectedSkill}
- If a skill check is required for this action, you MUST use this skill.
- If no check is needed, keep diceUsed empty.

` : ''}${usagePolicy}PRE-ROLLED DICE AVAILABLE:
${JSON.stringify(preRolledDice, null, 2)}

OUTPUT LANGUAGE REQUIREMENT:
- Keep all JSON keys and enum values in English exactly as specified.
- In \`actionLog\`, \`summary\` MUST use ${targetLanguageLabel}.
- Keep names/identifiers/location values from context unchanged (do not translate them).

USAGE:
- Each dice type has multiple pre-rolled results (1d100 has 10, others have 5). Select ONE result from the array for each dice you need.
- 1d100: Use for single skill checks, attribute checks, luck rolls (compare against character's skill percentage) - select one from 10 available results
- 1d100_opposed: Use for opposed checks (the second character's roll) - select one from 5 available results
- 1d3, 1d4, 1d6, 2d6, 1d8, 1d10, 1d20: Use for damage, sanity loss, etc. - select one from 5 available results each
- Dice with modifiers: You can add modifiers to pre-rolled dice (e.g., 1d3+1, 1d6+2 for damage bonus/STR bonus)
- You can choose to use these dice OR not use any if the action doesn't require dice
- When you use a die, record which die you used (including which result from the array, e.g., "1d100[0]: 67") and the result in your response

!!! Important: Always follow the 7th edition rules of Call of Cthulhu.

DiceUsed field:
- Record ONLY the dice you actually used from the pre-rolled dice
- Format: "[dice_name][index]: [result] ([skill/purpose] [penalty if any] = [success/failure])"
- Examples: "1d100[0]: 67 (Brawl 50% = success)", "1d100[1]: 82 (Spot Hidden 60% penalty die = failure)", "1d6[2]: 4 (knife damage)"
- When penalty dice or bonus dice apply, include "penalty die" or "bonus die" in parentheses, e.g. "(Perception 25% penalty die = failure)"
- When a percentage penalty applies (e.g. -20%), include it: "(Drive Auto 50% -20 = failure)"
- If no dice needed, use empty array: "diceUsed": []

Include "scenarioUpdate" if the action permanently changes the environment. "scenarioUpdate" can include:
- description: updated scene flavor text
- conditions: array of environmental condition objects
${!isNPC ? '' : '\nDo NOT include clues here; the GM determines clue revelations.'}

INVENTORY UPDATES:
If the action involves picking up, dropping, receiving, giving, or losing items, include "inventory" in stateUpdate.playerCharacter or stateUpdate.npcCharacters:
- Inventory items are objects with: { name: string, quantity?: number, properties?: Record<string, any> }
- To add items: "inventory": { "add": [{ "name": "item name 1", "quantity": 1 }, { "name": "item name 2" }] }
- To remove items: "inventory": { "remove": [{ "name": "item name", "quantity": 1 }] }
- To replace entire inventory: "inventory": [{ "name": "item1" }, { "name": "item2", "quantity": 3, "properties": { "weight": 2.5 } }]
- For item transfers between characters: update BOTH the giver and receiver
  * Giver: "inventory": { "remove": [{ "name": "item name" }] }
  * Receiver: "inventory": { "add": [{ "name": "item name" }] }

IMPORTANT - ITEM USAGE RESTRICTION:
The player can ONLY use items that:
1. Are in their current inventory (check the Character.inventory provided in context), OR
2. Are explicitly available in the current scene (mentioned in scenario description or conditions)
If the player attempts to use an item they don't have and isn't available in the scene, the action should fail with an appropriate explanation (e.g., "You don't have [item name]", "There is no [item name] available here").

TIME ESTIMATION:
Estimate how many minutes this action realistically takes in game time. Consider the nature and complexity of the action:
- Quick actions: 1-10 minutes (glancing, brief conversation, opening doors)
- Standard actions: 10-30 minutes (searching, examining)
- Extended actions: 30-120 minutes (combat, lengthy conversations, research)
- Long activities: 2-6 hours (long distance travel, surveillance, extended tasks)
- Very long activities: 6+ hours (sleeping, all-day journeys)

Be realistic and use your judgment. Include "timeElapsedMinutes" in your response.
${sceneChangePrompt}
${!isNPC && sceneNPCs && sceneNPCs.length > 0 ? `

## 🎭 NPC Response Analysis (Only for Player Actions)

After resolving the player's action, analyze how NPCs in the current scene will respond.

**IMPORTANT: NPC Perspective Limitation**
- NPCs act from their own perspective and are NOT omniscient
- Consider NPC's position, attention, and sensory capabilities when determining awareness
- NPCs may misinterpret or partially understand actions based on their perspective

For each NPC in the current scene, determine:

1. **Will the NPC respond?** (willRespond: true/false)
   - NPC can act against the investigator's action based on investigator's intent and the situation.
   - NPC must be able to perceive the action from their perspective and location
   - Consider NPC's goals, personality, relationships, and current state
   - For targeted actions: In most cases, only the targeted NPC should respond. Other NPCs should only respond if the action significantly impacts them.

2. **What type of response?** (responseType: one of the eight action types, or "none")
   - **none**: No response
   - **exploration**: Discovering clues, understanding environment
   - **social**: Influencing others, gathering intelligence
   - **stealth**: Acting without being detected
   - **combat**: Causing damage, subduing opponents
   - **chase**: Extending or closing distance
   - **mental**: Withstanding psychological shock
   - **environmental**: Confronting environment and physiological limits
   - **narrative**: Key choices without mechanical rolls

3. **Response Description**: Brief description of what the NPC will do

4. **Execution Order**: Assign a unique sequential number (1, 2, 3...) to each responding NPC
   - Lower numbers execute first (1 executes before 2, etc.)
   - Consider narrative flow and cause-effect relationships

5. **NPC Action Details**: For each responding NPC, provide:
   - **diceUsed**: Choose and use one or more Dices from the pre-rolled dice array if the NPC action requires skill checks
   - **actionLog**: Action log entry for the NPC
   - **stateUpdate**: State changes for the NPC (if any)

## Important Notes

- **For targeted actions**: In the vast majority of cases, only the targeted NPC should have willRespond: true. Other NPCs should only respond if the action significantly impacts them.
- The targetCharacter can be the investigator or any other NPC in the scene
- NPCs can respond to each other, not just to the investigator

**NPCs in Current Scene:**
Each NPC includes their last 3 actionLog entries (recentActionLog) showing their recent activities and locations. Use this information to understand what each NPC has been doing recently and how they might respond to the player's action.

${JSON.stringify(sceneNPCs, null, 2)}
` : ''}

## 🎲 Dice Interpretation (CoC 7e)

- Prefer explicit labels in dice results (success/failure/critical/fumble). If labels conflict, trust the numeric roll.
- **Critical success**: roll is 01.
- **Extreme success**: roll ≤ (skill ÷ 5).
- **Hard success**: roll ≤ (skill ÷ 2).
- **Regular success**: roll ≤ skill.
- **Failure**: roll > skill.
- **Fumble**: roll 96–100 if skill < 50; roll 100 if skill ≥ 50.
- If only "success" is provided without level, treat as regular unless roll/skill allows a higher tier.

## 📋 ActionLog Requirements

**REQUIRED**: Always include at least ONE actionLog entry for the current action.

**Format**: Each actionLog entry should have:
- "time": Use the current game time (provided in context) in "Day N, HH:MM" format
- "location": The LOCATION NAME
- "summary": Concise but descriptive summary (1-2 sentences)
- "successLevel": Optional. Include ONLY when this actionLog entry uses a SKILL CHECK.
  - Allowed values: "critical" | "extreme" | "hard" | "regular" | "failure" | "fumble" | "unknown"
  - If no skill check is used for this entry, omit "successLevel" entirely.
  - Do NOT infer successLevel for pure narrative/non-skill actions.
- "characterId": The ID of the character (player or NPC) who performed this action
  - Use the acting character's id from the context (Character.id or NPC.id)
  - If the action affects multiple characters, create separate entries with their respective characterIds

**For scene changes**: If sceneChange.shouldChange is true, include TWO entries:
1. One entry for the action that enables the scene change (current location)
2. One entry for the scene transition (target location)

## 📋 Output Format

Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "diceUsed": [
    // Array of dice you actually used (empty array if no dice needed)
    // Format: "[dice_name][index]: [result] ([skill%] [penalty if any] = [success/failure/N/A])"
    // Include "penalty die", "bonus die", or "-20" etc. when applicable
    "1d100[0]: 67 (Brawling 50% = failure)",
    "1d100[1]: 82 (Spot Hidden 60% penalty die = failure)",
    "1d3[1]: 2 + 1 (DB) = 3 (unarmed damage)"
  ],

  "actionLog": [
    {
      "time": "Day 1, 14:30",
      "location": "New York Public Library",
      "summary": "Searched the bookshelf and found a hidden journal",
      "successLevel": "regular",
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
    "conditions": [{"type": "lighting", "description": "...", "mechanicalEffect": "..."}]
  },
${hasValidSceneChangeRequest && !isNPC ? `
  "sceneChange": {
    "shouldChange": false,     // true if action succeeds in enabling scene change to "${existingSceneChangeRequest.targetSceneName}"
    "targetSceneName": "${existingSceneChangeRequest.targetSceneName}",   // Use the target from orchestrator
    "reason": "Reason for scene change success or failure. If blocked, explain why (e.g., 'Door is locked', 'Failed to unlock the door')"
  },
` : ''}
  "timeElapsedMinutes": <estimate the time elapsed in minutes>,
  "timeConsumption": "short", // "short", "medium", "long", "very long"
${!isNPC && sceneNPCs && sceneNPCs.length > 0 ? `
  "npcResponses": [  // Optional: Array of NPC responses (only for player actions)
    {
      "npcName": "NPC name",
      "npcId": "npc-id",
      "willRespond": true,
      "responseType": "social",
      "executionOrder": 1,
      "diceUsed": [  // Optional: Dice rolls if NPC action requires skill checks
        "1d100[index]: 45 (Persuade 50% = success)"
      ],
      "actionLog": [  // Required: At least one actionLog entry
        {
          "time": "Day 1, 14:30",
          "location": "Current Location",
          "summary": "NPC's action summary",
          "successLevel": "regular",
          "characterId": "npc-id"
        }
      ],
      "stateUpdate": {  // Optional: NPC state changes
        "status": {"hp": 0, "sanity": -1},
        "inventory": {"add": [{"name": "item"}]}
      }
    }
  ]
` : ''}
}
\`\`\`
`;
}

/**
 * Get the action type template based on action type
 */
export function getActionTypeTemplate(
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
