# Item State Visibility for LLM Planning — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the LLM correctly return `itemUpdates`/`targetItemUpdates` in `objectInteractionPayload` by providing it with Item schema, scene items, and detailed inventory in the planning prompt.

**Architecture:** Two-layer fix: (A) handler metadata provides the static Item schema + example to the LLM via registry-generated prompts, (B) agents inject dynamic runtime data (scene items, inventory with ids) into the prompt via template params.

**Tech Stack:** TypeScript, Vitest

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts` | Expand `description` with Item schema; update `exampleNode` with `itemUpdates` |
| Create | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/itemFormatHelpers.ts` | Shared `formatItemSummary()` and `formatSceneItems()` |
| Create | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/itemFormatHelpers.test.ts` | Tests for formatting helpers |
| Modify | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts` | Add `sceneItems` param |
| Modify | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanAgent.ts` | Build scene items + enhance inventory formatting |
| Modify | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts` | Add `sceneItems` param |
| Modify | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts` | Build scene items + NPC inventory in prompt |

---

### Task 1: Update handler static schema

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts:86-110`

- [ ] **Step 1: Update `description` to include Item schema reference**

Replace the `description` field (line 89-92) with:

```typescript
  description:
    "Interact with an object in the current scene. " +
    "Supports pickup, place, use, inspect, and destroy actions. " +
    "Side effects modify inventory and scene item lists.\n\n" +
    "For non-normal use (actionType set), include `itemUpdates` and/or `targetItemUpdates` " +
    "with the expected item state changes after success. Mergeable Item fields:\n" +
    "- `damaged` (boolean), `damageDetails`: `{ damagedBy, damagedAt, reason }`\n" +
    "- `isLightSource` (boolean), `lightLevel` (number)\n" +
    "- `consumableStats`: `{ uses, effect, duration }` — set uses to 0 to consume\n" +
    "- `containerStats`: `{ locked, contents }` — set locked:false to unlock\n" +
    "- `weaponStats`: `{ ammo }` — decrement for ammo use",
```

- [ ] **Step 2: Update `exampleNode` to demonstrate non-normal use with itemUpdates**

Replace the `exampleNode` (lines 98-110) with:

```typescript
  exampleNode: {
    nodeId: "oi1",
    type: "object_interaction",
    action: "Pour acid on the padlock to dissolve it",
    location: "study_room",
    actionType: "exploration",
    impact: 2,
    timeAdvanceMinutes: 10,
    objectInteractionPayload: {
      action: "use",
      itemId: "acid_vial",
      targetItemId: "padlock",
      itemUpdates: { consumableStats: { uses: 0 } },
      targetItemUpdates: { containerStats: { locked: false }, damaged: true },
    },
  },
```

- [ ] **Step 3: Run existing tests to verify nothing broke**

Run: `pnpm vitest run src/dynamicworldagent/engine/handlers/__tests__/objectInteractionHandler.test.ts`
Expected: All tests PASS (metadata changes don't affect execution logic)

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts
git commit -m "feat(items): add Item schema + itemUpdates example to object_interaction handler"
```

---

### Task 2: Create shared item formatting helpers

**Files:**
- Create: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/itemFormatHelpers.ts`
- Create: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/itemFormatHelpers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/itemFormatHelpers.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatItemSummary, formatItemList, formatSceneItems } from "../itemFormatHelpers.js";
import type { Item, DynamicScene } from "../../../world_builder/types.js";

