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

Evidence retrieved from game history across **all active scene rooms**.
Each item includes a \`sceneName\` field indicating where the event occurred.

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
- Evidence comes from multiple scene rooms (different player groups in different locations). The \`sceneName\` field shows where each piece of evidence originated.
- Consider evidence from ALL rooms — global triggers are game-wide.
- Be strict — only return true if there is solid evidence

### Step 2: Determine if Global Trigger Causes Game End

If the global trigger has been triggered, check if it causes game end:
- Does it directly fulfill or align with the endState's pointOfNoReturn trigger?
- Only trigger events that directly fulfill the pointOfNoReturn cause game end

### Step 3: Check Victory Conditions

Determine if **ANY ONE** condition has been fulfilled:
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
