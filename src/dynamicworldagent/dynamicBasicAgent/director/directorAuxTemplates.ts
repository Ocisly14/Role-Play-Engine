/**
 * Director auxiliary templates.
 */
export function getGlobalTriggerEventCheckTemplate(): string {
  return `# Director Agent - Global Trigger & Victory Trigger Check

Analyze recent game events to determine:
1. Whether global trigger events have been fulfilled (doom escalation)
2. Whether investigators have achieved at least one victory condition (success)

## 🎯 Global Trigger
\`\`\`json
{{globalTriggerJson}}
\`\`\`

## 🏆 Victory Trigger
{{#if victoryTriggerJson}}
\`\`\`json
{{victoryTriggerJson}}
\`\`\`
{{else}}
*No victory trigger defined for this module.*
{{/if}}

## 🏁 End State Definition
\`\`\`json
{{endStateJson}}
\`\`\`

## 📚 Retrieved Trigger Evidence (RAG)

\`\`\`json
{{triggerEvidenceJson}}
\`\`\`

## 🕒 Current Turn New ActionLog Entries

\`\`\`json
{{currentTurnActionLogsJson}}
\`\`\`

## 🎬 Task

### Step 1: Check Global Trigger Events

Determine if the events described in the global trigger have occurred.

**Evaluation:**
- Check if the retrieved trigger evidence and current-turn action logs provide clear evidence that the trigger events have happened
- Consider logical implications (e.g., if someone left for a destination, they may have arrived)
- Be strict — only return true if there is solid evidence

### Step 2: Determine if Global Trigger Causes Game End

If the global trigger has been triggered, check if it causes game end:
- Does it directly fulfill or align with the endState's pointOfNoReturn trigger?
- Only trigger events that directly fulfill the pointOfNoReturn cause game end

### Step 3: Check Victory Conditions

If a victory trigger is defined, determine if **ANY ONE** condition has been fulfilled:
- Check each condition individually against the retrieved trigger evidence and current-turn action logs
- If at least one condition has solid direct evidence, set victoryAchieved = true
- Be strict — only count conditions with solid, direct evidence

## 📋 Output Format

Return ONLY valid JSON:

\`\`\`json
{
  "triggered": true,
  "causesGameEnd": false,
  "victoryAchieved": false,
  "achievedVictoryCondition": null
}
\`\`\`

**Fields:**
- **triggered**: boolean - Whether the global trigger events have occurred
- **causesGameEnd**: boolean - Whether this causes game end (only true if triggered AND aligns with pointOfNoReturn)
- **victoryAchieved**: boolean - Whether at least one victory condition has been fulfilled (false if no victory trigger defined)
- **achievedVictoryCondition**: string | null - The exact victory condition text that was fulfilled (must be one item from \`victoryTrigger.conditions\`). Use null if \`victoryAchieved\` is false.

*Analyze:*`;
}

/**
 * Stuck Hint Narrative Template - for when the player appears stuck
 * Injects game time, tension, current scene snapshot, scenario connections, and last 3 investigator inputs/narratives.
 * Asks the LLM to produce a short in-world hint (clues, items, places, NPCs) without direct revelation.
 */
export function getStuckHintNarrativeTemplate(): string {
  return `# Director Agent - Stuck Hint Narrative

The player appears stuck and does not know what to do next. Your task is to generate a **short in-world hint narrative** that subtly nudges them—without directly revealing solutions or secrets. The narrative must **sound natural**, **follow smoothly from the recent GM narratives above**, and read as one continuous, fluent story—not a detached hint box.

## Game State
- **Game Time**: {{gameTime}}
- **Tension**: {{tension}} / 10

## Current Scene (Full Snapshot)

\`\`\`json
{{currentSceneSnapshotJson}}
\`\`\`

## Scenario Connections

Available connections from the current scene (other locations the character could go or consider):

\`\`\`json
{{scenarioConnectionsJson}}
\`\`\`

## Recent Character Actions (Last 3 turns)

{{#if recentTurns}}
{{#each recentTurns}}
**Turn #{{this.turnNumber}}**
- Character input: "{{this.characterInput}}"
- GM narrative: {{#if this.keeperNarrative}}"{{this.keeperNarrative}}"{{else}}*none*{{/if}}

{{/each}}
{{else}}
*No recent turns*
{{/if}}

## Task

Based on the current situation (scene, connections, recent inputs and narratives), produce a **brief narrative hint** (2–4 sentences) that:

- **Output language**: Write the narrative in the **same language** as the investigator's recent inputs (see "Character input" above). If they wrote in Chinese, respond in Chinese; if in English, respond in English. Match the player's language.
- **Quantity**: Give **at most two** clue/location/NPC hints in the narrative. Do not list more than two distinct nudges; one or two is enough.
- **Tone and continuity**: Use a **natural, in-world tone**. The hint must **flow directly from the last GM narrative**—same voice, same pacing, no abrupt shift. It should feel like the next paragraph of the story, not a separate "hint" message. Keep the prose **coherent and fluent**.
- **Allowed**: Subtle hints about clues, items, locations, or NPCs—e.g. atmosphere, something worth noticing, a nudge toward a person or place. Write as in-world description (what the investigator might sense, notice, or recall), not meta-advice.
- **Not allowed**: Do NOT spell out the solution, directly reveal secrets, or tell the player what to do in plain language.

## Response

Return ONLY valid JSON in this form:

\`\`\`json
{
  "narrative": "Your hint narrative here (2-4 sentences, in-world, same language as investigator input, at most two hints)"
}
\`\`\`

*Generate the hint narrative:*`;
}
