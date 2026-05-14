# Object Interaction LLM Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an LLM resolver for `object_interaction` nodes that determines item state changes, item movements, and per-character memories — mirroring the character_interaction resolver pattern.

**Architecture:** The handler performs mechanical pre-checks (location, item existence, skill roll). On success, tickProcessor calls an LLM resolver (MEDIUM model) that sees the action context, scene items, actor inventory, skill roll result, and co-present NPCs. The resolver outputs structured item operations and memories. A dedicated apply function executes the operations mechanically.

**Tech Stack:** TypeScript, Vitest, LLM via `generateText` (MEDIUM model class)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts` | Modify | Add `ObjectStateDelta`, `ItemOperation` types |
| `src/dynamicworldagent/engine/handlers/objectInteractionStateResolver.ts` | Create | LLM system/user prompts, `resolveObjectInteractionState()`, `applyObjectDelta()` |
| `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts` | Modify | Strip side effects — only location check + skill roll |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | Modify | Call resolver on successful object_interaction, write memories |
| `src/dynamicworldagent/engine/handlers/__tests__/objectInteractionStateResolver.test.ts` | Create | Unit tests for resolver prompt building and delta application |

---

### Task 1: Add Output Types

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts`

- [ ] **Step 1: Add `ItemOperation` and `ObjectStateDelta` types**

```typescript
// After the existing InteractionStateDelta interface

export interface ItemOperation {
  itemId: string;
  operation: "move" | "modify" | "destroy";
  /** Where the item ends up. Required for "move". */
  moveTo?: {
    type: "scene" | "inventory" | "container";
    /** NPC ID when type=inventory. Defaults to actor. */
    ownerId?: string;
    /** Container item ID when type=container. */
    containerId?: string;
  };
  /** Partial Item fields to merge. Used with "modify" (and optionally "move"). */
  updates?: Record<string, unknown>;
}

export interface ObjectStateDelta {
  /** Ordered list of item operations to apply. */
  itemOperations: ItemOperation[];
  /** Scene conditions to add (e.g. "desk drawer left open"). */
  addSceneConditions?: string[];
  /** First-person memory for the actor. */
  memory: string;
  /** First-person memories for co-present NPCs who witnessed the action. */
  witnessMemories?: Record<string, string>;
}
```

- [ ] **Step 2: Build and verify no errors**

Run: `pnpm build`

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts
git commit -m "feat: add ObjectStateDelta and ItemOperation types for object interaction resolver"
```

---

### Task 2: Create Object Interaction State Resolver

**Files:**
- Create: `src/dynamicworldagent/engine/handlers/objectInteractionStateResolver.ts`

- [ ] **Step 1: Create the resolver file with system prompt**

The system prompt instructs the LLM to:
- Output item operations (move/modify/destroy) with exact item IDs from the provided data
- NOT invent items that don't exist in the scene or inventory
- Respect container lock status (locked containers cannot be opened without a key)
- Write first-person memory for the actor
- Write witness memories for co-present NPCs (if any witnessed the action)
- Use the provided language for memory text

```typescript
import { ModelClass, generateText } from "../../../models/index.js";
import type {
  ItemOperation,
  ObjectStateDelta,
  PlanNode,
  SuccessLevel,
} from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { Item } from "../../state/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────

