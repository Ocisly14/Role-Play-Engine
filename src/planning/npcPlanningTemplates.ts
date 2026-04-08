import type { ScheduleEntry } from "./types.js";

// ===================== Shared Type =====================

export interface PromptParts {
  systemPrompt: string;
  userPrompt: string;
}

function contentLanguageName(language: string): string {
  return language?.startsWith("zh") ? "Chinese" : "English";
}

// ===================== Daily Schedule (Layer 1 — coarse) =====================

export interface DailyScheduleParams {
  npcName: string;
  npcId: string;
  npcProfile: string;
  longTermIntent: string;
  relationships: string;
  townMap: string;
  yourLocation: string;
  scenarioConditions: string;
  /** Filtered world state: weather, nearby fires, NPC fatigue/sanity */
  worldStatePrompt: string;
  gameDay: number;
  currentTime: string;
  language: string;
  /** Ranked memory context from unified memory system */
  memoryContext?: string;
  /** Module background: era, location, technology level, atmosphere */
  moduleBackground?: string;
}

export function buildDailySchedulePrompt(
  params: DailyScheduleParams
): PromptParts {
  const systemPrompt = `You are a character living in a simulated world. Act as a real person would.
${params.moduleBackground ? `\n## Setting\n${params.moduleBackground}\n` : ""}
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
  { "location": "Public Library", "activity": "Look up old newspaper clippings about the missing person case" }
]
\`\`\`

Each entry has exactly two fields:
- \`"location"\`: exact location name from "Places You Know" (always English)
- \`"activity"\`: one sentence — what you intend to do there (in ${contentLanguageName(params.language)})`;

  const userPrompt = `## Your Location
${params.yourLocation}

## Places You Know
${params.townMap || "No map available."}

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
  yourLocation: string;
  townMap: string;
  sceneDescription: string;
  sceneItems: string;
  sceneNpcs: string;
  sceneConditions: string;
  /** Formatted connections from the current scene (e.g. "通往卧室的走廊") */
  sceneConnections?: string;
  /** Filtered world state: weather, fire, fatigue, sanity etc. */
  worldStatePrompt: string;
  npcInventory: string;
  currentTime: string;
  gameDay: number;
  language: string;
  handlerPrompt?: string;
  planningPrompt?: string;
  outputSchemaPrompt?: string;
  /** Module background: era, location, technology level, atmosphere */
  moduleBackground?: string;
  /** The NPC's current short-term focus (null when starting a new schedule entry) */
  shortTermIntent?: string | null;
  /** Outcome text from the previous completed/failed/interrupted node */
  lastActionOutcome?: string;
}

const TWENTY_FOUR_HOUR_TIME_GUIDANCE = `## Time Semantics
- All times use a 24-hour clock in \`HH:MM\` format.`;

const DEFAULT_NODE_GUARDRAILS_PROMPT = `## Planning Guardrails
- You can only interact with items, characters, and the environment in your **current scene**. To act in a different scene (including other scenes in the same building), emit a movement node to that scene first, then your action node. The only exception is when the action itself directly displaces you as a side effect, such as jumping out a window or diving through an opening.
- For movement nodes, set \`destination\` to the exact scene or place name from "Places You Know". Non-movement nodes execute at your current position — do not specify \`destination\`.
- For object interactions, you may only target items that already appear in \`Items You Can See\` or \`What You're Carrying\`.
- Do not invent new documents, copies, notes, printouts, receipts, witness copies, or memo variants unless they already exist in the scene, inventory, or prior action history.
- **Respect objective reality:** Your actions must be consistent with the physical conditions listed in "World Conditions" and the events recorded in "What Happened Today So Far". If you are detained, restrained, bound, or otherwise physically constrained, you cannot freely move, interact with objects, or leave — unless your action is specifically aimed at escaping or resolving the constraint (e.g., breaking free, persuading a captor to release you). Likewise, do not plan actions that contradict established facts from your memory log.`;

