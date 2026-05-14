# Tick Engine Plugin Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the monolithic tickProcessor into a pluggable game engine with NodeHandler and WorldFeature registries, enabling new game mechanics via independent files.

**Architecture:** Two-layer plugin system — NodeHandlers dispatch node execution by type, WorldFeatures run between buckets to simulate world systems. A central GameEngineRegistry holds both and auto-generates LLM prompt fragments. Migration is incremental: registry with fallback → extract handlers one by one → extract features → automate prompts.

**Tech Stack:** TypeScript (ESM, NodeNext), existing DynamicGameStateManager API, LangGraph graph integration

**Design Doc:** `docs/plans/2026-03-09-tick-engine-plugin-architecture-design.md`

---

### Task 1: Create Engine Type Definitions

**Files:**
- Create: `src/dynamicworldagent/engine/types.ts`

**Step 1: Write types file**

```typescript
import type { ActionType } from "../../shared/state/index.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { PlanNode, CharacterAction } from "../dynamicBasicAgent/npcPlanning/types.js";

// ===== Node Handler: executes a specific PlanNode type =====

export interface NodeHandler {
  /** The PlanNodeType this handler processes (e.g. "movement", "fire_spread") */
  type: string;

  /** Execute a single node, return the resulting action */
  execute(node: PlanNode, dgsm: DynamicGameStateManager, ctx: ExecutionContext): CharacterAction;

  // --- LLM prompt metadata (auto-injected into plan agent prompts) ---

  /** Human-readable description of what this type does */
  description: string;

  /** Fields the LLM must provide on the PlanNode */
  requiredFields: string[];

  /** Fields the LLM may optionally provide */
  optionalFields?: string[];

  /** Example PlanNode for the LLM prompt */
  exampleNode: Partial<PlanNode>;
}

// ===== World Feature: self-running world system =====

export interface WorldFeature {
  /** Unique identifier */
  id: string;

  /** Which SceneCondition types this feature manages */
  conditionTypes: string[];

  /** Human-readable description */
  description: string;

  /** Called after each 5-min bucket. Return new PlanNodes to inject into subsequent buckets. */
  onBucketEnd(bucketActions: CharacterAction[], dgsm: DynamicGameStateManager): PlanNode[];

  /** Called once at tick start */
  onTickStart?(dgsm: DynamicGameStateManager): void;

  /** Called once at tick end with all actions from the entire tick */
  onTickEnd?(allActions: CharacterAction[], dgsm: DynamicGameStateManager): void;

  /** Generate current state description for LLM context. Return "" to omit from prompt. */
  stateDescription(dgsm: DynamicGameStateManager): string;
}

// ===== Execution Context: shared utilities passed to handlers =====

export interface ExecutionContext {
  /** Resolve a skill roll for the node */
  resolveSkillRoll(
    node: PlanNode,
    adjustedSkills: Record<string, number>,
    dgsm: DynamicGameStateManager
  ): SkillRollResult;

  /** Get scene penalties for a location */
  getScenePenalties(location: string, dgsm: DynamicGameStateManager): Map<string, number>;

  /** Apply penalties to a skills record */
  applyPenalties(skills: Record<string, number>, penalties: Map<string, number>): Record<string, number>;

  /** Get difficulty for a node (player explicit or NPC relationship-derived) */
  getNodeDifficulty(node: PlanNode, dgsm: DynamicGameStateManager): "regular" | "hard" | "extreme" | "luck_only";

  /** Luck-based failure rate */
  luckFailureRate(luck: number): number;

  /** Select best skill for an action description + action type */
  selectBestSkill(
    actionDesc: string,
    actionType: ActionType,
    npcSkills: Record<string, number>
  ): { skill: string; value: number } | null;
}

export interface SkillRollResult {
  failed: boolean;
  reason?: string;
  detail?: string;
  successLevel: import("../dynamicBasicAgent/npcPlanning/types.js").SuccessLevel;
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit src/dynamicworldagent/engine/types.ts`
Expected: No errors (or only unrelated errors from other files)

**Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/types.ts
git commit -m "feat(engine): add NodeHandler, WorldFeature, ExecutionContext type definitions"
```

---

### Task 2: Create GameEngineRegistry

**Files:**
- Create: `src/dynamicworldagent/engine/registry.ts`

**Step 1: Write registry implementation**

```typescript
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { NodeHandler, WorldFeature } from "./types.js";

export class GameEngineRegistry {
  private handlers = new Map<string, NodeHandler>();
  private features = new Map<string, WorldFeature>();

  registerHandler(handler: NodeHandler): void {
    if (this.handlers.has(handler.type)) {
      console.warn(`[GameEngineRegistry] Overwriting handler for type: ${handler.type}`);
    }
    this.handlers.set(handler.type, handler);
  }

