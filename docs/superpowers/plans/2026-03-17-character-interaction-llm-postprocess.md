# Character Interaction LLM Post-Processing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mechanical character_interaction post-processing in tickProcessor with a single LLM call that produces rich narrative outcomes, relationship changes, memories, discoveries, and side effects.

**Architecture:** Extend `NodeHandler` with an optional async `postProcess` method. `characterInteractionHandler` implements it to call an LLM with full NPC/scene/relationship context. tickProcessor detects `postProcess` and uses its structured result to apply all state writes generically, removing ~150 lines of character_interaction-specific hardcoded logic.

**Tech Stack:** TypeScript, existing `generateText` + `ModelClass` from `src/models/index.ts`, Vitest

**Spec:** `docs/superpowers/specs/2026-03-17-character-interaction-llm-postprocess-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/dynamicworldagent/engine/types.ts` | `PostProcessContext`, `PostProcessResult` types + `postProcess` on `NodeHandler` |
| `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts` | Simplified `execute` (pre-checks only) + `postProcess` implementation |
| `src/dynamicworldagent/engine/handlers/characterInteractionPrompt.ts` | **New** — prompt builder function |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | `applyPostProcessResult` function + postProcess detection in execution loop |
| `src/dynamicworldagent/engine/handlers/__tests__/characterInteractionHandler.test.ts` | Updated tests |

---

## Chunk 1: Types + Handler Simplification

### Task 1: Add PostProcessResult and PostProcessContext types to engine/types.ts

**Files:**
- Modify: `src/dynamicworldagent/engine/types.ts:10-34`

- [ ] **Step 1: Add new types after NodeHandler interface**

Add these types after line 34 (after closing `}` of `NodeHandler`) and before the `WorldFeatureResult` interface at line 39. Also add the `postProcess` method to `NodeHandler`.

In `NodeHandler` (line 10-34), add `postProcess` as an optional method after `exampleNode`:

```typescript
// Inside NodeHandler interface, after exampleNode:
  /** Optional async post-processing via LLM. If defined, tickProcessor calls this
   *  after execute() succeeds and uses the result for all state writes. */
  postProcess?(ctx: PostProcessContext): Promise<PostProcessResult>;
```

Then add the new interfaces between `NodeHandler` and `WorldFeatureResult`:

```typescript
// ===== Post-Process types (used by handlers with LLM post-processing) =====

/** Context passed to NodeHandler.postProcess() */
export interface PostProcessContext {
  node: import("../dynamicBasicAgent/npcPlanning/types.js").PlanNode;
  action: import("../dynamicBasicAgent/npcPlanning/types.js").CharacterAction;
  dgsm: DynamicGameStateManager;
  memoryManager?: import("../memory/NpcMemoryManager.js").NpcMemoryManager;
  sessionId: string;
  moduleId: string;
  gameDay: number;
  language: string;
  runtime: any;
  modelClass?: import("../../models/index.js").ModelClass;
}

/** Structured result from NodeHandler.postProcess() — drives all state writes */
export interface PostProcessResult {
  outcome: string;
  relationshipChange?: {
    scoreDelta: number;
    note: string;
  };
  initiatorMemory: string;
  targetMemory?: string;
  itemTransfers?: Array<{
    itemId: string;
    fromNpcId: string;
    toNpcId: string;
  }>;
  knowledgeTransfers?: Array<{
    targetNpcId: string;
    content: string;
    sourceKnowledgeId?: string;
  }>;
  discoveredIds?: string[];
  sideEffects?: {
    itemChanges?: Array<{
      itemId: string;
      updates: Partial<import("../state/types.js").Item>;
    }>;
    sceneConditions?: Array<{
      sceneId: string;
      condition: {
        description: string;
        mechanicalEffect?: {
          skillPenalty?: Array<{ skill: string; delta: number }>;
          blocked?: boolean;
        };
      };
    }>;
    damagedEvidenceId?: string;
  };
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/types.ts
git commit -m "feat: add PostProcessContext and PostProcessResult types to NodeHandler"
```

---

