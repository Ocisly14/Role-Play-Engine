# Operations Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create EngineTool implementations for all 4 handler/tool types (action, movement, character_interaction, item), establishing the unified operations pattern. EngineTools are registered alongside existing handlers — no existing flow changes yet.

**Architecture:** Each operation wraps existing handler + resolver logic. execute() produces `{delta, narrative}`, applyDelta() applies state changes. Existing tick processor continues using old handlers; the new EngineTools are registered but not called from tick yet (rewiring is a later sub-project).

**Tech Stack:** TypeScript, Vitest, Biome

---

### Task 1: Create operations directory and movementOp

Movement is the simplest — no LLM resolver needed. This establishes the pattern.

**Files:**
- Create: `src/engine/operations/movementOp.ts`
- Create: `src/engine/operations/__tests__/movementOp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/engine/operations/__tests__/movementOp.test.ts`:

```typescript
import { movementOp } from "../movementOp.js";

describe("movementOp", () => {
  it("has correct id and schema", () => {
    expect(movementOp.id).toBe("movement");
    expect(movementOp.schema.requiredParams.map((p) => p.name)).toEqual([
      "actorId",
      "action",
      "destination",
    ]);
  });

  it("execute returns delta with newPosition on success", async () => {
    const dgsm = {
      getState: () => ({
        npcCharacters: [{ id: "npc_a", skills: { Stealth: 50 } }],
        blockedConnections: [],
      }),
      getCharacterPosition: () => ({ type: "scene", sceneId: "s1" }),
      resolveLocationId: () => "s1",
      getTopology: () => ({
        scenes: [
          { id: "s1", outlineId: "o1" },
          { id: "s2", outlineId: "o1" },
        ],
        junctions: [],
        roads: [],
        outlines: [{ id: "o1", entrySceneId: "s1" }],
      }),
      setCharacterPosition: vi.fn(),
    };
    const ctx = {
      getNodeDifficulty: () => "regular" as const,
      getScenePenalties: () => new Map(),
      getCharacterPenalties: () => new Map(),
      applyPenalties: (_s: Record<string, number>) => _s,
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const result = await movementOp.execute(
      { actorId: "npc_a", action: "Walk to s2", destination: "s2" },
      dgsm as any,
      ctx as any,
    );

    expect(result.delta.status).toBe("completed");
    expect(result.narrative.outcome).toBeTruthy();
  });

  it("execute returns failed delta when no destination", async () => {
    const dgsm = {
      getState: () => ({
        npcCharacters: [{ id: "npc_a", skills: {} }],
        blockedConnections: [],
      }),
      getCharacterPosition: () => ({ type: "scene", sceneId: "s1" }),
      resolveLocationId: () => "s1",
      getTopology: () => ({ scenes: [], junctions: [], roads: [], outlines: [] }),
    };
    const ctx = {
      getNodeDifficulty: () => "regular" as const,
      getScenePenalties: () => new Map(),
      getCharacterPenalties: () => new Map(),
      applyPenalties: (_s: Record<string, number>) => _s,
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const result = await movementOp.execute(
      { actorId: "npc_a", action: "Walk", destination: "" },
      dgsm as any,
      ctx as any,
    );

    expect(result.delta.status).toBe("failed");
  });

  it("applyDelta sets character position when completed", () => {
    const setPos = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = { setCharacterPosition: setPos } as any;

    movementOp.applyDelta(dgsm, {
      status: "completed",
      actorId: "npc_a",
      newPosition: { type: "scene", sceneId: "s2" },
      outcome: "Arrived",
    });

    expect(setPos).toHaveBeenCalledWith("npc_a", {
      type: "scene",
      sceneId: "s2",
    });
  });

  it("applyDelta does nothing when failed", () => {
    const setPos = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = { setCharacterPosition: setPos } as any;

    movementOp.applyDelta(dgsm, {
      status: "failed",
      actorId: "npc_a",
      newPosition: null,
      outcome: "Blocked",
    });

    expect(setPos).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/operations/__tests__/movementOp.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Create movementOp.ts**

Create `src/engine/operations/movementOp.ts`:

```typescript
import type { CharacterPosition } from "../../state/topologyTypes.js";
import { findTopologyPath } from "../shared/pathfinding.js";
import type {
  EngineTool,
  EngineToolResult,
  ExecutionContext,
} from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { resolveTargetPosition } from "../handlers/movementHandler.js";