  registerFeature(feature: WorldFeature): void {
    if (this.features.has(feature.id)) {
      console.warn(`[GameEngineRegistry] Overwriting feature: ${feature.id}`);
    }
    this.features.set(feature.id, feature);
  }

  getHandler(type: string): NodeHandler | undefined {
    return this.handlers.get(type);
  }

  hasHandler(type: string): boolean {
    return this.handlers.has(type);
  }

  getAllHandlers(): NodeHandler[] {
    return [...this.handlers.values()];
  }

  getAllFeatures(): WorldFeature[] {
    return [...this.features.values()];
  }

  getFeature(id: string): WorldFeature | undefined {
    return this.features.get(id);
  }

  /** Auto-generate prompt fragment listing all registered node types with descriptions + examples */
  buildHandlerPrompt(): string {
    if (this.handlers.size === 0) return "";

    let prompt = "## Node Type Reference\n\n";
    for (const handler of this.handlers.values()) {
      prompt += `### ${handler.type}\n`;
      prompt += `${handler.description}\n`;
      prompt += `Required fields: ${handler.requiredFields.join(", ")}\n`;
      if (handler.optionalFields?.length) {
        prompt += `Optional fields: ${handler.optionalFields.join(", ")}\n`;
      }
      prompt += `Example:\n\`\`\`json\n${JSON.stringify(handler.exampleNode, null, 2)}\n\`\`\`\n\n`;
    }
    return prompt;
  }

  /** Auto-generate prompt fragment with current world state from all active features */
  buildWorldStatePrompt(dgsm: DynamicGameStateManager): string {
    const sections: string[] = [];
    for (const feature of this.features.values()) {
      const state = feature.stateDescription(dgsm);
      if (state) {
        sections.push(`### ${feature.description}\n${state}`);
      }
    }
    if (sections.length === 0) return "";
    return "## Current World State\n\n" + sections.join("\n\n") + "\n";
  }
}
```

**Step 2: Verify it compiles**

Run: `pnpm build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/registry.ts
git commit -m "feat(engine): add GameEngineRegistry with handler/feature registration and prompt generation"
```

---

### Task 3: Extract Shared Utilities

Extract the pure utility functions from `tickProcessor.ts` that all handlers share.

**Files:**
- Create: `src/dynamicworldagent/engine/shared/skillRoll.ts`
- Create: `src/dynamicworldagent/engine/shared/scenePenalty.ts`
- Create: `src/dynamicworldagent/engine/shared/dice.ts`
- Create: `src/dynamicworldagent/engine/shared/nodeHelpers.ts`
- Create: `src/dynamicworldagent/engine/shared/index.ts`

**Step 1: Extract dice utilities**

Create `src/dynamicworldagent/engine/shared/dice.ts` with functions from tickProcessor.ts lines 114-272:
- `rollD100()`
- `isFumble(roll, skillValue)`
- `getSuccessLevel(roll, skillValue)`
- `getSuccessLevelWithDifficulty(roll, skillValue, difficulty)`
- `SUCCESS_RANK`
- `luckFailureRate(luck)`
- `getDamageBonus(str, siz)`
- `rollDamageBonus(db)`

```typescript
import type { SuccessLevel } from "../../dynamicBasicAgent/npcPlanning/types.js";

export function rollD100(): number {
  return Math.floor(Math.random() * 100) + 1;
}

export function isFumble(roll: number, skillValue: number): boolean {
  return skillValue < 50 ? roll >= 96 : roll === 100;
}

export function getSuccessLevel(roll: number, skillValue: number): SuccessLevel {
  if (roll === 1) return "critical";
  if (isFumble(roll, skillValue)) return "fumble";
  if (roll <= Math.floor(skillValue / 5)) return "hard";
  if (roll <= Math.floor(skillValue / 2)) return "hard";
  if (roll <= skillValue) return "regular";
  return "fail";
}

export function getSuccessLevelWithDifficulty(
  roll: number,
  skillValue: number,
  difficulty: "regular" | "hard" | "extreme"
): SuccessLevel {
  if (roll === 1) return "critical";
  if (isFumble(roll, skillValue)) return "fumble";
  const threshold =
    difficulty === "extreme" ? Math.floor(skillValue / 5)
    : difficulty === "hard" ? Math.floor(skillValue / 2)
    : skillValue;
  if (roll <= threshold) return "regular";
  return "fail";
}

export const SUCCESS_RANK: Record<SuccessLevel, number> = {
  critical: 3,
  hard: 2,
  regular: 1,
  fail: 0,
  fumble: -1,
};

export function luckFailureRate(luck: number): number {
  return 0.025 + (100 - luck) * 0.0005;
}

