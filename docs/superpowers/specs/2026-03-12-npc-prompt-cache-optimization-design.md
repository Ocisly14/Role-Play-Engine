# NPC Planning Prompt Cache Optimization

## Context

The NPC planning system makes multiple LLM calls per tick — one per NPC for each planning phase (Layer 1 schedule, Layer 2 detailed nodes, impact gate, revisions). With N NPCs, a single tick can generate 10-30+ LLM calls, most of which share significant overlapping content (world state, scene map, static instructions).

**Problem:** All shared content is re-sent and re-processed on every call, wasting tokens and cost.

**Solution:** Switch to OpenAI (gpt-5-mini) and restructure all NPC planning prompts to maximize automatic prefix caching. OpenAI caches request prefixes ≥ 1024 tokens at 90% discount with no code changes needed — just matching prefixes.

## Model Switch

Change `.env`:
```
MODEL_PROVIDER=openai
SMALL_OPENAI_MODEL=gpt-5-mini
MEDIUM_OPENAI_MODEL=gpt-5-mini
```

No code changes needed for the switch itself — `generateText()` already supports OpenAI via `MODEL_PROVIDER` env var.

## Design

### Return Type Change

The 6 high-frequency `build*Prompt` functions in `npcPlanningTemplates.ts` currently return `string`. They will return `PromptParts`.

**Excluded:** `buildGenerateLongTermIntentPrompt` (called once on init, low cache value) and `buildRelationshipUpdatePrompt` (both profiles unique per call, low cache value) remain as `string` return — no change needed.

Return type:

```typescript
interface PromptParts {
  systemPrompt: string;  // Static instructions + rules + output format
  userPrompt: string;    // Shared world context first, NPC-specific content last
}
```

Callers adapt to:
```typescript
const { systemPrompt, userPrompt } = buildXxxPrompt(params);
await generateText({
  runtime,
  context: userPrompt,
  customSystemPrompt: systemPrompt,
  modelClass: ModelClass.SMALL,
});
```

### Prompt Restructuring Principle

OpenAI auto-caches the longest matching prefix (system messages + beginning of user messages). Strategy:

```
┌─ System Prompt ────────────────────────────┐
│ Task description + rules + output format    │  ← Identical across ALL NPC calls
│ Handler/feature prompts (Layer 2 only)      │     of the same type. Always cached.
├─ User Prompt (prefix) ────────────────────┤
│ Shared world context:                       │  ← Same for all NPCs in one tick.
│   sceneMap, worldState, conditions, time    │     Auto-cached after first NPC call.
├─ User Prompt (suffix) ────────────────────┤
│ NPC-specific:                               │  ← Varies per NPC. Not cached.
│   profile, intent, memory, relationships    │
└─────────────────────────────────────────────┘
```

### Per-Prompt Breakdown

#### 1. Layer 1 — Daily Schedule (`buildDailySchedulePrompt`)

**System prompt** (~400 tokens):
- Task description ("Plan your day...")
- Planning rules ("How to Plan Your Day" section)
- Social interaction guidance
- Output format (JSON array of `{location, activity}`)

**User prompt — shared prefix** (~500-800 tokens):
- `## Places You Know` (sceneMap)
- `## Current Conditions Around You` (scenarioConditions)
- World state prompt (worldStatePrompt)
- `## Right Now` (Day X, HH:MM)

**User prompt — NPC-specific:**
- `## Character: {name} ({id})`
- `## Who You Are` (npcProfile)
- `## Your Goal` (longTermIntent)
- `## Your Memory` (memoryContext)
- `## People You Know` (relationships)

**Expected cache:** system (~400) + shared prefix (~500-800) = **~900-1200 tokens cached per NPC call** after the first.

#### 2. Layer 2 — Detailed Nodes (`buildDetailedNodesPrompt`)

**System prompt** (~800-1200 tokens):
- Task description ("Look at your plan, expand next step into action nodes...")
- Node Type Reference (routine, movement, character_interaction, etc.)
- ActionType reference
- Handler prompt (from registry)
- Planning prompt (from features)
- Output schema (PlanNode JSON format)

**User prompt — shared prefix** (~100-200 tokens):
- `## Right Now` (Day X, HH:MM)

**User prompt — NPC-specific:**
- Character ID, profile, goal
- Today's plan, memory log
- Current location, scene description, conditions, items, people, inventory

**Expected cache:** system prompt alone is ~800-1200 tokens, already near/above 1024 threshold. All NPC calls share this. Layer 2 has less shared user content since scene context varies by NPC location.

#### 3. Impact Gate — BATCH (`buildBatchImpactGatePrompt`) — NEW

Replace per-NPC `buildImpactGatePrompt` with a single batch call.

**System prompt** (~300 tokens):
- Task description + judgment rules
- Output format (JSON array)

**User prompt** (single call for all NPCs):
```
## What Just Happened
{triggeringEvents}

## Right Now
{bucketTime}

## Affected Characters

### 1. {npcName} ({npcId})
location: {loc} | goal: {intent} | today: {schedule} | doing: {plan}

### 2. {npcName} ({npcId})
...

## Output
Return a JSON array, one entry per character:
[{ "npcId": "...", "shouldRevise": false, "shouldReviseSchedule": false, "witnessEntry": "..." }]
```

**No memoryContext** — impact gate only judges "does this affect me?", doesn't need deep memory recall. Memory is used later in revisePlans/reviseSchedule.

**N calls → 1 call.** Shared events written once. Each NPC adds ~80-100 tokens.

#### 4. Revise Schedule (`buildReviseSchedulePrompt`)

Same split as Layer 1. System prompt contains task + revision rules + output format. User prompt has shared world context first, then NPC-specific content + trigger description.

