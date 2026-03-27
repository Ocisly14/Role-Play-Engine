# Remove Location from Non-Movement Nodes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `location` field from non-movement node output. Handlers derive location from the NPC's current position at execution time, eliminating `location_mismatch` failures.

**Architecture:** Add `location` override to `makeAction`, update 4 handlers to resolve current position and remove location validation, update 2 resolvers to accept resolved location, simplify tickProcessor by removing location_mismatch auto-movement, update prompts to only require location for movement nodes.

**Tech Stack:** TypeScript, Vitest

---

## File Map

| File | Change | Responsibility |
|------|--------|---------------|
| `src/dynamicworldagent/engine/shared/nodeHelpers.ts` | Modify | Add `location` override param to `makeAction` |
| `src/dynamicworldagent/engine/handlers/actionHandler.ts` | Modify | Remove location check, use current position |
| `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts` | Modify | Remove location check, use current position for penalties |
| `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts` | Modify | Remove location check, use current position for scene/item lookup |
| `src/dynamicworldagent/engine/handlers/sceneInteractionHandler.ts` | Modify | Remove location check, use current position for scene ops |
| `src/dynamicworldagent/engine/handlers/interactionStateResolver.ts` | Modify | Accept `resolvedLocation` param, use instead of `node.location` |
| `src/dynamicworldagent/engine/handlers/objectInteractionStateResolver.ts` | Modify | Accept `resolvedLocation` param, use instead of `node.location` |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | Modify | Remove location_mismatch auto-movement, pass resolved location to resolvers |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts` | Modify | Location only for movement in prompts/schemas |

---

### Task 1: Add location override to `makeAction`

**Files:**
- Modify: `src/dynamicworldagent/engine/shared/nodeHelpers.ts:53-80`

- [ ] **Step 1: Add location to opts**

```typescript
export function makeAction(
  node: PlanNode,
  status: "completed" | "failed",
  outcome: string,
  opts?: {
    location?: string;
    gameTime?: string;
    difficulty?: "regular" | "hard" | "extreme";
    successLevel?: SuccessLevel;
    failureReason?: FailureReason;
  }
): CharacterAction {
  return {
    characterId: node.characterId,
    characterName: node.characterName,
    gameTime: opts?.gameTime ?? node.endTime,
    action: node.action,
    location: opts?.location ?? node.location,
    type: node.type,
    skill: node.skill,
    impact: node.impact,
    difficulty: opts?.difficulty,
    successLevel: opts?.successLevel,
    status,
    outcome,
    failureReason: opts?.failureReason,
    targetCharacterIds: node.targetCharacterIds,
  };
}
```

Only change: added `location?: string` to opts, and `location: opts?.location ?? node.location` in the return.

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: Success (backward compatible — no callers use location yet).

---

### Task 2: Update actionHandler — remove location check, use current position

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/actionHandler.ts`

- [ ] **Step 1: Rewrite handler to use current position**

Replace the entire file with:

```typescript
import type {
  CharacterAction,
  PlanNode,
} from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { restCharacter } from "../features/staminaFeature.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";
import type { ExecutionContext, NodeHandler } from "../types.js";

export const actionHandler: NodeHandler = {
  type: "action",

  description:
    'A narrative action performed by a character at their current location. This handler is for actions that do NOT change object, character, or scene state. If skill is set, a skill roll determines success; otherwise the action auto-succeeds. Set routineSubtype to "rest" for sleeping, napping, or resting — this resets fatigue automatically.',

  requiredFields: ["action"],

  optionalFields: ["skill", "routineSubtype"],

  exampleNode: {
    nodeId: "a1",
    startTime: "22:00",
    endTime: "22:05",
    type: "action",
    routineSubtype: "rest",
    action: "Sleep for the night to recover from exhaustion",
    impact: 0,
  },

  execute(
    node: PlanNode,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): CharacterAction {
    const state = dgsm.getState();
    const pos = dgsm.getCharacterPosition(node.characterId);
    const currentLocation = pos ? dgsm.resolveLocationId(pos) : node.location;
    const npc = state.npcCharacters.find((n) => n.id === node.characterId);
    const npcSkills = npc?.skills ?? {};
    const difficulty = ctx.getNodeDifficulty(node, dgsm);

    // Scene + character penalties (using current position)
    const scenePenalties = ctx.getScenePenalties(currentLocation, dgsm);
    const charPenalties = ctx.getCharacterPenalties(node.characterId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    let resolvedSuccessLevel:
      | import("../../dynamicBasicAgent/npcPlanning/types.js").SuccessLevel
      | undefined;
    let lastRollDetail: string | undefined;

    const lang = ctx.language ?? "en";

    // skill present? -> skill roll
    if (node.skill) {
      const rollResult = ctx.resolveSkillRoll(node, adjustedSkills, dgsm);
      resolvedSuccessLevel = rollResult.successLevel;
      if (rollResult.failed) {
        lastRollDetail = rollResult.reason;
        return makeAction(
          node,
          "failed",
          buildOutcome(node, "failed", { rollDetail: lastRollDetail }, lang),
          {
            location: currentLocation,
            difficulty,
            successLevel: resolvedSuccessLevel,
            failureReason: "skill_roll_failed",
          }
        );
      }
      lastRollDetail = rollResult.detail;
    }

    // Rest subtype → reset fatigue via stamina feature
    if (node.routineSubtype === "rest") {
      restCharacter(dgsm, node.characterId);
    }

    return makeAction(
      node,
      "completed",
      buildOutcome(node, "completed", { rollDetail: lastRollDetail }, lang),
      { location: currentLocation, difficulty, successLevel: resolvedSuccessLevel }
    );
  },
};
```

