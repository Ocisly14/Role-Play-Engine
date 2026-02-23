import type { SceneChangeRequest } from "../../../shared/state/index.js";

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
  targetIntent?: string | null,
  outputLanguage: "en" | "zh" = "zh",
  fatigueActive?: boolean
): string {
  // Check if there's a valid scene change request from orchestrator
  const hasValidSceneChangeRequest =
    existingSceneChangeRequest?.shouldChange === true &&
    existingSceneChangeRequest?.targetSceneName;

  // Build base system prompt - only include scene change detection if there's a valid scene change request
  let sceneChangePrompt = "";
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
    ? ""
    : selectedSkill
      ? `SKILL POLICY:
- A player-selected skill is provided; treat the action as using that skill.
- If no check is needed, keep diceUsed empty.
`
      : skillSelectionMode === "auto"
        ? `SKILL POLICY:
- It is auto skill selection mode.
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
${
  originalUserInput && !isNPC
    ? `## User Input
User input: ${originalUserInput}

`
    : ""
}${
  !isNPC && targetIntent
    ? `## Orchestrator Target Intent
Target intent: ${targetIntent}
- This intent is parsed by Orchestrator and should be used as additional context when resolving this action.

`
    : ""
}## Character Action
Character action: ${actionDescription}

${
  !isNPC && selectedSkill
    ? `## Player-Selected Skill
Player selected skill: ${selectedSkill}
- If a skill check is required for this action, you MUST use this skill.
- If no check is needed, keep diceUsed empty.

`
    : ""
}${
  !isNPC && fatigueActive
    ? `⚠️ PLAYER FATIGUE STATUS:
当前角色状态：疲惫。所有玩家技能判定难度提高一个等级。
Current player status: Fatigued. Increase player skill check difficulty by one level.
- regular → hard (skill ÷ 2)
- hard → extreme (skill ÷ 5)
- extreme → extreme (already at maximum difficulty, no further increase)

`
    : ""
}${usagePolicy}PRE-ROLLED DICE AVAILABLE:
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

🚨 CRITICAL: If no skill is chosen by the user, DO NOT select any dice. Always use empty array "diceUsed": [] when no skill is selected. Unless the skill selection mode is "auto".

!!! Important: Always follow the 7th edition rules of Call of Cthulhu.

SUSTAINED COMBAT DETECTION:
- Player-initiated attack rule: if the player attacks and the targeted NPC is likely to retaliate, resist, or continue fighting, treat it as sustained combat (entersCombat: true).
- NPC-initiated hostility rule: if an NPC proactively attacks/threatens imminent violence against the player, treat it as sustained combat (entersCombat: true, combatInitiatedBy: "npc").
- Use NPC personality, current status/injuries, tactical position, and short-term goals/motives to judge whether they will fight on, retreat, surrender, or avoid escalation.
- Defeated NPC bias rule: use the injected "DEFEATED NPC HISTORY". If a target NPC appears in that list, default to NOT entering sustained combat (entersCombat: false).
- Exception to defeated NPC bias: only set entersCombat: true for previously defeated NPCs when the investigator's action creates immediate major life/safety threat (e.g., lethal strike, execution attempt, fire/explosion, clearly deadly escalation).
- For non-lethal pressure (questioning, intimidation, warning shots, minor restraint, ordinary confrontation), previously defeated NPCs should generally avoid re-entering combat.
- When entersCombat: true, list the NPC IDs of all combatants in combatParticipantIds.
- combatInitiatedBy: "player" if the player struck first or declared the attack; "npc" if an NPC turned hostile and attacked without player instigation.

DiceUsed field:
- Record ONLY the dice you actually used from the pre-rolled dice
- Format: "[character name]: [dice results...](penalty/bonus for each extra die),(skill/purpose use highest/lowest [value] = success/failure/N/A)"
- Always include WHO is making the check before each dice record.
- IMPORTANT: When selecting multiple dice, always select in order starting from index 0 (e.g., [0], [0,1], [0,1,2], etc.)
- Examples:
  - Normal roll: "John: 1d100[0]: 67 (Brawl 50% = success)"
  - 1 Penalty die: "Dr. Smith: 1d100[0]: 45, 1d100[1]: 82(penalty),(Spot Hidden 60% use highest 82 = failure)"
  - 2 Penalty dice: "John: 1d100[0]: 45, 1d100[1]: 82(penalty), 1d100[2]: 67(penalty),(Listen 50% use highest 82 = failure)"
  - 1 Bonus die: "John: 1d100[0]: 82, 1d100[1]: 34(bonus),(Stealth 55% use lowest 34 = success)"
  - 2 Bonus dice: "John: 1d100[0]: 82, 1d100[1]: 34(bonus), 1d100[2]: 56(bonus),(Stealth 55% use lowest 34 = success)"
  - Damage: "John: 1d6[0]: 4 (knife damage = 4)"
- When penalty/bonus dice apply: Mark EACH extra die with (penalty) or (bonus), then specify which value is used for the check
- When a percentage penalty applies (e.g. -20%), include it: "(Drive Auto 50% -20 = )"
- If no dice needed, use empty array: "diceUsed": []

Include "scenarioUpdate" if the action permanently changes the environment. "scenarioUpdate" can include:
- description: updated scene flavor text
- conditions: array of environmental condition objects
${!isNPC ? "" : "\nDo NOT include clues here; the GM determines clue revelations."}

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
${
  !isNPC && sceneNPCs && sceneNPCs.length > 0
    ? `

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
`
    : ""
}

## 🎲 Dice Interpretation (CoC 7e)

### Basic Success Levels
- Prefer explicit labels in dice results (success/failure/critical/fumble). If labels conflict, trust the numeric roll.
- **Critical success**: roll is 01.
- **Extreme success**: roll ≤ (skill ÷ 5).
- **Hard success**: roll ≤ (skill ÷ 2).
- **Regular success**: roll ≤ skill.
- **Failure**: roll > skill.
- **Fumble**: roll 96–100 if skill < 50; roll 100 if skill ≥ 50.
- If only "success" is provided without level, treat as regular unless roll/skill allows a higher tier.

### Penalty Die and Bonus Die
- **Penalty Die**: Select multiple 1d100 results (2 for one penalty die, 3 for two penalty dice, etc.) and use the **HIGHEST** value for the check.
- **Bonus Die**: Select multiple 1d100 results (2 for one bonus die, 3 for two bonus dice, etc.) and use the **LOWEST** value for the check.
- Whether to use penalty or bonus die is determined by the situation of the scene and character's status. Normally, one dice is enough for deciding the success or failure.

## 📋 ActionLog Requirements

**REQUIRED**: Always include at least ONE actionLog entry for the current action.

**Format**: Each actionLog entry should have:
- "time": Use the current game time (provided in context) in "Day N, HH:MM" format
- "location": The LOCATION NAME
- "summary": Concise but descriptive summary (1-2 sentences). **IMPORTANT**: If the action has a target (NPC, object, or location), INCLUDE the target in the summary (e.g., "Asked Dr. Smith about the missing journal", "Attacked the cultist with a knife", "Examined the locked door").
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
    // Select penalty/bonus dice when applicable
    // Format: Mark each extra die with (penalty) or (bonus), then specify which value is used
    // Always select dice in order starting from index 0
    "John: 1d100[0]: 67 (Brawling 50% = failure)",
    "Dr. Smith: 1d100[1]: 45, 1d100[2]: 82(penalty),(Spot Hidden 60% use highest 82 = failure)",
    "John: 1d3[0]: 2 + 1 (DB) = 3 (unarmed damage = 3)"
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
    // Optional: Update character state/appearance (HP, sanity, inventory, etc based on the result of the action)
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
    "npcCharacters": [         // Optional: only if NPC state/appearance changes
      {
        "id": "npc-id",        // MUST use exact NPC id
        "name": "NPC Name",
        "status": {"hp": -4, "sanity": 0},
        "appearance": "Updated appearance description based on the result of the action (optional)"
      }
    ]
  },

  "scenarioUpdate": {          // Optional: only if environment permanently changes
    "description": "Updated scene description",
    "conditions": [{"type": "lighting", "description": "...", "mechanicalEffect": "..."}]
  },
${
  hasValidSceneChangeRequest && !isNPC
    ? `
  "sceneChange": {
    "shouldChange": false,     // true if action succeeds in enabling scene change to "${existingSceneChangeRequest.targetSceneName}"
    "targetSceneName": "${existingSceneChangeRequest.targetSceneName}",   // Use the target from orchestrator
    "reason": "Reason for scene change success or failure. If blocked, explain why (e.g., 'Door is locked', 'Failed to unlock the door')"
  },
`
    : ""
}
  "timeElapsedMinutes": <estimate the time elapsed in minutes>,
  "timeConsumption": "short", // "instant" | "short" | "medium" | "long" | "very long"
  "entersCombat": false,            // true if sustained combat starts this turn
  "combatParticipantIds": [],       // NPC IDs actively fighting the player (only when entersCombat: true)
  "combatInitiatedBy": "player",   // "player" or "npc" (only when entersCombat: true)
  // When entersCombat=true AND combatInitiatedBy="npc", provide the NPC opening attack intents
  "openingPendingNpcActions": [
    {
      "npcId": "npc-id",
      "npcName": "NPC Name",
      "actionNarrative": "NPC opening attack intent"
    }
  ],

  "relationshipChanges": [  // Optional: only when this action meaningfully shifts trust/hostility/loyalty
    {
      "sourceNpcId": "npc-id",          // NPC whose relationship changes (MUST be a scene NPC)
      "targetId": "target-character-id", // Who they feel differently about
      "targetName": "Exact target name",
      "relationshipType": "ally",        // Updated relationship label
      "attitude": -20,                   // New attitude delta (-100 to 100)
      "description": "Why the attitude changed"
    }
  ]
${
  !isNPC && sceneNPCs && sceneNPCs.length > 0
    ? `
  "npcResponses": [  // Optional: Array of NPC responses (only for player actions)
    {
      "npcName": "NPC name",
      "npcId": "npc-id",
      "willRespond": true,
      "responseType": "social",
      "executionOrder": 1,
      "diceUsed": [  // Optional: Dice rolls if NPC action requires skill checks
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
      "stateUpdate": {  // Optional: NPC state/appearance changes
        "status": {"hp": 0, "sanity": -1},
        "inventory": {"add": [{"name": "item"}]},
        "appearance": "Updated appearance description based on the result of the action (optional)"
      }
    }
  ]
`
    : ""
}
}
\`\`\`
`;
}
