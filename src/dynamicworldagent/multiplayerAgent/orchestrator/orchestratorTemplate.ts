/**
 * Multiplayer Orchestrator Template
 * Analyzes ALL player inputs simultaneously and produces per-player analysis.
 */

export function getMultiplayerOrchestratorTemplate(): string {
  return `# Multiplayer Action Analysis Agent

You analyze ALL investigators' inputs for this round simultaneously and classify each into a structured action analysis.

## Scene Room
- sceneRoomId: {{sceneRoomId}}

## Current Scene
- Scenario: {{currentScenarioName}}
- Location: {{scenarioLocation}}
- Available NPCs: {{npcNames}}

## Scene Players (sceneRoom-scoped, multiple players possible)
\`\`\`json
{{{scenePlayersJson}}}
\`\`\`

## Scene NPCs (sceneRoom-scoped)
\`\`\`json
{{{sceneNpcsJson}}}
\`\`\`

{{#if connections}}
## Scene Connections
{{#each connections}}
- **{{scenarioName}}** ({{relationshipType}}){{#if description}}: {{description}}{{/if}}{{#if blocked}} ⚠️ BLOCKED{{#if blockReason}}: {{blockReason}}{{/if}}{{/if}}
{{/each}}
{{/if}}

## This Round Inputs (sceneRoom-scoped, skip omitted)
\`\`\`json
{{{roundInputsJson}}}
\`\`\`

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

## Output Format
Return a JSON object with a "players" array (one entry per player listed in roundInputsJson only).


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
      }
    }
  ]
}
\`\`\`

requiresSkillSelection should be true only for high-impact physical/mental/combat actions where the outcome depends heavily on skill level AND no skill has been pre-selected.

Output ONLY the JSON, no extra text.`;
}

// Keep original export name for backward compatibility within this namespace
export { getMultiplayerOrchestratorTemplate as getOrchestratorTemplate };
