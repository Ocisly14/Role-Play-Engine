import { COC_SKILL_LIST_PROMPT } from "./cocSkillList.js";
import type { ScheduleEntry } from "./types.js";

// ===================== Shared Type =====================

export interface PromptParts {
  systemPrompt: string;
  userPrompt: string;
}

function contentLanguageName(language: string): string {
  return language?.startsWith("zh") ? "Chinese" : "English";
}

// ===================== Day Memory Summarization =====================

export interface SummarizeDayMemoryParams {
  npcName: string;
  npcProfile: string;
  gameDay: number;
  eventLog: string;
  /** Formatted list of NPC's existing knowledge (from information/secret memories) */
  existingKnowledge: string;
  language: string;
}

export function buildSummarizeDayMemoryPrompt(
  params: SummarizeDayMemoryParams
): PromptParts {
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
- Review today's events for new information you learned
- For things others told you or you observed/deduced, create an entry
- Do NOT include knowledge you already have (check "Your Existing Knowledge")
- **category**: "knowledge" for facts and information, "secret" for things you want to keep hidden from others
- **difficulty**: How hard it would be for someone to extract this from you — "automatic" (you'd share freely), "regular", "hard", "extreme" (you'd never willingly reveal)

## Output
Return a JSON object. No extra text. JSON keys must be in English. Write all text content ("content", "text") in ${contentLanguageName(params.language)}.

\`\`\`json
{
  "memories": [
    { "content": "One concise sentence about what happened.", "importance": 3 }
  ],
  "newKnowledge": [
    { "id": "learned_day1_1", "text": "what you learned", "category": "knowledge", "difficulty": "regular" }
  ]
}
\`\`\``;

  const userPrompt = `## Day ${params.gameDay}

## Who You Are
${params.npcProfile}

## Your Existing Knowledge
${params.existingKnowledge || "(none)"}

## Today's Events
${params.eventLog}`;

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

export function buildDailySchedulePrompt(
  params: DailyScheduleParams
): PromptParts {
  const systemPrompt = `You are an NPC character in a Call of Cthulhu tabletop RPG.

## Task
Plan your day. Think about what you need to do and where you need to go — from now until you go to sleep.

Write your plan as an ordered list of activities: WHERE you'll go and WHAT you intend to do there. Each entry is one sentence — just your intent, not the details of how you'll do it. The order matters — it's the sequence you'll follow.

## How to Plan Your Day
- Think about who you are — your job, your habits, your personality. Plan a day that feels natural for someone like you.
- Balance your everyday routine (meals, work, rest, hobbies) with actions that move you closer to your goal.
- Use exact location names from "Places You Know" for the location field.
- Use only the exact name itself for \`location\`. Do not copy topology notes, residents, or text after labels like \`Exact Name:\` or \`Topology Note:\`.
- Be realistic — you wouldn't break into someone's office in broad daylight, and you need to eat and rest.
- Plan entries as you need for a full day. Fewer if it's already late.
- Treat the current time as 24-hour clock time.

## Social Interactions
If you want to share information with or talk to another character, plan a visit to their location. The detailed planning step will handle the specifics of what you say.

## Output
Return a JSON array in the order you plan to do them. No extra text. JSON keys must be in English. Write the "activity" value in ${contentLanguageName(params.language)}. Keep "location" as the exact English location name from "Places You Know".

\`\`\`json
[
  { "location": "My Home", "activity": "Have breakfast and review notes from yesterday" },
  { "location": "Public Library", "activity": "Search the archives for information about the ritual" }
]
\`\`\`

Each entry has exactly two fields:
- \`"location"\`: exact location name from "Places You Know" (always English)
- \`"activity"\`: one sentence — what you intend to do there (in ${contentLanguageName(params.language)})`;

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
  sceneMap: string;
  sceneDescription: string;
  sceneItems: string;
  sceneNpcs: string;
  sceneConditions: string;
  /** Formatted connections from the current scene (e.g. "通往卧室的走廊") */
  sceneConnections?: string;
  /** Formatted overview of other rooms in the same building (name + description only) */
  buildingContext?: string;
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

const TWENTY_FOUR_HOUR_TIME_GUIDANCE = `## Time Semantics
- All times use a 24-hour clock in \`HH:MM\` format.`;

const DEFAULT_NODE_GUARDRAILS_PROMPT = `## Planning Guardrails
- You can only interact with items, characters, and the environment in your **current scene**. To act in a different scene (including other scenes in the same building), emit a movement node to that scene first, then your action node.
- For \`location\`, use the exact scene or place name. If you are inside a building, use the specific scene name (from "Your Current Location" or "Other Rooms In This Building"), not the building name.
- For object interactions, you may only target items that already appear in \`Items You Can See\` or \`What You're Carrying\`.
- Do not invent new documents, copies, notes, printouts, receipts, witness copies, or memo variants unless they already exist in the scene, inventory, or prior action history.`;

const DEFAULT_DETAILED_NODE_TYPE_REF = `## Node Type Reference
- **"routine"**: Self-contained action, no interaction target.
- **"movement"**: Move to a destination. Set location to the exact destination name from "Places You Know".
- **"character_interaction"**: Interact with one or more characters.
  - Describe what you do entirely in \`action\`.
  - Put all targets in top-level \`targetCharacterIds\`.
  - For single-target interactions, \`targetCharacterIds\` should still be an array with one ID.
- **"object_interaction"**: Interact with a physical object. Describe what you do in \`action\`. Set \`objectInteractionPayload.itemId\` to the primary item. An LLM resolver handles all state changes.
- **"scene_interaction"**: Search, investigate, or modify the environment.
  - Only include \`sceneConnectionEffect\` when you are changing a real map connection that already exists.
  - \`sceneConnectionEffect.targetScenarioId\` must be an existing connected location ID from the current location's known map data.
  - Never invent internal sub-areas, doors, partitions, or descriptive labels such as \`private_office_partition\`.
  - If there is no exact existing connected location ID to target, omit \`sceneConnectionEffect\`.

## Skill Checks

You can use a skill to accomplish an action or achieve your goal. Set \`"skill"\` to a skill name from "Available Skills" below only when the action is genuinely difficult or uses an unusual, forceful, deceptive, or creative method. The engine will roll d100 to determine success or failure.

- Omit \`"skill"\` by default for routine or straightforward actions.
- Simple \`move\`, ordinary \`inspect\`, casual conversation, and other everyday actions should usually omit \`"skill"\`.
- **Normal social interactions do NOT require skills.** Greeting someone, chatting, sharing a meal, asking for directions, everyday small talk, exchanging information, or any other ordinary conversation should NEVER use a skill. Skills like Charm, Persuade, Intimidate, Bluff, Fast Talk, or Psychology should only be used for **unconventional, high-stakes, or manipulative** social actions — e.g. coercion, seduction, deception, intimidation, extracting secrets, or convincing someone to act against their own interest.
- Before choosing a skill for an object action, inspect the injected item state first (locked/unlocked, damaged, uses, lit/unlit, ammo, etc.) and choose a normal action if the state already makes it possible.
- If you include \`"skill"\`, it must be an exact name from "Available Skills". Never invent generic labels such as \`social\`, \`professional\`, or \`exploration\`.
- For object movement, only reference items that already appear in \`Items You Can See\` or \`What You're Carrying\`. Do not invent new intermediate objects such as printouts unless a previous action has already created them.
- Use \`move\` when the item is simply changing where it is. Do not split same-scene relocation into artificial \`pickup\` then \`place\` steps.

## Impact

- \`"impact": 0\` = private or low-consequence action. No one else needs to react.
- \`"impact": 1\` = direct target only. Use this only for targeted actions with \`targetCharacterIds\` where the target should meaningfully react, and only when the action also uses a \`skill\`.
- \`"impact": 2\` = noticeable to others in the same scene.
- \`"impact": 3\` = noticeable across the same larger location or building.
- \`"impact": 4\` = noticeable in nearby locations or the surrounding area.
- \`"impact": 5\` = major event with global or session-wide consequences.
- Default to \`"impact": 0\` unless there is a clear reason to escalate it.

## Available Skills
${COC_SKILL_LIST_PROMPT}`;

function defaultDetailedOutputSchema(language: string): string {
  const lang = contentLanguageName(language);
  return `## Output
Return a JSON array of PlanNode objects. No extra text. JSON keys must be in English. Write "action" values in ${lang}. Keep "location", "type", "skill", "nodeId", IDs, and enum values in English.

### Fields
\`\`\`json
{
  "nodeId": "unique-id",
  "startTime": "HH:MM",
  "endTime": "HH:MM",
  "action": "description of what you do (in ${lang})",
  "location": "exact location name from Places You Know (English)",
  "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
  "skill": "OMIT if no skill check needed, otherwise exact skill name (English)",
  "impact": "Default 0. Use 1 only for targeted consequential actions with skill; 2+ for broader effects"
}
\`\`\`

Add type-specific fields as documented in the Node Type Reference above.`;
}

export function buildDetailedNodesPrompt(
  params: DetailedNodesParams
): PromptParts {
  const todayPlan = JSON.stringify(params.todayPlan, null, 2);

  const systemPrompt = `You are an NPC character in a Call of Cthulhu tabletop RPG.

## Task
Look at your full plan for today and what has already happened. First decide which plan step is the next one you should actually do now. Then break only that next step into concrete action nodes.

Do not expand the whole day. Do not repeat plan steps that your memory log already shows as completed, interrupted, cancelled, or no longer relevant.

If the next step is not at your current location, emit a movement node first (set location to the destination), then emit the action node. Movement does not need to be broken into segments — one movement node will take you directly to the destination regardless of distance.
Use only the exact destination name itself in \`location\`; do not include topology notes or any explanatory suffix.

${TWENTY_FOUR_HOUR_TIME_GUIDANCE}

## How To Choose The Next Step
- Use "Your Plan For Today" as the source of truth for the intended sequence.
- **Carefully read "What Happened Today So Far"** to understand what you have already done, what outcomes occurred, and what the current situation is. Use this to:
  - Judge which planned steps are already done, blocked, disrupted, or no longer necessary.
  - Avoid generating actions that duplicate, repeat, or contradict what you already accomplished (e.g., if you already hid your notebook, do not generate another "hide notebook" action).
  - Build on completed actions — your next steps should logically follow from what has already happened, not ignore it.
- Choose exactly one next plan step to execute now.
- If all meaningful plan steps are already done, return an empty JSON array.

## Node Quality
- Each node must be **one coherent, continuous action** — something the character does from start to finish without interruption. If two actions naturally flow together as one activity, keep them in one node.
- Do NOT generate trivial micro-actions such as "close a page", "adjust posture", "glance around" as standalone nodes. These can be mentioned within a larger action's description but should not be their own node.
- If a single logical activity can be described in one node, do not split it into multiple tiny steps.

## Action Continuity
- Generated nodes must form a **logical, coherent sequence**. Each action should naturally follow from the previous one — consider physical location, time flow, and narrative causality.
- If the previous action ended at a specific location or produced a specific outcome, the next action must acknowledge and build on that context rather than ignoring it.
- Avoid abrupt, unexplained jumps between unrelated activities. If a transition is needed (e.g., finishing a conversation then moving to a new task), ensure the sequence reads as a believable chain of behavior for this character.
- Think about what a real person would do next given what just happened, where they are, and what they were trying to accomplish.

## Skill Checks
You can use a skill to accomplish an action. Pick from "Available Skills" only when the action is difficult or uses a non-routine method. Omit it for straightforward actions.

${params.handlerPrompt || DEFAULT_DETAILED_NODE_TYPE_REF}

${DEFAULT_NODE_GUARDRAILS_PROMPT}

${params.planningPrompt || ""}

${params.outputSchemaPrompt || defaultDetailedOutputSchema(params.language)}`;

  const userPrompt = `## Places You Know
${params.sceneMap || "No map available."}

## Right Now
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

${params.sceneConnections ? `## Exits & Passages\n${params.sceneConnections}\n\n` : ""}${params.buildingContext ? `## Other Rooms In This Building\n${params.buildingContext}\n` : ""}## Where You Are
${params.sceneDescription || "No description available."}

## Conditions Here
${params.sceneConditions || "Nothing unusual."}

${params.worldStatePrompt || ""}

## Items You Can See
${params.sceneItems || "Nothing here."}

## People Present
${params.sceneNpcs || "You're alone."}

## What You're Carrying
${params.npcInventory || "Nothing."}

`;

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

export function buildReviseSchedulePrompt(
  params: ReviseScheduleParams
): PromptParts {
  const systemPrompt = `You are an NPC character in a Call of Cthulhu tabletop RPG.

## Task
Something significant just happened. Look at your remaining plans for today and decide: do you need to change anything?

Think about how this event affects your goals and your safety. Adjust your schedule if needed — you can change plans, add new ones, drop old ones, or rearrange the order. If the event doesn't really affect your plans, leave them as they are.

## Instructions
- Only change what the event actually affects. Don't rewrite plans that are still fine.
- Keep the same format: each entry has "location", "activity". Order matters.
- Use exact location names from "Places You Know" for the location field.
- If this event fundamentally changes what you're trying to accomplish, update your long-term goal too.
- Treat the current time as 24-hour clock time.

## Output
Return a single JSON object. No extra text. JSON keys must be in English. Write "activity" and "updatedLongTermIntent" values in ${contentLanguageName(params.language)}. Keep "location" as the exact English location name.

\`\`\`json
{
  "revisedSchedule": [
    { "location": "exact location name from Places You Know", "activity": "what you will do" }
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
  interruptedNode?: string;
  triggerDescription: string;
  currentLocation: string;
  currentPositionDetail: string;
  sceneMap: string;
  sceneDescription: string;
  sceneItems: string;
  sceneNpcs: string;
  sceneConditions: string;
  buildingContext?: string;
  worldStatePrompt: string;
  npcInventory: string;
  currentTime: string;
  gameDay: number;
  language: string;
  handlerPrompt?: string;
  planningPrompt?: string;
  outputSchemaPrompt?: string;
  failureReason?: string;
  failureOutcome?: string;
  blockedReason?: string;
}

function revisePlansOutputSchema(language: string): string {
  const lang = contentLanguageName(language);
  return `## Output
Return a single JSON object with a "revisedNodes" array. No extra text. JSON keys must be in English. Write "action" and "updatedLongTermIntent" values in ${lang}. Keep "location", "type", "skill", "nodeId", IDs, and enum values in English.

IMPORTANT: "revisedNodes" MUST be an array of PlanNode objects — even if there is only one node, wrap it in an array.
IMPORTANT: "revisedNodes" must cover only the current phase of action from right now, not the whole day.

\`\`\`json
{
  "revisedNodes": [
    {
      "nodeId": "unique-id",
      "startTime": "HH:MM",
      "endTime": "HH:MM",
      "action": "description of what you do (in ${lang})",
      "location": "exact location name from Places You Know (English)",
      "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
      "impact": "Default 0. Use 1 only for targeted consequential actions with skill; 2+ for broader effects"
    }
  ],
  "shouldUpdateLongTermIntent": false,
  "updatedLongTermIntent": "only if shouldUpdateLongTermIntent is true"
}
\`\`\``;
}

export function buildRevisePlansPrompt(params: RevisePlansParams): PromptParts {
  const todayPlan = JSON.stringify(params.todayPlan, null, 2);

  const systemPrompt = `You are an NPC character in a Call of Cthulhu tabletop RPG.

## Task
Something just disrupted your plans. Look at what you were about to do right now and decide how to adjust the current phase of action.

You can reorder, change, add, or drop actions within this immediate phase. If this event fundamentally changes what you're trying to accomplish long-term, say so.

Set each node's \`location\` to the exact location name from "Places You Know" where that action happens. If the next step is not at your current location, include movement nodes first.
Do not include topology notes, residents, or label prefixes in \`location\`; output only the exact place name.

## Instructions
- Only change what the event actually affects. Don't rewrite actions that are still fine.
- Revise only the current phase or immediate next step from right now.
- Generate only short-horizon actionable nodes for what you do next.
- Do not expand the rest of the day into detailed nodes unless it is the last step of the current phase.
- Do not generate distant later-day activities.
- Treat the current time as 24-hour clock time.
- **Carefully read "Relevant Memories / Recent Context"** to understand what you have already done today. Do NOT generate actions that duplicate or repeat completed actions (e.g., if you already stashed your notebook, do not generate another "stash notebook" node).
- Each revised node must be **one coherent, continuous action** — something the character does from start to finish without interruption. If two actions naturally flow together as one activity, keep them in one node.
- Do not create trivial micro-actions (e.g., "adjust posture", "close a page", "glance around") as standalone nodes. Fold minor details into the description of a larger action instead.

## Action Continuity
- Revised nodes must form a **logical, coherent sequence**. Each action should naturally follow from the previous one — consider physical location, time flow, and narrative causality.
- The first revised node must be a believable reaction to the interruption, acknowledging what just happened rather than ignoring it.
- Avoid abrupt, unexplained jumps between unrelated activities. The revised plan should read as a natural continuation of the character's behavior given the disruption.
- Think about what a real person would do next given what just happened, where they are, and what they were trying to accomplish.

## Skill Checks
You can use a skill to accomplish an action. Pick from "Available Skills". Omit for everyday actions. Normal conversations, greetings, and routine social interactions do NOT need skills — only use skills for unconventional actions like coercion, seduction, deception, or intimidation.

${params.handlerPrompt || DEFAULT_DETAILED_NODE_TYPE_REF}

${DEFAULT_NODE_GUARDRAILS_PROMPT}

${params.planningPrompt || ""}

${params.outputSchemaPrompt || revisePlansOutputSchema(params.language)}`;

  const userPrompt = `## Places You Know
${params.sceneMap || "No map available."}

## Right Now
Day ${params.gameDay}, ${params.currentTime}

## Character: ${params.npcName} (${params.npcId})

## Who You Are
${params.npcProfile}

## Your Goal
${params.longTermIntent}

## What Just Happened
${params.triggerDescription}

${
  params.failureReason || params.failureOutcome || params.blockedReason
    ? `## Why The Last Action Failed
- Engine failure reason: ${params.failureReason || "unknown"}
- Detailed outcome: ${params.failureOutcome || "No detailed outcome provided."}
${params.blockedReason ? `- Blocked reason: ${params.blockedReason}` : ""}`
    : ""
}

## Your Plan For Today
${todayPlan}

## Relevant Memories / Recent Context
${params.memoryLog || "Nothing recorded yet."}

${
  params.interruptedNode
    ? `## Action Being Interrupted
You were in the middle of this action when the disruption occurred. It is now cancelled — you must account for it in your revised plan.
${params.interruptedNode}

`
    : ""
}## Your Pending Actions
${params.pendingNodes}

## Your Current Location
${params.currentLocation || "Unknown"}

## Your Exact Position
${params.currentPositionDetail || "Unknown."}

${params.buildingContext ? `## Other Rooms In This Building\n${params.buildingContext}\n` : ""}## Where You Are
${params.sceneDescription || "No description available."}

## Conditions Here
${params.sceneConditions || "Nothing unusual."}

${params.worldStatePrompt || ""}

## Items You Can See
${params.sceneItems || "Nothing here."}

## People Present
${params.sceneNpcs || "You're alone."}

## What You're Carrying
${params.npcInventory || "Nothing."}

`;

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
Something just happened involving you or around you. Think about what you perceived and how it affects you.

Decide:
1. Should you change what you're doing **right now**? (shouldRevise)
2. Should you change your **plans for the rest of the day**? (shouldReviseSchedule)

## Instructions
- Write a brief note about what you perceived and how you feel about it.
- shouldRevise=true ONLY when the event directly threatens your current plan's success or your personal safety:
  - Your current action is materially blocked or impossible to continue
  - You are in physical danger or your sanity is at risk
  - A critical opportunity or threat demands an immediate change in action
  - Someone you need for your plan has left, been incapacitated, or turned hostile
- shouldRevise=false for everything else:
  - Someone entering or leaving the room is NOT a reason to revise unless it directly blocks your plan
  - Casual encounters, background noise, overhearing conversation, minor curiosity
  - Events that are interesting but don't affect what you're currently doing
  - Seeing colleagues or acquaintances nearby — this is normal, not disruptive
- shouldReviseSchedule=true ONLY if the event makes your rest-of-day plans impossible or pointless (e.g., a destination destroyed, a key person arrested, a critical deadline moved).
- A brief interruption or local distraction is never enough to change the rest-of-day schedule.

## Output
Return a single JSON object. No extra text. JSON keys must be in English. Write "witnessEntry" in ${contentLanguageName(params.language)}.

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

export function buildRelationshipUpdatePrompt(
  params: RelationshipUpdateParams
): string {
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
Return a single JSON object. No extra text. JSON keys must be in English. Write "note" in ${contentLanguageName(params.language)}.

\`\`\`json
{
  "scoreDelta": 0,
  "note": "Updated relationship description reflecting current state."
}
\`\`\``;
}
