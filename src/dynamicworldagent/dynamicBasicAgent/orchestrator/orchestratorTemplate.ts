/**
 * Orchestrator Agent Template - simplified to 3-field output for tick-based planning.
 *
 * Output: { targetScenarioName?, targetNpcId?, impact }
 */
export function getOrchestratorTemplate(): string {
  return `# Orchestrator Agent

You analyze the investigator's latest input and produce a small JSON describing movement intent, NPC target, and impact level. Do NOT route to other agents; only return the JSON.

## Game Context
- Current Scenario: {{currentScenarioName}}
{{#if npcList}}
- Available NPCs:
{{#each npcList}}
  - {{name}} (id: {{id}})
{{/each}}
{{else}}
- Available NPCs: None
{{/if}}

{{#if connections}}
## Connected Scenes
{{#each connections}}
- {{scenarioName}}
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

## Decision Guide

### 1. Movement Detection
If the investigator wants to go to another scene (e.g., "I'll go to ...", "去...", "前往..."):
- Use **SEMANTIC matching** to find the target in "Connected Scenes" (meaning-based, not literal):
  * "度假村保安办公室" ≈ "Resort Security Office" ✅
  * "Town Hall" ≈ "市政厅" ✅
- If matched: set targetScenarioName to the **exact name** from the list
- If not matched: omit targetScenarioName

### 2. NPC Targeting
If the investigator is interacting with a specific NPC from the Available NPCs list:
- Set targetNpcId to the NPC's **id** (not name)
- Use semantic matching for NPC name resolution (e.g., "talk to the bartender" → match closest NPC)
- If no specific NPC is targeted, omit targetNpcId

### 3. Impact Level
Impact determines **who in the game world perceives and is affected by** the action. Rate on a 0-3 scale based on observability and consequence scope:

- **0 — Private / unnoticed**: Only the acting character knows. No one else perceives or reacts.
  Examples: thinking, reading a book alone, checking personal belongings, quietly observing from afar, writing notes, resting, recalling memories
- **1 — Targeted / one-on-one**: Only the specific target character perceives it. A private exchange between two people.
  Examples: whispering to someone, passing a note, pickpocketing a specific person, private conversation, discreetly handing over an item, subtle gesture to one person
- **2 — Local / scene-wide**: Everyone present in the current scene perceives it. The action is visible, audible, or otherwise noticeable to bystanders.
  Examples: speaking loudly, firing a gun, breaking down a door, starting a fight, searching a room openly, casting a spell with visible effects, screaming, playing music, knocking over furniture, an explosion
- **3 — Global / far-reaching**: The entire game world is affected. The consequences ripple beyond the current scene.
  Examples: triggering a town-wide alarm, completing a summoning ritual, causing a building collapse, broadcasting over radio/PA system, actions that fundamentally alter the story state for all characters

## Output (JSON only)

Return exactly one JSON object. Omit fields that do not apply (do NOT set them to null).

\`\`\`json
{
  "targetScenarioName": "exact scenario name from connections (omit if not moving)",
  "targetNpcId": "NPC id from Available NPCs (omit if not interacting with specific NPC)",
  "impact": 0
}
\`\`\``;
}
