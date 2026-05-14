# Atomic Node Generation & routine→action Type Rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NPC detailed nodes atomic (one physically continuous action per node) and rename the `routine` type to `action` with a strict "no state change" definition.

**Architecture:** Prompt-driven change — rewrite 3 sections of the NPC planning templates (Node Type Reference, Node Quality, Skill Checks) and rename the `routine` type to `action` across the codebase. Handler logic stays the same; only the type string and prompt text change.

**Tech Stack:** TypeScript, Vitest

---

## File Map

| File | Change | Responsibility |
|------|--------|---------------|
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts` | Modify:3-8 | Rename `"routine"` → `"action"` in `BuiltinNodeType` |
| `src/dynamicworldagent/engine/handlers/routineHandler.ts` → `actionHandler.ts` | Rename + modify | Rename file, export name, type string |
| `src/dynamicworldagent/engine/handlers/index.ts` | Modify:1 | Update export |
| `src/dynamicworldagent/engine/registerDefaults.ts` | Modify:11,18 | Update import + registration |
| `src/dynamicworldagent/engine/index.ts` | Modify:16 | Update re-export |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts` | Modify:84,107,115 | Update switch case + fallback strings |
| `src/dynamicworldagent/engine/features/staminaFeature.ts` | Modify:224 | Update comment |
| `src/dynamicworldagent/engine/features/eventTriggerFeature.ts` | Modify:458 | Update example node type |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts` | Modify:203,220-226,254,289-301,488,519-529 | Rewrite Node Type Ref, Node Quality, Skill Checks, output schemas |
| `src/dynamicworldagent/engine/handlers/__tests__/routineHandler.test.ts` → `actionHandler.test.ts` | Rename + modify | Update all references |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/timingShift.test.ts` | Modify:31,42,49,92,99 | Update type strings |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/revisionHelpers.test.ts` | Modify:31 | Update type string |
| `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/NPCPlanningAgent.deathGuards.test.ts` | Modify:52 | Update type string |
| `src/dynamicworldagent/engine/__tests__/integration.test.ts` | Modify:354,474,694,722 | Update type strings + handler lookup |
| `src/dynamicworldagent/engine/features/__tests__/eventTriggerFeature.test.ts` | Modify:131 | Update type string |
| `src/dynamicworldagent/engine/shared/__tests__/impactPropagation.test.ts` | Modify:90 | Update type string |

---

### Task 1: Rename type enum `"routine"` → `"action"`

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.ts:3-8`

- [ ] **Step 1: Update BuiltinNodeType**

In `types.ts`, change:

```typescript
export type BuiltinNodeType =
  | "action"
  | "movement"
  | "character_interaction"
  | "object_interaction"
  | "scene_interaction";
```

- [ ] **Step 2: Verify no type errors**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: Errors in files that still reference `"routine"` — this is expected and will be fixed in subsequent tasks.

---

### Task 2: Rename handler file and export

**Files:**
- Rename: `src/dynamicworldagent/engine/handlers/routineHandler.ts` → `actionHandler.ts`
- Modify: `src/dynamicworldagent/engine/handlers/index.ts:1`
- Modify: `src/dynamicworldagent/engine/registerDefaults.ts:11,18`
- Modify: `src/dynamicworldagent/engine/index.ts:16`

- [ ] **Step 1: Rename the handler file**

```bash
mv src/dynamicworldagent/engine/handlers/routineHandler.ts src/dynamicworldagent/engine/handlers/actionHandler.ts
```

- [ ] **Step 2: Update the handler content**

In `actionHandler.ts`, replace the export and type references:

