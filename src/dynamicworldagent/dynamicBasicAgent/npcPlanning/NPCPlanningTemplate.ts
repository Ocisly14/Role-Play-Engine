export interface LongTermIntentParams {
  npcName: string;
  npcProfile: string;
  truthTimeline: string;
  moduleBackground: string;
  language: string;
}

export function buildGenerateLongTermIntentPrompt(params: LongTermIntentParams): string {
  return `You are the Game Master for a Call of Cthulhu tabletop RPG.

## Task
Generate a long-term intent (multi-day goal) for this NPC. The intent should reflect their personality, role in the story, and knowledge of the truth timeline.

## NPC Profile
${params.npcProfile}

## Module Background
${params.moduleBackground}

## Truth Timeline (Keeper-only)
${params.truthTimeline}

## Output
Return a single JSON object. No extra text.
Always write in English.

\`\`\`json
{
  "intent": "A concise 1-3 sentence description of this NPC's multi-day goal and motivation."
}
\`\`\``;
}

export interface DailyPlanParams {
  npcName: string;
  npcId: string;
  npcProfile: string;
  longTermIntent: string;
  memoryLog: string;
  relationships: string;
  sceneMap: string;
  scenarioConditions: string;
  gameDay: number;
  currentTime: string;
  language: string;
}

export function buildGenerateDailyPlanPrompt(params: DailyPlanParams): string {
  return `You are the Game Master for a Call of Cthulhu tabletop RPG.

## Task
Generate today's action plan for NPC "${params.npcName}" (ID: "${params.npcId}", Day ${params.gameDay}).
Create a sequence of time-stamped action nodes covering the NPC's full day from current time onward.

## NPC Profile
${params.npcProfile}

## Long-Term Intent
${params.longTermIntent}

## Memory Log (all previous days + today so far)
${params.memoryLog || "No actions recorded yet."}

## Relationships
${params.relationships}

## Scene Map (connections)
${params.sceneMap}

## Current Scene Conditions
${params.scenarioConditions || "None."}

## Current Time
Day ${params.gameDay}, ${params.currentTime}

## Planning Guidelines

### Daily Rhythm
Build a realistic full-day schedule that reflects this NPC's nature, occupation, personality, and habits. The schedule should feel natural and character-consistent — infer appropriate wake/sleep times, meal breaks, work hours, and leisure from the NPC profile. Non-human entities follow their own logic.

### Balancing Routine vs. Intent
- Mix everyday activities (meals, work, rest, hobbies) with intent-driven actions that advance the NPC's long-term goal.
- Routine grounds the NPC in the world; intent-driven nodes push the story forward.
- Anchor intent-driven actions at realistic times — don't schedule a break-in during broad daylight if the NPC would logically wait for cover of darkness.

### Movement & Location
- Use "movement" nodes to change scenes. The NPC must be at the correct location before interacting.
- Only move to connected scenes. If a path is blocked, plan an alternative.
- Check other NPC locations — if you need to interact with someone, ensure you're in the same scene at the right time.

### When to Set actionType
Set actionType **only** when the outcome is genuinely uncertain and requires a skill check.
- Routine daily activities, simple movement, friendly conversation with allies → **no actionType** (auto-succeed)
- Searching for hidden things, persuading reluctant NPCs, sneaking, picking locks, combat → **set actionType**
- High relationship score (>60) means simple requests auto-succeed; only set actionType for unreasonable or sensitive demands.

## Node Type Reference
- **"routine"**: Self-contained action, no interaction target. Examples: eating, resting, reading, working, sleeping, thinking.
- **"movement"**: Move to a connected scene. Set location to the target scenarioId.
- **"character_interaction"**: Interact with a specific character. Requires targetCharacterId. Include characterInteractionPayload if transferring item/clue/information.
- **"object_interaction"**: Interact with a physical object. Include objectInteractionPayload (pickup/place/use/inspect/destroy).
- **"scene_interaction"**: Search, investigate, or modify the environment. Include sceneConnectionEffect if changing a connection.

## ActionType Categories (optional — set when skill roll is needed)
- **exploration**: Finding hidden things, researching, analyzing
- **social**: Influencing, persuading, deceiving, intimidating
- **combat**: Physical violence — attacking, defending, restraining
- **stealth**: Acting undetected — sneaking, hiding, pickpocketing
- **chase**: Pursuit or escape
- **mental**: Sanity resistance — confronting cosmic horror
- **environmental**: Surviving harsh conditions, emergency medicine
- **narrative**: Interpreting lore, performing rituals, dramatic speeches

## Impact Levels
Impact determines **who perceives and is affected by** the action:
- **0 — Private / unnoticed**: Only the acting character knows. No one else perceives or reacts.
  Examples: thinking, reading alone, checking belongings, observing from afar, writing notes, resting
- **1 — Targeted / one-on-one**: Only the specific target character perceives it. A private exchange.
  Examples: whispering, passing a note, pickpocketing someone, private conversation, discreet item handoff
- **2 — Local / scene-wide**: Everyone in the current scene perceives it. Visible/audible to bystanders.
  Examples: speaking loudly, firing a gun, breaking a door, starting a fight, searching a room openly, screaming
- **3 — Global / far-reaching**: The entire game world is affected. Consequences ripple beyond the scene.
  Examples: triggering a town alarm, summoning ritual, building collapse, radio broadcast

## Output
Return a JSON array of nodes. No extra text. Always write in English.
Only generate nodes from current time onward. Use concrete "HH:MM" timestamps that reflect realistic timing for each action. Include optional fields only when relevant.

\`\`\`json
[
  {
    "nodeId": "unique-id",
    "gameTime": "HH:MM",
    "action": "description of what the NPC does",
    "location": "scenarioId where this happens",
    "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
    "actionType": "exploration|social|combat|stealth|chase|mental|environmental|narrative (OMIT if no skill roll)",
    "impact": 0,
    "targetCharacterId": "only for character_interaction",
    "characterInteractionPayload": { "transferType": "item|clue|information", "itemId": "", "clueId": "", "informationContent": "" },
    "objectInteractionPayload": { "action": "pickup|place|use|inspect|destroy", "itemId": "" },
    "sceneConnectionEffect": { "targetScenarioId": "", "action": "block|unblock" },
    "status": "pending"
  }
]
\`\`\``;
}