export function getDamageBonus(str: number, siz: number): string {
  const total = str + siz;
  if (total <= 64) return "-2";
  if (total <= 84) return "-1";
  if (total <= 124) return "0";
  if (total <= 164) return "+1d4";
  if (total <= 204) return "+1d6";
  return "+2d6";
}

export function rollDamageBonus(db: string): number {
  if (db === "0") return 0;
  const sign = db.startsWith("-") ? -1 : 1;
  const diceMatch = db.match(/(\d+)d(\d+)/);
  if (diceMatch) {
    const count = parseInt(diceMatch[1]);
    const sides = parseInt(diceMatch[2]);
    let total = 0;
    for (let i = 0; i < count; i++) {
      total += Math.floor(Math.random() * sides) + 1;
    }
    return sign * total;
  }
  const flat = parseInt(db);
  return isNaN(flat) ? 0 : flat;
}
```

**Step 2: Extract scene penalty utilities**

Create `src/dynamicworldagent/engine/shared/scenePenalty.ts` with functions from tickProcessor.ts lines 276-304:

```typescript
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { SceneCondition } from "../../dynamicBasicAgent/npcPlanning/types.js";

export function getScenePenalties(
  location: string,
  dgsm: DynamicGameStateManager
): Map<string, number> {
  const penalties = new Map<string, number>();
  const conditions: SceneCondition[] = dgsm.getSceneConditions(location);
  for (const cond of conditions) {
    if (cond.mechanicalEffect?.skillPenalty) {
      for (const p of cond.mechanicalEffect.skillPenalty) {
        penalties.set(p.skill, (penalties.get(p.skill) ?? 0) + p.delta);
      }
    }
  }
  return penalties;
}

export function applyPenalties(
  skills: Record<string, number>,
  penalties: Map<string, number>
): Record<string, number> {
  if (penalties.size === 0) return skills;
  const adjusted = { ...skills };
  for (const [skill, delta] of penalties) {
    if (adjusted[skill] !== undefined) {
      adjusted[skill] = Math.max(1, adjusted[skill] + delta);
    }
  }
  return adjusted;
}
```

**Step 3: Extract skill roll resolution**

Create `src/dynamicworldagent/engine/shared/skillRoll.ts` with the `resolveSkillRoll` function from tickProcessor.ts lines 308-449, `getNodeDifficulty` from lines 156-174, `selectBestSkill` from lines 178-215, and `matchHorrorSource` from lines 219-237. Import dice utilities from `./dice.js`.

This file is large (~200 lines) — copy the exact logic from tickProcessor.ts lines 156-449, updating imports to use local `./dice.js` and `../../dynamicBasicAgent/npcPlanning/actionTypeSkillMap.js`.

**Step 4: Extract node helpers**

Create `src/dynamicworldagent/engine/shared/nodeHelpers.ts` with:
- `makeAction()` — builds CharacterAction from PlanNode (tickProcessor.ts lines 912-932)
- `buildOutcome()` — builds rich outcome string (tickProcessor.ts lines 887-910)

These need slight refactoring to be standalone functions instead of closures (pass `resolvedSuccessLevel`, `lastRollDetail`, `difficulty` as parameters).

```typescript
import type { PlanNode, CharacterAction, FailureReason, SuccessLevel } from "../../dynamicBasicAgent/npcPlanning/types.js";

export function buildOutcome(
  node: PlanNode,
  status: "completed" | "failed",
  opts?: { rollDetail?: string; reason?: string }
): string {
  const parts: string[] = [node.action];
  if (opts?.rollDetail) {
    parts.push(`[${opts.rollDetail}]`);
  } else if (opts?.reason) {
    parts.push(`[${opts.reason}]`);
  }
  // Payload context
  if (node.type === "character_interaction" && node.characterInteractionPayload) {
    const p = node.characterInteractionPayload;
    if (p.transferType === "item" && p.itemId) parts.push(`(item: ${p.itemId})`);
    else if (p.transferType === "clue" && p.clueId) parts.push(`(clue: ${p.clueId})`);
    else if (p.transferType === "information" && p.informationContent) parts.push(`(info: ${p.informationContent})`);
  } else if (node.type === "object_interaction" && node.objectInteractionPayload) {
    const p = node.objectInteractionPayload;
    parts.push(`(${p.action}${p.itemId ? `: ${p.itemId}` : ""})`);
  } else if (node.type === "scene_interaction" && node.sceneConnectionEffect) {
    const e = node.sceneConnectionEffect;
    parts.push(`(${e.action} connection to ${e.targetScenarioId})`);
  }
  parts.push(status === "completed" ? "succeeded" : "failed");
  return parts.join(" ");
}