Key changes:
- Removed `isCharacterAtLocation` import and check
- Removed `"location"` from `requiredFields`
- Removed `location` from `exampleNode`
- Added `const currentLocation = pos ? dgsm.resolveLocationId(pos) : node.location`
- Scene penalties use `currentLocation`
- All `makeAction` calls pass `location: currentLocation`

- [ ] **Step 2: Verify build**

Run: `pnpm build`

---

### Task 3: Update characterInteractionHandler — remove location check, use current position

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts`

- [ ] **Step 1: Apply changes**

1. Remove `isCharacterAtLocation` from imports (keep `arePositionsCoLocated`)
2. Remove `"location"` from `requiredFields` (line 28): `requiredFields: ["action", "targetCharacterIds"],`
3. Remove `location` from `exampleNode` (line 38)
4. After getting `pos` (line 50), add: `const currentLocation = pos ? dgsm.resolveLocationId(pos) : node.location;`
5. Replace `node.location` with `currentLocation` in scene penalties (line 65): `ctx.getScenePenalties(currentLocation, dgsm)`
6. **Remove** the location check block (lines 74-82)
7. Replace `node.location` in target scene penalties (line 114): `ctx.getScenePenalties(currentLocation, dgsm)`
8. Add `location: currentLocation` to all `makeAction` calls (lines 56, 76-if-kept-for-other-failures, 95, 128, 144)

Every `makeAction` call in this handler must pass `{ location: currentLocation, ... }`.

- [ ] **Step 2: Verify build**

Run: `pnpm build`

---

### Task 4: Update objectInteractionHandler — remove location check, use current position

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts`

- [ ] **Step 1: Apply changes**

1. Remove `isCharacterAtLocation` import
2. Remove `"location"` from `requiredFields` (line 24): `requiredFields: ["action"],`
3. Remove `location` from `exampleNode` (line 34)
4. After getting `pos` (line 47), add: `const currentLocation = pos ? dgsm.resolveLocationId(pos) : node.location;`
5. Replace `ctx.getScenePenalties(node.location, dgsm)` with `ctx.getScenePenalties(currentLocation, dgsm)` (line 53)
6. **Remove** the location check block (lines 58-66)
7. Replace `dgsm.getScene(node.location)` with `dgsm.getScene(currentLocation)` in item pre-check (line 96)
8. Add `location: currentLocation` to all `makeAction` calls (lines 60, 79, 129, 141)

Every `makeAction` call must pass `{ location: currentLocation, ... }`.

- [ ] **Step 2: Verify build**

Run: `pnpm build`

---

### Task 5: Update sceneInteractionHandler — remove location check, use current position

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/sceneInteractionHandler.ts`

- [ ] **Step 1: Apply changes**

1. Remove `isCharacterAtLocation` import
2. Remove `"location"` from `requiredFields` (line 26): `requiredFields: ["action"],`
3. Remove `location` from `exampleNode` (line 35)
4. After getting `pos` (line 50), add: `const currentLocation = pos ? dgsm.resolveLocationId(pos) : node.location;`
5. Replace `ctx.getScenePenalties(node.location, dgsm)` with `ctx.getScenePenalties(currentLocation, dgsm)` (line 56)
6. **Remove** the location check block (lines 68-81)
7. Replace ALL remaining `node.location` with `currentLocation`:
   - Line 112: `dgsm.appendSceneCondition(currentLocation, ...)`
   - Line 117: `getTopologyNeighbors(currentLocation, topology)`
   - Line 119: `dgsm.getScene(currentLocation)`
   - Line 131: `dgsm.setConnectionBlocked(currentLocation, ...)`
   - Line 139: warning log
8. Add `location: currentLocation` to all `makeAction` calls (lines 70, 89, 144)

- [ ] **Step 2: Verify build**

Run: `pnpm build`

---

### Task 6: Update resolvers to accept resolved location

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/interactionStateResolver.ts`
- Modify: `src/dynamicworldagent/engine/handlers/objectInteractionStateResolver.ts`

- [ ] **Step 1: Update interactionStateResolver**

Find the `resolveInteractionState` function signature. Add a `resolvedLocation: string` parameter after the existing params. Then replace all `node.location` references inside that function with `resolvedLocation`:
- Line 257: `location: resolvedLocation,`
- Line 371: `dgsm.getScene(resolvedLocation)`
- Line 374: `dgsm.getSceneConditions(resolvedLocation)`
- Line 380: scene ID fallback
- Line 401: `dgsm.getConnectionBlockReason(resolvedLocation, ...)`
- Line 460: `buildWorldStateBlock(dgsm, node.characterId, resolvedLocation, registry)`