describe("formatItemSummary", () => {
  it("formats a basic item with id, name, type", () => {
    const item: Item = { id: "torch", name: "Torch", type: "lighting" };
    const result = formatItemSummary(item);
    expect(result).toContain("torch");
    expect(result).toContain("Torch");
    expect(result).toContain("lighting");
  });

  it("includes consumableStats.uses when present", () => {
    const item: Item = {
      id: "medkit", name: "First Aid Kit", type: "consumable",
      consumableStats: { uses: 3, effect: "heals minor wounds" },
    };
    const result = formatItemSummary(item);
    expect(result).toContain("uses: 3");
  });

  it("includes locked status for containers", () => {
    const item: Item = {
      id: "safe", name: "Safe", type: "container",
      containerStats: { locked: true, lockDifficulty: "hard" },
    };
    const result = formatItemSummary(item);
    expect(result).toContain("locked");
  });

  it("includes isLightSource status for lighting", () => {
    const item: Item = {
      id: "lantern", name: "Lantern", type: "lighting",
      isLightSource: true, lightLevel: 3,
    };
    const result = formatItemSummary(item);
    expect(result).toContain("lit");
  });

  it("includes damaged status when damaged", () => {
    const item: Item = { id: "gun", name: "Revolver", type: "weapon", damaged: true };
    const result = formatItemSummary(item);
    expect(result).toContain("damaged");
  });

  it("includes ammo for weapons with weaponStats", () => {
    const item: Item = {
      id: "gun", name: "Revolver", type: "weapon",
      weaponStats: { skill: "Firearms", damage: "1d10", range: "30m", attacksPerRound: 1, ammo: 6 },
    };
    const result = formatItemSummary(item);
    expect(result).toContain("ammo: 6");
  });
});

describe("formatItemList", () => {
  it("returns empty string for empty array", () => {
    expect(formatItemList([])).toBe("");
  });

  it("formats multiple items as bulleted list", () => {
    const items: Item[] = [
      { id: "key", name: "Room Key", type: "key" },
      { id: "torch", name: "Torch", type: "lighting" },
    ];
    const result = formatItemList(items);
    expect(result).toContain("- ");
    expect(result.split("\n").length).toBe(2);
  });
});