export function makeAction(
  node: PlanNode,
  status: "completed" | "failed",
  outcome: string,
  opts?: {
    difficulty?: "regular" | "hard" | "extreme" | "luck_only";
    successLevel?: SuccessLevel;
    failureReason?: FailureReason;
  }
): CharacterAction {
  return {
    characterId: node.characterId,
    characterName: node.characterName,
    gameTime: node.gameTime,
    action: node.action,
    location: node.location,
    type: node.type,
    actionType: node.actionType,
    impact: node.impact,
    isPlayer: node.isPlayer,
    difficulty: opts?.difficulty,
    successLevel: opts?.successLevel,
    status,
    outcome,
    failureReason: opts?.failureReason,
    targetCharacterId: node.targetCharacterId,
  };
}
```

**Step 5: Create barrel export**

Create `src/dynamicworldagent/engine/shared/index.ts`:

```typescript
export * from "./dice.js";
export * from "./scenePenalty.js";
export * from "./skillRoll.js";
export * from "./nodeHelpers.js";
```

**Step 6: Verify build**

Run: `pnpm build`
Expected: Build succeeds

**Step 7: Commit**

```bash
git add src/dynamicworldagent/engine/shared/
git commit -m "feat(engine): extract shared utilities (dice, skillRoll, scenePenalty, nodeHelpers)"
```

---

### Task 4: Create ExecutionContext Implementation

**Files:**
- Create: `src/dynamicworldagent/engine/executionContext.ts`

**Step 1: Write the execution context**

This wraps the shared utilities into the `ExecutionContext` interface so handlers receive them:

```typescript
import type { ExecutionContext } from "./types.js";
import {
  resolveSkillRoll,
  getNodeDifficulty,
  selectBestSkill,
  luckFailureRate,
  getScenePenalties,
  applyPenalties,
} from "./shared/index.js";

export function createExecutionContext(): ExecutionContext {
  return {
    resolveSkillRoll,
    getScenePenalties,
    applyPenalties,
    getNodeDifficulty,
    luckFailureRate,
    selectBestSkill,
  };
}
```

**Step 2: Verify build**

Run: `pnpm build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/executionContext.ts
git commit -m "feat(engine): add ExecutionContext factory wrapping shared utilities"
```

---

### Task 5: Extract routineHandler

**Files:**
- Create: `src/dynamicworldagent/engine/handlers/routineHandler.ts`

**Step 1: Write the handler**

Extract logic from tickProcessor.ts lines 936-951:

```typescript
import type { NodeHandler } from "../types.js";
import type { PlanNode, CharacterAction } from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { ExecutionContext } from "../types.js";
import { buildOutcome, makeAction } from "../shared/nodeHelpers.js";

export const routineHandler: NodeHandler = {
  type: "routine",

  description:
    "Self-contained action, no interaction target. Examples: eating, resting, reading something already in hand, thinking, recalling memories.",

  requiredFields: ["action", "location"],
  optionalFields: ["actionType", "difficulty"],

  exampleNode: {
    type: "routine",
    action: "Read the diary found earlier",
    location: "hotel_room",
    impact: 0,
    timeAdvanceMinutes: 15,
  },

  execute(node: PlanNode, dgsm: DynamicGameStateManager, ctx: ExecutionContext): CharacterAction {
    const npcLocation = dgsm.getNpcLocation(node.characterId);
    const difficulty = ctx.getNodeDifficulty(node, dgsm);

    if (npcLocation && npcLocation !== node.location) {
      return makeAction(node, "failed", buildOutcome(node, "failed", { reason: "not at expected location" }), {
        difficulty,
        failureReason: "location_mismatch",
      });
    }

    if (node.actionType) {
      const npc = dgsm.getState().npcCharacters.find((n) => n.id === node.characterId);
      const npcSkills = npc?.skills ?? {};
      const penalties = ctx.getScenePenalties(node.location, dgsm);
      const adjustedSkills = ctx.applyPenalties(npcSkills, penalties);
      const rollResult = ctx.resolveSkillRoll(node, adjustedSkills, dgsm);
      if (rollResult.failed) {
        return makeAction(node, "failed", buildOutcome(node, "failed", { reason: rollResult.reason }), {
          difficulty,
          successLevel: rollResult.successLevel,
          failureReason: "skill_roll_failed",
        });
      }
      return makeAction(node, "completed", buildOutcome(node, "completed", { rollDetail: rollResult.detail }), {
        difficulty,
        successLevel: rollResult.successLevel,
      });
    }

    return makeAction(node, "completed", buildOutcome(node, "completed"), { difficulty });
  },
};
```

**Step 2: Verify build**

Run: `pnpm build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/routineHandler.ts
git commit -m "feat(engine): extract routineHandler from executeNode"
```

---

### Task 6: Extract movementHandler

**Files:**
- Create: `src/dynamicworldagent/engine/handlers/movementHandler.ts`

**Step 1: Write the handler**

Extract logic from tickProcessor.ts lines 953-993. Also needs the pathfinding helpers (`findPath`, `calculateTravelTime`) from lines 27-93. Import them — they can stay in shared or be imported from the original tickProcessor for now.

Create `src/dynamicworldagent/engine/shared/pathfinding.ts` first with `findPath` and `calculateTravelTime` extracted from tickProcessor.ts lines 27-93.

Then write the handler following the same pattern as routineHandler, using `buildOutcome` and `makeAction` from shared, and calling `ctx.resolveSkillRoll` for creative movement, pathfinding for normal movement.

**Step 2: Verify build**

Run: `pnpm build`

**Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/shared/pathfinding.ts src/dynamicworldagent/engine/handlers/movementHandler.ts
git commit -m "feat(engine): extract movementHandler with pathfinding utilities"
```

