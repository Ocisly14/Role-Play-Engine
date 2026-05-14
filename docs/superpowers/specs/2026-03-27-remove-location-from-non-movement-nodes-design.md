# Remove Location Field from Non-Movement Nodes

Date: 2026-03-27

## Problem

Every node type currently requires a `location` field. Non-movement handlers validate that the NPC is at `node.location` before executing, failing with `location_mismatch` if not.

This causes cascading failures because:

1. **Auto-movement breaks subsequent nodes**: When the system auto-moves an NPC to a different sub-scene (e.g., to reach an item), the NPC's actual position no longer matches the `location` field on their remaining planned nodes.
2. **LLM picks wrong sub-scene names**: The LLM sometimes generates incorrect or imprecise location strings (e.g., building name instead of sub-scene), causing unnecessary failures.
3. **Redundant information**: The system already tracks NPC positions via `dgsm.getCharacterPosition()`. Requiring the LLM to also specify location in every node duplicates this and creates inconsistency.

Example from simulation: Lux Lynch is auto-moved from 档案室 (SCN_3_SUB_3) to 接待处 (SCN_3_SUB_1) to access an item, but her next node still targets SCN_3_SUB_3 → `location_mismatch` failure → unnecessary revision cascade.

## Solution

Remove `location` from non-movement node output. Non-movement handlers derive the action's location from the NPC's current position at execution time.

**Only movement nodes specify `location`** — as the destination to move to.

## Design

### What Changes

#### 1. Handlers — Remove location validation, use current position

For `actionHandler`, `characterInteractionHandler`, `objectInteractionHandler`, `sceneInteractionHandler`:

- **Remove** the `isCharacterAtLocation(pos, node.location)` check
- **Resolve** current location at handler entry: `const currentLocation = dgsm.resolveLocationId(pos)`
- **Replace** all `node.location` references with `currentLocation` (scene penalties, scene data lookup, condition writes, connection blocking)
- Pass `currentLocation` to `makeAction` via the `gameTime` opts or a new location override

#### 2. `makeAction` (nodeHelpers.ts) — Add location override

Currently: `location: node.location`

Add an optional `location` parameter:
```typescript
export function makeAction(
  node: PlanNode,
  status: "completed" | "failed",
  outcome: string,
  opts?: {
    location?: string;  // NEW: override node.location with current position
    gameTime?: string;
    // ...existing fields
  }
): CharacterAction {
  return {
    // ...
    location: opts?.location ?? node.location,
    // ...
  };
}
```

#### 3. Resolvers — Use current position for scene data

`interactionStateResolver.ts` and `objectInteractionStateResolver.ts`:
- Their `buildUserPrompt` functions receive `node.location` to fetch scene data
- Change to accept and use the NPC's resolved current location instead
- This affects: scene description, scene items, scene conditions, connected locations, witness detection, world state block

#### 4. TickProcessor — Simplify location_mismatch handling

- The `location_mismatch` failure branch for non-movement nodes (auto-movement pathfinding) can be removed — it will never fire since handlers no longer check location
- `action.location` should use the NPC's current position (from the handler's resolved location, passed through `makeAction`)
- Other `node.location` references in tickProcessor (memory recording, object delta application, discovery, etc.) should use the resolved location from the handler result (`action.location`)

#### 5. Prompt Templates — Remove location from non-movement output

In `npcPlanningTemplates.ts`:

**Node Type Reference**: Update to clarify location is movement-only:
```
- **"action"**: ... (no location field needed — executes at current position)
- **"movement"**: Move to a destination. Set `location` to the exact destination name.
- **"character_interaction"**: ... (no location field needed)
- **"object_interaction"**: ... (no location field needed)
- **"scene_interaction"**: ... (no location field needed)
```

**Output schema**: Remove `location` from the generic field list. Add it only under movement-specific fields:
```json
{
  "nodeId": "unique-id",
  "startTime": "HH:MM",
  "endTime": "HH:MM",
  "action": "description",
  "type": "action|movement|character_interaction|object_interaction|scene_interaction",
  "location": "ONLY for movement — exact destination name from Places You Know",
  "skill": "...",
  "impact": "..."
}
```

**Planning Guardrails**: Remove/simplify the rule about using exact scene names for all nodes. Keep only for movement:
```
- For movement nodes, set `location` to the exact scene or place name.
- Non-movement nodes execute at your current location — do not specify `location`.
```

#### 6. NPCPlanningAgent — Node normalization

In `normalizePlanNode()`: For non-movement nodes, `location` can be empty/undefined. The field stays on `PlanNode` type for backward compatibility (movement still needs it), but non-movement nodes won't have it populated from LLM output.

If `location` is missing on a non-movement node, `normalizePlanNode` should set it to the NPC's current position at planning time (as a hint, not as a constraint).

#### 7. PlanNode type — location becomes optional for non-movement

`location` remains a required field on `PlanNode` (for backward compat and movement), but non-movement nodes may have it set to empty string or the NPC's current position at planning time. The key change is that **handlers no longer validate it**.

## What Does NOT Change

- Movement handler — still requires and validates `location` as destination
- `PlanNode` type definition — `location` field stays (used by movement, used for display)
- Memory recording — `action.location` still recorded, but now sourced from NPC's actual position
- Impact propagation — uses `action.location` which is now accurate (current position)
- Encounter system — uses `dgsm.getCharacterPosition()`, unaffected
- LLM resolver logic (knowledge transfer, state changes) — unchanged, just receives accurate location

## Files Affected

| File | Change |
|------|--------|
| `src/dynamicworldagent/engine/handlers/actionHandler.ts` | Remove location check, use current position |
| `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts` | Remove location check, use current position for scene penalties |
| `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts` | Remove location check, use current position for scene/item lookup |
| `src/dynamicworldagent/engine/handlers/sceneInteractionHandler.ts` | Remove location check, use current position for scene ops |
| `src/dynamicworldagent/engine/shared/nodeHelpers.ts` | Add location override to makeAction |
| `src/dynamicworldagent/engine/handlers/interactionStateResolver.ts` | Accept/use resolved location |
| `src/dynamicworldagent/engine/handlers/objectInteractionStateResolver.ts` | Accept/use resolved location |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | Remove location_mismatch auto-movement, pass resolved location |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts` | Location only for movement in prompts |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts` | Adjust normalizePlanNode |
