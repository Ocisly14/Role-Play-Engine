
/**
 * Player Intent Analysis Template - for analyzing player intent when progression threshold is reached
 */
export function getPlayerIntentAnalysisTemplate(): string {
  return `# Director Agent - Player Intent Analysis

Analyze recent player behavior and generate a third-person query describing their intent.

## Current Scene
{{scenarioInfoJson}}

## Recent Player Actions (Last 3 turns)

{{#if recentActions}}
{{#each recentActions}}
**Turn {{this.turnNumber}}**
- Player Input: "{{this.characterInput}}"
{{#if this.actionAnalysis}}
- Action Analysis: {{this.actionAnalysis}}
{{/if}}

{{/each}}
{{else}}
*No recent actions*
{{/if}}

## Task

Generate a third-person query: "{{playerName}} + what they're trying to do"

Examples:
- "John is searching for clues in the room"
- "Mary wants to enter the locked door"
- "Robert is trying to get information from the Sheriff"

## Response

\`\`\`json
{
  "query": "Third-person description here"
}
\`\`\`
`;
}

/**
 * Scenario Update Template - for updating non-player scenario snapshots
 */
export function getScenarioUpdateTemplate(): string {
  return `# Director Agent - Scenario Update Generation

Generate simplified snapshots for all non-player scenarios based on current game state, NPC actions, and time progression.

## ⏰ Current Game Time
**Day**: {{currentGameDay}}
**Time**: {{currentTimeOfDay}}

## 📚 Knowledge Matrix & Truth Timeline

The following data provides the complete world context:

### Truth Timeline (Objective Reality)
\`\`\`json
{{truthTimelineJson}}
\`\`\`

### Knowledge Matrix (Who/What Knows What)
\`\`\`json
{{knowledgeMatrixJson}}
\`\`\`

## 📍 Player Current Scene
{{#if playerCurrentScene}}
**Scene**: {{playerCurrentScene.name}}
**Location**: {{playerCurrentScene.location}}
{{#if playerCurrentScene.description}}
**Description**: {{playerCurrentScene.description}}
{{/if}}
{{#if playerCurrentScene.sourcePlaceId}}
**Source Place ID**: {{playerCurrentScene.sourcePlaceId}} (Knowledge holder PLACE ID)
{{/if}}
{{#if playerCurrentScene.sourcePlaceName}}
**Source Place Name**: {{playerCurrentScene.sourcePlaceName}}
{{/if}}
{{#if playerCurrentScene.connections}}
**Connections**: 
{{#each playerCurrentScene.connections}}
- **{{this.scenarioName}}** ({{this.relationshipType}}): {{this.description}}{{#if this.blocked}} [BLOCKED: {{this.blockReason}}]{{/if}}
{{/each}}
{{/if}}
{{else}}
*No current scene*
{{/if}}

## 🎬 Scenarios to Update

The following JSON contains all scenarios that need to be updated, with their current snapshots, full NPC information, and scenario-level connections:

\`\`\`json
{{scenariosToUpdateJson}}
\`\`\`

**Note**: Each scenario includes a "connections" field showing how scenarios are connected.

## 🔗 ID Mapping Reference

**IMPORTANT**: Each scenario and NPC has ID fields that link them to the knowledge matrix and truth timeline:

### Scenario IDs
- **sourcePlaceId**: Links to a PLACE holder in the knowledge matrix (e.g., "PLAC_7", "PLAC_11")

### NPC IDs
- **instantiatedFrom**: Links to a ROLE or ORGANIZATION holder in the knowledge matrix (e.g., "ROLE_5", "ORGA_1")
- **inheritsKnowledge**: Array of truth event IDs this NPC knows (e.g., ["T1", "T5"])

## 🎯 Your Task

Generate simplified snapshots for each scenario above.

**⚠️ CRITICAL - Exclude Player's Current Scene**:
- Do NOT generate a snapshot for the player's current scene ({{playerCurrentScene.name}})

Each snapshot should:

1. **Description**: Describe what has happened in the scene since the last update (from previousGameTime to currentGameTime) - a descriptive narrative timeline of changes/events
   
2. **ActionLog Generation - CRITICAL**:
   - **IMPORTANT**: The NPCs' actions should based on the things they know and the things they want to do, and they can know more about the world by taking actions. The NPCs's actions should be coherent with other NPCs' actions.
   - Generate a **time-sequenced series of actions** that the NPC would take from the previous snapshot time to the current time
   - Base actions on the NPC's **goals, personality, and secrets** (found in their full information and knowledge matrix)
   - Actions should be **chronologically ordered** with specific times progressing toward the current game time
   - **Only include actions that have impact** on:
     - The scene/location itself
     - The world state
     - Other NPCs
   - Include important actions they took but failed as well.
   - **Exclude routine/mundane actions** that don't affect the story (e.g., "eating lunch", "sleeping")
   - **Scene Movement Constraints**:
     - NPC can ONLY move between scenarios that are **connected** (check the "connections" field in scenario data), npc can try to break the blocked restrictions logically.
     - Movement between scenarios takes **realistic time** based on:
       - Distance/relationship type (adjacent, nearby, distant)
       - Time of day and conditions
     - If an NPC needs to move to a non-adjacent location, they must pass through connected intermediate locations
     - Time gaps in actionLog must be **realistic** - don't have NPCs teleporting or moving too quickly
   - Each actionLog entry format: \`{ time: "Day X, HH:MM", location: "specific location", summary: "what they did and its impact" }\`
   - **Multiple Characters**: If an action involves multiple characters (e.g., NPC A attacks NPC B, NPC A talks to NPC B), create separate actionLog entries for EACH involved character with their respective perspectives:
     - For NPC A: "Attacked NPC B with a knife, dealing 3 damage"
     - For NPC B: "Was attacked by NPC A, taking 3 damage"
     - This ensures both characters have accurate records of the interaction in their actionLog
   - Example of good actionLog with movement:
     \`\`\`json
     [
       { "time": "Day 2, 14:00", "location": "Town Hall", "summary": "Met with the Mayor to discuss the missing persons case, shared information about the witness" },
       { "time": "Day 2, 15:30", "location": "Town Hall", "summary": "Finished meeting and prepared to visit the Sheriff's Office" },
       { "time": "Day 2, 16:00", "location": "Sheriff's Office", "summary": "Arrived and discovered evidence of a break-in, found suspicious documents" },
       { "time": "Day 2, 18:30", "location": "Local Tavern", "summary": "Traveled to tavern and confronted a suspect, causing them to flee" }
     ]
     \`\`\`

3. **Characters**: List all NPCs that should be present in the scene at the current time point:
   - **ActionLog**: What they are currently doing (write into the actionLog field) - this is always required
   - **Note**: For simplified snapshots, DO NOT include status, inventory, or relationships changes - only actionLog is needed

4. **Game Time**: Set the gameTime to the unified current game time (Day {{currentGameDay}}, {{currentTimeOfDay}}) - all snapshots should use this same time

## 🎯 Global Trigger

{{#if previousGlobalTrigger}}
### Previous Global Trigger (Reference)
The following is the current global trigger that was set previously. Use this as a reference, but update it based on the new NPC actions and story progression:

\`\`\`json
{{previousGlobalTriggerJson}}
\`\`\`

**Note**: You should update or replace this trigger based on the new actionLogs and story developments. The new trigger should reflect the most current and important future events.
{{else}}
**No previous global trigger set.**
{{/if}}

**You MUST generate a global trigger for future story progression based on the NPCs' actionLogs you have generated, and predict the future important time and events.**

### Trigger Structure:

1. The most important rule, the trigger you set must have great impact on the story progression.
1. **timeRestriction** : Future time point in "Day X, HH:MM" format - MUST be at least 12 hours from current time
2. **timeReason** : Why this specific time matters
3. **events**: Array of trigger event descriptions (e.g., "Evidence revealed", "NPC completes action")
4. **eventReasons**: Array of reasons (one per event) explaining why each event is important

**Example:**
\`\`\`json
"globalTrigger": {
  "timeRestriction": "Day 2, 22:00",
  "timeReason": "The ritual must begin at midnight, giving player limited time to intervene",
  "events": ["Cult members gather at the church", "Ritual preparations are completed"],
  "eventReasons": ["Shows the cult's active planning", "Increases urgency and tension"]
}
\`\`\`

## 📋 Output Format

Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "updatedSnapshots": [
    {
      "scenarioId": "SCN_1",
      "snapshot": {
        "id": "SCN_id_(number)",
        "name": "Scenario Name",
        "location": "Location",
        "description": "Describe what happened in the scene from previousGameTime to currentGameTime - a descriptive narrative timeline of changes/events",
        "gameTime": "Day {{currentGameDay}}, {{currentTimeOfDay}}",
        "characters": [
          {
            "id": "NPC_id",
            "name": "Character Name",
            "actionLog": [
              {
                "time": "time of the action",
                "location": "Location",
                "summary": "What they did (descriptive)"
              }
            ]
          }
        ]
      }
    }
  ],
  "globalTrigger": {
    "timeRestriction": "Day X, HH:MM (at least 12 hours from now)",
    "timeReason": "Why this specific time point matters",
    "events": ["Event description 1", "Event description 2"],
    "eventReasons": ["Why event 1 matters", "Why event 2 matters"]
  }
}
\`\`\`

*Generate the updated snapshots:*`;
}