---

### Task 7: Extract characterInteractionHandler

**Files:**
- Create: `src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts`

**Step 1: Write the handler**

Extract logic from tickProcessor.ts lines 995-1054. This is the most complex handler with:
- Location + target presence checks
- luck_only difficulty path for NPCs
- Player vs NPC branching for skill rolls
- Side effects: item/clue transfer via dgsm methods

Follow the same pattern. Use `ctx.luckFailureRate()` for luck checks.

**Step 2: Verify build**

Run: `pnpm build`

**Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/characterInteractionHandler.ts
git commit -m "feat(engine): extract characterInteractionHandler"
```

---

### Task 8: Extract objectInteractionHandler

**Files:**
- Create: `src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts`

**Step 1: Write the handler**

Extract logic from tickProcessor.ts lines 1056-1114. Similar structure to characterInteractionHandler but with object-specific side effects (pickup, place, destroy).

**Step 2: Verify build**

Run: `pnpm build`

**Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/objectInteractionHandler.ts
git commit -m "feat(engine): extract objectInteractionHandler"
```

---

### Task 9: Extract sceneInteractionHandler

**Files:**
- Create: `src/dynamicworldagent/engine/handlers/sceneInteractionHandler.ts`

**Step 1: Write the handler**

Extract logic from tickProcessor.ts lines 1116-1159. Side effects: append scene condition, block/unblock connections.

**Step 2: Verify build**

Run: `pnpm build`

**Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/sceneInteractionHandler.ts
git commit -m "feat(engine): extract sceneInteractionHandler"
```

---

### Task 10: Create Handler Barrel Export + Register All 5 Handlers

**Files:**
- Create: `src/dynamicworldagent/engine/handlers/index.ts`
- Create: `src/dynamicworldagent/engine/registerDefaults.ts`

**Step 1: Create handlers barrel**

```typescript
export { routineHandler } from "./routineHandler.js";
export { movementHandler } from "./movementHandler.js";
export { characterInteractionHandler } from "./characterInteractionHandler.js";
export { objectInteractionHandler } from "./objectInteractionHandler.js";
export { sceneInteractionHandler } from "./sceneInteractionHandler.js";
```

**Step 2: Create default registration**

```typescript
import { GameEngineRegistry } from "./registry.js";
import {
  routineHandler,
  movementHandler,
  characterInteractionHandler,
  objectInteractionHandler,
  sceneInteractionHandler,
} from "./handlers/index.js";

export function createDefaultRegistry(): GameEngineRegistry {
  const registry = new GameEngineRegistry();

  // Register all built-in handlers
  registry.registerHandler(routineHandler);
  registry.registerHandler(movementHandler);
  registry.registerHandler(characterInteractionHandler);
  registry.registerHandler(objectInteractionHandler);
  registry.registerHandler(sceneInteractionHandler);

  // Features will be registered in subsequent tasks

  return registry;
}
```

**Step 3: Verify build**

Run: `pnpm build`

**Step 4: Commit**

```bash
git add src/dynamicworldagent/engine/handlers/index.ts src/dynamicworldagent/engine/registerDefaults.ts
git commit -m "feat(engine): add handler barrel exports and createDefaultRegistry"
```

---

### Task 11: Refactor tickProcessor to Use Registry Dispatch

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`
- Create: `src/dynamicworldagent/engine/index.ts`

**Step 1: Create engine barrel export**

```typescript
export type { NodeHandler, WorldFeature, ExecutionContext, SkillRollResult } from "./types.js";
export { GameEngineRegistry } from "./registry.js";
export { createDefaultRegistry } from "./registerDefaults.js";
export { createExecutionContext } from "./executionContext.js";
```

**Step 2: Modify runTick signature**

In `tickProcessor.ts`, update `runTick` to accept registry + ctx:

