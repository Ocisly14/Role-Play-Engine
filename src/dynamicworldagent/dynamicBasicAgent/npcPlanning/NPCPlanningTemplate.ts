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
Output language: ${params.language}

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
  actionLog: string;
  relationships: string;
  npcLocations: string;
  sceneMap: string;
  scenarioConditions: string;
  gameDay: number;
  currentTime: string;
  language: string;
}

export function buildGenerateDailyPlanPrompt(params: DailyPlanParams): string {
  return `You are the Game Master for a Call of Cthulhu tabletop RPG.

## Task
Generate today's action plan for NPC "${params.npcName}" (Day ${params.gameDay}).
Create a sequence of time-stamped action nodes that this NPC will execute throughout the day.

## NPC Profile
${params.npcProfile}

## Long-Term Intent
${params.longTermIntent}

## Action History
${params.actionLog || "No actions recorded yet."}

## Relationships
${params.relationships}

## Other NPC Locations
${params.npcLocations}

## Scene Map (connections)
${params.sceneMap}

## Current Scene Conditions
${params.scenarioConditions || "None."}

## Current Time
Day ${params.gameDay}, ${params.currentTime}

## Node Type Reference
- "routine": Independent action, no skill check needed (reading, eating, patrolling)
- "movement": Move to another scene. Will fail if path is blocked.
- "character_interaction": Interact with another character. Requires targetCharacterId. Include characterInteractionPayload if transferring item/clue/information.
- "object_interaction": Interact with an object. Include objectInteractionPayload.
- "scene_interaction": Search or modify a scene. Include sceneConnectionEffect if changing a connection.

## ActionType (optional, set when skill roll is needed)
"exploration" | "social" | "combat" | "stealth" | "chase" | "mental" | "environmental" | "narrative"
Omit actionType for actions that succeed automatically (routine daily activities, simple movements).

## Impact Levels
- 0: Nobody perceives (private action)
- 1: Target character only
- 2: All characters in current scene
- 3: All characters globally

## Output
Return a JSON array of nodes. No extra text. Output language: ${params.language}
Only generate nodes from current time onward.

\`\`\`json
[
  {
    "nodeId": "unique-id",
    "gameTime": "HH:MM",
    "action": "description of what the NPC does",
    "location": "scenarioId where this happens",
    "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
    "actionType": "exploration|social|combat|stealth|chase|mental|environmental|narrative (omit if no skill roll)",
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
  actionLog: string;
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

## Action History
${params.actionLog || "No actions recorded yet."}

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
Return a single JSON object. No extra text. Output language: ${params.language}

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
1. A brief witness entry describing what they perceived (for their action log).
2. Whether witnessing these events should cause them to revise their current plan.

## Time Bucket: ${params.bucketTime}

## Candidates
${candidateBlock}

## Output
Return a JSON array with one entry per candidate. No extra text. Output language: ${params.language}

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
Return a single JSON object. No extra text. Output language: ${params.language}

\`\`\`json
{
  "scoreDelta": 0,
  "note": "Updated relationship description reflecting current state."
}
\`\`\``;
}