```typescript
export const actionHandler: NodeHandler = {
  type: "action",

  description:
    "A narrative action performed by a character at their current location. " +
    "This handler is for actions that do NOT change object, character, or scene state. " +
    "If skill is set, a skill roll determines success; otherwise the action auto-succeeds. " +
    'Set routineSubtype to "rest" for sleeping, napping, or resting — this resets fatigue automatically.',

  requiredFields: ["action", "location"],

  optionalFields: ["skill", "routineSubtype"],

  exampleNode: {
    nodeId: "a1",
    startTime: "22:00",
    endTime: "22:05",
    type: "action",
    routineSubtype: "rest",
    action: "Sleep for the night to recover from exhaustion",
    location: "home_bedroom",
    impact: 0,
  },

  execute(
    node: PlanNode,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): CharacterAction {
    // ... rest of execute method stays exactly the same
```

Only the `export const` name, `type`, `description`, and `exampleNode.type` / `exampleNode.nodeId` change. The `execute` method body is unchanged.

- [ ] **Step 3: Update handlers/index.ts**

```typescript
export { actionHandler } from "./actionHandler.js";
export { movementHandler } from "./movementHandler.js";
export { characterInteractionHandler } from "./characterInteractionHandler.js";
export { objectInteractionHandler } from "./objectInteractionHandler.js";
export { sceneInteractionHandler } from "./sceneInteractionHandler.js";
```

- [ ] **Step 4: Update registerDefaults.ts**

```typescript
import {
  characterInteractionHandler,
  movementHandler,
  objectInteractionHandler,
  actionHandler,
  sceneInteractionHandler,
} from "./handlers/index.js";
```

And:

```typescript
  registry.registerHandler(actionHandler);
```

- [ ] **Step 5: Update engine/index.ts**

Change the re-export:

```typescript
export {
  actionHandler,
  movementHandler,
  characterInteractionHandler,
  objectInteractionHandler,
  sceneInteractionHandler,
} from "./handlers/index.js";
```

---

### Task 3: Update all source code references to `"routine"`

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts:84,107,115`
- Modify: `src/dynamicworldagent/engine/features/eventTriggerFeature.ts:458`
- Modify: `src/dynamicworldagent/engine/features/staminaFeature.ts:224`

- [ ] **Step 1: Update NPCPlanningAgent.ts**

Line 84 — switch case:

```typescript
    case "action":
```

Line 107 — fallback type:

```typescript
          typeof rawNode.type === "string" ? rawNode.type : "action"
```

Line 115 — fallback type:

```typescript
      typeof rawNode.type === "string" ? rawNode.type : "action"
```

- [ ] **Step 2: Update eventTriggerFeature.ts**

Line 458 — example node:

```typescript
      type: "action",
```

- [ ] **Step 3: Update staminaFeature.ts**

Line 224 — comment only:

```typescript
 * Called by actionHandler when a rest node completes.
```

- [ ] **Step 4: Verify no type errors**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors in source files (test files may still have errors).

---

### Task 4: Rewrite prompt templates

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/npcPlanningTemplates.ts`

- [ ] **Step 1: Replace DEFAULT_DETAILED_NODE_TYPE_REF**

Replace the entire `DEFAULT_DETAILED_NODE_TYPE_REF` constant (lines 202-239) with:

```typescript
const DEFAULT_DETAILED_NODE_TYPE_REF = `## Node Type Reference

- **"action"**: A self-contained action that does NOT change any object, character, or scene state. Use this for narrative-only behavior: waiting, thinking, eating, resting, watching (without using a skill), pretending, walking around a room, etc. No LLM resolver runs — the engine treats this as "the character did it, period."

  If your action involves:
  - Moving/hiding/using/modifying a physical item → use "object_interaction"
  - Talking to, persuading, threatening, or observing (with a skill) another character → use "character_interaction"
  - Searching, investigating, or modifying the environment → use "scene_interaction"
  - Going to a different location → use "movement"

