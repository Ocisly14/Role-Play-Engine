# Simulation P0 Bugfixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three critical P0 bugs that make the NPC simulation non-functional: broken plan revision, stuck schedule entries, and NPC movement failures.

**Architecture:** Three independent fixes, each targeting a different part of the planning pipeline. Fix 1 (revisePlans parsing) ensures LLM output is correctly extracted. Fix 2 (schedule consumption) adds a shift-and-persist step after generating detailed nodes. Fix 3 (NPC location init) resolves macro locations to sub-scenes and prefers `currentLocation` if present on NPC profile.

**Tech Stack:** TypeScript, Prisma, Vitest

---

## File Map

| File | Change | Responsibility |
|------|--------|---------------|
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts` | Modify | Fix schedule consumption in `generateDetailedNodes()` + robust `revisePlans()` parsing + add `markNodeFailed()` |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | Modify | Mark failed nodes before calling revision; add retry cap |
| `src/dynamicworldagent/state/moduleLoader.ts` | Modify | Use `npc.currentLocation` for initial position; resolve macro → sub-scene |
| `src/dynamicworldagent/engine/shared/skillRoll.ts` | Modify | Case-insensitive skill lookup |

---

## Chunk 1: Fix revisePlans LLM parsing

### Task 1: Make `revisePlans()` parsing robust

The LLM returns JSON but the `revisedNodes` field is either missing, wrapped in an extra object, or the entire response is just an array. Currently `parseJsonResponse` returns the parsed object, then the check `Array.isArray(parsed.revisedNodes)` fails silently 100% of the time, leaving nodes unchanged.

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts:21-27` (parseJsonResponse)
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts:580-613` (revisePlans parsing block)

- [ ] **Step 1: Add a `extractRevisedNodes` helper after `parseJsonResponse`**

In `NPCPlanningAgent.ts`, add a helper function after the existing `parseJsonResponse` (after line 27):

```typescript
/**
 * Extract revisedNodes array from various LLM response shapes:
 * - { revisedNodes: [...] }         → return revisedNodes
 * - { revisedNodes: { ... } }       → wrap in array
 * - [ ... ]  (raw array)            → return as-is
 * - { nodes: [...] }                → return nodes (common LLM alias)
 */
function extractRevisedNodes(parsed: unknown): PlanNode[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.revisedNodes)) return obj.revisedNodes as PlanNode[];
    if (obj.revisedNodes && typeof obj.revisedNodes === "object" && !Array.isArray(obj.revisedNodes)) {
      return [obj.revisedNodes as PlanNode];
    }
    if (Array.isArray(obj.nodes)) return obj.nodes as PlanNode[];
  }
  return null;
}
```

- [ ] **Step 2: Update `revisePlans()` to use the new helper**

Replace lines 581–591 in `revisePlans()`:

```typescript
// OLD:
const parsed = parseJsonResponse<{
  revisedNodes: PlanNode[];
  shouldUpdateLongTermIntent: boolean;
  updatedLongTermIntent?: string;
}>(response);

// Inject characterId + characterName
if (!Array.isArray(parsed.revisedNodes)) {
  console.warn(`[Planning] revisePlans for ${npc.name}: LLM returned non-array revisedNodes, keeping existing nodes`);
  return;
}
```

Replace with:

```typescript
const parsed = parseJsonResponse<Record<string, unknown>>(response);
const rawRevisedNodes = extractRevisedNodes(parsed);
if (!rawRevisedNodes || rawRevisedNodes.length === 0) {
  console.warn(`[Planning] revisePlans for ${npc.name}: could not extract revisedNodes from LLM response, keeping existing nodes`);
  return;
}
```

And update the code below to use `rawRevisedNodes` instead of `parsed.revisedNodes`:

```typescript
const revisedNodes = rawRevisedNodes.map((node) => ({
  ...node,
  characterId: npcId,
  characterName: npc.name,
  status: "pending" as const,
}));
```

Also update the intent check to safely access fields:

```typescript
const parsedObj = parsed as Record<string, unknown>;
if (parsedObj.shouldUpdateLongTermIntent && parsedObj.updatedLongTermIntent) {
  await this.prisma.npcLongTermIntent.updateMany({
    where: { sessionId, npcId },
    data: { intent: parsedObj.updatedLongTermIntent as string },
  });
}
```

- [ ] **Step 3: Build and verify no type errors**

Run: `pnpm build`
Expected: Clean build with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts
git commit -m "fix: make revisePlans robust to varied LLM response shapes"
```