```typescript
import { GameEngineRegistry } from "../../engine/registry.js";
import type { ExecutionContext } from "../../engine/types.js";

export async function runTick(
  playerNodes: PlanNode[],
  dgsm: DynamicGameStateManager,
  npcPlanningAgent: NPCPlanningAgent,
  sessionId: string,
  language: string = "en",
  registry?: GameEngineRegistry,
  ctx?: ExecutionContext
): Promise<TickResult> {
```

**Step 3: Replace executeNode dispatch**

Inside the bucket execution loop (line ~1268), replace:

```typescript
const action = executeNode(node, dgsm);
```

with:

```typescript
let action: CharacterAction;
if (registry && ctx && registry.hasHandler(node.type)) {
  action = registry.getHandler(node.type)!.execute(node, dgsm, ctx);
} else {
  action = executeNode(node, dgsm);  // fallback to legacy
}
```

**Step 4: Add WorldFeature onBucketEnd calls**

After the impact gate call in the bucket loop (after line ~1370), add:

```typescript
// WorldFeature bucket-end processing
if (registry) {
  for (const feature of registry.getAllFeatures()) {
    const newNodes = feature.onBucketEnd(bucketActions, dgsm);
    if (newNodes.length > 0) {
      // Inject into remaining buckets
      for (const newNode of newNodes) {
        const newBucket = minutesToBucket(timeToMinutes(newNode.gameTime));
        if (!buckets.has(newBucket)) {
          buckets.set(newBucket, []);
          // Insert new bucket key in sorted order
          const insertIdx = sortedBucketKeys.findIndex(k => k > newBucket);
          if (insertIdx === -1) sortedBucketKeys.push(newBucket);
          else sortedBucketKeys.splice(insertIdx, 0, newBucket);
        }
        buckets.get(newBucket)!.push(newNode);
      }
    }
  }
}
```

**Step 5: Add tick start/end hooks**

At the beginning of `runTick` (after line ~1207):

```typescript
if (registry) {
  for (const feature of registry.getAllFeatures()) {
    feature.onTickStart?.(dgsm);
  }
}
```

At the end before return (before line ~1419):

```typescript
if (registry) {
  for (const feature of registry.getAllFeatures()) {
    feature.onTickEnd?.(allActions, dgsm);
  }
}
```

**Step 6: Apply same changes to resumeTick**

Mirror the registry/ctx parameters and dispatch logic in `resumeTick` (lines 1424-1580).

**Step 7: Verify build**

Run: `pnpm build`
Expected: Build succeeds. The old `executeNode` function still exists as fallback.

**Step 8: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts src/dynamicworldagent/engine/index.ts
git commit -m "feat(engine): integrate registry dispatch into tickProcessor with legacy fallback"
```

---

### Task 12: Update Graph to Create and Pass Registry

**Files:**
- Modify: `src/dynamicworldagent/graph/dynamicGraph.ts`

**Step 1: Import and create registry**

At the top of the graph builder function, import and instantiate:

```typescript
import { createDefaultRegistry, createExecutionContext } from "../../engine/index.js";

// Inside the graph builder:
const registry = createDefaultRegistry();
const executionCtx = createExecutionContext();
```

**Step 2: Pass registry to runTick calls**

In the `tickExecutionLoop` node (line ~488), update:

```typescript
tickResult = await runTick(
  pendingPlayerNodes,
  dgsm,
  npcPlanningAgent,
  dgsm.getState().sessionId,
  language,
  registry,
  executionCtx
);
```

And the `resumeTick` call (line ~471):

```typescript
tickResult = await resumeTick(
  pendingInterrupt.remainingBuckets,
  pendingInterrupt.previousActions,
  dgsm,
  npcPlanningAgent,
  dgsm.getState().sessionId,
  pendingPlayerNodes,
  language,
  registry,
  executionCtx
);
```

**Step 3: Verify build**

Run: `pnpm build`

**Step 4: Commit**

```bash
git add src/dynamicworldagent/graph/dynamicGraph.ts
git commit -m "feat(engine): pass registry and execution context through graph to tickProcessor"
```

---

### Task 13: Verify Handlers Match Legacy Behavior

**Files:**
- Create: `src/dynamicworldagent/engine/__tests__/handlerParity.test.ts`

**Step 1: Write parity tests**

Test each handler against the legacy `executeNode` with identical inputs to verify same outputs. Use Vitest. Mock `dgsm` with a minimal stub.

Test cases for each of the 5 handlers:
- Successful execution (no actionType)
- Successful execution (with actionType, mocked skill roll)
- Location mismatch failure
- Skill roll failure
- Handler-specific: movement blocked path, character_interaction target absent, etc.

**Step 2: Run tests**

Run: `npx vitest run src/dynamicworldagent/engine/__tests__/handlerParity.test.ts`
Expected: All pass

**Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/__tests__/handlerParity.test.ts
git commit -m "test(engine): add handler parity tests against legacy executeNode"
```

