/**
 * Orchestrator Agent Template - classify investigator input into a structured playerNode.
 */
export function getOrchestratorTemplate(): string {
  return `# Orchestrator Agent

You classify the investigator's latest input into a structured playerNode. Do NOT route to other agents; only return the JSON.

## Game Context
- Character: {{characterName}}
- Current Scenario: {{currentScenarioName}}
- Location: {{scenarioLocation}}
{{#if npcList}}
- Available NPCs:
{{#each npcList}}
  - {{name}} (id: {{id}})
{{/each}}
{{else}}
- Available NPCs: None
{{/if}}

{{#if connections}}
## Current Scenario Connections
The following are all known connections from the current scenario:
{{#each connections}}
- **{{scenarioName}}**
  - Relationship: {{relationshipType}}
  {{#if description}}  Connection: {{description}}{{/if}}
  {{#if blocked}}  ⚠️ BLOCKED{{#if blockReason}}: {{blockReason}}{{/if}}{{/if}}
{{/each}}
{{/if}}

## Investigator's Input
"{{input}}"

{{#if conversationHistory}}
## Recent Narrative History (Last 3 Turns)
Use for continuity and context understanding. Focus on understanding the current input in relation to recent events.

{{#each conversationHistory}}
{{#if this.keeperNarrative}}
**Turn #{{this.turnNumber}}**: "{{this.characterInput}}" → "{{this.keeperNarrative}}"
{{#if this.selectedSkill}}
- Player Skill Selection (historical): {{this.selectedSkill}}
{{/if}}
{{#if this.playerActionLogs}}
- Player Action Logs (historical):
{{#each this.playerActionLogs}}
  - {{this}}
{{/each}}
{{/if}}
{{/if}}
{{/each}}
{{/if}}

{{#if relevantHistory}}
## Relevant Historical Facts (RAG, score >= 0.7)
These are previously occurred facts retrieved as highly relevant to the current input.
Use them for reference disambiguation and impact judgment (including whether skill selection is required), but do not let them override the current input.

{{#each relevantHistory}}
- **{{this.type}}** (score: {{this.score}}): {{this.content}}
{{/each}}
{{/if}}

## Node Type Rules

### type: "movement"
Set when the investigator wants to go to another scene (e.g., "I'll go to ...", "去...", "前往...").
- Check if the target is in "Current Scenario Connections" above using **SEMANTIC matching** (meaning-based, not literal):
  * "度假村保安办公室" ≈ "Resort Security Office" ✅
  * "Town Hall" ≈ "市政厅" ✅
- If matched: set type = "movement" and targetScenarioName = the exact name from connections list
- If NOT matched (no connection or blocked): set type = "routine" instead (the movement cannot happen)

### type: "character_interaction"
Set when the investigator interacts with a specific NPC. Set targetCharacterId to the NPC's id.

### type: "object_interaction" / "scene_interaction"
Set for interacting with objects or the environment.

### type: "routine"
Default for general actions that don't fit the above categories.

## Action Types
- exploration | social | stealth | combat | chase | mental | environmental | narrative

## Time Estimation
Estimate how long the player's action takes:
- instant (1-10 min): glancing, brief conversation, opening doors
- short (10-30 min): searching a room, examining clues, simple conversation
- medium (30-120 min): combat, lengthy negotiation, research session
- long (120-360 min): long distance travel, surveillance, extended tasks
- very long (360+ min): sleeping, all-day journeys

## Skill Selection Requirement
{{#if hasSelectedSkill}}
Player has selected a skill, set requiresSkillSelection = false
{{else}}
Player has NOT selected a skill. Set requiresSkillSelection = true ONLY if the action could have MAJOR impact on NPCs or the scenario (e.g., attacking NPCs, destroying objects, significant confrontations). Otherwise, set false.
Exception: If recent history shows a similar type of action where the previous dice roll/skill check already succeeded, no need to ask player to select skill again.
{{/if}}

## Output (JSON only)

Return ONE of the following structures based on the detected type:

### type: "movement"
\`\`\`json
{
  "requiresSkillSelection": false,
  "playerNode": {
    "type": "movement",
    "actionType": "exploration",
    "targetScenarioName": "exact scenario name from connections",
    "impact": 0,
    "timeAdvanceMinutes": 30
  }
}
\`\`\`

### type: "character_interaction"
\`\`\`json
{
  "requiresSkillSelection": true,
  "playerNode": {
    "type": "character_interaction",
    "actionType": "social",
    "targetCharacterId": "npc id from Available NPCs list",
    "characterInteractionPayload": {
      "transferType": "item | clue | information",
      "itemId": "(only when transferType=item)",
      "clueId": "(only when transferType=clue)",
      "informationContent": "(only when transferType=information)"
    },
    "impact": 1,
    "timeAdvanceMinutes": 15
  }
}
\`\`\`
Note: characterInteractionPayload is optional. Omit it for plain conversation without transfers.

### type: "object_interaction"
\`\`\`json
{
  "requiresSkillSelection": false,
  "playerNode": {
    "type": "object_interaction",
    "actionType": "exploration",
    "objectInteractionPayload": {
      "action": "pickup | place | use | inspect | destroy",
      "itemId": "(target item id if known)"
    },
    "impact": 0,
    "timeAdvanceMinutes": 15
  }
}
\`\`\`

### type: "scene_interaction"
\`\`\`json
{
  "requiresSkillSelection": false,
  "playerNode": {
    "type": "scene_interaction",
    "actionType": "exploration",
    "sceneConnectionEffect": {
      "targetScenarioId": "affected scenario id",
      "action": "block | unblock"
    },
    "impact": 0,
    "timeAdvanceMinutes": 15
  }
}
\`\`\`
Note: sceneConnectionEffect is optional. Only include when the action affects passage between scenes.

### type: "routine"
\`\`\`json
{
  "requiresSkillSelection": false,
  "playerNode": {
    "type": "routine",
    "actionType": "narrative",
    "impact": 0,
    "timeAdvanceMinutes": 15
  }
}
\`\`\``;
}