/**
 * Player Scene Switch Template - for generating complete target snapshot + simplified background snapshots during scene transitions
 */
export function getPlayerSceneSwitchTemplate():  string {
  return `# Director Agent - Scenario Update Generation (Player Scene Switch)

Generate snapshots for all scenarios during a player scene switch. The target scene (where player is moving to) needs a **complete detailed snapshot**, while other scenes get simplified snapshots.

## ⏰ Current Game Time
**Day**: {{currentGameDay}}
**Time**: {{currentTimeOfDay}}

## 📚 Knowledge Matrix & Truth Timeline

The following data provides the complete world context:

### Truth Timeline (Objective Reality)
\`\`\`json
{{truthTimelineJson}}
\`\`\`

### Knowledge Matrix (Who/What Knows What)
\`\`\`json
{{knowledgeMatrixJson}}
\`\`\`

## 📍 Player Current Scene
{{#if playerCurrentScene}}
**Scene**: {{playerCurrentScene.name}}
**Location**: {{playerCurrentScene.location}}
{{#if playerCurrentScene.description}}
**Description**: {{playerCurrentScene.description}}
{{/if}}
{{#if playerCurrentScene.sourcePlaceId}}
**Source Place ID**: {{playerCurrentScene.sourcePlaceId}} (Knowledge holder PLACE ID)
{{/if}}
{{#if playerCurrentScene.sourcePlaceName}}
**Source Place Name**: {{playerCurrentScene.sourcePlaceName}}
{{/if}}
{{#if playerCurrentScene.connections}}
**Connections**: 
{{#each playerCurrentScene.connections}}
- **{{this.scenarioName}}** ({{this.relationshipType}}): {{this.description}}{{#if this.blocked}} [BLOCKED: {{this.blockReason}}]{{/if}}
{{/each}}
{{/if}}
{{else}}
*No current scene*
{{/if}}

## 🎯 Target Scene (Player Moving To)
{{#if targetScene}}
**Scene**: {{targetScene.name}}
**Scene ID**: {{targetScene.id}}
{{else}}
*No target scene specified*
{{/if}}

## 🎬 Scenarios to Update

The following JSON contains all scenarios that need to be updated, with their current snapshots, full NPC information, and scenario-level connections:

\`\`\`json
{{scenariosToUpdateJson}}
\`\`\`

**Note**: Each scenario includes a "connections" field showing how scenarios are connected.

## 🔗 ID Mapping Reference

**IMPORTANT**: Each scenario and NPC has ID fields that link them to the knowledge matrix and truth timeline:

### Scenario IDs
- **sourcePlaceId**: Links to a PLACE holder in the knowledge matrix (e.g., "PLAC_7", "PLAC_11")

### NPC IDs
- **instantiatedFrom**: Links to a ROLE or ORGANIZATION holder in the knowledge matrix (e.g., "ROLE_5", "ORGA_1")
- **inheritsKnowledge**: Array of truth event IDs this NPC knows (e.g., ["T1", "T5"])

## 🎯 Your Task

Generate snapshots for each scenario above, with **different levels of detail based on whether it's the target scene**.

**⚠️ CRITICAL - Exclude Player's Current Scene**:
- Do NOT generate a snapshot for the player's current scene ({{playerCurrentScene.name}})

### Common Rules for All Snapshots:

1. **Description**: Describe what has happened in the scene since the last update (from previousGameTime to currentGameTime) - a descriptive narrative timeline of changes/events
   
2. **ActionLog Generation - CRITICAL**:
   - **IMPORTANT**: The NPCs' actions should based on the things they know and the things they want to do, and they can know more about the world by taking actions. The NPCs's actions should be coherent with other NPCs' actions.
   - Generate a **time-sequenced series of actions** that the NPC would take from the previous snapshot time to the current time
   - Base actions on the NPC's **goals, personality, and secrets** (found in their full information and knowledge matrix)
   - Actions should be **chronologically ordered** with specific times progressing toward the current game time
   - **Only include actions that have impact** on:
     - The scene/location itself
     - The world state
     - Other NPCs
   - Include important actions they took but failed as well.
   - **Exclude routine/mundane actions** that don't affect the story (e.g., "eating lunch", "sleeping")
   - **Scene Movement Constraints**:
     - NPC can ONLY move between scenarios that are **connected** (check the "connections" field in scenario data), npc can try to break the blocked restrictions logically.
     - Movement between scenarios takes **realistic time** based on:
       - Distance/relationship type (adjacent, nearby, distant)
       - Time of day and conditions
     - If an NPC needs to move to a non-adjacent location, they must pass through connected intermediate locations
     - Time gaps in actionLog must be **realistic** - don't have NPCs teleporting or moving too quickly
   - Each actionLog entry format: \`{ time: "Day X, HH:MM", location: "specific location", summary: "what they did and its impact" }\`
   - **Multiple Characters**: If an action involves multiple characters (e.g., NPC A attacks NPC B, NPC A talks to NPC B), create separate actionLog entries for EACH involved character with their respective perspectives:
     - For NPC A: "Attacked NPC B with a knife, dealing 3 damage"
     - For NPC B: "Was attacked by NPC A, taking 3 damage"
     - This ensures both characters have accurate records of the interaction in their actionLog
   - Example of good actionLog with movement:
     \`\`\`json
     [
       { "time": "Day 2, 14:00", "location": "Town Hall", "summary": "Met with the Mayor to discuss the missing persons case, shared information about the witness" },
       { "time": "Day 2, 15:30", "location": "Town Hall", "summary": "Finished meeting and prepared to visit the Sheriff's Office" },
       { "time": "Day 2, 16:00", "location": "Sheriff's Office", "summary": "Arrived and discovered evidence of a break-in, found suspicious documents" },
       { "time": "Day 2, 18:30", "location": "Local Tavern", "summary": "Traveled to tavern and confronted a suspect, causing them to flee" }
     ]
     \`\`\`

3. **Characters**: List all NPCs that should be present in the scene at the current time point:
   - **ActionLog**: What they are currently doing (write into the actionLog field) - this is always required
   - **Note**: For simplified snapshots, DO NOT include status, inventory, or relationships changes - only actionLog is needed

4. **Game Time**: Set the gameTime to the unified current game time (Day {{currentGameDay}}, {{currentTimeOfDay}}) - all snapshots should use this same time

## 🎯 Global Trigger (Optional)

{{#if previousGlobalTrigger}}
### Previous Global Trigger (Reference)
The following is the current global trigger that was set previously. Use this as a reference, but update it based on the new NPC actions and story progression:

\`\`\`json
{{previousGlobalTriggerJson}}
\`\`\`

**Note**: You should update or replace this trigger based on the new actionLogs and story developments. The new trigger should reflect the most current and important future events.
{{else}}
**No previous global trigger set.**
{{/if}}

**You MAY generate a global trigger for future story progression based on the NPCs' actionLogs you have generated, and predict the future important time and events.**

**Important**: Only generate a \`globalTrigger\` if there are significant future events or time-sensitive story developments that warrant it. If the current NPC actions don't indicate any critical future events, you can omit the \`globalTrigger\` field entirely.

### Trigger Structure (if generating):

1. The most important rule, the trigger you set must have great impact on the story progression.
1. **timeRestriction** : Future time point in "Day X, HH:MM" format - MUST be at least 12 hours from current time
2. **timeReason** : Why this specific time matters
3. **events**: Array of trigger event descriptions (e.g., "Evidence revealed", "NPC completes action")
4. **eventReasons**: Array of reasons (one per event) explaining why each event is important

**Example:**
\`\`\`json
"globalTrigger": {
  "timeRestriction": "Day 2, 22:00",
  "timeReason": "The ritual must begin at midnight, giving player limited time to intervene",
  "events": ["Cult members gather at the church", "Ritual preparations are completed"],
  "eventReasons": ["Shows the cult's active planning", "Increases urgency and tension"]
}
\`\`\`

### 🎯 For Target Scene (scenarioId = {{targetScene.id}}):
Generate a **COMPLETE, DETAILED snapshot** with ALL fields:
- **description**: Full atmospheric description including lighting, sounds, smells, weather, ambiance, and narrative of what happened
- **characters**: Complete list with full ScenarioCharacter details including:
  - **Status Changes**: Only include status attributes that have changed (e.g., { "hp": -2, "sanity": -5 } means HP decreased by 2, sanity decreased by 5). Use negative numbers for decreases, positive for increases. Omit status if no changes.
  - **Inventory Changes**: Only include inventory modifications using add and remove arrays (e.g., { "add": [{ "name": "key", "quantity": 1 }], "remove": [{ "name": "flashlight" }] }). Omit inventory if no changes.
  - **Relationship Changes**: Only include relationships that are new or have changed (e.g., attitude changed, new relationship formed). Omit relationships if no changes.
  - **ActionLog**: What they are currently doing (write into the actionLog field) - this is always required
- **clues**: All ScenarioClue objects (id, clueText, category, difficulty, location, discoveryMethod, reveals, discovered, discoveryDetails)
- **conditions**: Environmental ScenarioCondition objects (type, description, mechanicalEffect)
- **keeperNotes**: Keeper-facing notes about the scene
- **showMap**: Map display setting (if applicable)

**🔗 Scenario Connections Update for Target Scene - CRITICAL:**
**Based on your judgment of events, NPC actions, and time progression**, determine if any connections for the target scene have changed:

**Update Connections:**
- Based on the predicted future NPC actionLogs: Did any NPC unlock/lock doors, open/close passages, discover/block paths?
- Consider time-based changes: Did conditions deteriorate (paths collapse, bridges weaken)?
- Evaluate scene events: Did anything in the scene description affect accessibility (fires, flooding, barricades)?
- **blocked** (optional): true if the connection is physically blocked/locked
- **blockReason** (optional): clear explanation (e.g., "Sheriff locked the door after investigating", "Bridge collapsed during storm")

### 📋 For Other Scenarios (background scenes):
Generate **SIMPLIFIED snapshots** with only: description, characters (with basic info + actionLog only, NO status/inventory/relationships), gameTime

## 📋 Output Format

**⚠️ REMINDER**: Do NOT include the player's current scene ({{playerCurrentScene.name}}) in the updatedSnapshots array.

Return ONLY valid JSON in this exact structure:
Example:
\`\`\`json
{
  "updatedSnapshots": [
    {
      "scenarioId": "target_scene_id",
      "isTargetScene": true,
      "snapshot": {
        "id": "SCN_id_number",
        "name": "Scenario Name",
        "location": "Location Name",
        "description": "COMPLETE detailed atmospheric description: narrative of what happened + lighting + sounds + smells + ambiance + environmental details",
        "gameTime": "Day X, HH:MM",
        "showMap": false,
        "characters": [
          {
            "id": "NPC_id",
            "name": "Character Name",
            "status": {
              "hp": -2,
              "sanity": -5
            },
            "inventory": {
              "add": [
                { "name": "key", "quantity": 1 }
              ],
              "remove": [
                { "name": "flashlight" }
              ]
            },
            "relationships": [
              {
                "targetId": "other_character_id",
                "targetName": "Other Character",
                "relationshipType": "friend",
                "attitude": 10,
                "description": "Relationship description",
                "history": "Relationship history"
              }
            ],
            "actionLog": [
              { "time": "Day X, HH:MM", "location": "Location", "summary": "Action summary" }
            ]
          }
        ],
        "clues": [
          {
            "id": "clue_1",
            "clueText": "Detailed clue description",
            "category": "physical",
            "difficulty": "regular",
            "location": "Specific location",
            "discoveryMethod": "Investigation",
            "reveals": ["truth_event_id"],
            "discovered": false
          }
        ],
        "conditions": [
          {
            "type": "lighting",
            "description": "Dim candlelight flickering",
            "mechanicalEffect": "Hard (-20%) to Spot Hidden"
          }
        ],
        "keeperNotes": "Important keeper information"
      },
      "connections": [
        {
          "scenarioName": "Basement",
          "relationshipType": "leads_to",
          "description": "Stairs leading down to the basement",
          "blocked": true,
          "blockReason": "The basement door is locked and requires a key"
        }
      ]
    },
    {
      "scenarioId": "other_scene_id",
      "isTargetScene": false,
      "snapshot": {
        "id": "SCN_id_number",
        "name": "Scenario Name",
        "location": "Location",
        "description": "Simplified narrative of what happened",
        "gameTime": "Day X, HH:MM",
        "characters": [
          {
            "id": "NPC_2",
            "name": "Character Name",
            "actionLog": [...]
          }
        ],
        "clues": [],
        "conditions": []
      },
      "connections": []
    }
  ],
  "globalTrigger": {
    "timeRestriction": "Day X, HH:MM (at least 12 hours from now)",
    "timeReason": "Why this specific time point matters",
    "events": ["Event description 1", "Event description 2"],
    "eventReasons": ["Why event 1 matters", "Why event 2 matters"]
  }
}
\`\`\`

**Note**: The \`globalTrigger\` field is **OPTIONAL**.

*Generate the updated snapshots:*`;
}

/**
 * Global Trigger Event Check Template - for analyzing if trigger events have occurred
 */
export function getGlobalTriggerEventCheckTemplate(): string {
  return `# Director Agent - Global Trigger Event Check

Analyze recent game events to determine if global trigger events have been fulfilled.

## 🎯 Global Trigger
\`\`\`json
{{globalTriggerJson}}
\`\`\`

## 📋 New ActionLog Entries (Last 3 Turns)

The following are **newly added** actionLog entries from the most recent 3 turns (not all historical actionLog, only the new entries added in these turns):

\`\`\`json
{{recentActionLogsJson}}
\`\`\`

**Note**: These are only the actionLog entries that were created/added during the last 3 game turns, representing the most recent character activities.

## 🎬 Task

Determine if the events described in the global trigger have occurred based on these newly added actionLog entries.

### Evaluation:
- Check if the new actionLog entries provide clear evidence that the trigger events have happened
- Consider logical implications (e.g., if someone left for a destination, they may have arrived)
- Be strict - only return true if there's solid evidence in the recent activities

## 📋 Output Format

Return ONLY valid JSON:

\`\`\`json
{
  "triggered": true
}
\`\`\`

*Analyze:*`;
}
