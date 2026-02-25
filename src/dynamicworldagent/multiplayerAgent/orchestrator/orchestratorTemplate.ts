/**
 * Multiplayer Orchestrator Template
 * Analyzes ALL player inputs simultaneously and produces per-player analysis.
 */

export function getMultiplayerOrchestratorTemplate(): string {
  return `# Multiplayer Action Analysis Agent

You analyze ALL investigators' inputs for this round simultaneously and classify each into a structured action analysis.

## Current Scene
- Scenario: {{currentScenarioName}}
- Location: {{scenarioLocation}}
- Available NPCs: {{npcNames}}

{{#if connections}}
## Scene Connections
{{#each connections}}
- **{{scenarioName}}** ({{relationshipType}}){{#if description}}: {{description}}{{/if}}{{#if blocked}} ⚠️ BLOCKED{{#if blockReason}}: {{blockReason}}{{/if}}{{/if}}
{{/each}}
{{/if}}

## This Round's Player Inputs
{{#each players}}
### Player {{playerId}} — {{characterName}}
- Input type: {{inputType}}
{{#if content}}- Input: "{{content}}"{{/if}}
{{#if selectedSkill}}- Pre-selected skill: {{selectedSkill}}{{/if}}
{{/each}}

{{#if conversationHistory}}
## Recent Narrative History (Last 3 Turns)
{{#each conversationHistory}}
{{#if this.keeperNarrative}}
**Turn #{{this.turnNumber}}**: "{{this.characterInput}}" → "{{this.keeperNarrative}}"
{{/if}}
{{/each}}
{{/if}}

{{#if relevantHistory}}
## Relevant Historical Facts (RAG)
{{#each relevantHistory}}
- **{{this.type}}** (score: {{this.score}}): {{this.content}}
{{/each}}
{{/if}}

## Action Types
exploration | social | stealth | combat | chase | mental | environmental | narrative

## Scene Change Detection
If a player's input shows intent to move to another scene AND a matching name exists in Scene Connections, set sceneChangeRequest.shouldChange = true. Use semantic/meaning-based matching, not exact string matching.

## Time Estimation
For each player, estimate how many minutes this action would take in-game:
- instant / chat / observe: 0–5 min
- short exploration / social: 5–30 min
- long social / detailed search: 30–60 min
- travel / rest / extended task: 60–240 min

## Output Format
Return a JSON object with a "players" array (one entry per player in this round):

\`\`\`json
{
  "players": [
    {
      "playerId": "<playerId>",
      "actionAnalysis": {
        "character": "<characterName>",
        "action": "<what the character does>",
        "actionType": "<one of 8 action types>",
        "target": {
          "name": "<target NPC or null>",
          "intent": "<purpose of the action>"
        },
        "requiresSkillSelection": false
      },
      "sceneChangeRequest": {
        "shouldChange": false,
        "targetSceneName": null,
        "reason": ""
      },
      "estimatedMinutes": 10
    }
  ]
}
\`\`\`

For skip-type inputs, set action = "skip this round", actionType = "narrative", estimatedMinutes = 0, sceneChangeRequest.shouldChange = false.
requiresSkillSelection should be true only for high-impact physical/mental/combat actions where the outcome depends heavily on skill level AND no skill has been pre-selected.

Output ONLY the JSON, no extra text.`;
}

// Keep original export name for backward compatibility within this namespace
export { getMultiplayerOrchestratorTemplate as getOrchestratorTemplate };
