/**
 * Action-Driven Scene Change Template - for validating and selecting target scene
 */
export function getActionDrivenSceneChangeTemplate(): string {
    return `# Director Agent - Action-Driven Scene Change Validation

Based on the scene change request, determine the appropriate target scene from available scenarios.

## 📋 Scene Change Request
{{#if sceneChangeRequest}}
- **Target Scene Name**: {{sceneChangeRequest.targetSceneName}}
- **Reason**: {{sceneChangeRequest.reason}}
{{else}}
*No scene change request*
{{/if}}

## 📍 Current Scene
{{#if currentSnapshot}}
- **Name**: {{currentSnapshot.name}}
- **Location**: {{currentSnapshot.location}}
- **Description**: {{currentSnapshot.description}}
{{else}}
*No current scene*
{{/if}}

## 🎬 Available Scenarios
{{#if availableScenarios}}
{{#each availableScenarios}}
### **{{this.name}}** (ID: {{this.id}})
{{#if this.connections}}
**Connections**:
{{#each this.connections}}
- **{{this.scenarioName}}** ({{this.relationshipType}}){{#if this.description}}: {{this.description}}{{/if}}
{{/each}}
{{else}}
*No connections*
{{/if}}

{{/each}}
{{else}}
*No scenarios available*
{{/if}}

## 🎯 Your Task

Based on the scene change request, select the target scenario that matches the requested scene name.

## Response Format

Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "targetScenarioName": "exact scenario name from available scenarios",
  "targetScenarioId": "exact scenario ID from available scenarios"
}
\`\`\`

**Important**:
- **MUST** return the exact scenario name and ID from the available scenarios list above
- Match the requested scene name from the scene change request
- If the requested scene name doesn't exactly match any scenario, select the closest matching scenario based on the name

*Select the target scenario:*`;
}

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