export interface RevisePlansParams {
  npcName: string;
  npcProfile: string;
  longTermIntent: string;
  memoryLog: string;
  pendingNodes: string;
  triggerDescription: string;
  language: string;
}

export function buildRevisePlansPrompt(params: RevisePlansParams): string {
  return `You are the Game Master for a Call of Cthulhu tabletop RPG.

## Task
Revise the remaining daily plan for NPC "${params.npcName}" after a trigger event.

## NPC Profile
${params.npcProfile}

## Long-Term Intent
${params.longTermIntent}

## Today's Memory Log
${params.memoryLog || "No actions recorded yet today."}

## Current Pending Nodes
${params.pendingNodes}

## Trigger Event
${params.triggerDescription}

## Instructions
- Revise the pending nodes to account for the trigger event.
- You may reorder, modify, add, or remove nodes.
- Keep the same node format.
- Also determine if this event fundamentally changes the NPC's long-term intent.

## Output
Return a single JSON object. No extra text. Always write in English.

\`\`\`json
{
  "revisedNodes": [ /* same NpcPlanNode format as daily plan */ ],
  "shouldUpdateLongTermIntent": false,
  "updatedLongTermIntent": "only if shouldUpdateLongTermIntent is true"
}
\`\`\``;
}

export interface ImpactGateParams {
  bucketTime: string;
  candidates: Array<{
    npcId: string;
    npcName: string;
    longTermIntent: string;
    pendingNodesSummary: string;
    triggeringEvents: string;
  }>;
  language: string;
}

export function buildImpactGatePrompt(params: ImpactGateParams): string {
  const candidateBlock = params.candidates
    .map((c, i) => `### Candidate ${i + 1}: ${c.npcName} (${c.npcId})
- Long-term intent: ${c.longTermIntent}
- Pending plan summary: ${c.pendingNodesSummary}
- Triggering events witnessed: ${c.triggeringEvents}`)
    .join("\n\n");

  return `You are the Game Master for a Call of Cthulhu tabletop RPG.

## Task
For each NPC candidate below, determine:
1. A brief witness entry describing what they perceived (for their memory log).
2. Whether witnessing these events should cause them to revise their current plan.

## Time Bucket: ${params.bucketTime}

## Candidates
${candidateBlock}

## Output
Return a JSON array with one entry per candidate. No extra text. Always write in English.

\`\`\`json
[
  {
    "npcId": "the npc id",
    "shouldRevise": false,
    "witnessEntry": "Brief description of what this NPC perceived."
  }
]
\`\`\``;
}

export interface RelationshipUpdateParams {
  npcAName: string;
  npcAProfile: string;
  npcBName: string;
  npcBProfile: string;
  currentScore: number;
  currentNote: string;
  interactionOutcome: string;
  language: string;
}

export function buildRelationshipUpdatePrompt(params: RelationshipUpdateParams): string {
  return `You are the Game Master for a Call of Cthulhu tabletop RPG.

## Task
After a character interaction, update the relationship between two characters.

## Character A: ${params.npcAName}
${params.npcAProfile}

## Character B: ${params.npcBName}
${params.npcBProfile}

## Current Relationship
- Score: ${params.currentScore} (range: -100 to 100)
- Note: ${params.currentNote || "No prior note."}

## Interaction Outcome
${params.interactionOutcome}

## Score Reference
80~100: Absolute loyalty | 60~79: Deep trust | 40~59: Friendly | 20~39: Warm
0~19: Neutral | -1~-20: Cold | -21~-40: Wary | -41~-60: Hostile
-61~-80: Antagonistic | -81~-100: Mortal enemy

## Output
Return a single JSON object. No extra text. Always write in English.

\`\`\`json
{
  "scoreDelta": 0,
  "note": "Updated relationship description reflecting current state."
}
\`\`\``;
}
