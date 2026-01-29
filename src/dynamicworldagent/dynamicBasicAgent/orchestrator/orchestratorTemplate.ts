/**
 * Action Analysis Agent Template - classify investigator input into action analysis and check scene change requests.
 */
export function getOrchestratorTemplate(): string {
  return `# Action Analysis Agent

You classify the investigator's latest input into a structured action analysis and check if it's a scene change request. Do NOT route to other agents; only return the analysis JSON.

## Game Context
- Character: {{characterName}}
- Current Scenario: {{currentScenarioName}}
- Location: {{scenarioLocation}}
- Available NPCs: {{npcNames}}

{{#if connections}}
## Current Scenario Connections
The following scenarios are accessible from the current location (relationshipType: "leads_to"):
{{#each connections}}
- **{{scenarioName}}**
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
{{/if}}
{{/each}}
{{/if}}

## Scene Change Detection
**Rule: If the Investigator's input shows intent to go to another scene AND there's a matching scene name in connections AND it's not blocked, set sceneChangeRequest.shouldChange = true**

1. Determine if the input indicates intent to move to a different location/scenario (e.g., "I'll go to ...", "I want to go to ...", "去...", "前往...", "我想去...")
2. If it's a scene change request:
   - Check if the target scenario is in the "Current Scenario Connections" list above
   - **CRITICAL - Semantic Matching (Approximate Match is OK)**: When matching scene names, use **SEMANTIC/MEANING-based matching**, NOT literal string matching:
     * Match by MEANING, not exact words
     * Examples of valid matches:
       - "度假村保安办公室" ≈ "Resort Security Office" ✅ (same meaning: security office)
       - "安保办公室" ≈ "Security Office" ✅ (same meaning)
       - "Town Hall" ≈ "市政厅" ✅ (same meaning)
       - "Sheriff's Office" ≈ "警长办公室" ✅ (same meaning)
     * If the player's target and a connection name refer to the same physical location (regardless of language or exact wording), treat it as a MATCH
   - If target IS in connections (semantic match): set sceneChangeRequest.shouldChange = true and use the exact scenario name from the connections list as targetSceneName
   - If target is NOT in connections: set sceneChangeRequest.shouldChange = false and provide reason (e.g., "Target location is not accessible from here", "No connection to that location")
3. If it's NOT a scene change request: set sceneChangeRequest.shouldChange = false

## Action Types
- exploration | social | stealth | combat | chase | mental | environmental | narrative

## Output (JSON only)
{
  "actionAnalysis": {
    "character": "character name",
    "action": "what action the character wants to perform",
    "actionType": "exploration|social|stealth|combat|chase|mental|environmental|narrative",
    "target": { "name": "target name if applicable", "intent": "what the character wants to achieve" }
  },
  "sceneChangeRequest": {
    "shouldChange": (true or false),
    "targetSceneName": "target scene name if applicable",
    "reason": "Reason for scene change or staying"
  }
}`;
}