## 📍 Player Current Scene
{{#if playerCurrentScene}}
**Scene**: {{playerCurrentScene.name}}
**Location**: {{playerCurrentScene.location}}
{{else}}
*No current scene*
{{/if}}

## 📋 Scene Change Request
{{#if sceneChangeRequest}}
- **Target Scene Name**: {{sceneChangeRequest.targetSceneName}}
- **Reason**: {{sceneChangeRequest.reason}}
{{else}}
*No scene change request*
{{/if}}

## 🎬 Scenarios to Update

The following JSON contains all scenarios that need to be updated, with their current snapshots, full NPC information, and scenario-level connections:

\`\`\`json
{{scenariosToUpdateJson}}
\`\`\`

**Note**: Each scenario includes a "connections" field showing how scenarios are connected. These are scenario-level global data, not snapshot data.

## 🔗 ID Mapping Reference

**IMPORTANT**: Each scenario and NPC has ID fields that link them to the knowledge matrix and truth timeline:

### Scenario IDs
- **sourcePlaceId**: Links to a PLACE holder in the knowledge matrix (e.g., "PLAC_7", "PLAC_11")
  - Use this to find which knowledge holder this scenario represents
  - The PLACE holder's containsEvidence field shows what evidence is in this location
  - The PLACE holder's knows field shows what truth events are known here

### NPC IDs
- **instantiatedFrom**: Links to a ROLE or ORGANIZATION holder in the knowledge matrix (e.g., "ROLE_5", "ORGA_1")
  - Use this to find which knowledge holder this NPC represents
  - The holder's knows field shows what truth events this NPC knows
  - The holder's distortion field shows how this NPC's knowledge is distorted
- **inheritsKnowledge**: Array of truth event IDs this NPC knows (e.g., ["T1", "T5"])
  - These correspond to events in the truth timeline
  - Use this to understand what this NPC knows about the story

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

## 🎯 Your Task

Generate simplified snapshots for each scenario above. Each snapshot should:

1. **Description**: Describe what has happened in the scene since the last update (from previousGameTime to currentGameTime) - a descriptive narrative timeline of changes/events

2. **Characters**: List all NPCs that should be present in the scene at the current time point:
   - Their current status (alive, dead, injured, etc.) based on their actionLog timeline
   - What they are currently doing (descriptive notes)
   
3. **ActionLog Generation - CRITICAL**:
   - Generate a **time-sequenced series of actions** that the NPC would take from the previous snapshot time to the current time
   - Base actions on the NPC's **goals, personality, and secrets** (found in their full information and knowledge matrix)
   - Actions should be **chronologically ordered** with specific times progressing toward the current game time
   - **Only include actions that have impact** on:
     - The scene/location itself
     - The world state
     - Other NPCs
   - **Exclude routine/mundane actions** that don't affect the story (e.g., "eating lunch", "sleeping", "walking around")
   - **Scene Movement Constraints - CRITICAL**:
     - NPC can ONLY move between scenarios that are **connected** (check the "connections" field in scenario data)
     - Movement between scenarios takes **realistic time** based on:
       - Distance/relationship type (adjacent, nearby, distant)
       - Mode of transportation available
       - Time of day and conditions
     - If an NPC needs to move to a non-adjacent location, they must pass through connected intermediate locations
     - Time gaps in actionLog must be **realistic** - don't have NPCs teleporting or moving too quickly
   - Each actionLog entry format: \`{ time: "Day X, HH:MM", location: "specific location", summary: "what they did and its impact" }\`
   - Example of good actionLog with movement:
     \`\`\`json
     [
       { "time": "Day 2, 14:00", "location": "Town Hall", "summary": "Met with the Mayor to discuss the missing persons case, shared information about the witness" },
       { "time": "Day 2, 15:30", "location": "Town Hall", "summary": "Finished meeting and prepared to visit the Sheriff's Office" },
       { "time": "Day 2, 16:00", "location": "Sheriff's Office", "summary": "Arrived and discovered evidence of a break-in, found suspicious documents" },
       { "time": "Day 2, 18:30", "location": "Local Tavern", "summary": "Traveled to tavern and confronted a suspect, causing them to flee" }
     ]
     \`\`\`

4. **Game Time**: Set the gameTime to the unified current game time (Day {{currentGameDay}}, {{currentTimeOfDay}}) - all snapshots should use this same time

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
            "status": "alive",
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
  ]
}
\`\`\`

## ⚠️ Important Notes
**Exclude Player Scene**: Do NOT include the player's current scene in the updated snapshots

*Generate the updated snapshots:*`;
}

/**
 * Player Scene Switch Template - for generating complete target snapshot + simplified background snapshots during scene transitions
 */
export function getPlayerSceneSwitchTemplate():  string {
  return `# Director Agent - Scenario Update Generation

Generate snapshots for all non-player scenarios based on current game state, NPC actions, and time progression.

## ⏰ Current Game Time
**Day**: {{currentGameDay}}
**Time**: {{currentTimeOfDay}}

## 📍 Player Current Scene
{{#if playerCurrentScene}}
**Scene**: {{playerCurrentScene.name}}
**Location**: {{playerCurrentScene.location}}
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
  - Use this to find which knowledge holder this scenario represents
  - The PLACE holder's containsEvidence field shows what evidence is in this location
  - The PLACE holder's knows field shows what truth events are known here

### NPC IDs
- **instantiatedFrom**: Links to a ROLE or ORGANIZATION holder in the knowledge matrix (e.g., "ROLE_5", "ORGA_1")
  - Use this to find which knowledge holder this NPC represents
  - The holder's knows field shows what truth events this NPC knows
  - The holder's distortion field shows how this NPC's knowledge is distorted
- **inheritsKnowledge**: Array of truth event IDs this NPC knows (e.g., ["T1", "T5"])
  - These correspond to events in the truth timeline
  - Use this to understand what this NPC knows about the story

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

## 🎯 Your Task

Generate simplified snapshots for each scenario above. Each snapshot should:

1. **Description**: Describe what has happened in the scene since the last update (from previousGameTime to currentGameTime) - a descriptive narrative timeline of changes/events

2. **Characters**: List all NPCs that should be present in the scene at the current time point:
   - Their current status (alive, dead, injured, etc.) based on their actionLog timeline
   - What they are currently doing (descriptive notes)
   
3. **ActionLog Generation - CRITICAL**:
   - Generate a **time-sequenced series of actions** that the NPC would take from the previous snapshot time to the current time
   - Base actions on the NPC's **goals, personality, and secrets** (found in their full information and knowledge matrix)
   - Actions should be **chronologically ordered** with specific times progressing toward the current game time
   - **Only include actions that have impact** on:
     - The scene/location itself
     - The world state
     - Other NPCs
   - **Exclude routine/mundane actions** that don't affect the story (e.g., "eating lunch", "sleeping", "walking around")
   - **Scene Movement Constraints - CRITICAL**:
     - NPC can ONLY move between scenarios that are **connected** (check the "connections" field in scenario data)
     - Movement between scenarios takes **realistic time** based on:
       - Distance/relationship type (adjacent, nearby, distant)
       - Mode of transportation available
       - Time of day and conditions
     - If an NPC needs to move to a non-adjacent location, they must pass through connected intermediate locations
     - Time gaps in actionLog must be **realistic** - don't have NPCs teleporting or moving too quickly
   - Each actionLog entry format: \`{ time: "Day X, HH:MM", location: "specific location", summary: "what they did and its impact" }\`
   - Example of good actionLog with movement:
     \`\`\`json
     [
       { "time": "Day 2, 14:00", "location": "Town Hall", "summary": "Met with the Mayor to discuss the missing persons case, shared information about the witness" },
       { "time": "Day 2, 15:30", "location": "Town Hall", "summary": "Finished meeting and prepared to visit the Sheriff's Office" },
       { "time": "Day 2, 16:00", "location": "Sheriff's Office", "summary": "Arrived and discovered evidence of a break-in, found suspicious documents" },
       { "time": "Day 2, 18:30", "location": "Local Tavern", "summary": "Traveled to tavern and confronted a suspect, causing them to flee" }
     ]
     \`\`\`

4. **Game Time**: Set the gameTime to the unified current game time (Day {{currentGameDay}}, {{currentTimeOfDay}}) - all snapshots should use this same time

## 📋 Output Format

Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "updatedSnapshots": [
    {
      "scenarioId": "SCN_id",
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
            "status": "alive",
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
  ]
}
\`\`\`

## ⚠️ Important Notes
**Exclude Player Scene**: Do NOT include the player's current scene in the updated snapshots

*Generate the updated snapshots:*`;
}