export interface MovementDelta {
  status: "completed" | "failed";
  actorId: string;
  newPosition: CharacterPosition | null;
  outcome: string;
  successLevel?: string;
  rollDetail?: string;
  failureReason?: string;
}

export const movementOp: EngineTool<MovementDelta> = {
  id: "movement",

  description:
    "Move a character to a different location via topology pathfinding or skill-based creative movement.",

  schema: {
    requiredParams: [
      { name: "actorId", type: "string", description: "Character performing the movement" },
      { name: "action", type: "string", description: "Description of the movement" },
      { name: "destination", type: "string", description: "Target location ID" },
    ],
    optionalParams: [
      { name: "skill", type: "string", description: "Skill for creative movement (bypasses pathfinding)" },
    ],
    example: { actorId: "npc_01", action: "Walk to the harbor", destination: "harbor_docks" },
  },

  async execute(
    params: Record<string, unknown>,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext,
  ): Promise<EngineToolResult<MovementDelta>> {
    const actorId = params.actorId as string;
    const destination = params.destination as string;
    const skill = params.skill as string | undefined;

    const state = dgsm.getState();
    const pos = dgsm.getCharacterPosition(actorId);
    const fromLocation = pos ? dgsm.resolveLocationId(pos) : "";
    const npc = state.npcCharacters.find((n) => n.id === actorId);
    const npcSkills = npc?.skills ?? {};

    if (!destination) {
      return {
        delta: {
          status: "failed",
          actorId,
          newPosition: null,
          outcome: "No destination specified",
          failureReason: "location_blocked",
        },
        narrative: { outcome: "No destination specified" },
      };
    }

    const scenePenalties = ctx.getScenePenalties(destination, dgsm);
    const charPenalties = ctx.getCharacterPenalties(actorId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    const topology = dgsm.getTopology();

    // Creative movement with skill check
    if (skill) {
      const pseudoNode = {
        characterId: actorId,
        skill,
        action: params.action,
        impact: 0,
      } as any;
      const rollResult = ctx.resolveSkillRoll(pseudoNode, adjustedSkills, dgsm);
      if (rollResult.failed) {
        return {
          delta: {
            status: "failed",
            actorId,
            newPosition: null,
            outcome: rollResult.reason ?? "Skill check failed",
            successLevel: rollResult.successLevel,
            rollDetail: rollResult.reason,
            failureReason: "skill_roll_failed",
          },
          narrative: { outcome: rollResult.reason ?? "Skill check failed" },
        };
      }

      const targetPos = resolveTargetPosition(destination, topology, dgsm);
      return {
        delta: {
          status: "completed",
          actorId,
          newPosition: targetPos ?? null,
          outcome: `Moved to ${destination}`,
          successLevel: rollResult.successLevel,
          rollDetail: rollResult.detail,
        },
        narrative: { outcome: `Moved to ${destination}` },
      };
    }

    // Topology-based movement
    const currentPos = dgsm.getCharacterPosition(actorId);
    const targetPos = resolveTargetPosition(destination, topology, dgsm);
    if (currentPos && targetPos) {
      const topologyPath = findTopologyPath(
        currentPos,
        targetPos,
        topology,
        state.blockedConnections,
        dgsm,
      );

      if (!topologyPath) {
        return {
          delta: {
            status: "failed",
            actorId,
            newPosition: null,
            outcome: "No path available",
            failureReason: "location_blocked",
          },
          narrative: { outcome: "No path available" },
        };
      }

      return {
        delta: {
          status: "completed",
          actorId,
          newPosition: targetPos,
          outcome: `Moved to ${destination}`,
        },
        narrative: { outcome: `Moved to ${destination}` },
      };
    }

    return {
      delta: {
        status: "failed",
        actorId,
        newPosition: null,
        outcome: "Cannot resolve positions",
        failureReason: "location_blocked",
      },
      narrative: { outcome: "Cannot resolve positions" },
    };
  },

  applyDelta(dgsm: DynamicGameStateManager, delta: MovementDelta): void {
    if (delta.status === "completed" && delta.newPosition) {
      dgsm.setCharacterPosition(delta.actorId, delta.newPosition);
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/operations/__tests__/movementOp.test.ts`
Expected: PASS.

- [ ] **Step 5: Run biome check**

Run: `pnpm check 2>&1 | grep "operations/" | head -5`
Expected: No errors in our files.

---

### Task 2: Create actionOp

Action requires an LLM resolver to produce the scene delta. The operation wraps actionHandler logic + resolveActionState.

**Files:**
- Create: `src/engine/operations/actionOp.ts`
- Create: `src/engine/operations/__tests__/actionOp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/engine/operations/__tests__/actionOp.test.ts`:

```typescript
import { actionOp } from "../actionOp.js";
import type { ActionDelta } from "../actionOp.js";

describe("actionOp", () => {
  it("has correct id and schema", () => {
    expect(actionOp.id).toBe("action");
    expect(actionOp.schema.requiredParams.map((p) => p.name)).toEqual([
      "actorId",
      "action",
    ]);
    expect(actionOp.schema.optionalParams?.map((p) => p.name)).toEqual([
      "skill",
    ]);
  });

  it("execute with no skill returns completed delta (resolver skipped without runtime)", async () => {
    const dgsm = {
      getState: () => ({
        npcCharacters: [{ id: "npc_a", name: "Alice", skills: {} }],
      }),
      getCharacterPosition: () => ({ type: "scene", sceneId: "s1" }),
      resolveLocationId: () => "s1",
    };
    const ctx = {
      getNodeDifficulty: () => "regular" as const,
      getScenePenalties: () => new Map(),
      getCharacterPenalties: () => new Map(),
      applyPenalties: (_s: Record<string, number>) => _s,
      runtime: undefined,
      language: "en",
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const result = await actionOp.execute(
      { actorId: "npc_a", action: "Rest quietly" },
      dgsm as any,
      ctx as any,
    );

    expect(result.delta.status).toBe("completed");
    expect(result.delta.actorId).toBe("npc_a");
    expect(result.delta.locationId).toBe("s1");
    expect(result.narrative.outcome).toBeTruthy();
  });

  it("execute with failed skill roll returns failed delta", async () => {
    const dgsm = {
      getState: () => ({
        npcCharacters: [
          { id: "npc_a", name: "Alice", skills: { Stealth: 10 } },
        ],
      }),
      getCharacterPosition: () => ({ type: "scene", sceneId: "s1" }),
      resolveLocationId: () => "s1",
    };
    const ctx = {
      getNodeDifficulty: () => "regular" as const,
      getScenePenalties: () => new Map(),
      getCharacterPenalties: () => new Map(),
      applyPenalties: (_s: Record<string, number>) => _s,
      resolveSkillRoll: () => ({
        failed: true,
        successLevel: "fail" as const,
        reason: "Rolled 99 vs 10",
      }),
      runtime: undefined,
      language: "en",
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const result = await actionOp.execute(
      { actorId: "npc_a", action: "Sneak past", skill: "Stealth" },
      dgsm as any,
      ctx as any,
    );

    expect(result.delta.status).toBe("failed");
    expect(result.delta.failureReason).toBe("skill_roll_failed");
  });

  it("applyDelta calls applyActionSceneDelta when sceneDelta present", () => {
    const appendCondition = vi.fn();
    const dgsm = {
      getSceneConditions: () => [],
      replaceSceneConditions: vi.fn(),
      appendSceneCondition: appendCondition,
      setConnectionBlocked: vi.fn(),
      setConnectionHidden: vi.fn(),
    };
    const delta: ActionDelta = {
      status: "completed",
      actorId: "npc_a",
      locationId: "s1",
      sceneDelta: {
        addSceneConditions: [{ description: "Room is tidy" }],
        memory: "I tidied the room",
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    actionOp.applyDelta(dgsm as any, delta);
    expect(appendCondition).toHaveBeenCalledWith("s1", {
      description: "Room is tidy",
    });
  });

  it("applyDelta does nothing when no sceneDelta", () => {
    const dgsm = {};
    const delta: ActionDelta = {
      status: "failed",
      actorId: "npc_a",
      locationId: "s1",
      sceneDelta: null,
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    actionOp.applyDelta(dgsm as any, delta);
    // No error = success
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/operations/__tests__/actionOp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create actionOp.ts**

Create `src/engine/operations/actionOp.ts`:

```typescript
import type { SceneStateDelta, SuccessLevel } from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  applyActionSceneDelta,
  resolveActionState,
} from "../handlers/actionStateResolver.js";
import type {
  EngineTool,
  EngineToolResult,
  ExecutionContext,
} from "../types.js";

export interface ActionDelta {
  status: "completed" | "failed";
  actorId: string;
  locationId: string;
  sceneDelta: SceneStateDelta | null;
  successLevel?: SuccessLevel;
  rollDetail?: string;
  failureReason?: string;
}

export const actionOp: EngineTool<ActionDelta> = {
  id: "action",

  description:
    "A current-location action performed in the actor's present scene. " +
    "Examples: resting, searching, listening, barring an exit, hiding.",

  schema: {
    requiredParams: [
      { name: "actorId", type: "string", description: "Character performing the action" },
      { name: "action", type: "string", description: "What the character does" },
    ],
    optionalParams: [
      { name: "skill", type: "string", description: "Skill to check (omit for auto-success)" },
    ],
    example: {
      actorId: "npc_01",
      action: "Search the study for hidden documents",
      skill: "Library Use",
    },
  },

  async execute(
    params: Record<string, unknown>,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext,
  ): Promise<EngineToolResult<ActionDelta>> {
    const actorId = params.actorId as string;
    const action = params.action as string;
    const skill = params.skill as string | undefined;

    const state = dgsm.getState();
    const pos = dgsm.getCharacterPosition(actorId);
    const locationId = pos ? dgsm.resolveLocationId(pos) : "";
    const npc = state.npcCharacters.find((n) => n.id === actorId);
    const npcSkills = npc?.skills ?? {};

    const scenePenalties = ctx.getScenePenalties(locationId, dgsm);
    const charPenalties = ctx.getCharacterPenalties(actorId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    let successLevel: SuccessLevel | undefined;
    let rollDetail: string | undefined;
    let status: "completed" | "failed" = "completed";
    let failureReason: string | undefined;

    if (skill) {
      const pseudoNode = { characterId: actorId, skill, action, impact: 0 } as any;
      const rollResult = ctx.resolveSkillRoll(pseudoNode, adjustedSkills, dgsm);
      successLevel = rollResult.successLevel;
      rollDetail = rollResult.failed ? rollResult.reason : rollResult.detail;
      if (rollResult.failed) {
        status = "failed";
        failureReason = "skill_roll_failed";
      }
    }

    // Call LLM resolver if runtime is available
    let sceneDelta: SceneStateDelta | null = null;
    if (ctx.runtime) {
      const skillRollResult = successLevel
        ? { successLevel, detail: rollDetail ?? "" }
        : null;
      sceneDelta = await resolveActionState(
        { characterId: actorId, characterName: npc?.name ?? actorId, action, skill, type: "action", impact: 0, nodeId: "", startTime: "", endTime: "", status: "pending", executionMeta: { remainingMinutes: 5 } } as any,
        dgsm,
        ctx.runtime,
        skillRollResult,
        locationId,
        ctx.language ?? "en",
      );
    }

    const outcome = sceneDelta?.memory ?? action;
    return {
      delta: { status, actorId, locationId, sceneDelta, successLevel, rollDetail, failureReason },
      narrative: {
        outcome,
        memories: sceneDelta?.memory
          ? [{ characterId: actorId, text: sceneDelta.memory }]
          : undefined,
      },
    };
  },

  applyDelta(dgsm: DynamicGameStateManager, delta: ActionDelta): void {
    if (delta.sceneDelta) {
      applyActionSceneDelta(dgsm, delta.sceneDelta, delta.locationId, delta.actorId);
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/operations/__tests__/actionOp.test.ts`
Expected: PASS.

- [ ] **Step 5: Run biome check**

Run: `pnpm check 2>&1 | grep "operations/" | head -5`
Expected: No errors in our files.

---

### Task 3: Create itemOp

The existing itemTool already has preCheck/resolve/apply, making this conversion straightforward.

**Files:**
- Create: `src/engine/operations/itemOp.ts`
- Create: `src/engine/operations/__tests__/itemOp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/engine/operations/__tests__/itemOp.test.ts`:

```typescript
import { itemOp } from "../itemOp.js";

describe("itemOp", () => {
  it("has correct id and schema", () => {
    expect(itemOp.id).toBe("item");
    expect(itemOp.schema.requiredParams.map((p) => p.name)).toEqual([
      "actorId",
      "action",
      "itemId",
    ]);
  });

  it("applyDelta delegates to applyObjectDelta", () => {
    const dgsm = {
      getState: () => ({
        npcCharacters: [],
        scenes: [{ id: "s1", items: [{ id: "item1", name: "Knife" }] }],
      }),
      getNpcInventory: () => [],
      addItemToNpcInventory: vi.fn(),
      removeSceneItem: vi.fn(),
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    itemOp.applyDelta(dgsm as any, {
      actorId: "npc_a",
      locationId: "s1",
      objectDelta: {
        items: [{ itemId: "item1", location: "inventory" }],
        outcome: "Picked up knife",
      },
    });

    // verify scene item was manipulated
    expect(dgsm.removeSceneItem).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/operations/__tests__/itemOp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create itemOp.ts**

Create `src/engine/operations/itemOp.ts`:

```typescript
import type { ObjectStateDelta } from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  applyObjectDelta,
  resolveItemState,
} from "../tools/itemStateResolver.js";
import { itemTool } from "../tools/itemTool.js";
import type {
  EngineTool,
  EngineToolResult,
  ExecutionContext,
} from "../types.js";

export interface ItemDelta {
  actorId: string;
  locationId: string;
  objectDelta: ObjectStateDelta | null;
  failureReason?: string;
}

export const itemOp: EngineTool<ItemDelta> = {
  id: "item",

  description:
    "Manipulate items: pick up, move, modify, destroy, disassemble, combine.",

  schema: {
    requiredParams: [
      { name: "actorId", type: "string", description: "Character performing the action" },
      { name: "action", type: "string", description: "What the character does with the item" },
      { name: "itemId", type: "string", description: "Target item ID" },
    ],
    optionalParams: [
      { name: "skill", type: "string", description: "Skill to check" },
    ],
    example: {
      actorId: "npc_01",
      action: "Pick up the old key",
      itemId: "old_key_01",
    },
  },

  async execute(
    params: Record<string, unknown>,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext,
  ): Promise<EngineToolResult<ItemDelta>> {
    const actorId = params.actorId as string;
    const action = params.action as string;
    const itemId = params.itemId as string;

    const pos = dgsm.getCharacterPosition(actorId);
    const locationId = pos ? dgsm.resolveLocationId(pos) : "";

    // Pre-check via existing itemTool
    const pseudoNode = {
      characterId: actorId,
      action,
      type: "action",
      tools: [{ name: "item", args: { itemId } }],
    } as any;
    const preCheck = itemTool.preCheck(pseudoNode, { itemId }, dgsm);
    if (!preCheck.passed) {
      return {
        delta: {
          actorId,
          locationId,
          objectDelta: null,
          failureReason: preCheck.failureDetail ?? "pre_check_failed",
        },
        narrative: { outcome: preCheck.failureDetail ?? "Item not found" },
      };
    }

    // Resolve via LLM if runtime available
    if (ctx.runtime) {
      const skillRollResult = null; // item ops typically don't need skill rolls
      const resolveResult = await itemTool.resolve(
        pseudoNode,
        { itemId },
        dgsm,
        ctx.runtime,
        skillRollResult,
        locationId,
        ctx.language ?? "en",
        {
          executionStatus: "completed",
          startedAt: "",
          resolvedAt: "",
          plannedMinutes: 5,
          elapsedMinutes: 5,
        },
        {
          memoryManager: ctx.memoryManager,
          registry: undefined,
          sessionId: undefined,
          featureNotes: [],
        },
      );

      return {
        delta: {
          actorId,
          locationId,
          objectDelta: resolveResult.delta,
        },
        narrative: {
          outcome: resolveResult.outcomeDescription,
          memories: [{ characterId: actorId, text: resolveResult.outcomeDescription }],
        },
      };
    }

    return {
      delta: { actorId, locationId, objectDelta: null },
      narrative: { outcome: action },
    };
  },

  applyDelta(dgsm: DynamicGameStateManager, delta: ItemDelta): void {
    if (delta.objectDelta) {
      applyObjectDelta(dgsm, delta.actorId, delta.objectDelta, delta.locationId);
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/operations/__tests__/itemOp.test.ts`
Expected: PASS.

- [ ] **Step 5: Run biome check**

Run: `pnpm check 2>&1 | grep "operations/" | head -5`
Expected: No errors.

---

### Task 4: Create characterInteractionOp

The most complex operation — opposed skill rolls + LLM resolver for both actor and targets.

**Files:**
- Create: `src/engine/operations/characterInteractionOp.ts`
- Create: `src/engine/operations/__tests__/characterInteractionOp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/engine/operations/__tests__/characterInteractionOp.test.ts`:

```typescript
import { characterInteractionOp } from "../characterInteractionOp.js";

describe("characterInteractionOp", () => {
  it("has correct id and schema", () => {
    expect(characterInteractionOp.id).toBe("character_interaction");
    expect(
      characterInteractionOp.schema.requiredParams.map((p) => p.name),
    ).toEqual(["actorId", "action", "targetCharacterIds"]);
  });

  it("execute fails when targets array is empty", async () => {
    const dgsm = {
      getState: () => ({
        npcCharacters: [{ id: "npc_a", name: "Alice", skills: {} }],
      }),
      getCharacterPosition: () => ({ type: "scene", sceneId: "s1" }),
      resolveLocationId: () => "s1",
    };
    const ctx = {
      getNodeDifficulty: () => "regular" as const,
      getScenePenalties: () => new Map(),
      getCharacterPenalties: () => new Map(),
      applyPenalties: (_s: Record<string, number>) => _s,
      runtime: undefined,
      language: "en",
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const result = await characterInteractionOp.execute(
      {
        actorId: "npc_a",
        action: "Talk to nobody",
        targetCharacterIds: [],
      },
      dgsm as any,
      ctx as any,
    );

    expect(result.delta.status).toBe("failed");
    expect(result.delta.failureReason).toBe("no_targets");
  });

  it("applyDelta applies HP changes for actor", () => {
    const updateStats = vi.fn();
    const dgsm = {
      getNpcStats: () => ({ hp: 10, san: 50 }),
      updateNpcStats: updateStats,
      getNpcInventory: () => [],
      addItemToNpcInventory: vi.fn(),
      removeSceneItem: vi.fn(),
      getSceneConditions: () => [],
      replaceSceneConditions: vi.fn(),
      appendSceneCondition: vi.fn(),
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    characterInteractionOp.applyDelta(dgsm as any, {
      status: "completed",
      actorId: "npc_a",
      locationId: "s1",
      actorChanges: { hpDelta: -2 },
      targetChanges: {},
    });

    expect(updateStats).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/operations/__tests__/characterInteractionOp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create characterInteractionOp.ts**

Create `src/engine/operations/characterInteractionOp.ts`:

```typescript
import type { InteractionStateDelta } from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  applyCharacterDelta,
  resolveInteractionState,
} from "../handlers/interactionStateResolver.js";
import { arePositionsCoLocated } from "../shared/locationPresence.js";
import type {
  EngineTool,
  EngineToolResult,
  ExecutionContext,
} from "../types.js";

export interface CharacterInteractionDelta {
  status: "completed" | "failed";
  actorId: string;
  locationId: string;
  actorChanges: Record<string, unknown> | null;
  targetChanges: Record<string, Record<string, unknown>>;
  failureReason?: string;
}

export const characterInteractionOp: EngineTool<CharacterInteractionDelta> = {
  id: "character_interaction",

  description:
    "Interact with one or more characters: dialogue, combat, persuasion, trade.",

  schema: {
    requiredParams: [
      { name: "actorId", type: "string", description: "Character performing the interaction" },
      { name: "action", type: "string", description: "What the character does" },
      { name: "targetCharacterIds", type: "string[]", description: "Target character IDs" },
    ],
    optionalParams: [
      { name: "skill", type: "string", description: "Skill for opposed check" },
    ],
    example: {
      actorId: "npc_01",
      action: "Ask about the strange noises",
      targetCharacterIds: ["npc_02"],
    },
  },

  async execute(
    params: Record<string, unknown>,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext,
  ): Promise<EngineToolResult<CharacterInteractionDelta>> {
    const actorId = params.actorId as string;
    const action = params.action as string;
    const targetIds = params.targetCharacterIds as string[];
    const skill = params.skill as string | undefined;

    const state = dgsm.getState();
    const pos = dgsm.getCharacterPosition(actorId);
    const locationId = pos ? dgsm.resolveLocationId(pos) : "";
    const npc = state.npcCharacters.find((n) => n.id === actorId);
    const npcSkills = npc?.skills ?? {};

    if (!targetIds?.length) {
      return {
        delta: {
          status: "failed",
          actorId,
          locationId,
          actorChanges: null,
          targetChanges: {},
          failureReason: "no_targets",
        },
        narrative: { outcome: "No targets specified" },
      };
    }

    // Check target presence
    const actorPos = dgsm.getCharacterPosition(actorId);
    for (const targetId of targetIds) {
      const targetPos = dgsm.getCharacterPosition(targetId);
      if (!actorPos || !targetPos || !arePositionsCoLocated(actorPos, targetPos, dgsm)) {
        return {
          delta: {
            status: "failed",
            actorId,
            locationId,
            actorChanges: null,
            targetChanges: {},
            failureReason: "target_absent",
          },
          narrative: { outcome: "Target not present" },
        };
      }
    }

    // Skill roll if needed
    let successLevel: string | undefined;
    let rollDetail: string | undefined;
    let perTargetResults: Record<string, unknown> | undefined;

    if (skill) {
      const scenePenalties = ctx.getScenePenalties(locationId, dgsm);
      const charPenalties = ctx.getCharacterPenalties(actorId, dgsm);
      const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
      const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

      const pseudoNode = {
        characterId: actorId,
        skill,
        action,
        targetCharacterIds: targetIds,
        impact: 0,
      } as any;
      const rollResult = ctx.resolveSkillRoll(pseudoNode, adjustedSkills, dgsm);
      successLevel = rollResult.successLevel;
      rollDetail = rollResult.failed ? rollResult.reason : rollResult.detail;
      perTargetResults = rollResult.perTargetResults;

      if (rollResult.failed) {
        return {
          delta: {
            status: "failed",
            actorId,
            locationId,
            actorChanges: null,
            targetChanges: {},
            failureReason: "skill_roll_failed",
          },
          narrative: { outcome: rollDetail ?? "Skill check failed" },
        };
      }
    }

    // LLM resolver if runtime available
    if (ctx.runtime) {
      const skillRollResult = successLevel
        ? { successLevel, detail: rollDetail ?? "", perTargetResults }
        : null;
      const pseudoNode = {
        characterId: actorId,
        characterName: npc?.name ?? actorId,
        action,
        skill,
        targetCharacterIds: targetIds,
        type: "character_interaction",
        impact: 0,
        nodeId: "",
        startTime: "",
        endTime: "",
        status: "pending",
        executionMeta: { remainingMinutes: 5 },
      } as any;

      const delta = await resolveInteractionState(
        pseudoNode,
        dgsm,
        ctx.runtime,
        skillRollResult,
        [],
        locationId,
        ctx.language ?? "en",
        undefined,
        [],
        {
          executionStatus: "completed",
          startedAt: "",
          resolvedAt: "",
          plannedMinutes: 5,
          elapsedMinutes: 5,
        },
      );

      return {
        delta: {
          status: "completed",
          actorId,
          locationId,
          actorChanges: delta.actorChanges,
          targetChanges: delta.targetChanges ?? {},
        },
        narrative: {
          outcome: delta.actorChanges?.memory ?? action,
          memories: [
            ...(delta.actorChanges?.memory
              ? [{ characterId: actorId, text: delta.actorChanges.memory }]
              : []),
            ...Object.entries(delta.targetChanges ?? {}).flatMap(
              ([targetId, changes]: [string, any]) =>
                changes?.memory
                  ? [{ characterId: targetId, text: changes.memory }]
                  : [],
            ),
          ],
        },
      };
    }

    return {
      delta: {
        status: "completed",
        actorId,
        locationId,
        actorChanges: null,
        targetChanges: {},
      },
      narrative: { outcome: action },
    };
  },

  applyDelta(
    dgsm: DynamicGameStateManager,
    delta: CharacterInteractionDelta,
  ): void {
    if (delta.actorChanges) {
      applyCharacterDelta(dgsm, delta.actorId, delta.actorChanges as any, delta.locationId);
    }
    for (const [targetId, changes] of Object.entries(delta.targetChanges)) {
      if (changes) {
        applyCharacterDelta(dgsm, targetId, changes as any, delta.locationId);
      }
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/operations/__tests__/characterInteractionOp.test.ts`
Expected: PASS.

- [ ] **Step 5: Run biome check**

Run: `pnpm check 2>&1 | grep "operations/" | head -5`
Expected: No errors.

---

### Task 5: Register EngineTools and update exports

**Files:**
- Modify: `src/engine/registerDefaults.ts`
- Create: `src/engine/operations/index.ts`
- Modify: `src/engine/index.ts`

- [ ] **Step 1: Create operations/index.ts**

Create `src/engine/operations/index.ts`:

```typescript
export { actionOp } from "./actionOp.js";
export type { ActionDelta } from "./actionOp.js";
export { movementOp } from "./movementOp.js";
export type { MovementDelta } from "./movementOp.js";
export { characterInteractionOp } from "./characterInteractionOp.js";
export type { CharacterInteractionDelta } from "./characterInteractionOp.js";
export { itemOp } from "./itemOp.js";
export type { ItemDelta } from "./itemOp.js";
```

- [ ] **Step 2: Register EngineTools in registerDefaults.ts**

Add imports and registration calls to `src/engine/registerDefaults.ts`:

```typescript
import {
  actionOp,
  characterInteractionOp,
  itemOp,
  movementOp,
} from "./operations/index.js";
```

Add after existing tool registration:

```typescript
  // Register unified EngineTools
  registry.registerEngineTool(actionOp);
  registry.registerEngineTool(movementOp);
  registry.registerEngineTool(characterInteractionOp);
  registry.registerEngineTool(itemOp);
```

- [ ] **Step 3: Add operations exports to engine/index.ts**

Add to `src/engine/index.ts`:

```typescript
export {
  actionOp,
  movementOp,
  characterInteractionOp,
  itemOp,
} from "./operations/index.js";
export type {
  ActionDelta,
  MovementDelta,
  CharacterInteractionDelta,
  ItemDelta,
} from "./operations/index.js";
```

- [ ] **Step 4: Run all engine tests**

Run: `npx vitest run src/engine/`
Expected: All new operation tests pass. Existing tests unaffected.

- [ ] **Step 5: Run biome check**

Run: `pnpm check 2>&1 | grep "engine/" | head -10`
Expected: No new errors.
