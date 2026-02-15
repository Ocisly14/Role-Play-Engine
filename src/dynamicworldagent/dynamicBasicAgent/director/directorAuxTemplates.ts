/**
 * Director auxiliary templates.
 */
export function getGlobalTriggerEventCheckTemplate(): string {
  return `# Director Agent - Global Trigger Event Check & Game End Analysis

Analyze recent game events to determine if global trigger events have been fulfilled, and whether this triggers game end.

## 🎯 Global Trigger
\`\`\`json
{{globalTriggerJson}}
\`\`\`

## 🏁 End State Definition
The following defines the inevitable outcome if no intervention occurs:

\`\`\`json
{{endStateJson}}
\`\`\`

**Note**: The endState contains the pointOfNoReturn trigger. If the global trigger events align with or directly cause the point of no return to be reached, this will cause game end.

## 📋 New ActionLog Entries (Last 3 Turns)

The following are **newly added** actionLog entries from the most recent 3 turns (not all historical actionLog, only the new entries added in these turns):

\`\`\`json
{{recentActionLogsJson}}
\`\`\`

**Note**: These are only the actionLog entries that were created/added during the last 3 game turns, representing the most recent character activities.

## 🎬 Task

### Step 1: Check if Global Trigger Events Have Occurred

Determine if the events described in the global trigger have occurred based on these newly added actionLog entries.

**Evaluation:**
- Check if the new actionLog entries provide clear evidence that the trigger events have happened
- Consider logical implications (e.g., if someone left for a destination, they may have arrived)
- Be strict - only return true if there's solid evidence in the recent activities

### Step 2: Determine if This Causes Game End

If the global trigger has been triggered, determine if this causes the game to end by checking:

1. **Does the global trigger event align with the pointOfNoReturn trigger?**
   - Compare the global trigger events with the endState's pointOfNoReturn trigger
   - If the events directly fulfill or align with the point of no return condition, this causes game end

2. **Is the pointOfNoReturn condition now met?**
   - For time-based triggers: Has the time restriction been reached?
   - For condition-based triggers: Have the required conditions been fulfilled?

**Important**: 
- Not all global trigger events cause game end
- Only trigger events that directly relate to or fulfill the pointOfNoReturn cause game end
- If the global trigger is just a story progression event (e.g., "NPCs gather", "Evidence revealed") but doesn't fulfill the point of no return, it does NOT cause game end

## 📋 Output Format

Return ONLY valid JSON:

\`\`\`json
{
  "triggered": true,
  "causesGameEnd": false,
  "reason": "Event description or null if not triggered"
}
\`\`\`

**Fields:**
- **triggered**: boolean - Whether the global trigger events have occurred
- **causesGameEnd**: boolean - Whether this trigger causes the game to end (only true if triggered AND aligns with pointOfNoReturn)
- **reason**: string | null - Brief description of what triggered (e.g., "时间限制到达", "事件已完成", "Point of no return reached") or null if not triggered

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