---

### Task 14: Remove Legacy executeNode Fallback

Once parity is verified, remove the fallback.

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

**Step 1: Remove fallback dispatch**

Replace the conditional dispatch:

```typescript
let action: CharacterAction;
if (registry && ctx && registry.hasHandler(node.type)) {
  action = registry.getHandler(node.type)!.execute(node, dgsm, ctx);
} else {
  action = executeNode(node, dgsm);
}
```

With direct registry dispatch:

```typescript
const handler = registry.getHandler(node.type);
if (!handler) {
  console.warn(`[TickProcessor] No handler for node type: ${node.type}, skipping`);
  continue;
}
const action = handler.execute(node, dgsm, ctx);
```

**Step 2: Make registry and ctx required parameters**

Change `registry?: GameEngineRegistry` to `registry: GameEngineRegistry` and same for `ctx`.

**Step 3: Delete the old executeNode function**

Remove lines 868-1163 (the entire `executeNode` function) from tickProcessor.ts.

**Step 4: Also delete the now-unused imports and helper functions** that were extracted to shared/ and are no longer called directly from tickProcessor.ts:
- `getNodeDifficulty`, `selectBestSkill`, `matchHorrorSource`, `resolveSkillRoll`
- `getScenePenalties`, `applyPenalties`
- `rollD100`, `isFumble`, `getSuccessLevel`, `getSuccessLevelWithDifficulty`, `SUCCESS_RANK`
- `luckFailureRate`, `getDamageBonus`, `rollDamageBonus`

Keep: `timeToMinutes`, `minutesToBucket`, `getBucketLabel`, `findPath`, `calculateTravelTime`, `scanUnplannedEncounters`, `runImpactGate`, `discoverClues`, `embedDiscoveredClues`, `findNeighborMacroLocations`, `getParentLocationId`, `cosineSimilarity`

**Step 5: Verify build**

Run: `pnpm build`

**Step 6: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "refactor(engine): remove legacy executeNode, use registry dispatch exclusively"
```

---

### Task 15: Extract impactGateFeature

**Files:**
- Create: `src/dynamicworldagent/engine/features/impactGateFeature.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

**Step 1: Write the impact gate as a WorldFeature**

The impact gate is complex and async — it needs `NPCPlanningAgent`, `sessionId`, `gameDay`, `language`. This doesn't fit the simple `WorldFeature.onBucketEnd` signature cleanly.

**Approach:** Make the impact gate a "stateful" WorldFeature that gets configured with runtime dependencies:

```typescript
import type { WorldFeature } from "../types.js";
import type { PlanNode, CharacterAction } from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { NPCPlanningAgent } from "../../dynamicBasicAgent/npcPlanning/NPCPlanningAgent.js";

export class ImpactGateFeature implements WorldFeature {
  id = "impact_gate";
  conditionTypes: string[] = [];
  description = "Impact propagation: high-impact actions alert nearby NPCs who may revise plans";

  private npcPlanningAgent: NPCPlanningAgent;
  private sessionId: string;
  private gameDay: number;
  private language: string;

  // Accumulated player events from current tick (consumed by graph for interrupt)
  playerEvents: Array<{ event: CharacterAction; impact: number }> = [];

  constructor(deps: {
    npcPlanningAgent: NPCPlanningAgent;
    sessionId: string;
    gameDay: number;
    language: string;
  }) {
    this.npcPlanningAgent = deps.npcPlanningAgent;
    this.sessionId = deps.sessionId;
    this.gameDay = deps.gameDay;
    this.language = deps.language;
  }

  onTickStart(dgsm: DynamicGameStateManager): void {
    this.playerEvents = [];
  }

  onBucketEnd(bucketActions: CharacterAction[], dgsm: DynamicGameStateManager): PlanNode[] {
    // Note: The actual impact gate is async and needs to be called separately
    // This is a sync placeholder — the async logic stays in tickProcessor for now
    // until WorldFeature interface supports async onBucketEnd
    return [];
  }

  stateDescription(_dgsm: DynamicGameStateManager): string {
    return ""; // Impact gate has no visible state for LLM
  }
}
```

**Important note:** The impact gate's `onBucketEnd` is async (LLM calls for each affected NPC). The WorldFeature interface currently defines `onBucketEnd` as returning `PlanNode[]` synchronously.

**Decision for this task:** Keep the impact gate call inline in tickProcessor for now. Update the `WorldFeature.onBucketEnd` signature to `PlanNode[] | Promise<PlanNode[]>` in types.ts to support async features. Then move the impact gate in a follow-up.

Update `types.ts`:

```typescript
onBucketEnd(bucketActions: CharacterAction[], dgsm: DynamicGameStateManager): PlanNode[] | Promise<PlanNode[]>;
```

And update the dispatch in tickProcessor:

```typescript
for (const feature of registry.getAllFeatures()) {
  const newNodes = await feature.onBucketEnd(bucketActions, dgsm);
  // ... inject nodes
}
```

**Step 2: Verify build**

Run: `pnpm build`

**Step 3: Commit**

```bash
git add src/dynamicworldagent/engine/types.ts src/dynamicworldagent/engine/features/impactGateFeature.ts src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "feat(engine): add async WorldFeature support, scaffold ImpactGateFeature"
```

---

### Task 16: Update PlayerPlanAgent to Use Registry Prompt

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanAgent.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts`

**Step 1: Pass registry to PlayerPlanAgent**

Add `registry` parameter to `generatePlayerNodes`:

```typescript
import type { GameEngineRegistry } from "../../engine/registry.js";

async generatePlayerNodes(
  playerInput: string,
  dgsm: DynamicGameStateManager,
  orchestratorOutput: { ... },
  selectedSkill?: string | null,
  language?: string,
  registry?: GameEngineRegistry
): Promise<PlanNode[]> {
```

**Step 2: Update PlayerPlanTemplate to accept dynamic sections**

Add new fields to `PlayerPlanParams`:

```typescript
export interface PlayerPlanParams {
  // ... existing fields ...
  handlerPrompt?: string;     // from registry.buildHandlerPrompt()
  worldStatePrompt?: string;  // from registry.buildWorldStatePrompt()
}
```

**Step 3: In buildPlayerPlanPrompt, replace hardcoded Node Type Reference**

Replace the hardcoded `## Node Type Reference` section (lines 76-81) and `## The 8 ActionType Categories` section (lines 83-128) with:

```typescript
${params.handlerPrompt || DEFAULT_NODE_TYPE_REFERENCE}
```

Where `DEFAULT_NODE_TYPE_REFERENCE` is the current hardcoded text (as fallback when no registry is provided).

**Step 4: Add world state to prompt**

After Scene Conditions section, add:

```typescript
${params.worldStatePrompt || ""}
```

**Step 5: In PlayerPlanAgent, generate and pass these sections**

```typescript
const handlerPrompt = registry?.buildHandlerPrompt();
const worldStatePrompt = registry?.buildWorldStatePrompt(dgsm);

const params: PlayerPlanParams = {
  // ... existing params ...
  handlerPrompt,
  worldStatePrompt,
};
```

**Step 6: Verify build**

Run: `pnpm build`

**Step 7: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanAgent.ts src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts
git commit -m "feat(engine): PlayerPlanAgent uses registry-generated prompts for node types and world state"
```

---

### Task 17: Update Graph to Pass Registry to PlayerPlanAgent

**Files:**
- Modify: `src/dynamicworldagent/graph/dynamicGraph.ts`

**Step 1: Pass registry to PlayerPlanAgent call**

In the `playerPlanAgent` node (around line ~396), add `registry` parameter:

```typescript
const playerNodes = await playerPlanAgent.generatePlayerNodes(
  userInput,
  dgsm,
  orchestratorOutput,
  selectedSkill,
  language,
  registry  // new parameter
);
```

**Step 2: Verify build**

Run: `pnpm build`

**Step 3: Commit**

```bash
git add src/dynamicworldagent/graph/dynamicGraph.ts
git commit -m "feat(engine): pass registry to PlayerPlanAgent in graph"
```

---

### Task 18: End-to-End Smoke Test

**Files:**
- No new files. Manual testing.

**Step 1: Build the project**

Run: `pnpm build`
Expected: Clean build, no type errors

**Step 2: Start the server**

Run: `pnpm chat:dev`
Expected: Server starts without errors

**Step 3: Manual play test**

Play through 2-3 turns covering:
- A routine action (reading, resting)
- A movement action (move to another scene)
- A character interaction (talk to an NPC)
- A scene interaction (search the room)

Verify:
- Skill rolls work as before
- NPC nodes execute between player turns
- Impact gate fires on high-impact actions
- Clue discovery works
- No console errors related to missing handlers

**Step 4: Commit if any fixes needed**

---

### Task 19: Document How to Add a New Feature

**Files:**
- Create: `src/dynamicworldagent/engine/README.md`

**Step 1: Write developer guide**

Short guide explaining:
1. How to create a new NodeHandler (copy routineHandler as template)
2. How to create a new WorldFeature (with example)
3. How to register them in `registerDefaults.ts`
4. What happens automatically (prompt injection, tick dispatch)

**Step 2: Commit**

```bash
git add src/dynamicworldagent/engine/README.md
git commit -m "docs(engine): add developer guide for adding new handlers and features"
```