function parseJsonResponse<T>(raw: string): T {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  text = text.replace(/\\([^"\\\/bfnrtu])/g, "$1");
  return JSON.parse(text) as T;
}

function formatItem(item: Item): string {
  const parts: string[] = [`id: ${item.id}`, `name: ${item.name}`];
  if (item.type) parts.push(`type: ${item.type}`);
  if (item.description) parts.push(`desc: ${item.description}`);
  if (item.damaged) parts.push("DAMAGED");
  if (item.category) parts.push(`category: ${item.category}`);
  if (item.isLightSource !== undefined)
    parts.push(item.isLightSource ? "lit" : "unlit");
  if (item.consumableStats?.uses !== undefined)
    parts.push(`uses: ${item.consumableStats.uses}`);
  if (item.containerStats) {
    parts.push(item.containerStats.locked ? "LOCKED" : "unlocked");
    const stored = item.containerStats.storedItems ?? [];
    if (stored.length > 0)
      parts.push(`contains: [${stored.map((s) => s.name).join(", ")}]`);
  }
  if (item.weaponStats?.ammo !== undefined)
    parts.push(`ammo: ${item.weaponStats.ammo}`);
  return `{ ${parts.join(", ")} }`;
}

// ─── Prompt builders ──────────────────────────────────────────────────

function buildSystemPrompt(language: string): string {
  return `You are a tabletop horror RPG 7th Edition game state resolver for object interactions.
Given an NPC's action on objects/items and the skill roll outcome, determine the concrete item state changes.

## Item Operations
Return an ordered list of item operations. Each operation has:
- "itemId": exact ID from the provided scene items or actor inventory. NEVER invent IDs.
- "operation": "move" | "modify" | "destroy"
- "moveTo": (for "move") where the item ends up:
  - { "type": "inventory" } — into actor's inventory (default)
  - { "type": "scene" } — onto the scene floor
  - { "type": "container", "containerId": "<item_id>" } — into a container item
- "updates": (for "modify", optional for "move") partial Item fields to merge. Supported:
  - damaged (boolean), damageDetails: { damagedBy, damagedAt, reason }
  - isLightSource (boolean), lightLevel (number)
  - consumableStats: { uses } — set uses to 0 to consume
  - containerStats: { locked } — set locked:false to unlock
  - weaponStats: { ammo } — decrement for ammo use

## Rules
- Only output operations for items that actually change. If nothing changes, return empty itemOperations.
- A LOCKED container cannot be opened unless the actor has a matching key in their inventory. If they don't have a key, output no operation and explain in memory.
- If the skill check failed, the intended action did not succeed. Reflect this in the memory. You may still output minor side effects (e.g. noise alerting others).
- For "inspect" actions: no item operations needed — just write a detailed memory of what the actor observed.
- For "destroy": the item is removed from play entirely.

## Witnesses
If other NPCs are present in the same scene, decide whether they noticed the action:
- Obvious actions (moving large items, breaking things, loud noise) → witnesses notice
- Subtle actions (quietly pocketing a small item, reading a document) → witnesses may not notice
- Write a witness memory only for NPCs who would plausibly notice.

## Memory
- Always required for the actor.
- Write from that character's first-person perspective: what they did, what they found, what they noticed.
- If inspecting an item, include relevant details they would observe.
- Write in ${language}.

## Output
Return a single JSON object. No extra text. JSON keys in English. Memory values in ${language}.

\`\`\`json
{
  "itemOperations": [
    {
      "itemId": "item_id",
      "operation": "move",
      "moveTo": { "type": "inventory" },
      "updates": {}
    }
  ],
  "addSceneConditions": ["desk drawer left open"],
  "memory": "first-person account of what happened (REQUIRED)",
  "witnessMemories": {
    "<npc_id>": "first-person account from witness perspective"
  }
}
\`\`\``;
}

function buildUserPrompt(
  node: PlanNode,
  actorName: string,
  actorInventory: Item[],
  sceneItems: Item[],
  sceneDescription: string,
  witnesses: Array<{ id: string; name: string }>,
  skillRollResult: { successLevel: SuccessLevel; detail: string } | null,
  actorMemoryContext: string | undefined
): string {
  const nodeSection = JSON.stringify(
    {
      action: node.action,
      type: node.type,
      skill: node.skill,
      impact: node.impact,
      location: node.location,
      objectInteractionPayload: node.objectInteractionPayload,
    },
    null,
    2
  );

  const rollSection = skillRollResult
    ? `Skill roll: ${skillRollResult.successLevel} — ${skillRollResult.detail}`
    : "No skill check — auto success";

  const inventorySection =
    actorInventory.length > 0
      ? actorInventory.map((i) => `  ${formatItem(i)}`).join("\n")
      : "  (empty)";

  const sceneItemsSection =
    sceneItems.length > 0
      ? sceneItems.map((i) => `  ${formatItem(i)}`).join("\n")
      : "  (no items)";

  const witnessSection =
    witnesses.length > 0
      ? witnesses.map((w) => `  ${w.name} (${w.id})`).join("\n")
      : "  (none)";

  const memorySection = actorMemoryContext
    ? `## Actor's Recent Context\n${actorMemoryContext}`
    : "";

  return [
    "# Object Interaction Node",
    nodeSection,
    "",
    rollSection,
    "",
    `## Actor: ${actorName} (${node.characterId})`,
    "### Inventory",
    inventorySection,
    "",
    `## Scene: ${sceneDescription}`,
    "### Scene Items",
    sceneItemsSection,
    "",
    "## Other NPCs Present",
    witnessSection,
    "",
    memorySection,
  ].join("\n");
}

// ─── Main resolver ────────────────────────────────────────────────────

export async function resolveObjectInteractionState(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  runtime: any,
  skillRollResult: { successLevel: SuccessLevel; detail: string } | null,
  language: string,
  memoryManager?: NpcMemoryManager,
  sessionId?: string
): Promise<ObjectStateDelta> {
  const state = dgsm.getState();

  // Actor data
  const actorNpc = state.npcCharacters.find((n) => n.id === node.characterId);
  const actorName = actorNpc?.name ?? node.characterId;
  const actorInventory = dgsm.getNpcInventory(node.characterId);

  // Scene data
  const scene = dgsm.getScene(node.location);
  const sceneItems = scene?.items ?? [];
  const sceneDescription = scene
    ? `${scene.name} (${scene.id}) — ${scene.description ?? ""}`
    : node.location;

  // Witnesses: other NPCs in the same scene
  const witnesses: Array<{ id: string; name: string }> = [];
  for (const npc of state.npcCharacters) {
    if (npc.id === node.characterId) continue;
    const pos = dgsm.getCharacterPosition(npc.id);
    if (!pos) continue;
    const locId = dgsm.resolveLocationId(pos);
    if (locId === node.location) {
      witnesses.push({ id: npc.id, name: npc.name });
    }
  }

  // Actor memory context
  let actorMemoryContext: string | undefined;
  if (memoryManager && sessionId) {
    actorMemoryContext = await memoryManager.getContext({
      npcId: node.characterId,
      sessionId,
      purpose: "action",
      query: node.action,
      currentGameDay: state.gameDay,
    });
  }

  const systemPrompt = buildSystemPrompt(language);
  const userPrompt = buildUserPrompt(
    node,
    actorName,
    actorInventory,
    sceneItems,
    sceneDescription,
    witnesses,
    skillRollResult,
    actorMemoryContext
  );

  try {
    const response = await generateText({
      runtime,
      context: userPrompt,
      customSystemPrompt: systemPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    const parsed = parseJsonResponse<{
      itemOperations?: ItemOperation[];
      addSceneConditions?: string[];
      memory?: string;
      witnessMemories?: Record<string, string>;
    }>(response);

    return {
      itemOperations: parsed.itemOperations ?? [],
      addSceneConditions: parsed.addSceneConditions,
      memory: parsed.memory ?? node.action,
      witnessMemories: parsed.witnessMemories,
    };
  } catch (error) {
    console.warn(
      `[ObjectInteractionResolver] LLM call failed, using fallback:`,
      error instanceof Error ? error.message : error
    );
    return {
      itemOperations: [],
      memory: node.action,
    };
  }
}

// ─── State applicator ─────────────────────────────────────────────────

export function applyObjectDelta(
  dgsm: DynamicGameStateManager,
  actorId: string,
  delta: ObjectStateDelta,
  sceneId: string
): void {
  const scene = dgsm.getScene(sceneId);

  for (const op of delta.itemOperations) {
    // Find the item from scene or actor inventory
    let item: Item | undefined;
    let sourceType: "scene" | "inventory" | "container" | undefined;
    let sourceContainerId: string | undefined;

    // Try actor inventory
    const invItem = dgsm.findNpcItem(actorId, op.itemId);
    if (invItem) {
      sourceType = "inventory";
      item = invItem;
    }

    // Try scene items
    if (!item && scene) {
      const sceneItem = scene.items.find((i) => i.id === op.itemId);
      if (sceneItem) {
        sourceType = "scene";
        item = sceneItem;
      }
    }

    // Try inside containers (scene items that are containers)
    if (!item && scene) {
      for (const containerItem of scene.items) {
        if (!containerItem.containerStats?.storedItems) continue;
        const stored = containerItem.containerStats.storedItems.find(
          (s) => s.id === op.itemId
        );
        if (stored) {
          sourceType = "container";
          sourceContainerId = containerItem.id;
          item = stored;
          break;
        }
      }
    }

    // Try inside inventory containers
    if (!item) {
      const inv = dgsm.getNpcInventory(actorId);
      for (const containerItem of inv) {
        if (!containerItem.containerStats?.storedItems) continue;
        const stored = containerItem.containerStats.storedItems.find(
          (s) => s.id === op.itemId
        );
        if (stored) {
          sourceType = "container";
          sourceContainerId = containerItem.id;
          item = stored;
          break;
        }
      }
    }

    if (!item) {
      console.warn(
        `[ObjectInteractionResolver] Item ${op.itemId} not found, skipping`
      );
      continue;
    }

    // Apply updates (for modify and move+modify)
    if (op.updates && Object.keys(op.updates).length > 0) {
      for (const [key, value] of Object.entries(op.updates)) {
        if (value !== undefined) {
          (item as any)[key] = value;
        }
      }
    }

    if (op.operation === "destroy") {
      // Remove from wherever it is
      if (sourceType === "inventory") {
        dgsm.removeItemFromNpc(actorId, op.itemId);
      } else if (sourceType === "scene" && scene) {
        const idx = scene.items.findIndex((i) => i.id === op.itemId);
        if (idx !== -1) scene.items.splice(idx, 1);
      } else if (sourceType === "container" && sourceContainerId) {
        // Remove from container's storedItems
        removeFromContainer(dgsm, actorId, sceneId, sourceContainerId, op.itemId);
      }
      continue;
    }

    if (op.operation === "move" && op.moveTo) {
      // Remove from source
      if (sourceType === "inventory") {
        dgsm.removeItemFromNpc(actorId, op.itemId);
      } else if (sourceType === "scene" && scene) {
        const idx = scene.items.findIndex((i) => i.id === op.itemId);
        if (idx !== -1) scene.items.splice(idx, 1);
      } else if (sourceType === "container" && sourceContainerId) {
        removeFromContainer(dgsm, actorId, sceneId, sourceContainerId, op.itemId);
      }

      // Add to destination
      const dest = op.moveTo;
      if (dest.type === "inventory") {
        const ownerId = dest.ownerId ?? actorId;
        dgsm.addItemToNpc(ownerId, item);
      } else if (dest.type === "scene" && scene) {
        scene.items.push(item);
      } else if (dest.type === "container" && dest.containerId) {
        addToContainer(dgsm, actorId, sceneId, dest.containerId, item);
      }
    }
    // "modify" with no move: updates already applied in-place above
  }

  // Scene conditions
  if (delta.addSceneConditions) {
    for (const desc of delta.addSceneConditions) {
      dgsm.appendSceneCondition(sceneId, { description: desc });
    }
  }
}

// ─── Container helpers ────────────────────────────────────────────────

function findContainerItem(
  dgsm: DynamicGameStateManager,
  actorId: string,
  sceneId: string,
  containerId: string
): Item | undefined {
  // Check scene
  const scene = dgsm.getScene(sceneId);
  if (scene) {
    const found = scene.items.find((i) => i.id === containerId);
    if (found) return found;
  }
  // Check actor inventory
  return dgsm.findNpcItem(actorId, containerId);
}

function removeFromContainer(
  dgsm: DynamicGameStateManager,
  actorId: string,
  sceneId: string,
  containerId: string,
  itemId: string
): void {
  const container = findContainerItem(dgsm, actorId, sceneId, containerId);
  if (!container?.containerStats?.storedItems) return;
  const stored = container.containerStats.storedItems;
  const idx = stored.findIndex((s) => s.id === itemId);
  if (idx !== -1) {
    stored.splice(idx, 1);
    container.containerStats.contents = stored.map((s) => s.id);
  }
}

function addToContainer(
  dgsm: DynamicGameStateManager,
  actorId: string,
  sceneId: string,
  containerId: string,
  item: Item
): void {
  const container = findContainerItem(dgsm, actorId, sceneId, containerId);
  if (!container?.containerStats) return;
  const stored = container.containerStats.storedItems ?? [];
  stored.push(item);
  container.containerStats.storedItems = stored;
  container.containerStats.contents = stored.map((s) => s.id);
}
```

- [ ] **Step 2: Build and verify no errors**

Run: `pnpm build`

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/objectInteractionStateResolver.ts
git commit -m "feat: add LLM resolver for object_interaction"
```

---

### Task 3: Simplify Object Interaction Handler

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts`

The handler keeps **only** mechanical pre-checks:
1. Location check
2. Item existence check (for the primary `itemId` in payload)
3. Skill roll (if `node.skill` present)

All side effects (item moves, use logic, destroy) are removed — the LLM resolver handles them.

- [ ] **Step 1: Rewrite the handler's execute method**

Replace the entire `execute()` method body. Keep the existing normal-use type handlers (`useConsumable`, `useKey`, `useLighting`, `useContainer`) and container/move helpers as private fallback utilities (they'll be used by the fallback path when LLM fails), but the `execute()` method itself only does:

```typescript
async execute(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  ctx: ExecutionContext
): Promise<CharacterAction> {
  const state = dgsm.getState();
  const pos = dgsm.getCharacterPosition(node.characterId);
  const npc = state.npcCharacters.find((n) => n.id === node.characterId);
  const npcSkills = npc?.skills ?? {};
  const difficulty = ctx.getNodeDifficulty(node, dgsm);

  // Scene + character penalties
  const scenePenalties = ctx.getScenePenalties(node.location, dgsm);
  const charPenalties = ctx.getCharacterPenalties(node.characterId, dgsm);
  const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
  const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

  // Location check
  if (!isCharacterAtLocation(pos, node.location)) {
    return makeAction(
      node,
      "failed",
      buildOutcome(node, "failed", { reason: "not at expected location" }),
      { difficulty, failureReason: "location_mismatch" }
    );
  }

  // Skill roll (only when node.skill is set)
  let resolvedSuccessLevel: SuccessLevel | undefined;
  let lastRollDetail: string | undefined;

  if (node.skill) {
    const rollResult = ctx.resolveSkillRoll(node, adjustedSkills, dgsm);
    resolvedSuccessLevel = rollResult.successLevel;
    if (rollResult.failed) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { rollDetail: rollResult.reason }),
        {
          difficulty,
          successLevel: resolvedSuccessLevel,
          failureReason: "skill_roll_failed",
        }
      );
    }
    lastRollDetail = rollResult.detail;
  }

  // Return success — tickProcessor handles LLM resolution
  const action = makeAction(
    node,
    "completed",
    node.action,
    { difficulty, successLevel: resolvedSuccessLevel }
  );
  action.rollDetail = lastRollDetail;
  return action;
},
```

- [ ] **Step 2: Add SuccessLevel import**

The handler now needs the `SuccessLevel` type import:
```typescript
import type {
  CharacterAction,
  ItemLocationRef,
  PlanNode,
  SuccessLevel,
} from "../../dynamicBasicAgent/npcPlanning/types.js";
```

- [ ] **Step 3: Build and verify no errors**

Run: `pnpm build`

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts
git commit -m "refactor: simplify object_interaction handler to checks-only, defer side effects to LLM resolver"
```

---

### Task 4: Wire Resolver into TickProcessor

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

- [ ] **Step 1: Add imports**

```typescript
import {
  resolveObjectInteractionState,
  applyObjectDelta,
} from "../../engine/handlers/objectInteractionStateResolver.js";
```

- [ ] **Step 2: Add object_interaction post-execution block**

After the existing character_interaction post-execution block (around line 1213), and before the general memory write block, add:

```typescript
    // 4b. object_interaction: call LLM resolver for item state changes
    if (
      action.status === "completed" &&
      node.type === "object_interaction"
    ) {
      const skillRollResult =
        action.successLevel
          ? { successLevel: action.successLevel, detail: action.rollDetail ?? "" }
          : null;

      const delta = await resolveObjectInteractionState(
        node,
        dgsm,
        ctx.runtime,
        skillRollResult,
        language,
        memoryManager,
        sessionId
      );

      // Apply item operations
      applyObjectDelta(dgsm, node.characterId, delta, node.location);

      // Override action outcome with LLM memory
      action.outcome = delta.memory;
      action.stateMemories = {
        [node.characterId]: delta.memory,
        ...(delta.witnessMemories ?? {}),
      };
    }
```

The existing memory write block already handles `action.stateMemories`:
- Actor memory: uses `action.stateMemories[node.characterId]` if present
- Witness memories: iterates `action.stateMemories` entries (skipping actor)

So no changes needed to the memory write block — it already supports per-character memories.

- [ ] **Step 3: Build and verify no errors**

Run: `pnpm build`

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "feat: wire object_interaction LLM resolver into tickProcessor"
```

---

### Task 5: Write Tests

**Files:**
- Create: `src/dynamicworldagent/engine/handlers/__tests__/objectInteractionStateResolver.test.ts`

- [ ] **Step 1: Write unit tests for applyObjectDelta**

```typescript
import { describe, expect, it } from "vitest";
import { applyObjectDelta } from "../objectInteractionStateResolver.js";
import type { ObjectStateDelta } from "../../../dynamicBasicAgent/npcPlanning/types.js";

function createMockDgsm() {
  const inventories: Record<string, any[]> = {};
  const scenes: Record<string, { id: string; name: string; items: any[] }> = {};
  const sceneConditions: Record<string, any[]> = {};

  return {
    getScene(id: string) { return scenes[id] ?? null; },
    getNpcInventory(npcId: string) { return inventories[npcId] ?? []; },
    findNpcItem(npcId: string, itemId: string) {
      return (inventories[npcId] ?? []).find((i: any) => i.id === itemId);
    },
    addItemToNpc(npcId: string, item: any) {
      if (!inventories[npcId]) inventories[npcId] = [];
      inventories[npcId].push(item);
    },
    removeItemFromNpc(npcId: string, itemId: string) {
      const inv = inventories[npcId] ?? [];
      const idx = inv.findIndex((i: any) => i.id === itemId);
      if (idx === -1) return undefined;
      return inv.splice(idx, 1)[0];
    },
    appendSceneCondition(sceneId: string, cond: any) {
      if (!sceneConditions[sceneId]) sceneConditions[sceneId] = [];
      sceneConditions[sceneId].push(cond);
    },
    getCharacterPosition() { return null; },
    resolveLocationId() { return ""; },
    // Test helpers
    _addScene(id: string, name: string, items: any[]) {
      scenes[id] = { id, name, items };
    },
    _addInventory(npcId: string, items: any[]) {
      inventories[npcId] = items;
    },
    _getConditions(sceneId: string) {
      return sceneConditions[sceneId] ?? [];
    },
  };
}

describe("applyObjectDelta", () => {
  it("moves item from scene to actor inventory", () => {
    const dgsm = createMockDgsm();
    dgsm._addScene("office", "Office", [
      { id: "cash_box", name: "Cash Box", type: "container" },
    ]);
    dgsm._addInventory("npc_victor", []);

    const delta: ObjectStateDelta = {
      itemOperations: [
        {
          itemId: "cash_box",
          operation: "move",
          moveTo: { type: "inventory" },
        },
      ],
      memory: "I picked up the cash box.",
    };

    applyObjectDelta(dgsm as any, "npc_victor", delta, "office");

    expect(dgsm.getScene("office")!.items).toHaveLength(0);
    expect(dgsm.getNpcInventory("npc_victor")).toHaveLength(1);
    expect(dgsm.getNpcInventory("npc_victor")[0].id).toBe("cash_box");
  });

  it("modifies item in-place without moving", () => {
    const dgsm = createMockDgsm();
    dgsm._addScene("office", "Office", [
      { id: "drawer", name: "Desk Drawer", type: "container",
        containerStats: { locked: true, storedItems: [], contents: [] } },
    ]);

    const delta: ObjectStateDelta = {
      itemOperations: [
        {
          itemId: "drawer",
          operation: "modify",
          updates: { containerStats: { locked: false, storedItems: [], contents: [] } },
        },
      ],
      memory: "I unlocked the drawer.",
    };

    applyObjectDelta(dgsm as any, "npc_victor", delta, "office");

    const drawer = dgsm.getScene("office")!.items[0];
    expect(drawer.containerStats.locked).toBe(false);
  });

  it("destroys item from scene", () => {
    const dgsm = createMockDgsm();
    dgsm._addScene("office", "Office", [
      { id: "paper", name: "Incriminating Paper" },
    ]);

    const delta: ObjectStateDelta = {
      itemOperations: [
        { itemId: "paper", operation: "destroy" },
      ],
      memory: "I burned the paper.",
    };

    applyObjectDelta(dgsm as any, "npc_victor", delta, "office");

    expect(dgsm.getScene("office")!.items).toHaveLength(0);
  });

  it("adds scene conditions", () => {
    const dgsm = createMockDgsm();
    dgsm._addScene("office", "Office", []);

    const delta: ObjectStateDelta = {
      itemOperations: [],
      addSceneConditions: ["desk drawer left open"],
      memory: "I left the drawer open.",
    };

    applyObjectDelta(dgsm as any, "npc_victor", delta, "office");

    expect(dgsm._getConditions("office")).toHaveLength(1);
    expect(dgsm._getConditions("office")[0].description).toBe("desk drawer left open");
  });

  it("skips unknown items gracefully", () => {
    const dgsm = createMockDgsm();
    dgsm._addScene("office", "Office", []);

    const delta: ObjectStateDelta = {
      itemOperations: [
        { itemId: "nonexistent", operation: "move", moveTo: { type: "inventory" } },
      ],
      memory: "Nothing happened.",
    };

    // Should not throw
    applyObjectDelta(dgsm as any, "npc_victor", delta, "office");
    expect(dgsm.getNpcInventory("npc_victor")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test src/dynamicworldagent/engine/handlers/__tests__/objectInteractionStateResolver.test.ts`

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/__tests__/objectInteractionStateResolver.test.ts
git commit -m "test: add unit tests for object interaction state resolver"
```

---

### Task 6: Remove Old Handler Side Effects

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts`

After confirming the resolver works end-to-end, remove the now-unused internal functions from the handler:
- `useConsumable`, `useKey`, `useLighting`, `useContainer`
- `buildInspectOutcome`, `buildInspectOutcomeWithContext`, `syncContainerContents`
- `findContainer`, `removeItemFromMoveSource`, `addItemToMoveTarget`, `formatMoveRef`

Keep only the handler definition with the simplified `execute()` method.

- [ ] **Step 1: Remove unused functions**

Remove all internal helper functions that are no longer called by `execute()`.

- [ ] **Step 2: Build and run tests**

Run: `pnpm build && pnpm test`

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts
git commit -m "refactor: remove unused handler side-effect functions, now handled by LLM resolver"
```
