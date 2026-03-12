import type { ScheduleEntry } from "./types.js";

// ===================== Shared Type =====================

export interface PromptParts {
  systemPrompt: string;
  userPrompt: string;
}

// ===================== Day Memory Summarization =====================

export interface SummarizeDayMemoryParams {
  npcName: string;
  npcProfile: string;
  gameDay: number;
  eventLog: string;
  receivedKnowledge: Array<{ id: string; text: string; category: string; from: string }>;
  existingKnowledgeIds: string[];
  language: string;
}

export function buildSummarizeDayMemoryPrompt(params: SummarizeDayMemoryParams): PromptParts {
  const receivedSection = params.receivedKnowledge.length > 0
    ? params.receivedKnowledge.map(k => `- [${k.id}] (from ${k.from}) "${k.text}" (${k.category})`).join("\n")
    : "None.";

  const existingIds = params.existingKnowledgeIds.length > 0
    ? params.existingKnowledgeIds.join(", ")
    : "(none)";

  const systemPrompt = `You are an NPC character in a Call of Cthulhu tabletop RPG.

## Task
It's the end of the day. Review everything that happened today and produce two outputs:
1. **Long-term memory**: The key moments worth remembering — what matters to you going forward.
2. **New knowledge**: Any facts, secrets, or observations you learned today that you didn't know before.

## Instructions

### Long-term Memory
- Write each memory as a separate entry with an importance score
- **importance** (1-5): 1 = minor detail, 2 = routine but worth noting, 3 = significant event, 4 = major turning point, 5 = critical/life-threatening
- Focus on: important events, relationship changes, emotional moments, threats or opportunities
- Drop routine actions unless something notable happened during them
- Write from your perspective, one concise sentence per entry

### New Knowledge
- Review "Knowledge Received Today" and "Today's Events" for new information
- For knowledge received from other characters, keep the original ID and text — decide whether to accept it
- For things you observed or deduced yourself, generate a new ID (e.g. "learned_dayN_1")
- Do NOT include knowledge you already have (check "Your Existing Knowledge IDs")
- **category**: "knowledge" for facts and information, "secret" for things you want to keep hidden from others
- **difficulty**: How hard it would be for someone to extract this from you — "automatic" (you'd share freely), "regular", "hard", "extreme" (you'd never willingly reveal)
- **relatedTo**: Array of truth event IDs, character IDs, or location IDs this knowledge relates to (optional, omit if unclear)

## Output
Return a JSON object. No extra text. Always write in English.

\`\`\`json
{
  "memories": [
    { "content": "One concise sentence about what happened.", "importance": 3 },
    { "content": "Another memory entry.", "importance": 4 }
  ],
  "newKnowledge": [
    { "id": "knowledge_id", "text": "what you learned", "category": "knowledge", "difficulty": "regular", "relatedTo": ["T1"] }
  ]
}
\`\`\``;

  const userPrompt = `## Day ${params.gameDay}

## Who You Are
${params.npcProfile}

## Your Existing Knowledge IDs
${existingIds}

## Today's Events
${params.eventLog}

## Knowledge Received Today
${receivedSection}`;

  return { systemPrompt, userPrompt };
}

// ===================== Daily Schedule (Layer 1 — coarse) =====================

export interface DailyScheduleParams {
  npcName: string;
  npcId: string;
  npcProfile: string;
  longTermIntent: string;
  relationships: string;
  sceneMap: string;
  scenarioConditions: string;
  /** Filtered world state: weather, nearby fires, NPC fatigue/sanity */
  worldStatePrompt: string;
  gameDay: number;
  currentTime: string;
  language: string;
  /** Ranked memory context from unified memory system */
  memoryContext?: string;
}