### Task 2: Simplify characterInteractionHandler.execute()

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts:110-128`

- [ ] **Step 1: Write test for simplified execute (no item transfer)**

Add a new test in `src/dynamicworldagent/engine/handlers/__tests__/characterInteractionHandler.test.ts`:

```typescript
it("does not perform item transfer in execute (deferred to postProcess)", () => {
  const dgsm = createMockDgsm();
  dgsm._addNpc("npc_a", { type: "scene", sceneId: "lobby" });
  dgsm._addNpc("npc_b", { type: "scene", sceneId: "lobby" });

  const node = makeNode({
    location: "lobby",
    characterInteractionPayload: {
      transferType: "item",
      itemId: "letter",
    },
  });

  const result = characterInteractionHandler.execute(node, dgsm as any, ctx);
  // Should succeed — execute no longer checks inventory or transfers items
  expect(result.status).toBe("completed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/dynamicworldagent/engine/handlers/__tests__/characterInteractionHandler.test.ts --reporter=verbose`
Expected: FAIL — currently `execute()` calls `dgsm.removeItemFromNpc` which returns undefined in mock, causing `object_not_found` failure.

- [ ] **Step 3: Remove item transfer from execute()**

In `characterInteractionHandler.ts`, replace lines 110-128 (the `// Apply side effects` block) with a simple completed return:

```typescript
    // Side effects (item transfer, knowledge transfer, etc.) are handled by postProcess
    return makeAction(
      node,
      "completed",
      buildOutcome(node, "completed", { rollDetail: lastRollDetail }),
      { difficulty, successLevel: resolvedSuccessLevel }
    );
```

Remove the duplicate `return makeAction(...)` at lines 130-135 since we now have a single return path.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/dynamicworldagent/engine/handlers/__tests__/characterInteractionHandler.test.ts --reporter=verbose`
Expected: All tests PASS.

- [ ] **Step 5: Verify build**

Run: `pnpm build`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts src/dynamicworldagent/engine/handlers/__tests__/characterInteractionHandler.test.ts
git commit -m "refactor: simplify characterInteractionHandler.execute to pre-checks only"
```

---

## Chunk 2: Prompt Template + postProcess Implementation

### Task 3: Create characterInteractionPrompt.ts

**Files:**
- Create: `src/dynamicworldagent/engine/handlers/characterInteractionPrompt.ts`

- [ ] **Step 1: Create prompt builder**

Create `src/dynamicworldagent/engine/handlers/characterInteractionPrompt.ts`:

```typescript
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { PlanNode, SuccessLevel } from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicNPCProfile } from "../../state/types.js";

export interface CharacterInteractionPromptParams {
  node: PlanNode;
  successLevel: SuccessLevel;
  dgsm: DynamicGameStateManager;
  memoryManager?: NpcMemoryManager;
  sessionId: string;
  gameDay: number;
  language: string;
}

export async function buildCharacterInteractionPrompt(
  params: CharacterInteractionPromptParams
): Promise<{ systemPrompt: string; userPrompt: string }> {
  const { node, successLevel, dgsm, memoryManager, sessionId, gameDay, language } = params;
  const state = dgsm.getState();

  // ── Initiator context ──
  const initiator = state.npcCharacters.find((n) => n.id === node.characterId);
  const initiatorStats = state.npcStats?.[node.characterId];
  const initiatorInventory = state.npcInventories?.[node.characterId] ?? initiator?.inventory ?? [];
  const initiatorMemories = memoryManager
    ? await memoryManager.query({
        npcId: node.characterId,
        sessionId,
        query: node.action,
        limit: 5,
        filters: { types: ["event"] },
      })
    : [];

  // ── Target context ──
  const targetId = node.targetCharacterId!;
  const target = state.npcCharacters.find((n) => n.id === targetId);
  const targetStats = state.npcStats?.[targetId];
  const targetInventory = state.npcInventories?.[targetId] ?? target?.inventory ?? [];
  const targetMemories = memoryManager
    ? await memoryManager.query({
        npcId: targetId,
        sessionId,
        query: node.action,
        limit: 5,
        filters: { types: ["event"] },
      })
    : [];

  // ── Relationship ──
  const relationship = dgsm.getRelationship(node.characterId, targetId) ?? {
    score: 0,
    note: "",
  };

  // ── Scene ──
  const scene = dgsm.getScene(node.location);

  // ── Discovery candidates ──
  // Evidence items in scene
  const evidenceCandidates = (scene?.items ?? [])
    .filter((i) => i.category === "evidence" && !i.damaged)
    .map((i) => ({
      id: i.id,
      name: i.name,
      description: i.description ?? "",
      difficulty: i.discoveryMethod ? "regular" : "automatic",
    }));

  // Target NPC knowledge/secrets
  const knowledgeCandidates: Array<{
    id: string;
    content: string;
    difficulty: string;
  }> = [];
  if (memoryManager) {
    const infoMemories = await memoryManager.query({
      npcId: targetId,
      sessionId,
      query: node.action,
      limit: 10,
      filters: { types: ["information", "secret"] },
    });
    for (const mem of infoMemories) {
      knowledgeCandidates.push({
        id: mem.id,
        content: mem.content,
        difficulty: (mem.metadata as any)?.difficulty ?? "regular",
      });
    }
  }

  // ── Format helpers ──
  const formatNpc = (npc: DynamicNPCProfile | undefined, stats: any, inv: any[]) => {
    if (!npc) return "Unknown NPC";
    const lines = [`Name: ${npc.name}`];
    if (npc.occupation) lines.push(`Occupation: ${npc.occupation}`);
    if (npc.personality) lines.push(`Personality: ${npc.personality}`);
    if (npc.background) lines.push(`Background: ${npc.background}`);
    if (stats) lines.push(`HP: ${stats.hp}, SAN: ${stats.san}`);
    if (inv.length > 0) lines.push(`Inventory: ${inv.map((i: any) => i.name).join(", ")}`);
    return lines.join("\n");
  };

  const formatMemories = (memories: Array<{ content: string }>) =>
    memories.length > 0
      ? memories.map((m) => `- ${m.content}`).join("\n")
      : "(none)";

  const langInstruction = language === "zh"
    ? "请用中文回复。"
    : "Respond in English.";

  // ── System prompt ──
  const systemPrompt = `You are the game engine for a Call of Cthulhu tabletop RPG simulation.
Your task is to resolve a character interaction and produce a structured JSON result.

${langInstruction}

## Success Level Interpretation
The dice roll result is: **${successLevel}**
- critical: Extraordinary success — exceptional outcomes, may discover extreme-difficulty secrets
- hard: Strong success — impressive outcomes, may discover hard-difficulty secrets
- regular: Normal success — expected outcomes, may discover regular-difficulty secrets
- fail: The action fails — only automatic discoveries possible
- fumble: Catastrophic failure — no discoveries, may damage evidence

## Discovery Rules
You will be given candidate evidence items and NPC knowledge. Select which ones are discovered based on:
1. The success level gates the maximum difficulty: critical→extreme, hard→hard, regular→regular, fail→automatic only, fumble→none
2. The action description must be contextually relevant to the discovery
3. Return discovered IDs in the "discoveredIds" array

## Fumble Rules
On fumble, you may select ONE undamaged evidence item ID to damage via "sideEffects.damagedEvidenceId".

## Output Format
Return ONLY a JSON object (no markdown, no explanation) with this schema:
{
  "outcome": "Narrative description of what happened",
  "relationshipChange": { "scoreDelta": <number -20 to +20>, "note": "brief reason" } | null,
  "initiatorMemory": "Event memory written from initiator's perspective",
  "targetMemory": "Event memory written from target's perspective" | null,
  "itemTransfers": [{ "itemId": "<id>", "fromNpcId": "<id>", "toNpcId": "<id>" }] | null,
  "knowledgeTransfers": [{ "targetNpcId": "<id>", "content": "<what was learned>", "sourceKnowledgeId": "<id>" }] | null,
  "discoveredIds": ["<candidate id>", ...] | null,
  "sideEffects": {
    "itemChanges": [{ "itemId": "<id>", "updates": { ... } }] | null,
    "sceneConditions": [{ "sceneId": "<id>", "condition": { "description": "..." } }] | null,
    "damagedEvidenceId": "<id>" | null
  } | null
}`;

  // ── User prompt ──
  const userPrompt = `## Initiator
${formatNpc(initiator, initiatorStats, initiatorInventory)}

### Recent Memories
${formatMemories(initiatorMemories)}

## Target
${formatNpc(target, targetStats, targetInventory)}

### Recent Memories
${formatMemories(targetMemories)}

## Relationship
Score: ${relationship.score} (range: -100 to +100)
Note: ${relationship.note || "(no prior note)"}

## Scene
Name: ${scene?.name ?? node.location}
Description: ${scene?.description ?? "Unknown location"}
${scene?.conditions?.length ? `Conditions: ${scene.conditions.map((c) => c.description).join("; ")}` : ""}

## Action
Description: ${node.action}
Skill: ${node.skill ?? "(none)"}
Difficulty: ${node.difficulty ?? "regular"}
Success Level: ${successLevel}
${node.characterInteractionPayload ? `Payload: ${JSON.stringify(node.characterInteractionPayload)}` : ""}

## Discovery Candidates

### Evidence Items in Scene
${evidenceCandidates.length > 0 ? evidenceCandidates.map((e) => `- ID: ${e.id} | Name: ${e.name} | ${e.description} | Difficulty: ${e.difficulty}`).join("\n") : "(none)"}

### Target NPC Knowledge
${knowledgeCandidates.length > 0 ? knowledgeCandidates.map((k) => `- ID: ${k.id} | ${k.content} | Difficulty: ${k.difficulty}`).join("\n") : "(none)"}`;

  return { systemPrompt, userPrompt };
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/characterInteractionPrompt.ts
git commit -m "feat: add character interaction prompt builder"
```

---

### Task 4: Implement postProcess on characterInteractionHandler

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts`

- [ ] **Step 1: Add postProcess implementation**

Add the following imports at the top of `characterInteractionHandler.ts`:

```typescript
import { ModelClass, generateText } from "../../../models/index.js";
import type { PostProcessContext, PostProcessResult } from "../types.js";
import { buildCharacterInteractionPrompt } from "./characterInteractionPrompt.js";
```

Also add a local `parseJsonResponse` helper at the bottom of the file (since the one in `NPCPlanningAgent.ts` is not exported):

```typescript
function parseJsonResponse<T>(raw: string): T {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  return JSON.parse(text) as T;
}
```

Then add the `postProcess` method to the `characterInteractionHandler` object, after the `execute` method:

```typescript
  async postProcess(ctx: PostProcessContext): Promise<PostProcessResult> {
    const { node, action, dgsm, memoryManager, sessionId, gameDay, language, runtime } = ctx;
    const modelClass = ctx.modelClass ?? ModelClass.MEDIUM;
    const successLevel = action.successLevel ?? "regular";

    try {
      const { systemPrompt, userPrompt } = await buildCharacterInteractionPrompt({
        node,
        successLevel,
        dgsm,
        memoryManager,
        sessionId,
        gameDay,
        language,
      });

      const response = await generateText({
        runtime,
        context: `${systemPrompt}\n\n${userPrompt}`,
        modelClass,
      });

      const result = parseJsonResponse<PostProcessResult>(response);

      return {
        outcome: result.outcome ?? action.outcome,
        relationshipChange: result.relationshipChange ?? undefined,
        initiatorMemory: result.initiatorMemory ?? action.outcome,
        targetMemory: result.targetMemory ?? undefined,
        itemTransfers: result.itemTransfers ?? undefined,
        knowledgeTransfers: result.knowledgeTransfers ?? undefined,
        discoveredIds: result.discoveredIds ?? undefined,
        sideEffects: result.sideEffects ?? undefined,
      };
    } catch (error) {
      // Graceful degradation: return minimal result on LLM failure
      console.warn(
        `[characterInteractionHandler] postProcess LLM failed, using fallback:`,
        error
      );
      return {
        outcome: action.outcome,
        initiatorMemory: `${action.gameTime} [${action.location}] - ${action.outcome}`,
        targetMemory: node.targetCharacterId
          ? `${node.characterName} ${action.action} — result: ${action.outcome}`
          : undefined,
      };
    }
  },
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts
git commit -m "feat: add postProcess LLM implementation to characterInteractionHandler"
```

---

## Chunk 3: tickProcessor Integration

### Task 5: Add applyPostProcessResult function to tickProcessor

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

- [ ] **Step 1: Add import for PostProcessResult**

At the top of `tickProcessor.ts`, add to the existing imports from `../../engine/types.js`:

```typescript
import type {
  ExecutionContext,
  PostProcessContext,
  PostProcessResult,
  TickRuntimeContext,
} from "../../engine/types.js";
```

- [ ] **Step 2: Add applyPostProcessResult function**

Add this function before the `runSimulationTick` function (around line 900, after the discovery/embedding helper functions):

```typescript
/**
 * Apply a PostProcessResult from a handler's postProcess() to game state.
 * Generic function — works for any handler that implements postProcess.
 */
async function applyPostProcessResult(
  result: PostProcessResult,
  node: PlanNode,
  action: CharacterAction,
  dgsm: DynamicGameStateManager,
  memoryManager: NpcMemoryManager | undefined,
  npcPlanningAgent: NPCPlanningAgent,
  sessionId: string,
  moduleId: string,
  gameDay: number,
  language: string
): Promise<void> {
  // 1. Overwrite action outcome
  action.outcome = result.outcome;

  // 2. Item transfers
  if (result.itemTransfers) {
    for (const transfer of result.itemTransfers) {
      const item = dgsm.removeItemFromNpc(transfer.fromNpcId, transfer.itemId);
      if (item) {
        dgsm.addItemToNpc(transfer.toNpcId, item);
      }
    }
  }

  // 3. Relationship update
  if (result.relationshipChange && node.targetCharacterId) {
    dgsm.updateRelationship(
      node.characterId,
      node.targetCharacterId,
      result.relationshipChange.scoreDelta,
      result.relationshipChange.note
    );
  }

  // 4. Initiator event memory
  if (memoryManager) {
    let logEntry = result.initiatorMemory;
    if (result.relationshipChange) {
      const sign = result.relationshipChange.scoreDelta >= 0 ? "+" : "";
      const rel = dgsm.getRelationship(node.characterId, node.targetCharacterId!);
      logEntry += ` [relationship ${sign}${result.relationshipChange.scoreDelta} → ${rel?.score ?? 0}, ${result.relationshipChange.note}]`;
    }
    await memoryManager.add({
      npcId: node.characterId,
      sessionId,
      moduleId,
      type: "event",
      content: logEntry,
      gameDay,
      gameTime: action.gameTime,
      location: action.location,
    });
  }

  // 5. Target event memory
  if (memoryManager && result.targetMemory && node.targetCharacterId) {
    await memoryManager.add({
      npcId: node.targetCharacterId,
      sessionId,
      moduleId,
      type: "event",
      content: result.targetMemory,
      gameDay,
      gameTime: action.gameTime,
      location: action.location,
    });
  }

  // 6. Knowledge transfers (validate co-location)
  if (memoryManager && result.knowledgeTransfers) {
    for (const transfer of result.knowledgeTransfers) {
      const actorPos = dgsm.getCharacterPosition(node.characterId);
      const targetPos = dgsm.getCharacterPosition(transfer.targetNpcId);
      if (!arePositionsCoLocated(actorPos, targetPos, dgsm)) continue;

      await memoryManager.add({
        npcId: transfer.targetNpcId,
        sessionId,
        moduleId,
        type: "information",
        content: transfer.content,
        gameDay,
        gameTime: action.gameTime,
        location: action.location,
        metadata: {
          knowledgeId: transfer.sourceKnowledgeId ?? `transfer_${node.nodeId}`,
          difficulty: "automatic",
        },
      });
    }
  }

  // 7. Discovery processing (validate IDs against candidates)
  if (result.discoveredIds && result.discoveredIds.length > 0) {
    const scene = dgsm.getScene(node.location);
    const evidenceItems = (scene?.items ?? []).filter(
      (i) => i.category === "evidence" && !i.damaged
    );
    const validEvidenceIds = new Set(evidenceItems.map((i) => i.id));

    const discoveries: DiscoveryEntry[] = [];

    for (const id of result.discoveredIds) {
      // Check evidence items
      const evidenceItem = evidenceItems.find((i) => i.id === id);
      if (evidenceItem) {
        discoveries.push({
          id,
          text: evidenceItem.description ?? evidenceItem.name,
          source: "evidence",
          sourceId: node.location,
          sourceName: scene?.name ?? node.location,
          difficulty: evidenceItem.discoveryMethod ? "regular" : "automatic",
          similarity: 1.0,
        });
        continue;
      }

      // Check NPC knowledge (memory IDs)
      if (memoryManager && node.targetCharacterId) {
        await markMemoryRevealed(memoryManager, node.targetCharacterId, sessionId, id);
        discoveries.push({
          id,
          text: id,
          source: "npc",
          sourceId: node.targetCharacterId,
          sourceName: node.characterName,
          difficulty: "regular",
          similarity: 1.0,
        });
      }
    }

    if (discoveries.length > 0) {
      action.discoveries = discoveries;
      embedDiscoveries(discoveries, dgsm, language as "en" | "zh");
      console.log(
        `[TickProcessor] postProcess discovered ${discoveries.length} item(s): ${discoveries.map((d) => `[${d.difficulty}] ${d.text.slice(0, 40)}`).join("; ")}`
      );
    }
  }

  // 8. Side effects
  if (result.sideEffects) {
    if (result.sideEffects.itemChanges) {
      for (const change of result.sideEffects.itemChanges) {
        // Direct scene item mutation (DynamicGameStateManager has no updateItem method)
        const scene = dgsm.getScene(node.location);
        if (scene) {
          const item = scene.items?.find((i) => i.id === change.itemId);
          if (item) {
            Object.assign(item, change.updates);
          }
        }
      }
    }
    if (result.sideEffects.sceneConditions) {
      for (const sc of result.sideEffects.sceneConditions) {
        dgsm.appendSceneCondition(sc.sceneId, sc.condition);
      }
    }
    if (result.sideEffects.damagedEvidenceId) {
      dgsm.damageEvidenceItem(
        result.sideEffects.damagedEvidenceId,
        node.characterName,
        `Interaction: ${node.action}`,
        node.location
      );
      const scene = dgsm.getScene(node.location);
      action.damagedEvidence = {
        itemId: result.sideEffects.damagedEvidenceId,
        sourceName: scene?.name ?? node.location,
      };
    }
  }

  // 9. Mark node completed
  await npcPlanningAgent.markNodeCompleted(
    sessionId,
    node.characterId,
    gameDay,
    node.nodeId,
    action.outcome
  );
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "feat: add applyPostProcessResult function to tickProcessor"
```

---

### Task 6: Integrate postProcess into tickProcessor execution loop

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts:1178-1428`

- [ ] **Step 1: Replace character_interaction post-processing with postProcess detection**

In the node execution loop, **preserve lines 1187-1191** (`itemContext`, `action`, `tickActions.push`, `eventOutcome`, `eventMetadata` — these are needed by the fallback path). Then replace the post-processing block starting at line 1193 (`// 4. Post-execution processing`) through line 1428 (end of `if (action.status === "failed")` block) with:

```typescript
    // 4. Post-execution processing
    if (handler.postProcess && action.status === "completed") {
      // Handler has LLM post-processing — use it for all state writes
      const postProcessCtx: PostProcessContext = {
        node,
        action,
        dgsm,
        memoryManager,
        sessionId,
        moduleId,
        gameDay,
        language,
        runtime: npcPlanningAgent.getRuntime(),
      };
      const result = await handler.postProcess(postProcessCtx);
      await applyPostProcessResult(
        result, node, action, dgsm, memoryManager,
        npcPlanningAgent, sessionId, moduleId, gameDay, language
      );
    } else if (handler.postProcess && action.successLevel === "fumble") {
      // Fumble with postProcess — let LLM decide which evidence to damage
      const postProcessCtx: PostProcessContext = {
        node,
        action,
        dgsm,
        memoryManager,
        sessionId,
        moduleId,
        gameDay,
        language,
        runtime: npcPlanningAgent.getRuntime(),
      };
      const result = await handler.postProcess(postProcessCtx);
      // Only apply side effects (damage decision) from fumble
      if (result.sideEffects?.damagedEvidenceId) {
        dgsm.damageEvidenceItem(
          result.sideEffects.damagedEvidenceId,
          node.characterName,
          `Fumbled: ${node.action}`,
          node.location
        );
        const scene = dgsm.getScene(node.location);
        action.damagedEvidence = {
          itemId: result.sideEffects.damagedEvidenceId,
          sourceName: scene?.name ?? node.location,
        };
      }
      // Mark node failed + queue revision (fumble is a failure)
      await npcPlanningAgent.markNodeFailed(
        sessionId,
        node.characterId,
        gameDay,
        node.nodeId,
        action.failureReason ?? "skill_roll_failed"
      );
      pendingRevisionRequests.push({
        npcId: node.characterId,
        trigger: {
          type: "failure",
          failureReason: action.failureReason!,
          action: action.action,
          gameTime: action.gameTime,
          failureOutcome: action.outcome,
        },
        reactionQuery: `${action.action} failed: ${action.outcome}`,
      });
    } else {
      // No postProcess — use existing hardcoded post-processing

      // On character_interaction success -> update relationship
      let relationshipChange: string | undefined;
      let relResult:
        | { scoreDelta: number; newScore: number; note: string }
        | null
        | undefined;
      if (
        action.status === "completed" &&
        node.type === "character_interaction" &&
        node.targetCharacterId
      ) {
        relResult = await npcPlanningAgent.updateRelationshipViaLLM(
          dgsm,
          node.characterId,
          node.targetCharacterId,
          action.outcome,
          language
        );
        if (relResult) {
          const sign = relResult.scoreDelta >= 0 ? "+" : "";
          relationshipChange = `[relationship ${sign}${relResult.scoreDelta} → ${relResult.newScore}, ${relResult.note}]`;
        }
      }

      // Mirror write: passive NPC gets event memory of this interaction
      if (
        memoryManager &&
        action.status === "completed" &&
        node.type === "character_interaction" &&
        node.targetCharacterId
      ) {
        const targetId = node.targetCharacterId;
        const initiatorName = node.characterName;

        await memoryManager.add({
          npcId: targetId,
          sessionId,
          moduleId,
          type: "event",
          content: `${initiatorName} ${action.action} — result: ${eventOutcome}`,
          gameDay,
          gameTime: action.gameTime,
          location: action.location,
          metadata: eventMetadata,
        });
      }

      // Log NPC actions and mark completed
      {
        let logEntry = `Day${gameDay} ${action.gameTime} [${action.location}] - ${eventOutcome}`;
        if (relationshipChange) logEntry += ` ${relationshipChange}`;

        if (memoryManager) {
          await memoryManager.add({
            npcId: node.characterId,
            sessionId,
            moduleId,
            type: "event",
            content: logEntry,
            gameDay,
            gameTime: action.gameTime,
            location: action.location,
            metadata: eventMetadata,
          });
        }

        await npcPlanningAgent.markNodeCompleted(
          sessionId,
          node.characterId,
          gameDay,
          node.nodeId,
          action.outcome
        );
      }

      // Knowledge transfer: write information memory to target NPC
      if (
        memoryManager &&
        action.status === "completed" &&
        node.type === "character_interaction" &&
        node.characterInteractionPayload?.transferType === "information" &&
        node.characterInteractionPayload.informationContent
      ) {
        const payload = node.characterInteractionPayload;
        const informationContent = payload.informationContent!;
        const targets =
          payload.targetCharacterIds ??
          (node.targetCharacterId ? [node.targetCharacterId] : []);
        const filteredTargets = targets.filter((id) => id !== node.characterId);

        const senderChar = state.npcCharacters.find(
          (n) => n.id === node.characterId
        );
        const senderName = senderChar?.name ?? node.characterName;

        const presentTargets = filteredTargets.filter((id) => {
          const actorPos = dgsm.getCharacterPosition(node.characterId);
          const tPos = dgsm.getCharacterPosition(id);
          return arePositionsCoLocated(actorPos, tPos, dgsm);
        });

        const sourceKnowledgeId =
          payload.relatedKnowledgeIds?.[0] ?? `transfer_${node.nodeId}`;

        for (const targetId of presentTargets) {
          await memoryManager.add({
            npcId: targetId,
            sessionId,
            moduleId,
            type: "information",
            content: `${senderName} told me: ${informationContent}`,
            gameDay,
            gameTime: action.gameTime,
            location: action.location,
            metadata: {
              knowledgeId: sourceKnowledgeId,
              difficulty: "automatic",
            },
          });
        }

        const targetNames = presentTargets
          .map((id) => {
            const npc = state.npcCharacters.find((n) => n.id === id);
            return npc?.name ?? id;
          })
          .join(", ");
        if (targetNames) {
          await memoryManager.add({
            npcId: node.characterId,
            sessionId,
            moduleId,
            type: "event",
            content: `Shared information with ${targetNames}: ${informationContent}`,
            gameDay,
            gameTime: action.gameTime,
            location: action.location,
            metadata: { outcome: action.outcome },
          });
        }
      }

      // Discovery — NPC discovers evidence/knowledge on successful actions
      if (action.status === "completed") {
        const effectiveSuccess: SuccessLevel = action.successLevel ?? "regular";
        const evidenceSceneId = node.location;
        const evidence = await discoverEvidence(
          node,
          effectiveSuccess,
          dgsm,
          language,
          evidenceSceneId
        );
        const npcKnowledge = memoryManager
          ? await discoverNpcKnowledge(
              node,
              effectiveSuccess,
              dgsm,
              language,
              memoryManager
            )
          : [];
        const allDiscoveries = [...evidence, ...npcKnowledge];

        if (allDiscoveries.length > 0) {
          action.discoveries = allDiscoveries;
          embedDiscoveries(allDiscoveries, dgsm, language as "en" | "zh");
          for (const entry of allDiscoveries) {
            if (entry.source === "npc" && memoryManager) {
              await markMemoryRevealed(
                memoryManager,
                entry.sourceId,
                sessionId,
                entry.id
              );
            }
          }
          console.log(
            `[TickProcessor] NPC discovered ${allDiscoveries.length} item(s): ${allDiscoveries.map((d) => `[${d.difficulty}] ${d.text.slice(0, 40)}`).join("; ")}`
          );
        }
      }

      // Fumble -> damage a random evidence item in the NPC's current scene
      if (action.successLevel === "fumble") {
        const scene = dgsm.getScene(node.location);
        const damageable =
          scene?.items?.filter((i) => i.category === "evidence" && !i.damaged) ??
          [];
        if (damageable.length > 0) {
          const victim =
            damageable[Math.floor(Math.random() * damageable.length)];
          dgsm.damageEvidenceItem(
            victim.id,
            node.characterName,
            `Fumbled: ${node.action}`,
            node.location
          );
          action.damagedEvidence = { itemId: victim.id, sourceName: scene!.name };
          console.log(
            `[TickProcessor] Fumble damaged evidence: ${(victim.description || victim.name).slice(0, 40)}`
          );
        }
      }

      // On failure -> mark node as failed, then revisePlans
      if (action.status === "failed") {
        await npcPlanningAgent.markNodeFailed(
          sessionId,
          node.characterId,
          gameDay,
          node.nodeId,
          action.failureReason ?? "unknown"
        );

        pendingRevisionRequests.push({
          npcId: node.characterId,
          trigger: {
            type: "failure",
            failureReason: action.failureReason!,
            action: action.action,
            gameTime: action.gameTime,
            failureOutcome: action.outcome,
          },
          reactionQuery: `${action.action} failed: ${action.outcome}`,
        });
      }
    }
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 3: Run existing tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "feat: integrate postProcess into tickProcessor execution loop"
```

---

## Chunk 4: Testing

### Task 7: Update characterInteractionHandler tests

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/__tests__/characterInteractionHandler.test.ts`

- [ ] **Step 1: Add postProcess test**

Add a new `describe` block in the test file:

```typescript
describe("characterInteractionHandler.postProcess", () => {
  it("is defined as a function", () => {
    expect(typeof characterInteractionHandler.postProcess).toBe("function");
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm test -- src/dynamicworldagent/engine/handlers/__tests__/characterInteractionHandler.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 4: Run build**

Run: `pnpm build`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/__tests__/characterInteractionHandler.test.ts
git commit -m "test: add postProcess existence test for characterInteractionHandler"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run format + lint**

Run: `pnpm check`
Expected: No errors (or auto-fixed).

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: No errors.

- [ ] **Step 4: Commit any format fixes**

```bash
git add -A
git commit -m "chore: format and lint fixes"
```