- **"movement"**: Move to a destination. Set location to the exact destination name from "Places You Know".
- **"character_interaction"**: Interact with one or more characters. This includes any action that uses a skill targeting another character (e.g., Spot Hidden to observe someone, Psychology to read them, Persuade to convince them).
  - Describe what you do entirely in \`action\`.
  - Put all targets in top-level \`targetCharacterIds\`.
  - For single-target interactions, \`targetCharacterIds\` should still be an array with one ID.
- **"object_interaction"**: Interact with a physical object — pick up, hide, move, use, combine, lock, unlock, destroy, etc. Describe what you do in \`action\`. Set \`objectInteractionPayload.itemId\` to the primary item. An LLM resolver handles all state changes.
- **"scene_interaction"**: Search, investigate, or modify the environment.
  - Only include \`sceneConnectionEffect\` when you are changing a real map connection that already exists.
  - \`sceneConnectionEffect.targetScenarioId\` must be an existing connected location ID from the current location's known map data.
  - Never invent internal sub-areas, doors, partitions, or descriptive labels such as \`private_office_partition\`.
  - If there is no exact existing connected location ID to target, omit \`sceneConnectionEffect\`.

## Skill Checks (tabletop horror RPG 7e Rules)

The engine acts as Keeper. A skill roll is called ONLY when:
1. The outcome is **genuinely uncertain** for someone with this character's ability
2. Failure has **meaningful consequences** (danger, lost time, alerting enemies, missing information, psychological harm)

**Do NOT use a skill when:**
- The task is trivially easy for a competent person (opening an unlocked door, reading a sign, walking down a street, picking up an object in plain sight)
- Failure would have no interesting consequence ("nothing happens" is not a stake)
- The outcome is a foregone conclusion (attacking a sleeping person, entering an empty unlocked room)

**DO use a skill when:**
- There is opposition or resistance (another character resists, a lock is locked, information is hidden)
- There is danger or time pressure (even a routine task becomes roll-worthy under stress or pursuit)
- The character is attempting something deceptive, forceful, or creative beyond normal capability

**Skill use determines node type:**
- Action with NO skill → type is usually "action" (pure narrative, no state change)
- Skill targeting a **person** (Spot Hidden to observe, Psychology to read, Persuade to convince, Intimidate to threaten) → "character_interaction" with targetCharacterIds
- Skill targeting an **object** (Locksmith to pick a lock, Mechanical Repair to fix something, Sleight of Hand to hide an item) → "object_interaction"
- Skill targeting the **environment** (Spot Hidden to search a room, Track to follow footprints, Navigate to find a path) → "scene_interaction"

**Social interactions:**
- Normal conversation, greetings, small talk, sharing information → NO skill, use "character_interaction" only if it meaningfully affects the target
- Coercion, seduction, deception, intimidation, extracting secrets, convincing someone to act against their interest → USE skill (Charm/Persuade/Intimidate/Fast Talk), type "character_interaction"

**Difficulty:**
- "regular" (roll ≤ skill value): Standard challenge — vast majority of rolls
- "hard" (roll ≤ skill/2): Exceptionally difficult, would challenge a professional
- "extreme" (roll ≤ skill/5): Borders of human capability — very rare

- If you include \`"skill"\`, it must be an exact name from "Available Skills". Never invent generic labels such as \`social\`, \`professional\`, or \`exploration\`.
- Before choosing a skill for an object action, inspect the injected item state first (locked/unlocked, damaged, uses, lit/unlit, ammo, etc.) and choose a normal action if the state already makes it possible.
- For object movement, only reference items that already appear in \`Items You Can See\` or \`What You're Carrying\`. Do not invent new intermediate objects such as printouts unless a previous action has already created them.
- Use \`move\` when the item is simply changing where it is. Do not split same-scene relocation into artificial \`pickup\` then \`place\` steps.

## Impact

- \`"impact": 0\` = private or low-consequence action. No one else needs to react.
- \`"impact": 1\` = direct target only. Use this only for targeted actions with \`targetCharacterIds\` where the target should meaningfully react, and only when the action also uses a \`skill\`.
- \`"impact": 2\` = noticeable to others in the same scene.
- \`"impact": 3\` = noticeable across the same larger location or building.
- \`"impact": 4\` = noticeable in nearby locations or the surrounding area.
- \`"impact": 5\` = major event with global or session-wide consequences.
- Default to \`"impact": 0\` unless there is a clear reason to escalate it.

## Available Skills
\${COC_SKILL_LIST_PROMPT}`;
```

- [ ] **Step 2: Replace Node Quality and Action Continuity in buildDetailedNodesPrompt**

Replace lines 289-301 (the `## Node Quality`, `## Action Continuity`, and `## Skill Checks` sections) in the `buildDetailedNodesPrompt` system prompt with:

```typescript
## Node Quality — Atomic Actions

Each node must be **one atomic action** — a single, physically continuous activity with one verb and one target. Split into separate nodes whenever:

- You **switch to a different object** (putting away notebook → picking up keys = 2 nodes)
- You **switch to a different person** (talking to A → turning to B = 2 nodes)
- You **change method or intent** (hiding a file → wiping fingerprints = 2 nodes)
- There is a natural **"then"** or **"and then"** break in the activity

**Good decomposition:**
- Node 1: [object_interaction] Put the sealed folder into the filing cabinet and lock it
- Node 2: [object_interaction] Take out irrelevant records and place them on the archive shelf as cover
- Node 3: [action] Wipe down the cabinet handle and surrounding surfaces
- Node 4: [object_interaction] Write a brief routine inspection entry in the mortuary log

**Bad (crammed into one node):**
- [action] Put the folder into the cabinet and lock it, take out fake records to cover tracks, clean fingerprints off the handle, and write a fake log entry

**What is NOT a separate node:**
- Trivial micro-actions embedded in a larger action (adjusting posture, glancing around)
- Natural continuation of the same physical activity (opening a drawer and reaching inside)
- Actions that cannot produce an independent outcome (unlocking a lock is part of opening a container)

## Action Continuity
- Atomic nodes must still form a **logical, coherent sequence**. Each action should naturally follow from the previous one.
- The sequence should read as a believable chain of behavior — no abrupt jumps between unrelated activities.
- Think: what would a real person do next given where they are and what just happened?
```

Note: The old standalone `## Skill Checks` one-liner at line 300-301 is removed — skill check guidance is now part of `DEFAULT_DETAILED_NODE_TYPE_REF`.

- [ ] **Step 3: Update output schema type enum**

In `defaultDetailedOutputSchema` (line 254), change:

```typescript
  "type": "action|movement|character_interaction|object_interaction|scene_interaction",
```

In `revisePlansOutputSchema` (line 488), change:

```typescript
      "type": "action|movement|character_interaction|object_interaction|scene_interaction",
```

- [ ] **Step 4: Update revision prompt Node Quality and Skill Checks**

In `buildRevisePlansPrompt` (lines 519-529), replace:

```typescript
- Each revised node must be **one atomic action** — a single, physically continuous activity with one verb and one target. Split whenever you switch objects, switch people, change method/intent, or there is a natural "then" break.
- Do not create trivial micro-actions (e.g., "adjust posture", "close a page", "glance around") as standalone nodes. Fold minor details into the description of a larger action instead.

## Action Continuity
- Revised nodes must form a **logical, coherent sequence**. Each action should naturally follow from the previous one — consider physical location, time flow, and narrative causality.
- The first revised node must be a believable reaction to the interruption, acknowledging what just happened rather than ignoring it.
- Avoid abrupt, unexplained jumps between unrelated activities. The revised plan should read as a natural continuation of the character's behavior given the disruption.
- Think about what a real person would do next given what just happened, where they are, and what they were trying to accomplish.

## Skill Checks
You can use a skill to accomplish an action. Pick from "Available Skills". Omit for everyday actions. Normal conversations, greetings, and routine social interactions do NOT need skills — only use skills for unconventional actions like coercion, seduction, deception, or intimidation.
```