export function buildDailySchedulePrompt(params: DailyScheduleParams): PromptParts {
  const systemPrompt = `You are an NPC character in a Call of Cthulhu tabletop RPG.

## Task
Plan your day. Think about what you need to do and where you need to go — from now until you go to sleep.

Write your plan as an ordered list of activities: WHERE you'll go and WHAT you intend to do there. Each entry is one sentence — just your intent, not the details of how you'll do it. The order matters — it's the sequence you'll follow.

## How to Plan Your Day
- Think about who you are — your job, your habits, your personality. Plan a day that feels natural for someone like you.
- Balance your everyday routine (meals, work, rest, hobbies) with actions that move you closer to your goal.
- Use scene IDs from "Places You Know" for locations.
- Be realistic — you wouldn't break into someone's office in broad daylight, and you need to eat and rest.
- Plan entries as you need for a full day. Fewer if it's already late.

## Social Interactions
If you want to share information with or talk to another character, plan a visit to their location. The detailed planning step will handle the specifics of what you say.

## Output
Return a JSON array in the order you plan to do them. No extra text. Always write in English.

\`\`\`json
[
  { "location": "home_kitchen", "activity": "Have breakfast and review notes from yesterday" },
  { "location": "library_main", "activity": "Search the archives for information about the ritual" }
]
\`\`\`

Each entry has exactly two fields:
- \`"location"\`: scene ID — where you need to go for this activity
- \`"activity"\`: one sentence — what you intend to do there`;

  const userPrompt = `## Places You Know
${params.sceneMap}

## Current Conditions Around You
${params.scenarioConditions || "Nothing unusual."}

${params.worldStatePrompt || ""}

## Right Now
Day ${params.gameDay}, ${params.currentTime}

## Character: ${params.npcName} (${params.npcId})

## Who You Are
${params.npcProfile}

## Your Goal
${params.longTermIntent}

${params.memoryContext ? `## Your Memory\n${params.memoryContext}` : ""}

## People You Know
${params.relationships}`;

  return { systemPrompt, userPrompt };
}

// ===================== Detailed Nodes (Layer 2 — fine) =====================

export interface DetailedNodesParams {
  npcName: string;
  npcId: string;
  npcProfile: string;
  longTermIntent: string;
  memoryLog: string;
  todayPlan: ScheduleEntry[];
  currentLocation: string;
  sceneDescription: string;
  sceneItems: string;
  sceneNpcs: string;
  sceneConditions: string;
  /** Filtered world state: weather, fire, fatigue, sanity etc. */
  worldStatePrompt: string;
  npcInventory: string;
  currentTime: string;
  gameDay: number;
  language: string;
  handlerPrompt?: string;
  planningPrompt?: string;
  outputSchemaPrompt?: string;
}

const DEFAULT_DETAILED_NODE_TYPE_REF = `## Node Type Reference
- **"routine"**: Self-contained action, no interaction target.
- **"movement"**: Move to a destination scene. Set location to the target scene ID.
- **"character_interaction"**: Interact with a specific character. Requires targetCharacterId.
  - For sharing information or knowledge with one or more characters, include characterInteractionPayload:
    { "transferType": "information", "informationContent": "what you want to tell them", "targetCharacterIds": ["id1", "id2"], "relatedKnowledgeIds": ["knowledge_id"] }
  - informationContent should reflect YOUR perspective — what you believe and how you'd say it.
  - targetCharacterIds is optional (defaults to targetCharacterId). relatedKnowledgeIds is optional (use when formally sharing knowledge you possess).
- **"object_interaction"**: Interact with a physical object. Include objectInteractionPayload. For creative non-standard uses, set actionType and include itemUpdates/targetItemUpdates.
- **"scene_interaction"**: Search, investigate, or modify the environment.

## ActionType (optional — set when skill roll is needed)
exploration | social | combat | stealth | chase | mental | environmental | narrative`;

const DEFAULT_DETAILED_OUTPUT_SCHEMA = `## Output
Return a JSON array of PlanNode objects. No extra text. Always write in English.

### Fields
\`\`\`json
{
  "nodeId": "unique-id",
  "gameTime": "HH:MM",
  "action": "description of what you do",
  "location": "sceneId",
  "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
  "actionType": "OMIT if no skill check needed",
  "impact": 0,
  "status": "pending"
}
\`\`\`

Add type-specific fields as needed:
- **character_interaction**: \`"targetCharacterId"\`, optional \`"characterInteractionPayload"\` with \`transferType\` ("item" or "information"), \`informationContent\`, \`targetCharacterIds\`, \`relatedKnowledgeIds\`
- **object_interaction**: \`"objectInteractionPayload"\` with \`itemUpdates\`/\`targetItemUpdates\` for non-standard use
- **scene_interaction**: optional \`"sceneConnectionEffect"\``;

export function buildDetailedNodesPrompt(params: DetailedNodesParams): PromptParts {
  const todayPlan = JSON.stringify(params.todayPlan, null, 2);

  const systemPrompt = `You are an NPC character in a Call of Cthulhu tabletop RPG.

## Task
Look at your full plan for today and what has already happened. First decide which plan step is the next one you should actually do now. Then break only that next step into concrete action nodes.

Do not expand the whole day. Do not repeat plan steps that your memory log already shows as completed, interrupted, cancelled, or no longer relevant.

Set each node's \`location\` to the scene where that action happens. If the next step is not at your current location, include movement nodes first. Cross-location travel is handled automatically.

## How To Choose The Next Step
- Use "Your Plan For Today" as the source of truth for the intended sequence.
- Use "What Happened Today So Far" to judge which planned steps are already done, blocked, disrupted, or no longer necessary.
- Choose exactly one next plan step to execute now.
- If all meaningful plan steps are already done, return an empty JSON array.

## When Your Actions Need a Skill Check
- Everyday activities, simple movement, friendly conversation → **no actionType** (auto-succeed)
- Searching for hidden things, persuading reluctant people, sneaking, fighting → **set actionType**

${params.handlerPrompt || DEFAULT_DETAILED_NODE_TYPE_REF}

${params.planningPrompt || ""}

${params.outputSchemaPrompt || DEFAULT_DETAILED_OUTPUT_SCHEMA}`;

  const userPrompt = `## Right Now
Day ${params.gameDay}, ${params.currentTime}

## Character: ${params.npcName} (${params.npcId})

## Who You Are
${params.npcProfile}

## Your Goal
${params.longTermIntent}

## Your Plan For Today
${todayPlan}

## What Happened Today So Far
${params.memoryLog || "Nothing recorded yet."}

## Your Current Location
${params.currentLocation || "Unknown"}

## Where You Are
${params.sceneDescription || "No description available."}

## Conditions Here
${params.sceneConditions || "Nothing unusual."}

${params.worldStatePrompt || ""}

## Items You Can See
${params.sceneItems || "Nothing here."}

## People Present
${params.sceneNpcs || "You're alone."}

## What You're Carrying
${params.npcInventory || "Nothing."}`;

  return { systemPrompt, userPrompt };
}

// ===================== Schedule Revision (Layer 1) =====================

export interface ReviseScheduleParams {
  npcName: string;
  npcId: string;
  npcProfile: string;
  longTermIntent: string;
  memoryContext: string;
  relationships: string;
  sceneMap: string;
  scenarioConditions: string;
  worldStatePrompt: string;
  remainingSchedule: string;
  triggerDescription: string;
  gameDay: number;
  currentTime: string;
  language: string;
}

export function buildReviseSchedulePrompt(params: ReviseScheduleParams): PromptParts {
  const systemPrompt = `You are an NPC character in a Call of Cthulhu tabletop RPG.

## Task
Something significant just happened. Look at your remaining plans for today and decide: do you need to change anything?

Think about how this event affects your goals and your safety. Adjust your schedule if needed — you can change plans, add new ones, drop old ones, or rearrange the order. If the event doesn't really affect your plans, leave them as they are.

## Instructions
- Only change what the event actually affects. Don't rewrite plans that are still fine.
- Keep the same format: each entry has "location", "activity". Order matters.
- Use scene IDs from "Places You Know" for locations.
- If this event fundamentally changes what you're trying to accomplish, update your long-term goal too.

## Output
Return a single JSON object. No extra text. Always write in English.

\`\`\`json
{
  "revisedSchedule": [
    { "location": "scene_id", "activity": "what you will do" }
  ],
  "shouldUpdateLongTermIntent": false,
  "updatedLongTermIntent": "only if shouldUpdateLongTermIntent is true"
}
\`\`\``;

  const userPrompt = `## Places You Know
${params.sceneMap}

## Current Conditions Around You
${params.scenarioConditions || "Nothing unusual."}

${params.worldStatePrompt || ""}

## Right Now
Day ${params.gameDay}, ${params.currentTime}

## Character: ${params.npcName} (${params.npcId})

## Who You Are
${params.npcProfile}

## Your Goal
${params.longTermIntent}

${params.memoryContext ? `## Your Memory\n${params.memoryContext}` : ""}

## People You Know
${params.relationships}

## What Just Happened
${params.triggerDescription}

## Your Remaining Plans for Today
${params.remainingSchedule}`;

  return { systemPrompt, userPrompt };
}

// ===================== Plan Node Revision (Layer 2) =====================

export interface RevisePlansParams {
  npcName: string;
  npcId: string;
  npcProfile: string;
  longTermIntent: string;
  memoryLog: string;
  todayPlan: ScheduleEntry[];
  pendingNodes: string;
  triggerDescription: string;
  currentLocation: string;
  sceneDescription: string;
  sceneItems: string;
  sceneNpcs: string;
  sceneConditions: string;
  worldStatePrompt: string;
  npcInventory: string;
  currentTime: string;
  gameDay: number;
  language: string;
  handlerPrompt?: string;
  planningPrompt?: string;
  outputSchemaPrompt?: string;
}

const REVISE_PLANS_OUTPUT_SCHEMA = `## Output
Return a single JSON object. No extra text. Always write in English.

\`\`\`json
{
  "revisedNodes": [ /* same PlanNode format */ ],
  "shouldUpdateLongTermIntent": false,
  "updatedLongTermIntent": "only if shouldUpdateLongTermIntent is true"
}
\`\`\``;

export function buildRevisePlansPrompt(params: RevisePlansParams): PromptParts {
  const todayPlan = JSON.stringify(params.todayPlan, null, 2);

  const systemPrompt = `You are an NPC character in a Call of Cthulhu tabletop RPG.

## Task
Something just disrupted your plans. Look at what you were about to do and decide how to adjust.

You can reorder, change, add, or drop actions. If this event fundamentally changes what you're trying to accomplish long-term, say so.

Set each node's \`location\` to the scene where that action happens. If the next step is not at your current location, include movement nodes first.

## Instructions
- Only change what the event actually affects. Don't rewrite actions that are still fine.
- You may reorder, change, add, or drop actions.

## When Your Actions Need a Skill Check
- Everyday activities, simple movement, friendly conversation → **no actionType** (auto-succeed)
- Searching for hidden things, persuading reluctant people, sneaking, fighting → **set actionType**

${params.handlerPrompt || DEFAULT_DETAILED_NODE_TYPE_REF}

${params.planningPrompt || ""}

${params.outputSchemaPrompt || REVISE_PLANS_OUTPUT_SCHEMA}`;

  const userPrompt = `## Right Now
Day ${params.gameDay}, ${params.currentTime}

## Character: ${params.npcName} (${params.npcId})

## Who You Are
${params.npcProfile}

## Your Goal
${params.longTermIntent}

## What Just Happened
${params.triggerDescription}

## Your Plan For Today
${todayPlan}

## What Happened Today So Far
${params.memoryLog || "Nothing recorded yet."}

## Your Pending Actions
${params.pendingNodes}

## Your Current Location
${params.currentLocation || "Unknown"}

## Where You Are
${params.sceneDescription || "No description available."}

## Conditions Here
${params.sceneConditions || "Nothing unusual."}

${params.worldStatePrompt || ""}

## Items You Can See
${params.sceneItems || "Nothing here."}

## People Present
${params.sceneNpcs || "You're alone."}

## What You're Carrying
${params.npcInventory || "Nothing."}`;

  return { systemPrompt, userPrompt };
}

// ===================== Impact Gate (per-NPC) =====================

export interface ImpactGateParams {
  bucketTime: string;
  candidate: {
    npcId: string;
    npcName: string;
    currentLocation: string;
    longTermIntent: string;
    todayScheduleSummary: string;
    currentDetailedPlan: string;
    triggeringEvents: string;
    memoryContext?: string;
  };
  language: string;
}

export function buildImpactGatePrompt(params: ImpactGateParams): PromptParts {
  const c = params.candidate;

  const memorySection = c.memoryContext
    ? `\n## Relevant Memories\n${c.memoryContext}\n`
    : "";

  const systemPrompt = `You are an NPC character in a Call of Cthulhu tabletop RPG.

## Task
You just witnessed something. Think about what you saw and how it affects you.

Decide:
1. Should you change what you're doing **right now**? (shouldRevise)
2. Should you change your **plans for the rest of the day**? (shouldReviseSchedule)

## Instructions
- Write a brief note about what you perceived and how you feel about it.
- Set shouldRevise=true only if the events meaningfully affect what you're doing right now.
- Set shouldReviseSchedule=true only if the events fundamentally change your plans for the rest of the day (e.g., a place you planned to visit was destroyed, someone you need to meet was arrested).

## Output
Return a single JSON object. No extra text. Always write in English.

\`\`\`json
{
  "shouldRevise": false,
  "shouldReviseSchedule": false,
  "witnessEntry": "Brief description of what you perceived."
}
\`\`\``;

  const userPrompt = `You are ${c.npcName}.

## What Just Happened
${c.triggeringEvents}
${memorySection}
## Who You Are
- Current location: ${c.currentLocation}
- Your goal: ${c.longTermIntent}
- Your plan for today: ${c.todayScheduleSummary || "No schedule."}
- What you're doing right now: ${c.currentDetailedPlan || "Nothing planned."}

## Right Now
${params.bucketTime}`;

  return { systemPrompt, userPrompt };
}

// ===================== Relationship Update (GM perspective) =====================
// NOTE: Excluded from PromptParts refactor — both profiles unique per call, low cache value.

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
