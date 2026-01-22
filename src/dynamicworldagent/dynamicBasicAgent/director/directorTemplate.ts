/**
 * Action-Driven Scene Change Template - for validating and selecting scene based on map
 */
export function getActionDrivenSceneChangeTemplate(): string {
    return `# Director Agent - Action-Driven Scene Change Validation

Based on the character's input and previous narrative context, determine the appropriate target scene using the town map and spatial logic.

## 📍 Current Scene
{{#if currentScene}}
**{{currentScene.name}}** @ {{currentScene.location}}
{{else}}
*No current scene*
{{/if}}

## 🗺️ Town Map & Spatial Logic
{{#if mapData}}
**Map Name**: {{mapData.map_name}}

**Spatial Logic**: {{mapData.spatial_logic}}

### Road Network
{{#each mapData.road_network}}
**{{this.road_name}}** ({{this.orientation}})
{{#if this.connected_to}}
🔗 Connected to: {{#each this.connected_to}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{/if}}
{{#if this.locations_along_road}}
📍 Locations: {{#each this.locations_along_road}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{/if}}
{{#if this.sub_sections}}
{{#each this.sub_sections}}
  - **{{this.segment}}**: Connected to {{#each this.connected_to}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
    Locations: {{#each this.locations}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{/each}}
{{/if}}

{{/each}}

### Hidden Connectivity
{{#if mapData.hidden_connectivity}}
{{#each mapData.hidden_connectivity}}
- **{{this.entry_point}}** → {{this.leads_to}}
{{/each}}
{{else}}
*No hidden connections*
{{/if}}
{{else}}
*Map data not available*
{{/if}}

## 📜 Previous Round Context
{{#if previousNarrative}}
**Previous Keeper Narrative**:
"{{previousNarrative}}"
{{else}}
*No previous narrative available*
{{/if}}

## 💬 Current Character Input
{{#if characterInput}}
"{{characterInput}}"
{{else}}
*No character input available*
{{/if}}

## ⏰ Current Game Time
{{#if currentGameTime}}
**Day**: {{currentGameTime.gameDay}}
**Time**: {{currentGameTime.timeOfDay}}
{{else}}
*Game time not available*
{{/if}}

## 🎬 Available Scenarios & Snapshots
{{#if scenariosWithSnapshots}}
{{#each scenariosWithSnapshots}}
### **{{this.scenarioName}}**
{{#if this.snapshots}}
{{#each this.snapshots}}
- **Snapshot**: "{{this.snapshotName}}" (ID: {{this.snapshotId}})
  - Location: {{this.location}}
  {{#if this.timeRestriction}}
  - ⏰ Time Restriction: **{{this.timeRestriction}}**
    - Check if current time (Day {{../currentGameTime.gameDay}}, Time {{../currentGameTime.timeOfDay}}) matches this restriction
  {{else}}
  - ✅ **No Time Restriction**: Available at any time
  {{/if}}
{{/each}}
{{else}}
*No snapshots available*
{{/if}}

{{/each}}
{{else}}
*No scenarios available*
{{/if}}

## Guidelines
- Analyze the character's input and the previous narrative to understand the intent for scene change
- Use the map's spatial logic to determine which scene the character wants to reach or should reach
- Check road connections: scenes on the same road or connected roads are accessible from the current location
- Consider hidden connectivity (entry points) if applicable
- **IMPORTANT**: Select the appropriate snapshot based on time restrictions:
  - If a snapshot has **no timeRestriction**, it's available at any time
  - If a snapshot has a **specific time** (e.g., "day1 evening"), it's only available at that exact time
  - If a snapshot has a **time range** (e.g., "day2 (after)"), it's available from that time onwards
  - Check the current game time (Day {{currentGameTime.gameDay}}, Time {{currentGameTime.timeOfDay}}) against each snapshot's timeRestriction
  - If multiple snapshots are available for a scenario, choose the one that matches the current time or has no restriction
- **MUST** return the exact snapshot ID from the available scenarios list that matches the current game time

## Response
\`\`\`json
{
  "targetSnapshotId": "exact snapshot ID that matches current game time (e.g., 'scenario-xxx-snapshot' or 'scenario-xxx-snapshot-1')",
  "reasoning": "Why this snapshot is selected based on map spatial logic and time restrictions (2-3 sentences)"
}
\`\`\`

**Important**:
- **MUST** return the exact snapshot ID from the available scenarios list above
- Base your decision on the character's input, the context from the previous narrative, and the current game time
- Use the map's spatial logic to determine the most appropriate accessible scene
- **Check time restrictions**: Only select snapshots that are available at the current game time (Day {{currentGameTime.gameDay}}, Time {{currentGameTime.timeOfDay}})
- If the character's intended destination is not directly accessible, suggest the closest accessible scene based on map connections
- Reference specific roads, connections, and time restrictions in your reasoning

*Validate and decide:*`;
}

/**
 * Narrative Direction Template - for generating narrative instruction for keeper agent
 */
