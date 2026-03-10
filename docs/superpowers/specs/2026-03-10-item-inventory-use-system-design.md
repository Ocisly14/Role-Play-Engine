# Item Inventory & Use System Design

## Problem

The current `objectInteractionHandler` has critical data-loss bugs and missing functionality:

1. **Pickup loses Item data**: `addItemToNpc(characterId, itemId)` stores only the ID string. Full Item object (description, type, stats) is discarded.
2. **Place creates bare objects**: `scene.items.push({ id: itemId, name: itemId })` — all item metadata lost.
3. **Use and Inspect have no implementation**: The handler falls through to success without executing any logic.
4. **Inventory is string-based**: `npcInventories: Record<string, string[]>` cannot hold Item objects.
5. **Pickup/place uses wrong scene**: `getCurrentScene()` returns the player's scene, not the acting NPC's scene. Must use `getScene(node.location)`.

## Affected Files

| File | Change |
|------|--------|
| `src/dynamicworldagent/state/DynamicGameState.ts` | `npcInventories` type change + manager methods |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts` | `ObjectInteractionPayload` extension |
| `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts` | Rewrite all 5 actions |
| `src/dynamicworldagent/engine/shared/nodeHelpers.ts` | Outcome string for extended payload |
| `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts` | Update `addItemToNpc`/`removeItemFromNpc` calls |
| `src/dynamicworldagent/state/DynamicGameStateLoader.ts` | Inventory initialization: `InventoryItem` → `Item` mapping |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts` | Update payload examples for LLM |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts` | Update payload examples for LLM |

## Design

### 1. Inventory Storage: Full Item Objects

Change `npcInventories` from `Record<string, string[]>` to `Record<string, Item[]>`.

Update the `DynamicGameState` interface and all manager methods:

```typescript
npcInventories: Record<string, Item[]>;

getNpcInventory(npcId: string): Item[] { ... }
addItemToNpc(npcId: string, item: Item): void { ... }
removeItemFromNpc(npcId: string, itemId: string): Item | undefined { ... }
findNpcItem(npcId: string, itemId: string): Item | undefined { ... }
```

`removeItemFromNpc` returns the removed Item so callers (e.g., `place`) can use it.

**Loader initialization** (`DynamicGameStateLoader.ts`): Convert `InventoryItem` (from NPC profiles) to `Item` during state loading. Map `InventoryItem.name` → `Item.name`, `InventoryItem.properties` → spread into Item fields. Items loaded this way will have minimal fields (name only) unless the NPC profile provides richer data.

### 2. Extended ObjectInteractionPayload

```typescript
export interface ObjectInteractionPayload {
  action: "pickup" | "place" | "use" | "inspect" | "destroy";
  itemId?: string;
  targetItemId?: string;
  // Non-normal use only: LLM returns expected item state after successful action
  itemUpdates?: Partial<Item>;
  targetItemUpdates?: Partial<Item>;
}
```

- `targetItemId`: The item being acted upon (e.g., use key on safe).
- `itemUpdates`: Partial changes to merge onto the used item after success.
- `targetItemUpdates`: Partial changes to merge onto the target item after success.

**LLM prompt templates** must be updated with examples showing the new fields so the LLM knows to emit `targetItemId` and `itemUpdates`/`targetItemUpdates` for non-normal use cases.

### 3. Pickup & Place — Lossless Transfer

**Scene lookup**: Always use `dgsm.getScene(node.location)`, never `getCurrentScene()`.

**Pickup:**
1. Find full Item object in `scene.items` by `payload.itemId`.
2. If not found: return `makeAction("failed", ...)` with `failureReason: "object_not_found"`.
3. Splice it from `scene.items`.
4. Push the full Item into `npcInventories[characterId]` via `addItemToNpc(characterId, item)`.

**Place:**
1. Call `removeItemFromNpc(characterId, itemId)` — returns full Item or `undefined`.
2. If `undefined`: return `makeAction("failed", ...)` with `failureReason: "object_not_found"`.
3. Push the returned Item into `scene.items`.

No data loss in either direction.

### 4. Use — Dual-Path System

Use operates in two modes, determined by whether the PlanNode has an `actionType`:

#### Normal Use (no `actionType`)

The item's `type` field drives a built-in handler. No skill check needed.

| Item Type    | Normal Use Behavior |
|-------------|-------------------|
| `consumable` | Decrement `consumableStats.uses`. If 0, remove from inventory. Effect application is narrative-only (Keeper interprets `consumableStats.effect` string). |
| `key`        | Unlock the container/door identified by `targetItemId` in the scene. Set `containerStats.locked = false`. If no `targetItemId`, fail with `"object_not_found"`. |
| `lighting`   | Toggle `isLightSource`. If consumable (has `consumableStats`), decrement uses. |
| `container`  | Open/close the container. If locked, require matching key in NPC inventory (any item with `type: "key"`). |
| `document`   | No-op for `use` — documents are handled by `inspect`. |
| `tool`       | No default use behavior — tools are passive. Falls through as success. |
| `weapon`     | No default use behavior — weapons use combat handler. Falls through as success. |

#### Non-Normal Use (has `actionType`)

For creative or cross-type interactions (e.g., pour acid on a safe lock).

1. LLM generates PlanNode with `actionType` (e.g., `"science"`) and `objectInteractionPayload.itemUpdates` / `targetItemUpdates` representing the expected end-state on success.
2. Engine performs skill check via `ctx.resolveSkillRoll()`.
3. On success: deep-merge `itemUpdates` onto the source item, deep-merge `targetItemUpdates` onto the target item. Deep merge means nested objects like `consumableStats` or `containerStats` are merged field-by-field, not replaced wholesale.
4. On failure: no state changes applied.

**Deep merge implementation**: A simple recursive merge function that handles plain objects. For each key in the update: if both existing and update values are plain objects, recurse; otherwise overwrite.

### 5. Inspect

Returns item details for narrative generation. No state mutation.

- If item has `containerStats` and is unlocked: include contents list.
- If item is a `document`: include description.
- Otherwise: surface `name`, `description`, `damaged`, `damageDetails`.

**Result delivery**: Encode inspect details into the `outcome` string of the returned `CharacterAction`. The Keeper agent already reads `outcome` for narrative generation — no new fields needed.

### 6. Destroy

Current implementation removes from inventory only. Extend to also handle scene items:

- If item is in NPC inventory: `removeItemFromNpc`.
- If item is in scene: splice from `scene.items`.
- If item not found in either location: return `makeAction("failed", ...)` with `failureReason: "object_not_found"`.
- Push event to `scene.events`.

## Scope

### In Scope
- `DynamicGameState.npcInventories` type change + manager methods
- `DynamicGameStateLoader.ts` inventory initialization update
- `ObjectInteractionPayload` extension
- `objectInteractionHandler` rewrite for all 5 actions
- `characterInteractionHandler` call-site updates
- Type handler functions for normal use
- `nodeHelpers.ts` outcome formatting update
- LLM prompt template updates for new payload fields

### Out of Scope
- Container nesting (items inside container items) — future work
- Item crafting/combination system
- Multiplayer inventory sync
- UI changes for item management
- Mechanical consumable effect resolution (effects are narrative-only for now)
