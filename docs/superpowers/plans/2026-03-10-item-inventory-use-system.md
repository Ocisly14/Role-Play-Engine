# Item Inventory & Use System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix item pickup/place data loss, implement use/inspect/destroy logic, and change NPC inventories from string IDs to full Item objects.

**Architecture:** Change `npcInventories` from `Record<string, string[]>` to `Record<string, Item[]>`. Rewrite `objectInteractionHandler` with proper item transfer, dual-path use system (normal type handlers + non-normal LLM-driven skill checks), inspect result encoding, and error handling. Update handler `exampleNode` (used by registry-generated LLM prompts) and fallback template constants.

**Tech Stack:** TypeScript, Vitest

**Note on backward compatibility:** Existing serialized game states may have `npcInventories` as `string[]`. Checkpoint restoration from older saves is out of scope for this plan — the loader handles fresh initialization only.

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `src/dynamicworldagent/state/DynamicGameState.ts` | State interface + manager methods for inventory | Modify |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts` | `ObjectInteractionPayload` type definition | Modify |
| `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts` | All 5 interaction actions + handler metadata (`exampleNode`) | Rewrite |
| `src/dynamicworldagent/engine/shared/nodeHelpers.ts` | Outcome string formatting for extended payload | Modify |
| `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts` | Item transfer between characters | Modify |
| `src/dynamicworldagent/state/DynamicGameStateLoader.ts` | InventoryItem→Item conversion during init | Modify |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts` | LLM prompt fallback constants | Modify |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts` | LLM prompt fallback constants | Modify |
| `src/dynamicworldagent/engine/handlers/__tests__/objectInteractionHandler.test.ts` | Tests for all 5 actions | Create |
| `src/dynamicworldagent/engine/shared/deepMerge.ts` | Deep merge utility for item updates | Create |

---

## Chunk 1: Core Type Changes & Inventory Methods

### Task 1: Extend ObjectInteractionPayload

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts:28-31`

- [ ] **Step 1: Update the ObjectInteractionPayload interface**

In `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts`, add a new import after line 1 and replace lines 28–31:

```typescript
// Add import after line 1:
import type { Item } from "../../world_builder/types.js";

// Replace lines 28-31:
// OLD:
export interface ObjectInteractionPayload {
  action: "pickup" | "place" | "use" | "inspect" | "destroy";
  itemId?: string;
}

// NEW:
export interface ObjectInteractionPayload {
  action: "pickup" | "place" | "use" | "inspect" | "destroy";
  itemId?: string;
  targetItemId?: string;
  /** Non-normal use: LLM returns expected item state changes after success */
  itemUpdates?: Partial<Item>;
  targetItemUpdates?: Partial<Item>;
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: Build succeeds (no consumers of the new fields yet)

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts
git commit -m "feat(items): extend ObjectInteractionPayload with targetItemId and itemUpdates"
```

---

### Task 2: Change npcInventories to Item[] and update manager methods

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameState.ts:161, 1541-1553`

- [ ] **Step 1: Add Item import**

At line 30–35, add `Item` to the existing import from `../world_builder/types.js`:

```typescript
import type {
  DynamicCharacterProfile,
  DynamicNPCProfile,
  DynamicScene,
  Item,
  TransportEdge,
} from "../world_builder/types.js";
```

- [ ] **Step 2: Change npcInventories type**

At line 161, change:

```typescript
// OLD:
npcInventories: Record<string, string[]>;
// NEW:
npcInventories: Record<string, Item[]>;
```

- [ ] **Step 3: Update manager methods**

Replace lines 1541–1553 (the three inventory methods) with:

```typescript
  getNpcInventory(npcId: string): Item[] {
    return this.state.npcInventories[npcId] ?? [];
  }

  findNpcItem(npcId: string, itemId: string): Item | undefined {
    return this.state.npcInventories[npcId]?.find(i => i.id === itemId);
  }

  addItemToNpc(npcId: string, item: Item): void {
    if (!this.state.npcInventories[npcId]) this.state.npcInventories[npcId] = [];
    this.state.npcInventories[npcId].push(item);
  }

  removeItemFromNpc(npcId: string, itemId: string): Item | undefined {
    if (!this.state.npcInventories[npcId]) return undefined;
    const idx = this.state.npcInventories[npcId].findIndex(i => i.id === itemId);
    if (idx === -1) return undefined;
    return this.state.npcInventories[npcId].splice(idx, 1)[0];
  }
```

- [ ] **Step 4: Verify build shows expected type errors at call sites**

Run: `pnpm build 2>&1 | head -40`
Expected: Type errors in `objectInteractionHandler.ts` and `characterInteractionHandler.ts` where `addItemToNpc` is called with a string.

- [ ] **Step 5: Commit**

```bash
git add src/dynamicworldagent/state/DynamicGameState.ts
git commit -m "feat(items): change npcInventories to Item[] with updated manager methods"
```

---

### Task 3: Update DynamicGameStateLoader inventory initialization

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameStateLoader.ts:807-814`