Note: The revision prompt gets its full Skill Checks + Node Type Reference from `${params.handlerPrompt || DEFAULT_DETAILED_NODE_TYPE_REF}` on line 531, so the inline skill checks section is replaced with a shorter reference. The detailed rules come through via the shared constant.

- [ ] **Step 5: Verify build**

Run: `pnpm build`
Expected: Build succeeds with no errors.

---

### Task 5: Update all test files

**Files:**
- Rename: `src/dynamicworldagent/engine/handlers/__tests__/routineHandler.test.ts` → `actionHandler.test.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/timingShift.test.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/revisionHelpers.test.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/__tests__/NPCPlanningAgent.deathGuards.test.ts`
- Modify: `src/dynamicworldagent/engine/__tests__/integration.test.ts`
- Modify: `src/dynamicworldagent/engine/features/__tests__/eventTriggerFeature.test.ts`
- Modify: `src/dynamicworldagent/engine/shared/__tests__/impactPropagation.test.ts`

- [ ] **Step 1: Rename and update actionHandler.test.ts**

```bash
mv src/dynamicworldagent/engine/handlers/__tests__/routineHandler.test.ts src/dynamicworldagent/engine/handlers/__tests__/actionHandler.test.ts
```

In the renamed file, apply these replacements globally:
- `import { routineHandler } from "../routineHandler.js"` → `import { actionHandler } from "../actionHandler.js"`
- `routineHandler` → `actionHandler` (all occurrences)
- `describe("routineHandler"` → `describe("actionHandler"`
- `toBe("routine")` → `toBe("action")`
- `type: "routine"` → `type: "action"`

- [ ] **Step 2: Update timingShift.test.ts**

Replace all `type: "routine"` with `type: "action"` (lines 31, 42, 49, 92, 99).

- [ ] **Step 3: Update revisionHelpers.test.ts**

Replace `type: "routine"` with `type: "action"` (line 31).

- [ ] **Step 4: Update NPCPlanningAgent.deathGuards.test.ts**

Replace `type: "routine"` with `type: "action"` (line 52).

- [ ] **Step 5: Update integration.test.ts**

Replace all `type: "routine"` with `type: "action"` (lines 354, 694, 722).
Replace `registry.getHandler("routine")` with `registry.getHandler("action")` (line 474).

- [ ] **Step 6: Update eventTriggerFeature.test.ts**

Replace `type: "routine"` with `type: "action"` (line 131).

- [ ] **Step 7: Update impactPropagation.test.ts**

Replace `type: "routine"` with `type: "action"` (line 90).

- [ ] **Step 8: Run all tests**

Run: `pnpm test -- --run 2>&1 | tail -30`
Expected: All tests pass.

---

### Task 6: Final verification and commit

- [ ] **Step 1: Run biome check**

Run: `pnpm check`
Expected: No lint or format errors.

- [ ] **Step 2: Run type check**

Run: `pnpm build:tsc`
Expected: No type errors.

- [ ] **Step 3: Run all tests**

Run: `pnpm test -- --run`
Expected: All tests pass.

- [ ] **Step 4: Verify no remaining `"routine"` references in source**

Run: `grep -rn '"routine"' src/`
Expected: No matches (only the word "routine" in natural language text is acceptable, not `"routine"` as a type string).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: rename routine node type to action, add atomic node generation and tabletop horror RPG skill check rules

- Rename routine→action in type enum, handler, registry, exports, and all tests
- Rewrite Node Type Reference: action = no state change (exclusion logic)
- Rewrite Node Quality: atomic actions with physical continuity split rules
- Rewrite Skill Checks: tabletop horror RPG rules, skill determines node type
- Update output schemas in detailed node and revision prompts
- DB compatible: old 'routine' data maps to 'action' at load time"
```
