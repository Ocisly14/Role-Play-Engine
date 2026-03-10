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
  /** Registry-generated prompt listing all registered node types */
  handlerPrompt?: string;
  /** Registry-generated prompt: impact levels + all feature planning prompts */
  planningPrompt?: string;
  /** Registry-generated output schema prompt */
  outputSchemaPrompt?: string;
}

/**
 * Default hardcoded node type + actionType reference for NPC planning.
 * Used as fallback when no registry-generated handlerPrompt is provided.
 */
const DEFAULT_NPC_NODE_TYPE_REFERENCE = `## Node Type Reference
- **"routine"**: Self-contained action, no interaction target. Examples: eating, resting, reading, working, sleeping, thinking.
- **"movement"**: Move to a destination scene. Set location to the target scene ID. Omit actionType for normal unblocked movement; set actionType when path is blocked (if skill can overcome it) or for creative movement.
- **"character_interaction"**: Interact with a specific character. Requires targetCharacterId. Include characterInteractionPayload if transferring item/clue/information.
- **"object_interaction"**: Interact with a physical object. Include objectInteractionPayload (pickup/place/use/inspect/destroy). For two-item interactions (e.g., use key on safe), include targetItemId. For creative non-standard uses, set actionType on the node and include itemUpdates/targetItemUpdates with expected end-state.
- **"scene_interaction"**: Search, investigate, or modify the environment. Include sceneConnectionEffect if changing a connection.

## ActionType Categories (optional — set when skill roll is needed)
- **exploration**: Finding hidden things, researching, analyzing
- **social**: Influencing, persuading, deceiving, intimidating
- **combat**: Physical violence — attacking, defending, restraining
- **stealth**: Acting undetected — sneaking, hiding, pickpocketing
- **chase**: Pursuit or escape — running, driving, climbing under pressure
- **mental**: Sanity resistance — confronting cosmic horror
- **environmental**: Surviving harsh conditions, emergency medicine, creative movement (climbing, jumping, swimming)
- **narrative**: Interpreting lore, performing rituals, dramatic speeches`;

const DEFAULT_NPC_OUTPUT_SCHEMA = `## Output
Return a JSON array of PlanNode objects. No extra text. Always write in English.
Only generate nodes from current time onward. Use concrete "HH:MM" timestamps that reflect realistic timing for each action.

Each node is a single flat JSON object combining:
1. All **Base Fields** (required on every node)
2. **Type-specific fields** for the chosen \`type\` (see below — omit if type has none)
3. **Feature overlay fields** if the action involves an active world feature (see below)

### Base Fields (every node)
\`\`\`json
{
  "nodeId": "unique-id",
  "gameTime": "HH:MM",
  "action": "description of what the NPC does",
  "location": "scenarioId where this happens",
  "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
  "actionType": "exploration|social|combat|stealth|chase|mental|environmental|narrative (OMIT if no skill roll)",
  "impact": 0,
  "status": "pending"
}
\`\`\`

### Type-Specific Additional Fields

**routine**: no additional fields

**movement**: no additional fields

**character_interaction** adds:
- \`"targetCharacterId"\`: (REQUIRED) e.g. \`"npc_dr_morgan"\`
- \`"characterInteractionPayload"\`: (optional) e.g. \`{"transferType":"item","itemId":"mysterious_letter"}\`

**object_interaction** adds:
- \`"objectInteractionPayload"\`: (optional) e.g. \`{"action":"pickup","itemId":"ancient_tome"}\` or \`{"action":"use","itemId":"room_key","targetItemId":"locked_safe"}\`. For non-standard creative uses, add \`"itemUpdates"\` and/or \`"targetItemUpdates"\` with the expected item state changes on success.

**scene_interaction** adds:
- \`"sceneConnectionEffect"\`: (optional) e.g. \`{"targetScenarioId":"basement_entrance","action":"block"}\`

### Complete Example
\`\`\`json
[
  {
    "nodeId": "ci1",
    "gameTime": "09:00",
    "action": "Hand over the mysterious letter to Dr. Morgan",
    "location": "hospital_lobby",
    "type": "character_interaction",
    "actionType": "social",
    "impact": 2,
    "status": "pending",
    "targetCharacterId": "npc_dr_morgan",
    "characterInteractionPayload": {
      "transferType": "item",
      "itemId": "mysterious_letter"
    }
  }
]
\`\`\``;

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
- Use "movement" nodes to change scenes. Set "location" to the destination scene ID.
- **Movement actionType rules:**
  - Connected path with NO blocked connections → **OMIT actionType** (auto-succeed, the system pathfinds)
  - Connected path but a connection is BLOCKED → read the block reason. If the obstacle can plausibly be overcome with a skill (e.g. locked door → Locksmith, barricade → environmental), **SET actionType**. If the block is impassable (e.g. collapsed building, magically sealed), do NOT attempt — plan an alternative route or give up.
  - No connection exists (creative movement: jumping from window, climbing walls, swimming across) → **SET actionType** (e.g. environmental, chase). Skill check required.
- To go home, move to a scene in your residence location.
- Travel time between buildings varies (shown in Nearby Locations).
- Check other NPC locations — if you need to interact with someone, ensure you're in the same scene at the right time.

### When to Set actionType
Set actionType **only** when the outcome is genuinely uncertain and requires a skill check.
- Routine daily activities, simple movement, friendly conversation with allies → **no actionType** (auto-succeed)
- Searching for hidden things, persuading reluctant NPCs, sneaking, picking locks, combat → **set actionType**
- High relationship score (>60) means simple requests auto-succeed; only set actionType for unreasonable or sensitive demands.

${params.handlerPrompt || DEFAULT_NPC_NODE_TYPE_REFERENCE}

${params.planningPrompt || ""}

${params.outputSchemaPrompt || DEFAULT_NPC_OUTPUT_SCHEMA}`;
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
  candidate: {
    npcId: string;
    npcName: string;
    currentLocation: string;
    longTermIntent: string;
    pendingNodesSummary: string;
    triggeringEvents: string;
  };
  language: string;
}

export function buildImpactGatePrompt(params: ImpactGateParams): string {
  const c = params.candidate;

  return `You are the Game Master for a Call of Cthulhu tabletop RPG.

## Task
Determine how the NPC "${c.npcName}" perceives the following events, and whether they should revise their current plan.

## Time: ${params.bucketTime}

## NPC: ${c.npcName}
- Current location: ${c.currentLocation}
- Long-term intent: ${c.longTermIntent}
- Pending plan: ${c.pendingNodesSummary || "No pending plans."}

## Events Witnessed
${c.triggeringEvents}

## Instructions
1. Write a brief witness entry from this NPC's perspective — what they perceived and how.
2. Decide whether these events should cause the NPC to revise their current plan. Only set shouldRevise=true if the events meaningfully conflict with or alter the NPC's goals or immediate plans.

## Output
Return a single JSON object. No extra text. Always write in English.

\`\`\`json
{
  "shouldRevise": false,
  "witnessEntry": "Brief description of what this NPC perceived."
}
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