#### 5. Revise Plans (`buildRevisePlansPrompt`)

Same split as Layer 2. System prompt contains task + revision rules + node type ref + output schema. User prompt has shared time prefix, then NPC-specific context + trigger + pending nodes.

#### 6. Day Summary (`buildSummarizeDayMemoryPrompt`)

Low cache value (each NPC's eventLog is unique). Still split for consistency:
- System prompt: task instructions + output format
- User prompt: NPC profile + events + knowledge (all NPC-specific)

### NPCPlanningAgent.ts Changes

**Method signature changes:**
- `runImpactGateForNpc()` → `runBatchImpactGate(candidates[], bucketTime, language)` returning array of results
- All other methods: adapt to destructure `{ systemPrompt, userPrompt }` from build functions

**Caller pattern:**
```typescript
// Before
const prompt = buildDailySchedulePrompt(params);
const response = await generateText({ runtime, context: prompt, modelClass: ModelClass.SMALL });

// After
const { systemPrompt, userPrompt } = buildDailySchedulePrompt(params);
const response = await generateText({
  runtime,
  context: userPrompt,
  customSystemPrompt: systemPrompt,
  modelClass: ModelClass.SMALL,
});
```

### tickProcessor.ts Changes

Impact gate section changes from per-NPC `Promise.all` to a batch call. The current post-gate logic per NPC (witness memory, revisePlans, triggerReasoning, reviseSchedule) is preserved.

**Key:** Per-NPC context data (`npcEvents`, `pendingNodes`, `schedule`, `longTermIntent`) is still fetched individually before the batch call and stored in a lookup map. After the batch gate returns, results are matched by `npcId` and each NPC's post-processing uses its pre-fetched context.

```typescript
// 1. Build candidates + pre-fetch per-NPC context
const candidateMap = new Map<string, { candidate, npcEvents, pendingNodes, schedule, npc }>();
for (const [npcId, npcEvents] of characterEventsMap) {
  const npc = state.npcCharacters.find(n => n.id === npcId);
  const pendingNodes = await npcPlanningAgent.getPendingNodes(sessionId, npcId, gameDay);
  const plan = await npcPlanningAgent.getDailyPlan(sessionId, npcId, gameDay);
  const schedule = (plan?.schedule as ScheduleEntry[]) ?? [];
  const longTermIntent = await npcPlanningAgent.getLongTermIntent(sessionId, npcId);
  candidateMap.set(npcId, {
    candidate: { npcId, npcName: npc?.name ?? npcId, currentLocation: ..., longTermIntent,
      todayScheduleSummary: ..., currentDetailedPlan: ... },
    npcEvents, pendingNodes, schedule, npc,
  });
}

// 2. Single batch LLM call
const allTriggeringEvents = /* union of all events formatted */;
const batchResults = await npcPlanningAgent.runBatchImpactGate(
  [...candidateMap.values()].map(c => c.candidate), allTriggeringEvents, bucketTime, language
);

// 3. Post-gate per-NPC processing (witness memory, revise, reasoning)
for (const result of batchResults) {
  const ctx = candidateMap.get(result.npcId);
  if (!ctx) continue;
  // write witness memory, call revisePlans if shouldRevise, reviseSchedule if shouldReviseSchedule, etc.
}
```

**Triggering events:** The batch prompt sends the union of all events. Each NPC's location context lets the LLM judge relevance. This is a minor behavioral change vs per-NPC scoped events, but acceptable — the LLM already has location info to filter.

**Lazy reactionContext:** `memoryManager.getContext()` for revisePlans/triggerReasoning is fetched **lazily** only for NPCs where `shouldRevise` or high-impact reasoning triggers. This avoids unnecessary memory retrieval for NPCs that don't need revision.

## Edge Cases

1. **Zero affected NPCs:** Skip batch call entirely (guard: `if (candidates.length === 0) return`).
2. **Malformed batch response:** If an NPC is missing from the response array, default to `{ shouldRevise: false, shouldReviseSchedule: false, witnessEntry: "" }` and log a warning. Do not retry.
3. **Large NPC count:** With ~100 tokens per NPC, 20 NPCs = ~2000 tokens for the NPC section. Well within gpt-5-mini context limits. No batching split needed for expected module sizes (typically 5-15 NPCs).

## Files to Modify

| File | Changes |
|------|---------|
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts` | 6 build functions return `PromptParts`; reorder content (shared prefix first); add `buildBatchImpactGatePrompt`; export `PromptParts` type |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts` | All callers destructure `{ systemPrompt, userPrompt }`; pass `customSystemPrompt` to `generateText`; replace `runImpactGateForNpc` with `runBatchImpactGate` |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | Impact gate: collect candidates, call batch method, iterate results with per-NPC post-processing |
| `src/dynamicworldagent/engine/types.ts` | Update `NpcPlanningCapability`: rename `runImpactGateForNpc` → `runBatchImpactGate`; fix missing `shouldReviseSchedule` in return type |
| `src/dynamicworldagent/engine/features/__tests__/*.test.ts` | Update mocks for renamed `runBatchImpactGate` (5 test files) |
| `.env` | `MODEL_PROVIDER=openai`, `SMALL_OPENAI_MODEL=gpt-5-mini` |

## Verification

1. `pnpm build` — no type errors
2. Manual test: run a game tick with multiple NPCs, verify:
   - Layer 1/2 prompts generate correct schedules/nodes
   - Impact gate batch returns correct per-NPC results
   - Revise schedule/plans still triggers correctly
3. Check OpenAI usage dashboard — verify `cached_tokens` appears in API responses, confirming prefix caching is working