- [ ] **Step 2: Update objectInteractionStateResolver**

Find the `resolveObjectInteractionState` function signature. Add a `resolvedLocation: string` parameter. Replace all `node.location`:
- Line 247: `location: resolvedLocation,`
- Line 363: `dgsm.getScene(resolvedLocation)`
- Line 366: scene name fallback
- Line 380: witness location check `if (locId === resolvedLocation)`
- Line 415: `buildWorldStateBlock(dgsm, node.characterId, resolvedLocation, registry)`

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: Errors in tickProcessor where resolvers are called without the new param — fixed in next task.

---

### Task 7: Update tickProcessor — pass resolved location, remove location_mismatch auto-movement

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

- [ ] **Step 1: Remove location_mismatch auto-movement block**

Delete lines 1405-1468 (the entire `if (action.failureReason === "location_mismatch")` block). This code will never fire because handlers no longer produce `location_mismatch` failures.

- [ ] **Step 2: Update resolver calls to pass resolved location**

The resolver calls in tickProcessor use `node.location`. Since handlers now set `action.location` to the current position, use `action.location` instead.

For `resolveInteractionState` call (around line 1598 after deletion): add `action.location` as the `resolvedLocation` argument.

For `resolveObjectInteractionState` call (around line 1649 after deletion): add `action.location` as the `resolvedLocation` argument.

- [ ] **Step 3: Update remaining node.location references in tickProcessor**

After the location_mismatch block is removed, update these remaining `node.location` references to use `action.location` (which is now the resolved current position):

- `applyObjectDelta(dgsm, node.characterId, objDelta, node.location)` → `action.location`
- `dgsm.getScene(node.location)` in fumble evidence damage → `action.location`
- `node.location` in discovery calls → `action.location`
- The prerequisite failed block (line ~1352) should also resolve current position for the action location

For the `object_not_found` auto-movement block (lines 1470-1546): this can stay but should use `action.location` instead of `node.location` for the scene lookup. The `node.location = targetSceneId` mutation (line 1542) should instead pass `location: targetSceneId` to the re-execution context.

- [ ] **Step 4: Verify build**

Run: `pnpm build`

---

### Task 8: Update prompt templates — location only for movement

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts`

- [ ] **Step 1: Update Node Type Reference**

In `DEFAULT_DETAILED_NODE_TYPE_REF`, update `"action"` and all non-movement types to NOT mention location. Update `"movement"` to clarify location is its destination:

For `"action"`: add "(no `location` needed — executes at current position)"
For `"movement"`: keep "Set `location` to the exact destination name from 'Places You Know'."
For `"character_interaction"`: add "(no `location` needed)"
For `"object_interaction"`: add "(no `location` needed)"
For `"scene_interaction"`: add "(no `location` needed)"

- [ ] **Step 2: Update output schema**

In `defaultDetailedOutputSchema`, change the `location` field description:

```
  "location": "ONLY for movement nodes — exact destination name from Places You Know (English). Omit for other types.",
```

In `revisePlansOutputSchema`, same change.

- [ ] **Step 3: Update Planning Guardrails**

In `DEFAULT_NODE_GUARDRAILS_PROMPT`, update:

Old: "For `location`, use the exact scene or place name. If you are inside a building, use the specific scene name..."
New: "For movement nodes, set `location` to the exact scene or place name. Non-movement nodes execute at your current position — do not specify `location`."

- [ ] **Step 4: Verify build**

Run: `pnpm build`

---

### Task 9: Run tests, fix, and verify

- [ ] **Step 1: Run all tests**

Run: `pnpm test -- --run 2>&1 | tail -30`

Fix any test failures caused by:
- Tests that pass `location` in `requiredFields` assertions for non-movement handlers
- Tests that assert `location_mismatch` failures for non-movement handlers
- Tests that check `node.location` values in handler results

- [ ] **Step 2: Run integration tests**

Run: `pnpm test -- --run src/dynamicworldagent/engine/__tests__/integration.test.ts 2>&1 | tail -20`

- [ ] **Step 3: Run biome check**

Run: `pnpm check 2>&1 | tail -10`

- [ ] **Step 4: Verify no remaining non-movement location_mismatch paths**

Run: `grep -n "location_mismatch" src/dynamicworldagent/engine/handlers/*.ts`
Expected: Only movementHandler.ts should reference location_mismatch.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove location field from non-movement nodes

- Non-movement handlers (action, character_interaction, object_interaction,
  scene_interaction) no longer require or validate location field
- Handlers resolve NPC's current position via dgsm.resolveLocationId()
- makeAction accepts location override, handlers pass resolved position
- Resolvers accept resolvedLocation param instead of using node.location
- TickProcessor: removed location_mismatch auto-movement (never fires)
- Prompts: location only required for movement nodes in output schema
- Eliminates location_mismatch failures caused by auto-movement or
  stale location data in planned nodes"
```