- [ ] **Step 1: Update the npcInventories initialization code**

At lines 807–814, replace:

```typescript
// OLD:
if (!completeState.npcInventories[npc.id]) {
  completeState.npcInventories[npc.id] = Array.isArray(npc.inventory)
    ? npc.inventory.map((item) =>
        typeof item === "string" ? item : item.name ?? String(item)
      )
    : [];
}
```

With:

```typescript
// NEW:
if (!completeState.npcInventories[npc.id]) {
  completeState.npcInventories[npc.id] = Array.isArray(npc.inventory)
    ? npc.inventory.map((item) => {
        if (typeof item === "string") {
          return { id: item, name: item };
        }
        return {
          id: item.name ?? String(item),
          name: item.name ?? String(item),
          ...(item.properties ?? {}),
        };
      })
    : [];
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build 2>&1 | head -20`
Expected: This file compiles. Remaining errors only in handler files.

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/state/DynamicGameStateLoader.ts
git commit -m "feat(items): convert InventoryItem to Item in loader initialization"
```

---

### Task 4: Update characterInteractionHandler for new addItemToNpc signature

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts:136-138`

- [ ] **Step 1: Update item transfer logic with error handling**

At lines 136–138, replace:

```typescript
// OLD:
if (payload.transferType === "item" && payload.itemId) {
  dgsm.removeItemFromNpc(node.characterId, payload.itemId);
  dgsm.addItemToNpc(node.targetCharacterId, payload.itemId);
```

With:

```typescript
// NEW:
if (payload.transferType === "item" && payload.itemId) {
  const item = dgsm.removeItemFromNpc(node.characterId, payload.itemId);
  if (!item) {
    return makeAction(
      node,
      "failed",
      buildOutcome(node, "failed", { reason: `item ${payload.itemId} not in inventory` }),
      { difficulty, failureReason: "object_not_found" },
    );
  }
  dgsm.addItemToNpc(node.targetCharacterId, item);
```

- [ ] **Step 2: Verify build**