const DEFAULT_DETAILED_NODE_TYPE_REF = `## Node Type Reference

- **"action"**: A current-location action performed in your present scene. Use this for quiet self-directed behavior AND environment-facing actions in the same scene: waiting, thinking, eating, resting, watching, searching the room, investigating the surroundings, drawing curtains, barring a door, turning off the lights, hiding in place, etc. An LLM resolver determines any scene changes, partial outcomes, memories, and fatigue impact after the action resolves.

  An "action" may also end with incidental self-movement when the action itself physically throws or carries you into a nearby location as a side effect, such as jumping out a window into a courtyard or diving through a newly opened passage. Do NOT use "action" for ordinary travel.

  If your action involves:
  - Moving/hiding/using/modifying a physical item → use "object_interaction"
  - Talking to, persuading, threatening, or observing (with a skill) another character → use "character_interaction"
  - Going to a different location on purpose, such as walking to the courtyard or heading upstairs → use "movement"

- **"movement"**: Move to a destination. Set \`destination\` to the exact destination name from "Places You Know". This is the ONLY type that uses the \`destination\` field.
- **"character_interaction"**: Interact with one or more characters. This includes any action that uses a skill targeting another character (e.g., Spot Hidden to observe someone, Psychology to read them, Persuade to convince them).
  - Describe what you do entirely in \`action\`.
  - Put all targets in top-level \`targetCharacterIds\`.
  - For single-target interactions, \`targetCharacterIds\` should still be an array with one ID.
- **"object_interaction"**: Interact with a physical object — pick up, hide, move, use, combine, lock, unlock, destroy, etc. Describe what you do in \`action\`. Set \`objectInteractionPayload.itemId\` to the primary item. An LLM resolver handles all state changes.

## Skill Checks (Call of Cthulhu 7e Rules)

The engine resolves skill rolls mechanically. A skill roll is called ONLY when:
1. The outcome is **genuinely uncertain** for someone with this character's ability
2. Failure has **meaningful consequences** (danger, lost time, alerting enemies, missing information, psychological harm)

**Do NOT use a skill when:**
- The task is trivially easy for a competent person (opening an unlocked door, reading a sign, walking down a street, picking up an object in plain sight)
- Failure would have no interesting consequence ("nothing happens" is not a stake)
- The outcome is a foregone conclusion (attacking a sleeping person, entering an empty unlocked room)

**DO use a skill when:**
- There is opposition or resistance (another character resists, a lock is locked, information is hidden)
- There is danger or time pressure (even a routine task becomes roll-worthy under stress or pursuit)
- The character is attempting something deceptive, forceful, or creative beyond normal capability

**Skill use determines node type:**
- Action with NO skill → type is usually "action"
- Skill targeting a **person** (Spot Hidden to observe, Psychology to read, Persuade to convince, Intimidate to threaten) → "character_interaction" with targetCharacterIds
- Skill targeting an **object** (Locksmith to pick a lock, Mechanical Repair to fix something, Sleight of Hand to hide an item) → "object_interaction"
- Skill targeting the **environment** (Spot Hidden to search a room, Track to follow footprints, Navigate to find a path) → "action"

**Social interactions:**
- Normal conversation, greetings, small talk, sharing information → NO skill, use "character_interaction" only if it meaningfully affects the target
- Coercion, seduction, deception, intimidation, extracting secrets, convincing someone to act against their interest → USE skill (Charm/Persuade/Intimidate/Fast Talk), type "character_interaction"

**Difficulty:**
- "regular" (roll ≤ skill value): Standard challenge — vast majority of rolls
- "hard" (roll ≤ skill/2): Exceptionally difficult, would challenge a professional
- "extreme" (roll ≤ skill/5): Borders of human capability — very rare

- If you include \`"skill"\`, it must be an exact name from "Available Skills". Never invent generic labels such as \`social\`, \`professional\`, or \`exploration\`.
- Before choosing a skill for an object action, inspect the injected item state first (locked/unlocked, damaged, uses, lit/unlit, ammo, etc.) and choose a normal action if the state already makes it possible.
- For object movement, only reference items that already appear in \`Items You Can See\` or \`What You're Carrying\`. Do not invent new intermediate objects such as printouts unless a previous action has already created them.
- Use \`move\` when the item is simply changing where it is. Do not split same-scene relocation into artificial \`pickup\` then \`place\` steps.

## Available Skills
\${COC_SKILL_LIST_PROMPT}`;