---

### Task 2: Mark failed nodes + add retry cap in tick processor

Currently, when a node fails:
1. The failed node stays `status: "pending"` in the DB
2. `revisePlans()` receives it in `pendingNodes` and tells the LLM to keep it
3. The same node re-executes and fails again → infinite loop

Fix: mark failed node as "failed" before calling revision, and add a max-retry cap.

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts:759-777` (add `markNodeFailed`)
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts:685-724` (failure handling block)

- [ ] **Step 1: Add `markNodeFailed()` method to `NPCPlanningAgent`**

Add after `markNodeCompleted` (after line 777):

```typescript
async markNodeFailed(
  sessionId: string,
  npcId: string,
  gameDay: number,
  nodeId: string,
  reason: string
): Promise<void> {
  const plan = await this.prisma.npcDailyPlan.findUnique({
    where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
  });
  if (!plan) return;
  const nodes = plan.nodes as unknown as PlanNode[];
  // Remove failed node from pending list (same as completed — prevents retry loops)
  const remaining = nodes.filter((n) => n.nodeId !== nodeId);
  await this.prisma.npcDailyPlan.update({
    where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    data: { nodes: remaining as any },
  });
}
```

- [ ] **Step 2: Update tick processor failure handling**

In `tickProcessor.ts`, replace lines 685-724 (the `if (action.status === "failed")` block):

```typescript
// On failure -> mark node as failed (removes from pending), then revisePlans
if (action.status === "failed") {
  // Remove the failed node first so revisePlans won't see it in pendingNodes
  await npcPlanningAgent.markNodeFailed(
    sessionId,
    node.characterId,
    gameDay,
    node.nodeId,
    action.failureReason ?? "unknown"
  );

  let failureContext: string | undefined;
  if (memoryManager) {
    failureContext = await memoryManager.getContext({
      npcId: node.characterId,
      sessionId,
      purpose: "reaction",
      query: `${action.action} failed: ${action.failureReason}`,
      currentGameDay: gameDay,
    });
  }
  const longTermIntent =
    failureContext ??
    (await npcPlanningAgent.getLongTermIntent(sessionId, node.characterId));
  const memoryLog = failureContext ? [failureContext] : [];
  const pendingNodes = await npcPlanningAgent.getPendingNodes(
    sessionId,
    node.characterId,
    gameDay
  );
  await npcPlanningAgent.revisePlans(
    dgsm,
    sessionId,
    node.characterId,
    {
      longTermIntent,
      memoryLog,
      pendingNodes,
      trigger: {
        type: "failure",
        failureReason: action.failureReason!,
        action: action.action,
        gameTime: action.gameTime,
      },
    },
    language,
    registry
  );
}
```

Note: The key difference is `markNodeFailed()` is called **before** `getPendingNodes()`, so the failed node is excluded from the revision context.

- [ ] **Step 3: Build and verify**

Run: `pnpm build`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts \
        src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "fix: mark failed nodes before revision to prevent infinite retry loops"
```

---

## Chunk 2: Fix schedule entry consumption

### Task 3: Consume schedule entry after generating detailed nodes

`generateDetailedNodes()` always reads `schedule[0]` but never removes it. After generating nodes, the consumed entry must be shifted off the schedule in the DB. Otherwise `ensureNpcNodesAvailable()` keeps re-generating nodes from the same first entry.

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts:330-343` (end of `generateDetailedNodes`)

- [ ] **Step 1: Add schedule consumption after node generation**

Replace lines 330-343 (from `// Append new nodes...` to `return enrichedNodes;`):