Run: `pnpm build 2>&1 | head -20`
Expected: Only `objectInteractionHandler.ts` errors remain.

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts
git commit -m "fix(items): update character interaction handler for Item-based inventory"
```

---

### Task 5: Update nodeHelpers outcome string for extended payload

**Files:**
- Modify: `src/dynamicworldagent/engine/shared/nodeHelpers.ts:20-22`

- [ ] **Step 1: Update outcome builder for targetItemId**

At lines 20–22, replace:

```typescript
// OLD:
} else if (node.type === "object_interaction" && node.objectInteractionPayload) {
    const p = node.objectInteractionPayload;
    parts.push(`(${p.action}${p.itemId ? `: ${p.itemId}` : ""})`);
```

With:

```typescript
// NEW:
} else if (node.type === "object_interaction" && node.objectInteractionPayload) {
    const p = node.objectInteractionPayload;
    const target = p.targetItemId ? ` → ${p.targetItemId}` : "";
    parts.push(`(${p.action}${p.itemId ? `: ${p.itemId}` : ""}${target})`);
```

- [ ] **Step 2: Verify build**

Run: `pnpm build 2>&1 | head -20`
Expected: Only objectInteractionHandler errors remain.

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/shared/nodeHelpers.ts
git commit -m "feat(items): include targetItemId in outcome string"
```

---

## Chunk 2: Deep Merge Utility & Handler Rewrite

### Task 6: Create deep merge utility

**Files:**
- Create: `src/dynamicworldagent/engine/shared/deepMerge.ts`
- Create: `src/dynamicworldagent/engine/shared/__tests__/deepMerge.test.ts`

- [ ] **Step 1: Write tests**

Create file `src/dynamicworldagent/engine/shared/__tests__/deepMerge.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { deepMergeItem } from "../deepMerge.js";

describe("deepMergeItem", () => {
  it("overwrites flat fields", () => {
    const target = { id: "x", name: "Torch", description: "A lit torch" };
    const updates = { description: "A burnt-out torch" };
    const result = deepMergeItem(target, updates);
    expect(result.description).toBe("A burnt-out torch");
    expect(result.name).toBe("Torch");
  });

  it("deep-merges nested objects", () => {
    const target = {
      id: "x",
      name: "Safe",
      containerStats: { capacity: 10, locked: true, lockDifficulty: "hard" as const, contents: [] },
    };
    const updates = { containerStats: { locked: false } };
    const result = deepMergeItem(target, updates);
    expect(result.containerStats!.locked).toBe(false);
    expect(result.containerStats!.capacity).toBe(10);
    expect(result.containerStats!.lockDifficulty).toBe("hard");
  });

  it("replaces arrays (does not merge them)", () => {
    const target = {
      id: "x",
      name: "Box",
      containerStats: { capacity: 5, locked: false, contents: ["item_a"] },
    };
    const updates = { containerStats: { contents: ["item_b"] } };
    const result = deepMergeItem(target, updates);
    expect(result.containerStats!.contents).toEqual(["item_b"]);
  });

  it("adds new fields without removing existing ones", () => {
    const target = { id: "x", name: "Key" };
    const updates = { damaged: true, damageDetails: { damagedBy: "fire", damagedAt: "12:00", reason: "burned" } };
    const result = deepMergeItem(target, updates);
    expect(result.damaged).toBe(true);
    expect(result.damageDetails!.damagedBy).toBe("fire");
    expect(result.name).toBe("Key");
  });

  it("returns mutated target (in-place merge)", () => {
    const target = { id: "x", name: "Pen" };
    const updates = { description: "A red pen" };
    const result = deepMergeItem(target, updates);
    expect(result).toBe(target);
  });

  it("skips undefined values in updates", () => {
    const target = { id: "x", name: "Torch", description: "A lit torch" };
    const updates = { description: undefined };
    const result = deepMergeItem(target, updates);
    expect(result.description).toBe("A lit torch");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/dynamicworldagent/engine/shared/__tests__/deepMerge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement deepMergeItem**

Create file `src/dynamicworldagent/engine/shared/deepMerge.ts`:

```typescript
/**
 * Deep-merge `updates` into `target` in place.
 * - Plain objects are merged recursively (field by field).
 * - Arrays and primitives are overwritten.
 * - undefined values in updates are skipped.
 * Returns the mutated `target`.
 */
export function deepMergeItem<T extends Record<string, unknown>>(target: T, updates: Partial<T>): T {
  for (const key of Object.keys(updates) as Array<keyof T>) {
    const uVal = updates[key];
    if (uVal === undefined) continue;
    const tVal = target[key];
    if (
      uVal !== null &&
      typeof uVal === "object" &&
      !Array.isArray(uVal) &&
      tVal !== null &&
      typeof tVal === "object" &&
      !Array.isArray(tVal)
    ) {
      deepMergeItem(
        tVal as Record<string, unknown>,
        uVal as Record<string, unknown>,
      );
    } else {
      (target as Record<string, unknown>)[key as string] = uVal;
    }
  }
  return target;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/dynamicworldagent/engine/shared/__tests__/deepMerge.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/dynamicworldagent/engine/shared/deepMerge.ts src/dynamicworldagent/engine/shared/__tests__/deepMerge.test.ts
git commit -m "feat(items): add deepMergeItem utility for non-normal use updates"
```

---

### Task 7: Write objectInteractionHandler tests

**Files:**
- Create: `src/dynamicworldagent/engine/handlers/__tests__/objectInteractionHandler.test.ts`

- [ ] **Step 1: Create test file with mock DGSM and all test cases**

Create `src/dynamicworldagent/engine/handlers/__tests__/objectInteractionHandler.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { objectInteractionHandler } from "../objectInteractionHandler.js";
import type { PlanNode, CharacterAction } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { Item, DynamicScene } from "../../../world_builder/types.js";
import type { ExecutionContext } from "../../types.js";

// ===== Mock DGSM =====

function createMockDgsm() {
  const scenes: Record<string, DynamicScene> = {};
  const npcInventories: Record<string, Item[]> = {};
  const npcLocations: Record<string, string> = {};
  const npcCharacters: Array<{ id: string; skills: Record<string, number>; status: { luck: number } }> = [];

  return {
    getState() {
      return { npcCharacters, npcInventories };
    },
    getScene(sceneId: string) {
      return scenes[sceneId] ?? null;
    },
    getCurrentScene() {
      return null; // should not be used
    },
    getNpcLocation(npcId: string) {
      return npcLocations[npcId] ?? null;
    },
    getNpcInventory(npcId: string): Item[] {
      return npcInventories[npcId] ?? [];
    },
    findNpcItem(npcId: string, itemId: string): Item | undefined {
      return npcInventories[npcId]?.find(i => i.id === itemId);
    },
    addItemToNpc(npcId: string, item: Item) {
      if (!npcInventories[npcId]) npcInventories[npcId] = [];
      npcInventories[npcId].push(item);
    },
    removeItemFromNpc(npcId: string, itemId: string): Item | undefined {
      if (!npcInventories[npcId]) return undefined;
      const idx = npcInventories[npcId].findIndex(i => i.id === itemId);
      if (idx === -1) return undefined;
      return npcInventories[npcId].splice(idx, 1)[0];
    },
    // Helpers for test setup
    _addScene(id: string, items: Item[] = [], events: string[] = []) {
      scenes[id] = { id, name: id, items, events, clues: [], connections: [] } as unknown as DynamicScene;
    },
    _addNpc(npcId: string, location: string, skills: Record<string, number> = {}, luck = 50) {
      npcLocations[npcId] = location;
      npcCharacters.push({ id: npcId, skills, status: { luck } });
    },
    _scenes: scenes,
    _npcInventories: npcInventories,
  };
}

function createMockCtx(): ExecutionContext {
  return {
    getNodeDifficulty: () => "regular" as const,
    getScenePenalties: () => new Map<string, number>(),
    getCharacterPenalties: () => new Map<string, number>(),
    applyPenalties: (skills: Record<string, number>, _penalties: Map<string, number>) => skills,
    luckFailureRate: () => 0, // never fails luck
    resolveSkillRoll: () => ({ failed: false, detail: "Regular success", successLevel: "regular" as const }),
  } as unknown as ExecutionContext;
}

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: "oi1",
    characterId: "player-1",
    characterName: "Investigator",
    gameTime: "10:00",
    action: "interact with object",
    location: "study",
    type: "object_interaction",
    impact: 1 as const,
    timeAdvanceMinutes: 5,
    status: "pending" as const,
    isPlayer: true,
    ...overrides,
  } as PlanNode;
}