function defaultDetailedOutputSchema(language: string): string {
  const lang = contentLanguageName(language);
  return `## Output
Return a single JSON object. No extra text. JSON keys must be in English. Write "action" values in ${lang}. Keep "destination", "type", "skill", IDs, and enum values in English.

\`\`\`json
{
  "node": {
    "startTime": "HH:MM",
    "endTime": "HH:MM",
    "action": "description of what you do (in ${lang})",
    "destination": "ONLY for movement — exact destination from Places You Know (English). Omit for other types.",
    "type": "action|movement|character_interaction|object_interaction",
    "skill": "OMIT if no skill check needed, otherwise exact skill name (English)"
  },
  "updatedShortTermIntent": "optional — update your current focus if it changed based on what happened"
}
\`\`\`

Add type-specific fields to \`node\` as documented in the Node Type Reference above.

- \`updatedShortTermIntent\`: set this if your focus has shifted (e.g., you finished what you were doing and are moving on, or something unexpected changed your plan). Omit if your focus hasn't changed.`;
}

export function buildDetailedNodesPrompt(
  params: DetailedNodesParams
): PromptParts {
  const todayPlan = JSON.stringify(params.todayPlan, null, 2);

  const systemPrompt = `You are a character living in a simulated world. Act as a real person would.
${params.moduleBackground ? `\n## Setting\n${params.moduleBackground}\n` : ""}
## Task
Look at your current focus, your plan for today, and what has already happened. Decide your **one** next action.

If your next action is not at your current location, emit a movement node (set destination to the destination). Movement does not need to be broken into segments — one movement node will take you directly to the destination regardless of distance.
Use only the exact destination name itself in \`destination\`; do not include topology notes or any explanatory suffix.

${TWENTY_FOUR_HOUR_TIME_GUIDANCE}

## How To Choose Your Next Action
- Use "Your Current Focus" as your immediate guide for what you're trying to accomplish.
- Use "Your Plan For Today" as the source of truth for the intended sequence.
- **Carefully read "What Happened Today So Far"** and "Last Action Result" to understand what you have already done, what outcomes occurred, and what the current situation is. Use this to:
  - Judge which planned steps are already done, blocked, disrupted, or no longer necessary.
  - Avoid generating actions that duplicate, repeat, or contradict what you already accomplished (e.g., if you already hid your notebook, do not generate another "hide notebook" action).
  - Build on completed actions — your next action should logically follow from what has already happened, not ignore it.

## Node Quality — Atomic Actions

Your node must be **one atomic action** — a single, physically continuous activity with one verb and one target.

**What is NOT a separate node:**
- Trivial micro-actions embedded in a larger action (adjusting posture, glancing around)
- Natural continuation of the same physical activity (opening a drawer and reaching inside)
- Actions that cannot produce an independent outcome (unlocking a lock is part of opening a container)

## Action Continuity
- Your action should naturally follow from what just happened.
- Think: what would a real person do next given where they are and what just happened?

${params.handlerPrompt || DEFAULT_DETAILED_NODE_TYPE_REF}

${DEFAULT_NODE_GUARDRAILS_PROMPT}

${params.planningPrompt || ""}

${params.outputSchemaPrompt || defaultDetailedOutputSchema(params.language)}
`;

  const userPrompt = `## Right Now
Day ${params.gameDay}, ${params.currentTime}

## Character: ${params.npcName} (${params.npcId})

## Who You Are
${params.npcProfile}

## Your Goal
${params.longTermIntent}

## Your Current Focus
${params.shortTermIntent || "Starting a new phase."}

## Your Plan For Today
${todayPlan}

## What Happened Today So Far
${params.memoryLog || "Nothing recorded yet."}

## Last Action Result
${params.lastActionOutcome || "No previous action."}

## Your Location
${params.yourLocation || "Unknown"}

## Places You Know
${params.townMap || "No map available."}

${params.sceneConnections ? `## Exits & Passages\n${params.sceneConnections}\n\n` : ""}## Where You Are
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
  townMap: string;
  yourLocation: string;
  scenarioConditions: string;
  worldStatePrompt: string;
  remainingSchedule: string;
  triggerDescription: string;
  gameDay: number;
  currentTime: string;
  language: string;
  /** Module background: era, location, technology level, atmosphere */
  moduleBackground?: string;
}

