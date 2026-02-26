import type { SceneChangeRequest } from "../../../shared/state/index.js";

/**
 * Build the base system prompt for multiplayer action resolution.
 * Only player actions go through this path — no NPC actions.
 */
export function buildActionSystemPrompt(
  originalUserInput: string | null | undefined,
  actionDescription: string,
  preRolledDice: Record<string, number[]>,
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
  if (hasValidSceneChangeRequest) {
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

  const usagePolicy = selectedSkill
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
MULTIPLAYER ROUND MODE:
- You will be given "scenePlayers" and "roundInputs" scoped to that sceneRoomId.
- Some players may be present in the room but omitted this round. Do NOT invent actions for omitted players.

TASK:
- For EACH player who has an input in "roundInputs", resolve their action independently using the shared scene context.
- Do NOT mix up players. Use the correct characterId/name/profile per player.
- Produce one output object per acting player, wrapped in a "players" array: { "players": [{ "playerId": "...", "output": { ... } }] }.

PER-PLAYER SKILL POLICY:
- Each player in "roundInputs" may have their own selectedSkill and skillSelectionMode.
- If a player has selectedSkill set, use that skill for their action.
- If a player has skillSelectionMode "auto", analyze their input to determine skill use.
- If a player has skillSelectionMode "manual" and no selectedSkill, do NOT infer a skill for them.

PER-PLAYER FATIGUE POLICY:
- If fatigueActive is true for a player, increase that player's skill check difficulty by one level:
  regular → hard (skill ÷ 2), hard → extreme (skill ÷ 5), extreme → extreme.

SCENE CHANGE REQUEST VALIDATION (per player):
- If a player has an existing sceneChangeRequest validated by orchestrator, you must decide whether their action enables it.
- Output \`sceneChange\` ONLY for players who have an existing sceneChangeRequest.

PRE-ROLLED DICE:
- A single shared preRolledDice pool is provided for the entire round.
- All players and NPCs draw from this same pool.

${
  originalUserInput
    ? `## User Input
User input: ${originalUserInput}

`
    : ""
}${
  targetIntent
    ? `## Orchestrator Target Intent
Target intent: ${targetIntent}
- This intent is parsed by Orchestrator and should be used as additional context when resolving this action.

`
    : ""
}## Character Action
Character action: ${actionDescription}

${
  selectedSkill
    ? `## Player-Selected Skill
Player selected skill: ${selectedSkill}
- If a skill check is required for this action, you MUST use this skill.
- If no check is needed, keep diceUsed empty.

`
    : ""
}${
  fatigueActive
    ? `⚠️ PLAYER FATIGUE STATUS:
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
- A shared dice pool is provided, scaled by number of acting players. Select ONE result from the array for each dice you need.
- 1d100: Use for single skill checks, attribute checks, luck rolls (compare against character's skill percentage)
- 1d100_opposed: Use for opposed checks (the second character's roll)
- 1d3, 1d4, 1d6, 2d6, 1d8, 1d10, 1d20: Use for damage, sanity loss, etc.
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

STATUS CONDITIONS UPDATES:
- If this action adds/removes/clears temporary status effects (e.g., injured, dazed, poisoned, restrained), write them in "stateUpdate.*.status.conditions".
- "conditions" must be a string array.
- Use [] to clear all current conditions for that character.
- Omit "conditions" when there is no change.

TIME ESTIMATION:
Estimate how many minutes this action realistically takes in game time. Consider the nature and complexity of the action:
- Quick actions: 1-10 minutes (glancing, brief conversation, opening doors)
- Standard actions: 10-30 minutes (searching, examining)
- Extended actions: 30-120 minutes (combat, lengthy conversations, research)
- Long activities: 2-6 hours (long distance travel, surveillance, extended tasks)
- Very long activities: 6+ hours (sleeping, all-day journeys)

Be realistic and use your judgment. Include "timeElapsedMinutes" in your response.

FROZEN (RE-INJECTED) INPUTS:
- Some roundRequests may have "frozenReinjection: true" — these are actions from a previous round
  that were too slow to resolve alongside faster actions.
- They include: actionStartGameTime (when they started), accumulatedElapsedMinutes (game time already passed),
  lastEstimatedMinutes (previous total estimate), and frozenRoundCount (how many rounds frozen so far).
- Re-evaluate them with CURRENT scene context (which may have changed).
- Estimate the REMAINING timeElapsedMinutes (not the total — subtract accumulatedElapsedMinutes from total estimate).
- If enough time has accumulated, the action may now complete quickly (small remaining time → joins group 1).

TIME GROUPING RULES:
- Actions within ~30 minutes of each other belong in the SAME group.
- A long-time action CAN be interrupted by other players' or NPCs' actions in the same round.
  If a group-1 action directly affects a slow player (e.g. someone talks to them, attacks them,
  an NPC confronts them, an explosion happens nearby), the slow player's action is INTERRUPTED.
  Interrupted actions go into group 1 with a short timeElapsedMinutes reflecting the interruption.
  Only interrupt when there is a clear causal reason — do not interrupt arbitrarily.

HEARTBEAT APPOINTMENT DETECTION:
- If the investigator and an NPC explicitly make a concrete future plan/appointment, output it in "heartbeatActions".
- The appointment should include: scheduledGameTime, npcId, npcName, task, location.
- scheduledGameTime must use format "Day N, HH:MM".
- If no new appointment is made this turn, return empty array: "heartbeatActions": [].

WHEN CONTEXT INCLUDES "HEARTBEAT DUE ACTIONS":
- Keep narrative/actionLog time-consistent with due/overdue appointments.
- Reflect whether the investigator follows, delays, misses, reschedules, or ignores those appointments.
- Do not force investigator behavior.
${sceneChangePrompt}
${
  sceneNPCs && sceneNPCs.length > 0
    ? `

## 🎭 NPC Response Analysis

After resolving each player's action, analyze how NPCs in the current scene will respond.

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

MULTIPLAYER TIME-GROUPED OUTPUT:
- Group all acting players by their action's time duration.
- Players whose timeElapsedMinutes are close together (within ~30 min of the fastest) go into the same group.
- The FIRST group (Group A) is the fastest. It gets FULL resolution: stateUpdate, npcResponses, scenarioUpdate, combat, etc.
- Later groups (B, C, ...) are SLOWER actions still in progress. They get ONLY: actionLog, timeElapsedMinutes, timeConsumption. No stateUpdate, no npcResponses, no scenarioUpdate, no combat.
- If ALL players have similar times, put them all in Group A (single group).
- All players and NPCs share a single preRolledDice pool.

Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "diceUsed": [
    // ALL dice rolls for the entire round — players AND NPCs combined
    // Select penalty/bonus dice when applicable
    // Format: Mark each extra die with (penalty) or (bonus), then specify which value is used
    // Always select dice in order starting from index 0
    // Always prefix with character name to identify who rolled
    "John: 1d100[0]: 67 (Brawling 50% = failure)",
    "John: 1d3[0]: 2 + 1 (DB) = 3 (unarmed damage = 3)",
    "Dr. Smith: 1d100[0]: 45, 1d100[1]: 82(penalty),(Spot Hidden 60% use highest 82 = failure)"
  ],

  "timeGroups": [
    {
      "groupId": 1,                // 1 = fastest group, 2 = next, 3 = slowest...
      "estimatedMinutes": 10,    // Average timeElapsedMinutes for this group
      "players": [
        {
          "playerId": "player-id-from-roundInputs",
          "output": {
            // === FULL OUTPUT for Group A (fastest group) ===
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
              "playerCharacter": {
                "name": "Character Name",
                "status": {
                  "hp": -3,
                  "sanity": 0,
                  "magic": 0,
                  "luck": 0,
                  "conditions": ["Injured", "Dazed"]
                },
                "inventory": {
                  "add": [{"name": "item name", "quantity": 1}],
                  "remove": [{"name": "item name", "quantity": 1}]
                }
              },
              "npcCharacters": [
                {
                  "id": "npc-id",
                  "name": "NPC Name",
                  "status": {"hp": -4, "sanity": 0, "conditions": ["Bleeding"]},
                  "appearance": "Updated appearance description"
                }
              ]
            },

            "scenarioUpdate": {
              "description": "Updated scene description",
              "conditions": [{"type": "lighting", "description": "...", "mechanicalEffect": "..."}]
            },

            // "sceneChange": Include ONLY if this player has a sceneChangeRequest in their roundRequest
            // {
            //   "shouldChange": false,
            //   "targetSceneName": "target scene name",
            //   "reason": "Reason for scene change success or failure"
            // },

            "timeElapsedMinutes": 10,
            "timeConsumption": "short",
            "entersCombat": false,
            "combatParticipantIds": [],
            "combatInitiatedBy": "player",
            "openingPendingNpcActions": [],

            "relationshipChanges": [],

            "heartbeatActions": []
${
  sceneNPCs && sceneNPCs.length > 0
    ? `
            ,
            "npcResponses": [
              {
                "npcName": "NPC name",
                "npcId": "npc-id",
                "willRespond": true,
                "responseType": "social",
                "executionOrder": 1,
                "diceUsed": [],
                "actionLog": [
                  {
                    "time": "Day 1, 14:30",
                    "location": "Current Location",
                    "summary": "NPC's action summary",
                    "successLevel": "regular",
                    "characterId": "npc-id"
                  }
                ],
                "stateUpdate": {
                  "status": {"hp": 0, "sanity": -1, "conditions": ["Shaken"]},
                  "inventory": {"add": [{"name": "item"}]},
                  "appearance": "Updated appearance"
                }
              }
            ]
`
    : ""
}
          }
        }
      ]
    },
    {
      "groupId": 2,                // Slower group
      "estimatedMinutes": 180,    // Average timeElapsedMinutes for this group
      "players": [
        {
          "playerId": "slow-player-id",
          "output": {
            // === MINIMAL OUTPUT for slow groups (B, C, ...) ===
            // Only actionLog + time fields. NO stateUpdate, NO npcResponses, NO scenarioUpdate, NO combat.
            "actionLog": [
              {
                "time": "Day 1, 14:30",
                "location": "Arkham Library",
                "summary": "Began researching ancient texts about the cult",
                "characterId": "character-id"
              }
            ],
            "timeElapsedMinutes": 180,
            "timeConsumption": "long"
          }
        }
      ]
    }
    // ... additional groups C, D if needed
  ]
}
\`\`\`
`;
}