```typescript
    // Append new nodes to existing nodes in DB and consume the schedule entry
    const existingPlan = await this.prisma.npcDailyPlan.findUnique({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
    });
    const existingNodes = (existingPlan?.nodes as unknown as PlanNode[]) ?? [];
    const mergedNodes = [...existingNodes, ...enrichedNodes];

    // Consume the first schedule entry (shift it off)
    const remainingSchedule = schedule.slice(1);

    await this.prisma.npcDailyPlan.update({
      where: { sessionId_npcId_gameDay: { sessionId, npcId, gameDay } },
      data: {
        nodes: mergedNodes as any,
        schedule: remainingSchedule as any,
      },
    });

    return enrichedNodes;
  }
```

- [ ] **Step 2: Build and verify**

Run: `pnpm build`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts
git commit -m "fix: consume schedule entry after generating detailed nodes"
```

---

## Chunk 3: Fix NPC initial location resolution

### Task 4: Use `npc.currentLocation` for initial position + init `characterPositions`

Two sub-bugs:
1. `initRuntime()` ignores the `currentLocation` field on NPC profiles, using only `residence` → macro → entry scene. But the NPC JSON may specify a specific sub-scene via `currentLocation`.
2. `characterPositions` is initialized as `{}` and never populated, causing the topology-based movement path to be skipped in `movementHandler`. The handler falls through to BFS, which can't handle macro IDs.

**Files:**
- Modify: `src/dynamicworldagent/state/moduleLoader.ts:221-228` (NPC location init block)

- [ ] **Step 1: Update NPC location resolution to prefer `currentLocation`**

Replace lines 221-228:

```typescript
  for (const npc of moduleData.npcs) {
    // Location: prefer explicit currentLocation, then resolve macro residence to entry scene
    const residence = npc.residence ?? residentToLocation[npc.id];
    const resolvedLocation = residence
      ? (macroToEntry[residence] ?? residence)
      : defaultSceneId;
    npcLocations[npc.id] = resolvedLocation;
    if (residence) npcResidences[npc.id] = residence;
```

With:

```typescript
  for (const npc of moduleData.npcs) {
    // Location: prefer explicit currentLocation from NPC profile
    const residence = npc.residence ?? residentToLocation[npc.id];
    let resolvedLocation: string;
    if (npc.currentLocation && moduleData.scenes.has(npc.currentLocation)) {
      // NPC profile specifies a valid sub-scene directly
      resolvedLocation = npc.currentLocation;
    } else if (residence) {
      resolvedLocation = macroToEntry[residence] ?? residence;
    } else {
      resolvedLocation = defaultSceneId;
    }
    // Validate: if resolvedLocation is a macro ID (not in scenes/junctions/roads), map it to entry scene
    if (
      !moduleData.scenes.has(resolvedLocation) &&
      !moduleData.junctions.has(resolvedLocation) &&
      !moduleData.roads.has(resolvedLocation)
    ) {
      const fallback = macroToEntry[resolvedLocation];
      if (fallback) {
        console.warn(`[moduleLoader] NPC ${npc.id} resolved to macro location ${resolvedLocation}, mapping to entry scene ${fallback}`);
        resolvedLocation = fallback;
      } else {
        console.warn(`[moduleLoader] NPC ${npc.id} resolved to unknown location ${resolvedLocation}, using default ${defaultSceneId}`);
        resolvedLocation = defaultSceneId;
      }
    }
    npcLocations[npc.id] = resolvedLocation;
    if (residence) npcResidences[npc.id] = residence;
```

- [ ] **Step 2: Initialize `characterPositions` from resolved locations**

After the NPC loop (after the line `npcRelationshipGraph[npc.id] = rels;`, before the closing `}` of the for-loop at line ~259), add:

```typescript
    // Initialize characterPosition from resolved location
    if (topology) {
      const scene = moduleData.scenes.get(resolvedLocation);
      if (scene) {
        // Check if this scene is connected to a junction
        for (const [juncId, junc] of moduleData.junctions) {
          if (junc.connectedSceneIds?.includes(resolvedLocation)) {
            characterPositions[npc.id] = { type: "junction", junctionId: juncId };
            break;
          }
        }
        // If not assigned via junction, check if it's along a road
        if (!characterPositions[npc.id]) {
          for (const [roadId, road] of moduleData.roads) {
            const along = road.alongConnections?.find((ac) => ac.sceneId === resolvedLocation);
            if (along) {
              characterPositions[npc.id] = { type: "road", roadId, position: along.position };
              break;
            }
          }
        }
        // Fallback: treat as scene position
        if (!characterPositions[npc.id]) {
          characterPositions[npc.id] = { type: "scene", sceneId: resolvedLocation };
        }
      }
    }
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/state/moduleLoader.ts
git commit -m "fix: resolve NPC locations to valid sub-scenes and init characterPositions"
```

---

## Chunk 4: Fix case-insensitive skill lookup

### Task 5: Make skill roll case-insensitive

The LLM generates lowercase skill names (e.g. `"persuade"`) but NPC profiles and `COC_SKILL_BASE_VALUES` use Title Case (`"Persuade"`). The lookup `adjustedSkills[skill]` fails, defaulting to `COC_SKILL_BASE_VALUES.get(skill)` which also fails with wrong case, falling back to `1`.

**Files:**
- Modify: `src/dynamicworldagent/engine/shared/skillRoll.ts:58-75`

- [ ] **Step 1: Add case-insensitive lookup helper**

Add before `resolveSkillRoll` (before line 58):

```typescript
/** Case-insensitive lookup in a Record<string, number>. Returns value or undefined. */
function caseInsensitiveLookup(
  skills: Record<string, number>,
  key: string
): number | undefined {
  if (skills[key] !== undefined) return skills[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(skills)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Case-insensitive lookup in a Map<string, number>. */
function caseInsensitiveMapGet(
  map: Map<string, number>,
  key: string
): number | undefined {
  const direct = map.get(key);
  if (direct !== undefined) return direct;
  const lower = key.toLowerCase();
  for (const [k, v] of map) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
```

- [ ] **Step 2: Update `resolveSkillRoll` to use case-insensitive lookups**

Replace lines 73-75:

```typescript
  // NPC's trained value, or CoC base value for untrained skill
  const baseValue = COC_SKILL_BASE_VALUES.get(skill) ?? 1;
  const skillValue = adjustedSkills[skill] ?? baseValue;
```

With:

```typescript
  // NPC's trained value, or CoC base value for untrained skill (case-insensitive)
  const baseValue = caseInsensitiveMapGet(COC_SKILL_BASE_VALUES, skill) ?? 1;
  const skillValue = caseInsensitiveLookup(adjustedSkills, skill) ?? baseValue;
```

- [ ] **Step 3: Also fix `pickBestFromCandidates` for case-insensitive defender skill lookup**

Replace lines 40-43:

```typescript
  for (const name of candidates) {
    const value = npcSkills[name];
    if (value !== undefined && (!best || value > best.value)) {
      best = { skill: name, value };
```

With:

```typescript
  for (const name of candidates) {
    const value = caseInsensitiveLookup(npcSkills, name);
    if (value !== undefined && (!best || value > best.value)) {
      best = { skill: name, value };
```

- [ ] **Step 4: Build and verify**

Run: `pnpm build`
Expected: Clean build.

- [ ] **Step 5: Run existing tests**

Run: `pnpm test`
Expected: All existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/dynamicworldagent/engine/shared/skillRoll.ts
git commit -m "fix: case-insensitive skill lookup for LLM-generated skill names"
```

---

## Summary of Changes

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| revisePlans always fails | LLM response shape doesn't match `{ revisedNodes: [...] }` | `extractRevisedNodes()` handles array, wrapped, aliased shapes |
| Same schedule entry re-consumed | `generateDetailedNodes` reads `schedule[0]` but never removes it | `schedule.slice(1)` persisted to DB after node generation |
| Failed nodes retry infinitely | Failed node stays `pending`, revision re-generates same action | `markNodeFailed()` removes node before revision call |
| Tom stuck at SCN_3 | `initRuntime` resolves residence to macro ID when `macroToEntry` lookup fails; `characterPositions` empty | Validate resolved location exists; prefer `currentLocation`; init `characterPositions` |
| Skill rolls always = 1 | LLM outputs `"persuade"` but data has `"Persuade"` | Case-insensitive lookup helpers |