export function buildReviseSchedulePrompt(
  params: ReviseScheduleParams
): PromptParts {
  const systemPrompt = `You are a character living in a simulated world. Act as a real person would.
${params.moduleBackground ? `\n## Setting\n${params.moduleBackground}\n` : ""}
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

  const userPrompt = `## Your Location
${params.yourLocation}

## Places You Know
${params.townMap || "No map available."}

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
    shortTermIntent?: string;
  };
  language: string;
  /** Module background: era, location, technology level, atmosphere */
  moduleBackground?: string;
}

export function buildImpactGatePrompt(params: ImpactGateParams): PromptParts {
  const c = params.candidate;

  const memorySection = c.memoryContext
    ? `\n## Relevant Memories\n${c.memoryContext}\n`
    : "";

  const systemPrompt = `You are a character living in a simulated world. Act as a real person would.
${params.moduleBackground ? `\n## Setting\n${params.moduleBackground}\n` : ""}
## Task
Something just happened involving you or around you. Think about what you perceived and how it affects you.

Decide:
1. Should you update what you're focused on? (shouldUpdateIntent)
2. Should you stop what you're doing right now and react immediately? (shouldInterruptCurrentNode)
3. Should you change your **plans for the rest of the day**? (shouldReviseSchedule)

## Instructions
- Write a brief note (1-2 sentences) about what you perceived and how you feel about it. This is a memory record of your perception and inner reaction only — do NOT describe any actions you take or plan to take.
- shouldUpdateIntent=true when the event changes your priorities or what you're focused on:
  - New information shifts what you care about or what you should be doing next
  - An opportunity or threat reframes your immediate goals
  - What you were focused on is no longer relevant or has been superseded
- shouldUpdateIntent=false for everything else:
  - The event is interesting but doesn't change what you're trying to accomplish
  - Minor distractions, background events, casual encounters
- shouldInterruptCurrentNode=true ONLY when you need to physically stop your current action and do something else immediately:
  - You are in physical danger or your sanity is at risk
  - Your current action is materially blocked or impossible to continue
  - A critical opportunity or threat demands an immediate change in action
  - Someone you need for your plan has left, been incapacitated, or turned hostile
- shouldInterruptCurrentNode=false for everything else:
  - Someone entering or leaving the room is NOT a reason to interrupt unless it directly blocks your action
  - Casual encounters, background noise, overhearing conversation, minor curiosity
  - Events that are interesting but don't prevent what you're currently doing
  - Seeing colleagues or acquaintances nearby — this is normal, not disruptive
- shouldReviseSchedule=true ONLY if the event makes your rest-of-day plans impossible or pointless (e.g., a destination destroyed, a key person arrested, a critical deadline moved).
- A brief interruption or local distraction is never enough to change the rest-of-day schedule.

## Output
Return a single JSON object. No extra text. JSON keys must be in English. Write "witnessEntry" in ${contentLanguageName(params.language)}.

\`\`\`json
{
  "shouldUpdateIntent": false,
  "updatedIntent": "only if shouldUpdateIntent is true — your new focus",
  "shouldInterruptCurrentNode": false,
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
- What you're focused on: ${c.shortTermIntent || "No specific focus."}
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
  return `You are the narrator of a simulated world.

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