describe("formatSceneItems", () => {
  it("returns empty string for null scene", () => {
    expect(formatSceneItems(null)).toBe("");
  });

  it("returns 'No items.' for scene with empty items", () => {
    const scene = { items: [] } as unknown as DynamicScene;
    expect(formatSceneItems(scene)).toBe("No items in this scene.");
  });

  it("formats scene items with full details", () => {
    const scene = {
      items: [
        { id: "safe", name: "Safe", type: "container", containerStats: { locked: true } },
      ],
    } as unknown as DynamicScene;
    const result = formatSceneItems(scene);
    expect(result).toContain("safe");
    expect(result).toContain("Safe");
    expect(result).toContain("locked");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/itemFormatHelpers.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the formatting helpers**

Create `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/itemFormatHelpers.ts`:

```typescript
import type { Item, DynamicScene } from "../../world_builder/types.js";

/**
 * One-line summary of an Item: "Name (id: X, type: Y, ...key stats)"
 * Designed for LLM consumption in planning prompts.
 */
export function formatItemSummary(item: Item): string {
  const tags: string[] = [`id: ${item.id}`];
  if (item.type) tags.push(`type: ${item.type}`);
  if (item.damaged) tags.push("damaged");
  if (item.isLightSource !== undefined) {
    tags.push(item.isLightSource ? "lit" : "unlit");
  }
  if (item.consumableStats?.uses !== undefined) {
    tags.push(`uses: ${item.consumableStats.uses}`);
  }
  if (item.containerStats) {
    tags.push(item.containerStats.locked ? "locked" : "unlocked");
  }
  if (item.weaponStats?.ammo !== undefined) {
    tags.push(`ammo: ${item.weaponStats.ammo}`);
  }
  return `${item.name} (${tags.join(", ")})`;
}

/** Format an array of Items as a bulleted list of summaries. */
export function formatItemList(items: Item[]): string {
  if (items.length === 0) return "";
  return items.map((i) => `- ${formatItemSummary(i)}`).join("\n");
}

/** Format scene items for prompt injection. Returns empty string if scene is null. */
export function formatSceneItems(scene: DynamicScene | null): string {
  if (!scene) return "";
  if (scene.items.length === 0) return "No items in this scene.";
  return formatItemList(scene.items);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/itemFormatHelpers.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/itemFormatHelpers.ts \
        src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/itemFormatHelpers.test.ts
git commit -m "feat(items): add shared item formatting helpers for planning prompts"
```

---

### Task 3: Wire item data into PlayerPlanAgent + Template

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts:1-27,148-256`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanAgent.ts:44-155,159-201`

- [ ] **Step 1: Add `sceneItems` param to `PlayerPlanParams`**

In `PlayerPlanTemplate.ts`, add to the `PlayerPlanParams` interface (after `sceneConditions`):

```typescript
  sceneItems: string;
```

- [ ] **Step 2: Add scene items section to the prompt template**

In `buildPlayerPlanPrompt()`, add after the `## Scene Conditions` section (after line 177):

```typescript
## Items in Current Scene
${params.sceneItems || "No items in this scene."}
```

- [ ] **Step 3: Enhance inventory formatting in PlayerPlanAgent**

In `PlayerPlanAgent.ts`, replace the inventory section in `formatPlayerProfile` (lines 193-199):

```typescript
    // Inventory
    if (player.inventory?.length) {
      const { formatItemList } = await import("./itemFormatHelpers.js");
      // ... no, top-level import is better
    }
```

Actually — use a top-level static import. Add to top of `PlayerPlanAgent.ts`:

```typescript
import { formatSceneItems, formatItemList } from "./itemFormatHelpers.js";
```

Then replace the inventory section (lines 193-199):

```typescript
    // Inventory (with ids for object_interaction payloads)
    if (player.inventory?.length) {
      parts.push(`Inventory:\n${formatItemList(player.inventory)}`);
    }
```

- [ ] **Step 4: Build sceneItems and pass to template params**

In `PlayerPlanAgent.generatePlayerNodes()`, after the `sceneConditions` block (around line 62), add:

```typescript
    // Build scene items list
    const sceneItems = formatSceneItems(currentScenario);
```

Then add `sceneItems` to the `params` object (after `sceneConditions`):

```typescript
      sceneItems,
```

- [ ] **Step 5: Build and verify no type errors**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts \
        src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanAgent.ts
git commit -m "feat(items): inject scene items + detailed inventory into player planning prompt"
```

---

### Task 4: Wire item data into NPCPlanningAgent + Template

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts:35-53,136-194`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts:86-160,395-403`

- [ ] **Step 1: Add `sceneItems` and `npcInventory` params to `DailyPlanParams`**

In `NPCPlanningTemplate.ts`, add to the `DailyPlanParams` interface (after `scenarioConditions`):

```typescript
  sceneItems: string;
  npcInventory: string;
```

- [ ] **Step 2: Add sections to the NPC daily plan prompt**

In `buildGenerateDailyPlanPrompt()`, add after `## Current Scene Conditions` section (after line 159):

```typescript

## Items in Current Scene
\${params.sceneItems || "No items in this scene."}

## NPC Inventory
\${params.npcInventory || "Empty."}
```

- [ ] **Step 3: Build sceneItems + npcInventory in NPCPlanningAgent**

In `NPCPlanningAgent.ts`, add top-level import:

```typescript
import { formatSceneItems, formatItemList } from "./itemFormatHelpers.js";
```

In `generateDailyPlans()`, inside the `npcs.map(async (npc) => { ... })` block, after `scenarioConditions` (around line 104), add:

```typescript
        const npcLocation = state.npcLocations[npc.id];
        const npcScene = npcLocation ? state.scenes.get(npcLocation) ?? null : null;
        const sceneItems = formatSceneItems(npcScene);
        const npcInventory = formatItemList(dgsm.getNpcInventory(npc.id));
```

Then add both to the `buildGenerateDailyPlanPrompt` call params (around line 114):

```typescript
          sceneItems,
          npcInventory,
```

- [ ] **Step 4: Add inventory to NPC profile in formatNpcProfile**

In `formatNpcProfile()` (line 395-403), add after the goals/secrets block:

```typescript
    // Inventory
    const inv = (npc as any).inventory;
    if (inv?.length) {
      parts.push(`Inventory:\n${formatItemList(inv)}`);
    }
```

- [ ] **Step 5: Build and verify no type errors**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 6: Run all related tests**

Run: `pnpm vitest run src/dynamicworldagent/`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts \
        src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts
git commit -m "feat(items): inject scene items + NPC inventory into NPC planning prompt"
```
