# NPC Prompt Cache Optimization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch to OpenAI (gpt-5-mini) and restructure NPC planning prompts for automatic prefix caching (90% cost reduction on shared content).

**Architecture:** Split 6 build*Prompt functions into `{ systemPrompt, userPrompt }` return type. System prompt = static instructions (identical across all NPC calls). User prompt = shared world context first (cached prefix), NPC-specific content last. Impact gate uses batch call (N NPCs → 1 LLM call).

**Tech Stack:** TypeScript, OpenAI gpt-5-mini, existing generateText abstraction with customSystemPrompt support.

**Spec:** `docs/superpowers/specs/2026-03-12-npc-prompt-cache-optimization-design.md`

---

## Chunk 1: Type Definitions & Template Restructuring

### Task 1: Add PromptParts type

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts:1-2`

- [ ] **Step 1: Add PromptParts interface after the ScheduleEntry import**

```typescript
export interface PromptParts {
  systemPrompt: string;
  userPrompt: string;
}
```

- [ ] **Step 2: Run build**

Run: `pnpm build`
Expected: Success (new type is exported but unused yet)

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts
git commit -m "feat: add PromptParts type for cache-optimized prompt splitting"
```

---

### Task 2: Restructure buildDailySchedulePrompt (Layer 1)

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts:132-188`

- [ ] **Step 1: Change return type and split content**

Change `): string {` to `): PromptParts {`

**systemPrompt** (static instructions — identical for all NPCs):
```
You are an NPC character in a tabletop horror RPG tabletop RPG.

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

```json
[
  { "location": "home_kitchen", "activity": "Have breakfast and review notes from yesterday" },
  { "location": "library_main", "activity": "Search the archives for information about the ritual" }
]
```

Each entry has exactly two fields:
- "location": scene ID — where you need to go for this activity
- "activity": one sentence — what you intend to do there
```

**userPrompt** (shared world context FIRST, NPC-specific LAST):
```
## Places You Know
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
```

- [ ] **Step 2: Run build**

Run: `pnpm build`
Expected: Errors in NPCPlanningAgent.ts (caller expects string, gets PromptParts). Expected at this stage.

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts
git commit -m "feat: restructure buildDailySchedulePrompt for prefix caching"
```

---

### Task 3: Restructure buildDetailedNodesPrompt (Layer 2)

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts:251-314`

- [ ] **Step 1: Change return type and split content**

Change `): string {` to `): PromptParts {`

**systemPrompt** (static — includes handler/feature prompts, ~800-1200 tokens):
```
You are an NPC character in a tabletop horror RPG tabletop RPG.

## Task
Look at your full plan for today and what has already happened. First decide which plan step is the next one you should actually do now. Then break only that next step into concrete action nodes.

Do not expand the whole day. Do not repeat plan steps that your memory log already shows as completed, interrupted, cancelled, or no longer relevant.

Set each node's `location` to the scene where that action happens. If the next step is not at your current location, include movement nodes first. Cross-location travel is handled automatically.

## How To Choose The Next Step
- Use "Your Plan For Today" as the source of truth for the intended sequence.
- Use "What Happened Today So Far" to judge which planned steps are already done, blocked, disrupted, or no longer necessary.
- Choose exactly one next plan step to execute now.
- If all meaningful plan steps are already done, return an empty JSON array.

## When Your Actions Need a Skill Check
- Everyday activities, simple movement, friendly conversation → no actionType (auto-succeed)
- Searching for hidden things, persuading reluctant people, sneaking, fighting → set actionType

${params.handlerPrompt || DEFAULT_DETAILED_NODE_TYPE_REF}

${params.planningPrompt || ""}

${params.outputSchemaPrompt || DEFAULT_DETAILED_OUTPUT_SCHEMA}
```

**userPrompt** (shared prefix minimal, then NPC-specific):
```
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
${params.npcInventory || "Nothing."}
```

Note: For Layer 2, the system prompt is already ~800-1200 tokens (includes handler/feature prompts). This alone exceeds the 1024 threshold. The user prompt has minimal shared content since scene context varies by NPC location.

- [ ] **Step 2: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts
git commit -m "feat: restructure buildDetailedNodesPrompt for prefix caching"
```

---

### Task 4: Restructure buildReviseSchedulePrompt (Layer 1 revision)

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts:336-392`

- [ ] **Step 1: Change return type and split content**

Same pattern as Layer 1. System prompt = task + revision rules + output format. User prompt = shared world context first, NPC-specific + trigger last.

**systemPrompt:**
```
You are an NPC character in a tabletop horror RPG tabletop RPG.

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

```json
{
  "revisedSchedule": [
    { "location": "scene_id", "activity": "what you will do" }
  ],
  "shouldUpdateLongTermIntent": false,
  "updatedLongTermIntent": "only if shouldUpdateLongTermIntent is true"
}
```
```

**userPrompt:**
```
## Places You Know
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
${params.remainingSchedule}
```

- [ ] **Step 2: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts
git commit -m "feat: restructure buildReviseSchedulePrompt for prefix caching"
```

---

### Task 5: Restructure buildRevisePlansPrompt (Layer 2 revision)

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts:431-499`

- [ ] **Step 1: Change return type and split content**

Same pattern as Layer 2. System prompt = task + revision rules + handler/schema prompts.

**systemPrompt:**
```
You are an NPC character in a tabletop horror RPG tabletop RPG.

## Task
Something just disrupted your plans. Look at what you were about to do and decide how to adjust.

You can reorder, change, add, or drop actions. If this event fundamentally changes what you're trying to accomplish long-term, say so.

Set each node's `location` to the scene where that action happens. If the next step is not at your current location, include movement nodes first.

## Instructions
- Only change what the event actually affects. Don't rewrite actions that are still fine.
- You may reorder, change, add, or drop actions.

## When Your Actions Need a Skill Check
- Everyday activities, simple movement, friendly conversation → no actionType (auto-succeed)
- Searching for hidden things, persuading reluctant people, sneaking, fighting → set actionType

${params.handlerPrompt || DEFAULT_DETAILED_NODE_TYPE_REF}

${params.planningPrompt || ""}

${params.outputSchemaPrompt || REVISE_PLANS_OUTPUT_SCHEMA}
```

**userPrompt:**
```
## Right Now
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
${params.npcInventory || "Nothing."}
```

- [ ] **Step 2: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts
git commit -m "feat: restructure buildRevisePlansPrompt for prefix caching"
```

---

### Task 6: Restructure buildSummarizeDayMemoryPrompt

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts:15-75`

- [ ] **Step 1: Change return type and split content**

Low cache value but split for consistency. System prompt = task instructions + output format. User prompt = all NPC-specific.

**systemPrompt:**
```
You are an NPC character in a tabletop horror RPG tabletop RPG.

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
- For things you observed or deduced yourself, generate a new ID
- Do NOT include knowledge you already have (check "Your Existing Knowledge IDs")
- **category**: "knowledge" for facts and information, "secret" for things you want to keep hidden
- **difficulty**: How hard it would be for someone to extract this from you — "automatic", "regular", "hard", "extreme"
- **relatedTo**: Array of related IDs (optional, omit if unclear)

## Output
Return a JSON object. No extra text. Always write in English.

```json
{
  "memories": [
    { "content": "One concise sentence about what happened.", "importance": 3 }
  ],
  "newKnowledge": [
    { "id": "knowledge_id", "text": "what you learned", "category": "knowledge", "difficulty": "regular", "relatedTo": ["T1"] }
  ]
}
```
```

**userPrompt:**
```
## Day ${params.gameDay}

## Who You Are
${params.npcProfile}

## Your Existing Knowledge IDs
${existingIds}

## Today's Events
${params.eventLog}

## Knowledge Received Today
${receivedSection}
```

Note: The `npcName` reference in "generate a new ID (e.g. learned_day${gameDay}_1)" moves into the system prompt as a generic example. The `gameDay` variable in the system prompt can use a placeholder since the actual day number is in the user prompt.

- [ ] **Step 2: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts
git commit -m "feat: restructure buildSummarizeDayMemoryPrompt for prefix caching"
```

---

### Task 7: Add buildBatchImpactGatePrompt

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts` (add near existing impact gate, ~line 501)

- [ ] **Step 1: Add types and function**

```typescript
export interface BatchImpactGateCandidate {
  npcId: string;
  npcName: string;
  currentLocation: string;
  longTermIntent: string;
  todayScheduleSummary: string;
  currentDetailedPlan: string;
}

export interface BatchImpactGateParams {
  triggeringEvents: string;
  bucketTime: string;
  candidates: BatchImpactGateCandidate[];
  language: string;
}

export function buildBatchImpactGatePrompt(params: BatchImpactGateParams): PromptParts {
  const candidatesSections = params.candidates
    .map((c, i) => `### ${i + 1}. ${c.npcName} (${c.npcId})
location: ${c.currentLocation} | goal: ${c.longTermIntent} | today: ${c.todayScheduleSummary || "No schedule."} | doing: ${c.currentDetailedPlan || "Nothing planned."}`)
    .join("\n\n");

  const systemPrompt = `You are the Game Master for a tabletop horror RPG tabletop RPG.

## Task
Events just happened in the game world. For each affected character below, decide:
1. Should they change what they're doing right now? (shouldRevise)
2. Should they change their plans for the rest of the day? (shouldReviseSchedule)
3. Write a brief witness note about what they perceived.

## Instructions
- Set shouldRevise=true only if the events meaningfully affect what that character is doing right now.
- Set shouldReviseSchedule=true only if the events fundamentally change that character's plans for the rest of the day (e.g., a place they planned to visit was destroyed, someone they need to meet was arrested).
- Consider each character's location — they can only perceive events near them.

## Output
Return a JSON array with one entry per character. No extra text. Always write in English.

\`\`\`json
[
  { "npcId": "character_id", "shouldRevise": false, "shouldReviseSchedule": false, "witnessEntry": "Brief description of what they perceived." }
]
\`\`\``;

  const userPrompt = `## What Just Happened
${params.triggeringEvents}

## Right Now
${params.bucketTime}

## Affected Characters

${candidatesSections}`;

  return { systemPrompt, userPrompt };
}
```

- [ ] **Step 2: Keep old buildImpactGatePrompt** (mark as deprecated with comment, don't remove yet in case of external references)

- [ ] **Step 3: Run build, commit**

Run: `pnpm build`

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts
git commit -m "feat: add batch impact gate prompt and complete template restructuring"
```

---

## Chunk 2: Caller Adaptation & Integration

### Task 8: Update NPCPlanningAgent callers to use PromptParts

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts`

- [ ] **Step 1: Update imports**

Add `PromptParts`, `buildBatchImpactGatePrompt`, `BatchImpactGateCandidate` to imports from `./npcPlanningTemplates.js`.

- [ ] **Step 2: Update generateSingleNpcSchedule** (uses buildDailySchedulePrompt)

Change from:
```typescript
const prompt = buildDailySchedulePrompt({ ... });
const response = await generateText({ runtime: this.runtime, context: prompt, modelClass: ModelClass.SMALL });
```
To:
```typescript
const { systemPrompt, userPrompt } = buildDailySchedulePrompt({ ... });
const response = await generateText({ runtime: this.runtime, context: userPrompt, customSystemPrompt: systemPrompt, modelClass: ModelClass.SMALL });
```

- [ ] **Step 3: Update generateDetailedNodes** (uses buildDetailedNodesPrompt)

Same pattern as step 2.

- [ ] **Step 4: Update reviseSchedule** (uses buildReviseSchedulePrompt)

Same pattern as step 2.

- [ ] **Step 5: Update revisePlans** (uses buildRevisePlansPrompt)

Same pattern as step 2.

- [ ] **Step 6: Update summarizeDayMemory** (uses buildSummarizeDayMemoryPrompt)

Same pattern as step 2.

- [ ] **Step 7: Replace runImpactGateForNpc with runBatchImpactGate**

Remove `runImpactGateForNpc` method. Add:

```typescript
async runBatchImpactGate(
  candidates: BatchImpactGateCandidate[],
  triggeringEvents: string,
  bucketTime: string,
  language: string = "en"
): Promise<Array<{ npcId: string; shouldRevise: boolean; shouldReviseSchedule: boolean; witnessEntry: string }>> {
  if (candidates.length === 0) return [];

  const { systemPrompt, userPrompt } = buildBatchImpactGatePrompt({
    triggeringEvents,
    bucketTime,
    candidates,
    language,
  });

  const response = await generateText({
    runtime: this.runtime,
    context: userPrompt,
    customSystemPrompt: systemPrompt,
    modelClass: ModelClass.SMALL,
  });

  const parsed = parseJsonResponse<Array<{ npcId: string; shouldRevise: boolean; shouldReviseSchedule: boolean; witnessEntry: string }>>(response);

  // Ensure all candidates have results; default missing ones
  const resultMap = new Map(parsed.map(r => [r.npcId, r]));
  return candidates.map(c => {
    const result = resultMap.get(c.npcId);
    if (!result) {
      console.warn(`[NPCPlanning] Batch impact gate missing result for ${c.npcId}, defaulting to no revision`);
      return { npcId: c.npcId, shouldRevise: false, shouldReviseSchedule: false, witnessEntry: "" };
    }
    return result;
  });
}
```

- [ ] **Step 8: Run build (expect errors in tickProcessor and types.ts)**

Run: `pnpm build`

- [ ] **Step 9: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts
git commit -m "feat: adapt NPCPlanningAgent to PromptParts and batch impact gate"
```

---

### Task 9: Rewrite impact propagation in tickProcessor

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts:712-818`

- [ ] **Step 1: Add BatchImpactGateCandidate import**

Add to imports at top of file:
```typescript
import type { BatchImpactGateCandidate } from "./npcPlanningTemplates.js";
```

- [ ] **Step 2: Replace the per-NPC Promise.all block with batch pattern**

Replace the `if (characterEventsMap.size > 0) { await Promise.all(...) }` block with:

1. Build candidateMap: iterate `characterEventsMap`, for each NPC fetch pendingNodes, plan, schedule, longTermIntent. Store in `Map<npcId, { candidate, npcEvents, npc }>`.
2. Build union of triggering events (deduplicated).
3. Single `runBatchImpactGate` call.
4. Iterate results: for each NPC, write witness memory, lazily fetch reactionContext only if `shouldRevise`, call revisePlans/reviseSchedule/triggerReasoning as needed.

Key detail: `reactionContext` is fetched **lazily** — only for NPCs where `result.shouldRevise === true`. This avoids unnecessary memory retrieval for NPCs that don't need revision.

See the spec `tickProcessor.ts Changes` section for the detailed code pattern.

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: Errors in types.ts (NpcPlanningCapability still has old method)

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "feat: rewrite impact gate to batch pattern in tickProcessor"
```

---

### Task 10: Update NpcPlanningCapability interface and test mocks

**Files:**
- Modify: `src/dynamicworldagent/engine/types.ts:72-84`
- Modify: `src/dynamicworldagent/engine/features/__tests__/fireFeature.test.ts`
- Modify: `src/dynamicworldagent/engine/features/__tests__/lightingFeature.test.ts`
- Modify: `src/dynamicworldagent/engine/features/__tests__/staminaFeature.test.ts`
- Modify: `src/dynamicworldagent/engine/features/__tests__/weatherFeature.test.ts`
- Modify: `src/dynamicworldagent/engine/features/__tests__/sanityFeature.test.ts`

- [ ] **Step 1: Update NpcPlanningCapability interface in types.ts**

Replace `runImpactGateForNpc` with:

```typescript
runBatchImpactGate(
  candidates: Array<{
    npcId: string;
    npcName: string;
    currentLocation: string;
    longTermIntent: string;
    todayScheduleSummary: string;
    currentDetailedPlan: string;
  }>,
  triggeringEvents: string,
  bucketTime: string,
  language: string
): Promise<Array<{ npcId: string; shouldRevise: boolean; shouldReviseSchedule: boolean; witnessEntry: string }>>;
```

- [ ] **Step 2: Update all 5 test mocks**

In each test file, find `runImpactGateForNpc: async () => ...` and replace with:

```typescript
runBatchImpactGate: async () => [],
```

- [ ] **Step 3: Run build and tests**

Run: `pnpm build && pnpm test`
Expected: Build succeeds, all feature tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/engine/types.ts src/dynamicworldagent/engine/features/__tests__/
git commit -m "feat: update NpcPlanningCapability interface to batch impact gate"
```

---

### Task 11: Update .env for OpenAI

**Files:**
- Modify: `.env`

- [ ] **Step 1: Update model provider and model names**

```
MODEL_PROVIDER=openai
SMALL_OPENAI_MODEL=gpt-5-mini
MEDIUM_OPENAI_MODEL=gpt-5-mini
```

- [ ] **Step 2: Verify OPENAI_API_KEY is set**

- [ ] **Step 3: Final build + test**

Run: `pnpm build && pnpm test`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add .env
git commit -m "chore: switch to OpenAI gpt-5-mini for NPC planning"
```

---

## Verification

After all tasks:

1. `pnpm build` — no type errors
2. `pnpm test` — all feature tests pass
3. Manual test with multiple NPCs:
   - Layer 1 schedules generate correctly
   - Layer 2 detailed nodes generate correctly
   - Batch impact gate returns valid per-NPC results
   - Witness memory written for each affected NPC
   - `revisePlans` and `reviseSchedule` trigger correctly
4. Check OpenAI usage dashboard for `cached_tokens` in API responses