describe("objectInteractionHandler", () => {
  let dgsm: ReturnType<typeof createMockDgsm>;
  let ctx: ExecutionContext;

  beforeEach(() => {
    dgsm = createMockDgsm();
    ctx = createMockCtx();
  });

  // ── Pickup ──

  describe("pickup", () => {
    it("transfers full Item from scene to NPC inventory", () => {
      const torch: Item = { id: "torch", name: "Torch", type: "lighting", isLightSource: true, lightLevel: 3 };
      dgsm._addScene("study", [torch]);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "pickup", itemId: "torch" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._scenes["study"].items).toHaveLength(0);
      expect(dgsm._npcInventories["player-1"]).toHaveLength(1);
      expect(dgsm._npcInventories["player-1"][0]).toEqual(torch);
    });

    it("fails when item not found in scene", () => {
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "pickup", itemId: "missing_item" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("object_not_found");
    });
  });

  // ── Place ──

  describe("place", () => {
    it("transfers full Item from NPC inventory to scene", () => {
      const key: Item = { id: "room_key", name: "Room Key", type: "key" };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", key);

      const node = makeNode({
        objectInteractionPayload: { action: "place", itemId: "room_key" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._npcInventories["player-1"]).toHaveLength(0);
      expect(dgsm._scenes["study"].items).toHaveLength(1);
      expect(dgsm._scenes["study"].items[0]).toEqual(key);
    });

    it("fails when item not in inventory", () => {
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "place", itemId: "missing_item" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("object_not_found");
    });
  });

  // ── Use (normal) ──

  describe("use — normal (no actionType)", () => {
    it("decrements consumable uses and removes when exhausted", () => {
      const medkit: Item = {
        id: "medkit", name: "First Aid Kit", type: "consumable",
        consumableStats: { uses: 1, effect: "heals minor wounds" },
      };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", medkit);

      const node = makeNode({
        objectInteractionPayload: { action: "use", itemId: "medkit" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._npcInventories["player-1"]).toHaveLength(0);
    });

    it("decrements consumable uses but keeps item when uses remain", () => {
      const bandage: Item = {
        id: "bandage", name: "Bandage Roll", type: "consumable",
        consumableStats: { uses: 3, effect: "stops bleeding" },
      };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", bandage);

      const node = makeNode({
        objectInteractionPayload: { action: "use", itemId: "bandage" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._npcInventories["player-1"]).toHaveLength(1);
      expect(dgsm._npcInventories["player-1"][0].consumableStats!.uses).toBe(2);
    });

    it("toggles lighting isLightSource", () => {
      const flashlight: Item = { id: "flashlight", name: "Flashlight", type: "lighting", isLightSource: false, lightLevel: 3 };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", flashlight);

      const node = makeNode({
        objectInteractionPayload: { action: "use", itemId: "flashlight" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._npcInventories["player-1"][0].isLightSource).toBe(true);
    });

    it("unlocks target container with key", () => {
      const key: Item = { id: "room_key", name: "Room Key", type: "key" };
      const safe: Item = {
        id: "safe", name: "Safe", type: "container",
        containerStats: { capacity: 10, locked: true, lockDifficulty: "hard", contents: [] },
      };
      dgsm._addScene("study", [safe]);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", key);

      const node = makeNode({
        objectInteractionPayload: { action: "use", itemId: "room_key", targetItemId: "safe" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._scenes["study"].items[0].containerStats!.locked).toBe(false);
    });

    it("fails when key used without targetItemId", () => {
      const key: Item = { id: "room_key", name: "Room Key", type: "key" };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", key);

      const node = makeNode({
        objectInteractionPayload: { action: "use", itemId: "room_key" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("object_not_found");
    });

    it("opens unlocked container", () => {
      const box: Item = {
        id: "box", name: "Box", type: "container",
        containerStats: { capacity: 5, locked: false, contents: [] },
      };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", box);

      const node = makeNode({
        objectInteractionPayload: { action: "use", itemId: "box" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
    });

    it("document use is a no-op success", () => {
      const diary: Item = { id: "diary", name: "Diary", type: "document", description: "A worn diary." };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", diary);

      const node = makeNode({
        objectInteractionPayload: { action: "use", itemId: "diary" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
    });
  });

  // ── Use (non-normal) ──

  describe("use — non-normal (has actionType)", () => {
    it("applies itemUpdates and targetItemUpdates on success", () => {
      const acid: Item = {
        id: "acid", name: "Acid", type: "consumable",
        consumableStats: { uses: 1, effect: "corrosive" },
      };
      const lock: Item = {
        id: "padlock", name: "Padlock", type: "container",
        containerStats: { capacity: 0, locked: true, lockDifficulty: "hard", contents: [] },
      };
      dgsm._addScene("study", [lock]);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", acid);

      const node = makeNode({
        actionType: "exploration",
        objectInteractionPayload: {
          action: "use",
          itemId: "acid",
          targetItemId: "padlock",
          itemUpdates: { consumableStats: { uses: 0, effect: "corrosive" } },
          targetItemUpdates: { containerStats: { locked: false }, damaged: true },
        },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._scenes["study"].items[0].containerStats!.locked).toBe(false);
      expect(dgsm._scenes["study"].items[0].damaged).toBe(true);
      // Acid consumed (uses=0) should be removed from inventory
      expect(dgsm._npcInventories["player-1"]).toHaveLength(0);
    });

    it("does not apply updates on skill check failure", () => {
      const failCtx = {
        ...ctx,
        resolveSkillRoll: () => ({ failed: true, reason: "Fumble", successLevel: "fumble" as const }),
      } as unknown as ExecutionContext;

      const lockpick: Item = { id: "lockpick", name: "Lockpick", type: "tool" };
      const safe: Item = {
        id: "safe", name: "Safe", type: "container",
        containerStats: { capacity: 10, locked: true, lockDifficulty: "hard", contents: [] },
      };
      dgsm._addScene("study", [safe]);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", lockpick);

      const node = makeNode({
        actionType: "stealth",
        objectInteractionPayload: {
          action: "use",
          itemId: "lockpick",
          targetItemId: "safe",
          targetItemUpdates: { containerStats: { locked: false } },
        },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, failCtx);
      expect(result.status).toBe("failed");
      expect(dgsm._scenes["study"].items[0].containerStats!.locked).toBe(true);
    });
  });

  // ── Inspect ──

  describe("inspect", () => {
    it("returns item details in outcome string", () => {
      const diary: Item = { id: "diary", name: "Diary", type: "document", description: "A worn leather diary with cryptic entries." };
      dgsm._addScene("study", [diary]);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "inspect", itemId: "diary" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(result.outcome).toContain("Diary");
      expect(result.outcome).toContain("A worn leather diary");
    });

    it("includes container contents when unlocked", () => {
      const box: Item = {
        id: "box", name: "Box", type: "container",
        containerStats: { capacity: 5, locked: false, contents: ["gold_coin", "silver_ring"] },
      };
      dgsm._addScene("study", [box]);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "inspect", itemId: "box" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(result.outcome).toContain("gold_coin");
      expect(result.outcome).toContain("silver_ring");
    });

    it("shows locked status for locked container", () => {
      const safe: Item = {
        id: "safe", name: "Safe", type: "container",
        containerStats: { capacity: 10, locked: true, lockDifficulty: "hard", contents: ["secret_doc"] },
      };
      dgsm._addScene("study", [safe]);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "inspect", itemId: "safe" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(result.outcome).toContain("locked");
      expect(result.outcome).not.toContain("secret_doc");
    });

    it("works for items in NPC inventory", () => {
      const compass: Item = { id: "compass", name: "Compass", type: "tool", description: "A brass compass." };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", compass);

      const node = makeNode({
        objectInteractionPayload: { action: "inspect", itemId: "compass" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(result.outcome).toContain("Compass");
      expect(result.outcome).toContain("A brass compass");
    });
  });

  // ── Destroy ──

  describe("destroy", () => {
    it("removes item from scene and logs event with item name", () => {
      const vase: Item = { id: "vase", name: "Ming Vase", type: "other" };
      dgsm._addScene("study", [vase]);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "destroy", itemId: "vase" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._scenes["study"].items).toHaveLength(0);
      expect(dgsm._scenes["study"].events).toContain("Investigator destroyed Ming Vase");
    });

    it("removes item from inventory when not in scene", () => {
      const note: Item = { id: "note", name: "Note", type: "document" };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", note);

      const node = makeNode({
        objectInteractionPayload: { action: "destroy", itemId: "note" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._npcInventories["player-1"]).toHaveLength(0);
    });

    it("fails when item not found anywhere", () => {
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "destroy", itemId: "ghost_item" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("object_not_found");
    });
  });

  // ── Location check ──

  describe("location check", () => {
    it("fails when NPC is not at expected location", () => {
      dgsm._addScene("study", [{ id: "book", name: "Book" }]);
      dgsm._addNpc("player-1", "kitchen");

      const node = makeNode({
        location: "study",
        objectInteractionPayload: { action: "pickup", itemId: "book" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("location_mismatch");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/dynamicworldagent/engine/handlers/__tests__/objectInteractionHandler.test.ts`
Expected: Multiple failures — handler still uses old string-based API

- [ ] **Step 3: Commit test file**

```bash
git add src/dynamicworldagent/engine/handlers/__tests__/objectInteractionHandler.test.ts
git commit -m "test(items): add comprehensive tests for objectInteractionHandler"
```

---

### Task 8: Rewrite objectInteractionHandler

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts` (full rewrite)

- [ ] **Step 1: Rewrite the handler**

Replace the entire contents of `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts`:

```typescript
import type { NodeHandler, ExecutionContext } from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { PlanNode, CharacterAction } from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { Item } from "../../world_builder/types.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";
import { deepMergeItem } from "../shared/deepMerge.js";

// ── Normal-use type handlers ──────────────────────────────────

function useConsumable(item: Item, npcId: string, dgsm: DynamicGameStateManager): string {
  if (item.consumableStats) {
    item.consumableStats.uses = Math.max(0, (item.consumableStats.uses ?? 1) - 1);
    if (item.consumableStats.uses <= 0) {
      dgsm.removeItemFromNpc(npcId, item.id);
      return `Used ${item.name} (consumed, removed from inventory)`;
    }
    return `Used ${item.name} (${item.consumableStats.uses} uses remaining)`;
  }
  return `Used ${item.name}`;
}

/** Returns a detail string on success, or null to signal failure. */
function useKey(
  item: Item,
  targetItemId: string | undefined,
  scene: { items: Item[] },
): string | null {
  if (!targetItemId) return null; // caller should return failure
  const target = scene.items.find(i => i.id === targetItemId);
  if (!target) return null;
  if (target.containerStats?.locked) {
    target.containerStats.locked = false;
    return `Unlocked ${target.name} with ${item.name}`;
  }
  return `${item.name} used on ${target.name} (already unlocked)`;
}

function useLighting(item: Item): string {
  item.isLightSource = !item.isLightSource;
  if (item.consumableStats && item.isLightSource) {
    item.consumableStats.uses = Math.max(0, (item.consumableStats.uses ?? 1) - 1);
  }
  return item.isLightSource ? `${item.name} turned on` : `${item.name} turned off`;
}

function useContainer(
  item: Item,
  npcId: string,
  dgsm: DynamicGameStateManager,
): string {
  if (!item.containerStats) return `${item.name} has no container properties`;
  if (item.containerStats.locked) {
    const inv = dgsm.getNpcInventory(npcId);
    const key = inv.find(i => i.type === "key");
    if (key) {
      item.containerStats.locked = false;
      return `Unlocked ${item.name} with ${key.name}`;
    }
    return `${item.name} is locked and you have no key`;
  }
  return `Opened ${item.name}`;
}

// ── Inspect helper ────────────────────────────────────────────

function buildInspectOutcome(item: Item): string {
  const parts: string[] = [`[Inspect] ${item.name}`];
  if (item.description) parts.push(item.description);
  if (item.damaged && item.damageDetails) {
    parts.push(`Damaged: ${item.damageDetails.reason}`);
  }
  if (item.containerStats) {
    if (item.containerStats.locked) {
      parts.push("Status: locked");
    } else if (item.containerStats.contents?.length) {
      parts.push(`Contents: ${item.containerStats.contents.join(", ")}`);
    } else {
      parts.push("Contents: empty");
    }
  }
  return parts.join(" | ");
}

// ── Main handler ──────────────────────────────────────────────

export const objectInteractionHandler: NodeHandler = {
  type: "object_interaction",

  description:
    "Interact with an object in the current scene. " +
    "Supports pickup, place, use, inspect, and destroy actions. " +
    "Side effects modify inventory and scene item lists.",

  requiredFields: ["action", "location"],

  optionalFields: ["actionType", "objectInteractionPayload"],

  exampleNode: {
    nodeId: "oi1",
    type: "object_interaction",
    action: "Use the room key to unlock the safe",
    location: "study_room",
    impact: 1,
    timeAdvanceMinutes: 5,
    objectInteractionPayload: {
      action: "use",
      itemId: "room_key",
      targetItemId: "safe",
    },
  },

  execute(
    node: PlanNode,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext,
  ): CharacterAction {
    const state = dgsm.getState();
    const npcLocation = dgsm.getNpcLocation(node.characterId);
    const npc = state.npcCharacters.find((n) => n.id === node.characterId);
    const npcSkills = npc?.skills ?? {};
    const luck = npc?.status?.luck ?? 50;
    const difficulty = ctx.getNodeDifficulty(node, dgsm);

    // Scene + character penalties
    const scenePenalties = ctx.getScenePenalties(node.location, dgsm);
    const charPenalties = ctx.getCharacterPenalties(node.characterId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    // Location check
    if (npcLocation && npcLocation !== node.location) {
      return makeAction(
        node,
        "failed",
        buildOutcome(node, "failed", { reason: "not at expected location" }),
        { difficulty, failureReason: "location_mismatch" },
      );
    }

    // Skill roll (for non-normal use with actionType)
    let resolvedSuccessLevel: import("../../dynamicBasicAgent/npcPlanning/types.js").SuccessLevel | undefined;
    let lastRollDetail: string | undefined;

    if (node.actionType) {
      if (node.isPlayer) {
        const rollResult = ctx.resolveSkillRoll(node, adjustedSkills, dgsm);
        resolvedSuccessLevel = rollResult.successLevel;
        if (rollResult.failed) {
          return makeAction(
            node,
            "failed",
            buildOutcome(node, "failed", { rollDetail: rollResult.reason }),
            { difficulty, successLevel: resolvedSuccessLevel, failureReason: "skill_roll_failed" },
          );
        }
        lastRollDetail = rollResult.detail;
      } else {
        // NPC: luck check + skill roll
        if (Math.random() < ctx.luckFailureRate(luck)) {
          return makeAction(
            node,
            "failed",
            buildOutcome(node, "failed", { reason: `bad luck (luck=${luck})` }),
            { difficulty, failureReason: "bad_luck" },
          );
        }
        const rollResult = ctx.resolveSkillRoll(node, adjustedSkills, dgsm);
        resolvedSuccessLevel = rollResult.successLevel;
        if (rollResult.failed) {
          return makeAction(
            node,
            "failed",
            buildOutcome(node, "failed", { rollDetail: rollResult.reason }),
            { difficulty, successLevel: resolvedSuccessLevel, failureReason: "skill_roll_failed" },
          );
        }
        lastRollDetail = rollResult.detail;
      }
    } else if (!node.isPlayer) {
      // NPC without actionType: luck-only check
      if (Math.random() < ctx.luckFailureRate(luck)) {
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { reason: `bad luck (luck=${luck})` }),
          { difficulty, failureReason: "bad_luck" },
        );
      }
    }

    // ── Apply side effects ────────────────────────────────────
    const scene = dgsm.getScene(node.location);
    const payload = node.objectInteractionPayload;

    if (payload) {
      // --- Pickup ---
      if (payload.action === "pickup" && payload.itemId) {
        if (!scene) {
          return makeAction(node, "failed", buildOutcome(node, "failed", { reason: "scene not found" }), { difficulty, failureReason: "object_not_found" });
        }
        const idx = scene.items.findIndex(i => i.id === payload.itemId);
        if (idx === -1) {
          return makeAction(node, "failed", buildOutcome(node, "failed", { reason: `${payload.itemId} not found in scene` }), { difficulty, failureReason: "object_not_found" });
        }
        const item = scene.items.splice(idx, 1)[0];
        dgsm.addItemToNpc(node.characterId, item);
      }

      // --- Place ---
      else if (payload.action === "place" && payload.itemId) {
        const item = dgsm.removeItemFromNpc(node.characterId, payload.itemId);
        if (!item) {
          return makeAction(node, "failed", buildOutcome(node, "failed", { reason: `${payload.itemId} not in inventory` }), { difficulty, failureReason: "object_not_found" });
        }
        if (scene) {
          scene.items.push(item);
        }
      }

      // --- Use ---
      else if (payload.action === "use" && payload.itemId) {
        // Find item in inventory or scene
        let item = dgsm.findNpcItem(node.characterId, payload.itemId);
        const itemInInventory = !!item;
        if (!item && scene) {
          item = scene.items.find(i => i.id === payload.itemId);
        }
        if (!item) {
          return makeAction(node, "failed", buildOutcome(node, "failed", { reason: `${payload.itemId} not found` }), { difficulty, failureReason: "object_not_found" });
        }

        if (node.actionType) {
          // Non-normal use: apply LLM-provided updates (skill check already passed above)
          if (payload.itemUpdates) {
            deepMergeItem(item as Record<string, unknown>, payload.itemUpdates as Record<string, unknown>);
          }
          if (payload.targetItemId && payload.targetItemUpdates && scene) {
            const target = scene.items.find(i => i.id === payload.targetItemId);
            if (target) {
              deepMergeItem(target as Record<string, unknown>, payload.targetItemUpdates as Record<string, unknown>);
            }
          }
          // Remove consumed items
          if (item.consumableStats && item.consumableStats.uses !== undefined && item.consumableStats.uses <= 0 && itemInInventory) {
            dgsm.removeItemFromNpc(node.characterId, item.id);
          }
        } else {
          // Normal use: type-specific handler
          let useDetail: string;
          switch (item.type) {
            case "consumable":
              useDetail = useConsumable(item, node.characterId, dgsm);
              break;
            case "key": {
              const keyResult = useKey(item, payload.targetItemId, scene ?? { items: [] });
              if (keyResult === null) {
                return makeAction(node, "failed", buildOutcome(node, "failed", { reason: `no target specified for ${item.name}` }), { difficulty, failureReason: "object_not_found" });
              }
              useDetail = keyResult;
              break;
            }
            case "lighting":
              useDetail = useLighting(item);
              break;
            case "container":
              useDetail = useContainer(item, node.characterId, dgsm);
              break;
            default:
              useDetail = `Used ${item.name}`;
              break;
          }
          lastRollDetail = useDetail;
        }
      }

      // --- Inspect ---
      else if (payload.action === "inspect" && payload.itemId) {
        let item = dgsm.findNpcItem(node.characterId, payload.itemId);
        if (!item && scene) {
          item = scene.items.find(i => i.id === payload.itemId);
        }
        if (!item) {
          return makeAction(node, "failed", buildOutcome(node, "failed", { reason: `${payload.itemId} not found` }), { difficulty, failureReason: "object_not_found" });
        }
        const inspectOutcome = buildInspectOutcome(item);
        return makeAction(node, "completed", inspectOutcome, { difficulty, successLevel: resolvedSuccessLevel });
      }

      // --- Destroy ---
      else if (payload.action === "destroy" && payload.itemId) {
        let removed = dgsm.removeItemFromNpc(node.characterId, payload.itemId);
        if (!removed && scene) {
          const idx = scene.items.findIndex(i => i.id === payload.itemId);
          if (idx !== -1) {
            removed = scene.items.splice(idx, 1)[0];
          }
        }
        if (!removed) {
          return makeAction(node, "failed", buildOutcome(node, "failed", { reason: `${payload.itemId} not found` }), { difficulty, failureReason: "object_not_found" });
        }
        if (scene) {
          scene.events.push(`${node.characterName} destroyed ${removed.name}`);
        }
      }
    }

    return makeAction(
      node,
      "completed",
      buildOutcome(node, "completed", { rollDetail: lastRollDetail }),
      { difficulty, successLevel: resolvedSuccessLevel },
    );
  },
};
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run src/dynamicworldagent/engine/handlers/__tests__/objectInteractionHandler.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Verify full build**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts
git commit -m "feat(items): rewrite objectInteractionHandler with full Item support"
```

---

## Chunk 3: LLM Prompt Updates

### Task 9: Update handler exampleNode and fallback templates

The production LLM prompts are generated by the handler registry from each handler's `exampleNode` and `optionalFields`. The DEFAULT constants in the template files are fallback-only. **Both must be updated.**

The `exampleNode` was already updated in Task 8 (it now shows `targetItemId`). This task updates the fallback template constants for completeness.

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts:63, 109-110`

- [ ] **Step 1: Update node type reference (line 63)**

Replace the object_interaction description:

```typescript
// OLD:
- **"object_interaction"**: Interact with a physical object. Include objectInteractionPayload (pickup/place/use/inspect/destroy).
```

With:

```typescript
// NEW:
- **"object_interaction"**: Interact with a physical object. Include objectInteractionPayload (pickup/place/use/inspect/destroy). For two-item interactions (e.g., use key on safe), include targetItemId. For creative non-standard uses, set actionType on the node and include itemUpdates/targetItemUpdates with expected end-state.
```

- [ ] **Step 2: Update output schema example (lines 109-110)**

Replace:

```typescript
// OLD:
**object_interaction** adds:
- `"objectInteractionPayload"`: (optional) e.g. `{"action":"pickup","itemId":"ancient_tome"}`
```

With:

```typescript
// NEW:
**object_interaction** adds:
- `"objectInteractionPayload"`: (optional) e.g. `{"action":"pickup","itemId":"ancient_tome"}` or `{"action":"use","itemId":"room_key","targetItemId":"locked_safe"}`. For non-standard creative uses, add `"itemUpdates"` and/or `"targetItemUpdates"` with the expected item state changes on success.
```

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts
git commit -m "feat(items): update NPC planning template with extended payload examples"
```

---

### Task 10: Update Player planning template

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts:37, 120-121`

- [ ] **Step 1: Update node type reference (line 37)**

Apply the same change as Task 9 Step 1 — replace the `object_interaction` description line.

- [ ] **Step 2: Update output schema example (lines 120-121)**

Apply the same change as Task 9 Step 2 — replace the `objectInteractionPayload` example.

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts
git commit -m "feat(items): update player planning template with extended payload examples"
```

---

### Task 11: Final verification

- [ ] **Step 1: Run all tests**

Run: `pnpm vitest run`
Expected: All tests pass

- [ ] **Step 2: Run full build**

Run: `pnpm build`
Expected: Build succeeds with no errors