export function getNarrativeDirectionTemplate(): string {
    return `# Director Agent - Narrative Direction Guidance

Generate narrative direction instructions for the Keeper Agent based on module constraints, keeper guidance, and current game context.

## 🎮 Current Game State

{{#if currentScene}}
**Scene**: {{currentScene.name}}
**Location**: {{currentScene.location}}
{{#if currentScene.description}}
**Description**: {{currentScene.description}}
{{/if}}
{{else}}
*No current scene*
{{/if}}

{{#if currentGameTime}}
**Game Time**: Day {{currentGameTime.gameDay}}, {{currentGameTime.timeOfDay}}
{{else}}
*Game time not available*
{{/if}}

{{#if playerStatus}}
**Player Character Status**:
- HP: {{playerStatus.hp}} / {{playerStatus.maxHp}}
- Sanity: {{playerStatus.sanity}} / {{playerStatus.maxSanity}}
- Status: {{#if playerStatus.isDead}}DEAD{{else}}{{#if playerStatus.isInsane}}INSANE{{else}}ALIVE{{/if}}{{/if}}
{{/if}}

## 📋 Module Constraints

{{#if moduleLimitations}}
### 🚫 Module Limitations
{{moduleLimitations}}

**IMPORTANT**: These are HARD CONSTRAINTS that must NEVER be violated in the narrative.
{{/if}}

{{#if keeperGuidance}}
### 🎭 Keeper Guidance
{{keeperGuidance}}

**IMPORTANT**: This guidance provides running advice for reveals, pacing levers, fail-forward options, tone cues, and when to call for rolls.
{{/if}}

## 💬 Character Input
"{{characterInput}}"

## 🎯 Action Results
{{#if actionResults}}
{{#each actionResults}}
### Action #{{@index}}: {{character}}
{{#if this.result}}
**Result**: {{this.result}}
{{/if}}
{{#if this.location}}
**Location**: {{this.location}}
{{/if}}
{{#if this.gameTime}}
**Game Time**: {{this.gameTime}}
{{/if}}
{{#if this.timeElapsedMinutes}}
**Time Elapsed**: {{this.timeElapsedMinutes}} minutes
{{/if}}
{{#if this.scenarioChanges}}
**Scenario Changes**: {{#each this.scenarioChanges}}{{this}}{{#unless @last}}; {{/unless}}{{/each}}
{{/if}}

{{/each}}
{{else}}
*No action results available*
{{/if}}

## 🎬 Your Task

You have TWO responsibilities:

### 1️⃣ Game Ending Detection

**FIRST**, determine if the game should end based on:
- **Player Death**: HP ≤ 0
- **Permanent Insanity**: Sanity ≤ 0 or permanent insanity condition
- **Time Limit Reached**: Check module limitations for any time-based ending conditions
- **Victory Condition Met**: Player achieved the module's victory objective
- **Other Failure**: Unrecoverable failure state (e.g., ritual completed, all NPCs dead)

If the game should end:
- Set 'gameEnded' to true
- Choose appropriate 'endingType': "death", "time_limit", "victory", "failure", or "other"
- Provide a clear 'endingReason' (2-3 sentences explaining WHY the game ended and what happens to the investigator)

**CRITICAL**: The ending reason should provide closure appropriate for the ending type, but avoid excessive spoilers about unrevealed plot elements.

### 2️⃣ Narrative Direction (if game is ongoing)

If the game has NOT ended, generate a **reference-style** narrative direction instruction for the Keeper Agent based on the current game state, module constraints, character input, and action results.

**The instruction should**:
1. Consider the current scene and game time context
2. Guide the narrative tone and atmosphere based on keeper guidance
3. Be aware of module limitations internally but **DO NOT reveal spoilers to the player**
4. Incorporate module notes considerations (pacing, content warnings, etc.)
5. Provide specific guidance on what to emphasize, reveal, or hint at in the narrative
6. Suggest pacing adjustments if needed based on module notes
7. **CRITICAL**: This is a REFERENCE for the Keeper, not a hard constraint - the Keeper may adapt based on player actions

**Anti-Spoiler Rules**:
- **NEVER** mention specific deadlines, time limits, or future events (e.g., "Day 8", "New Year", "ritual completion")
- **NEVER** reveal plot twists, villain identities, or hidden truths the player hasn't discovered
- **NEVER** directly state module limitations - instead, subtly guide tone/pacing to respect them
- Use indirect language: "maintain tension" instead of "there's a time limit"
- Focus on atmosphere, tone, and what to emphasize in the CURRENT moment

## Response Format

\`\`\`json
{
  "gameEnded": false,
  "endingType": null,
  "endingReason": null,
  "narrativeDirection": "Your narrative direction instruction here"
}
\`\`\`

**Fields**:
- 'gameEnded': true if game should end, false if ongoing
- 'endingType': If ended: "death" | "time_limit" | "victory" | "failure" | "other". Otherwise null
- 'endingReason': If ended: 2-3 sentences explaining why and what happens to the investigator. Otherwise null
- 'narrativeDirection': Reference guidance for Keeper (2-4 sentences)

*Generate your response:*`;
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

