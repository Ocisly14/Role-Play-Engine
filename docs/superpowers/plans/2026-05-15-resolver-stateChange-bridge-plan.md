# Resolver → StateChange → Memory Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the silently-broken resolver → applier → memory pipeline so resolver-emitted state changes (item.modify, memory.event, etc.) actually mutate the world and write memories.

**Architecture:** Centralize the LLM-output flat-dict → typed StateChange[] conversion inside `resolveState`. Wire `item.modify` to a new `dgsm.modifyItem` so item state changes flow into the runtime scene. Keep memory.event/witness appliers as no-ops; have `NpcActionController` consume them from `report.stateChanges` so the engine layer remains memory-agnostic. Delete the dead `PlannedOutcome.narrative` field and the controller's `[result]` handcoded write — the resolver's `memory.event` content is now canonical.

**Tech Stack:** TypeScript, pnpm, Node ≥18, no unit tests (per project convention — verification via tsc + e2e script).

**Spec:** `docs/superpowers/specs/2026-05-15-resolver-stateChange-bridge-design.md`

**Project conventions (override generic plan-skill defaults):**
- No new test files — codebase has zero unit tests by deliberate choice (Phase I cleanup).
- No per-task commits — single squash-style commit at end after user reviews diff.
- Verification = type-check + grep + e2e script (not unit tests).

---

## File map

| Path | Role |
|------|------|
| `src/state/DynamicGameState.ts` | Add `modifyItem(itemId, patch, from?)` mutator. |
| `src/engine/resolver/stateChangeTypes.ts` | Extend `item.modify` schema with `name?`, `description?`, `from?`. |
| `src/engine/resolver/stateChangeAppliers.ts` | Wire `item.modify` applier to `dgsm.modifyItem`; document the no-op intent on memory.event/witness. |
| `src/engine/resolver/stateResolver.ts` | Add `flattenToStateChanges`; tighten `resolveState` return type. |
| `src/engine/core/types.ts` | Drop `PlannedOutcome.narrative`. |
| `src/engine/core/tickOrchestrator.ts` | Update `plannedNarrative` source in `applyPendingCancellation` to the resolver's prior memory.event content. |
| `src/simulation/SimulationRunner.ts` | Slim `resolve` closure; drop narrative handling. |
| `scripts/test-role-agent.ts` | Slim `resolve` closure; enrich JSON `TickRecord` with `stateChanges`. |
| `src/roleSim/npcActionController.ts` | Add `routeResolverMemories`; delete old `[result]` write blocks; keep `[begin]` writer. |

Implementation order is deliberate: state layer first (no callers yet), then schema/applier (resolver layer), then resolveState refactor, then top-of-stack consumers.

---

## Task 1: Add `dgsm.modifyItem` to DynamicGameState

**Files:**
- Modify: `src/state/DynamicGameState.ts`

- [ ] **Step 1: Add the method**

Find the existing item helper block (`getNpcInventory` / `findNpcItem` / `addItemToNpc` / `removeItemFromNpc`, around line 820-841) and insert `modifyItem` immediately after `removeItemFromNpc`. Match existing comment + warning style.

```ts
/** Mutate an item's name/description in place. The item is found either at
 *  an explicit location (`from = "scene:<id>" | "<npcId>"`) or by scanning
 *  all scenes then all NPC inventories for the first matching id.
 *  Returns true on success, false (with warning) when no item matches. */
modifyItem(
  itemId: string,
  patch: { name?: string; description?: string },
  from?: string
): boolean {
  const candidates = this.locateItemCandidates(itemId, from);
  if (candidates.length === 0) {
    console.warn(
      `[DGSM] modifyItem: item id="${itemId}" not found${from ? ` at ${from}` : ""}`
    );
    return false;
  }
  const target = candidates[0];
  if (typeof patch.name === "string" && patch.name.trim().length > 0) {
    target.name = patch.name;
  }
  if (typeof patch.description === "string") {
    target.description = patch.description;
  }
  this.state.lastUpdated = new Date();
  return true;
}

/** Internal: collect Item[] entries matching id, scoped by `from` if given. */
private locateItemCandidates(itemId: string, from?: string): Item[] {
  const out: Item[] = [];
  if (from?.startsWith("scene:")) {
    const sceneId = from.slice("scene:".length);
    const scene = this.state.scenes.get(sceneId);
    if (scene) {
      for (const item of scene.items) {
        if (item.id === itemId) out.push(item);
      }
    }
    return out;
  }
  if (from && !from.startsWith("scene:")) {
    // Treat as NPC id.
    const inv = this.state.npcInventories[from];
    if (inv) {
      for (const item of inv) {
        if (item.id === itemId) out.push(item);
      }
    }
    return out;
  }
  // No `from`: scan scenes first, then inventories.
  for (const scene of this.state.scenes.values()) {
    for (const item of scene.items) {
      if (item.id === itemId) out.push(item);
    }
  }
  if (out.length === 0) {
    for (const inv of Object.values(this.state.npcInventories)) {
      for (const item of inv) {
        if (item.id === itemId) out.push(item);
      }
    }
  }
  return out;
}
```

`Item` is already imported at the top of the file (used by other methods like `addItemToNpc`); no new import needed.

- [ ] **Step 2: Type-check this file in isolation**

Run: `pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | grep "DynamicGameState"`
Expected: no errors mentioning DynamicGameState.ts.

---

## Task 2: Extend `item.modify` schema

**Files:**
- Modify: `src/engine/resolver/stateChangeTypes.ts`

- [ ] **Step 1: Replace the `item.modify` schema entry**

Find the existing block (~line 183-196) and replace with the extended version that exposes `name`, `description`, `from` to the resolver LLM:

```ts
"item.modify": {
  description:
    "Modify an existing item's display name or description. Use this to " +
    "surface state-progression in items the actor interacts with (e.g., " +
    "rename 'unopened letter' → 'opened letter' after the seal is broken).",
  schema: {
    type: "object",
    properties: {
      itemId: { type: "string", description: "ID of the item to modify." },
      from: {
        type: "string",
        description:
          "Optional location hint (`scene:<sceneId>` or `<npcId>`). When " +
          "absent the engine searches scenes then inventories for the id.",
      },
      name: {
        type: "string",
        description:
          "Optional new display name. Omit to leave unchanged.",
      },
      description: {
        type: "string",
        description:
          "Optional new description. Omit to leave unchanged.",
      },
    },
    required: ["itemId"],
  },
},
```

The key change is dropping the old required `properties` object entirely and replacing it with optional `name`/`description`/`from`, plus a description that tells the LLM why this exists.

---

## Task 3: Wire `item.modify` applier; document memory no-ops

**Files:**
- Modify: `src/engine/resolver/stateChangeAppliers.ts`

- [ ] **Step 1: Replace the `item.modify` applier**

Find the existing entry (search for `"item.modify":`) and replace its body with a real call. Use the file's existing `(dgsm, changes)` signature pattern.

```ts
"item.modify": (dgsm, changes) => {
  for (const c of changes) {
    dgsm.modifyItem(
      c.itemId,
      {
        ...(typeof c.name === "string" ? { name: c.name } : {}),
        ...(typeof c.description === "string"
          ? { description: c.description }
          : {}),
      },
      typeof c.from === "string" ? c.from : undefined
    );
  }
},
```

- [ ] **Step 2: Update the memory.event / memory.witness comments**

Find `"memory.event": (_dgsm, _changes) => {` (~line 235) and replace the `// No-op: memory writing is handled by the caller (tickProcessor)` comment with one that points to the actual current consumer:

```ts
"memory.event": (_dgsm, _changes) => {
  // No-op: memory writing is handled by NpcActionController.routeResolverMemories,
  // which scans report.stateChanges after applier.flush.
},

"memory.witness": (_dgsm, _changes) => {
  // No-op: memory writing is handled by NpcActionController.routeResolverMemories,
  // which scans report.stateChanges after applier.flush.
},
```

---

## Task 4: `flattenToStateChanges` + tighten `resolveState` return type

**Files:**
- Modify: `src/engine/resolver/stateResolver.ts`

- [ ] **Step 1: Add the typed return type and helper**

Add the following near the top of the file (after the `RESOLVER_META_KEYS` constant declaration):

```ts
import type { StateChange } from "../core/types.js";

export interface ResolvedOutcome {
  stateChanges: StateChange[];
  elapsedMinutes: number;
}

/** Convert the resolver's flat dict (`{"memory.event":[...], "item.modify":[...], "elapsedMinutes":N}`)
 *  into the engine's typed StateChange[] discriminated union. Skips meta keys
 *  (elapsedMinutes), drops empty arrays, and tags each entry with its kind. */
function flattenToStateChanges(
  resolution: Record<string, any>
): StateChange[] {
  const out: StateChange[] = [];
  for (const [typeId, value] of Object.entries(resolution)) {
    if ((RESOLVER_META_KEYS as readonly string[]).includes(typeId)) continue;
    if (!Array.isArray(value)) continue;
    for (const obj of value) {
      if (obj && typeof obj === "object") {
        out.push({ kind: typeId, ...obj } as unknown as StateChange);
      }
    }
  }
  return out;
}
```

- [ ] **Step 2: Rewrite `resolveState` to return `ResolvedOutcome`**

Replace the current `resolveState` (lines ~197-229) with:

```ts
export async function resolveState(
  ctx: ResolverContext
): Promise<ResolvedOutcome> {
  const prompt = buildResolverPrompt(ctx);

  let raw: Record<string, any> = {};
  try {
    const text = await generateText({
      customSystemPrompt: prompt,
      context: "",
      modelClass: ModelClass.MEDIUM,
      operation: "state-resolver",
    });
    raw = parseStateResolution(text);
  } catch (error) {
    console.warn(
      "[StateResolver] LLM call failed, returning empty resolution:",
      error instanceof Error ? error.message : error
    );
    raw = {};
  }

  if (ctx.definition.outputSchema) {
    if (!validateResolution(raw, ctx.definition.outputSchema)) {
      const allowed = getAllowedResolutionKeys(ctx.definition.outputSchema);
      for (const key of Object.keys(raw)) {
        if (!allowed.has(key)) delete raw[key];
      }
    }
  }

  const elapsedMinutes =
    typeof raw.elapsedMinutes === "number" && raw.elapsedMinutes >= 0
      ? raw.elapsedMinutes
      : 0;
  const stateChanges = flattenToStateChanges(raw);
  return { stateChanges, elapsedMinutes };
}
```

This collapses two responsibilities: (a) fetch + parse + validate the LLM output (existing), (b) flatten into the engine-friendly typed shape (new).

---

## Task 5: Drop `PlannedOutcome.narrative` + fix orchestrator's `plannedNarrative` source

**Files:**
- Modify: `src/engine/core/types.ts`
- Modify: `src/engine/core/tickOrchestrator.ts`

- [ ] **Step 1: Delete `narrative` from `PlannedOutcome`**

In `src/engine/core/types.ts`, find:

```ts
export interface PlannedOutcome {
  stateChanges: StateChange[];
  elapsedMinutes: number;
  narrative?: string;
}
```

Replace with:

```ts
export interface PlannedOutcome {
  stateChanges: StateChange[];
  elapsedMinutes: number;
}
```

- [ ] **Step 2: Update `applyPendingCancellation` to derive `plannedNarrative` from memory.event**

In `src/engine/core/tickOrchestrator.ts`, find the section in `applyPendingCancellation` that reads:

```ts
const plannedNarrative = (
  step.plannedOutcome as unknown as PlannedOutcome | undefined
)?.narrative;
```

Replace with:

```ts
// Derive `plannedNarrative` from the resolver's original memory.event content
// (the previous source — `plannedOutcome.narrative` — has been removed).
const priorOutcome = step.plannedOutcome as unknown as
  | PlannedOutcome
  | undefined;
const plannedNarrative = priorOutcome?.stateChanges
  .find(
    (s): s is Extract<StateChange, { kind: "memory.event" }> =>
      s.kind === "memory.event" && s.characterId === step.characterId
  )?.content;
```

(The `Extract` cast keeps TypeScript happy on the discriminated union narrowing.)

---

## Task 6: Slim `resolve` closures + JSON enrichment in test script

**Files:**
- Modify: `src/simulation/SimulationRunner.ts`
- Modify: `scripts/test-role-agent.ts`

- [ ] **Step 1: Update SimulationRunner's `resolve` closure**

The closure currently re-implements flatten logic by reading `resolution.stateChanges` (which never existed). With `resolveState` returning typed `ResolvedOutcome`, the closure becomes a thin wrapper. Find the closure (~lines 533-580) and replace its body:

```ts
resolve: async (
  step: ActionStep,
  ctx: unknown,
  cancel
): Promise<{ outcome: PlannedOutcome; plannedDuration: number }> => {
  const definition = this.definitions.get(step.definitionId);
  if (!definition) {
    return {
      outcome: { stateChanges: [], elapsedMinutes: 0 },
      plannedDuration: 0,
    };
  }
  const stateContext = buildStateContext(
    definition,
    {
      characterId: step.characterId,
      referencedEntities: step.referencedEntities,
    },
    this.dgsm,
    step.executionSceneId
  );
  // On cancel, wrap actionText with prompt directive so the resolver LLM
  // produces a partial-progress outcome.
  const actionForResolver = cancel
    ? [
        `[CANCELLED at minute ${cancel.elapsedMinutes.toFixed(1)} of planned ${cancel.plannedDuration.toFixed(1)} due to: ${cancel.reason}]`,
        `Original intent: "${step.actionText}"`,
        cancel.plannedNarrative
          ? `Original planned outcome (had it completed): ${cancel.plannedNarrative}`
          : "",
        `Produce a SHORT memory.event reflecting ONLY what actually happened in those ${cancel.elapsedMinutes.toFixed(1)} minutes before cancellation.`,
      ]
        .filter(Boolean)
        .join("\n")
    : step.actionText;

  const resolved = await resolveState({
    action: actionForResolver,
    definition,
    outcomeSection: definition.content,
    stateContext,
    language: this.language,
  });
  void ctx;
  // Engine is source of truth for elapsed time on cancel.
  const elapsedMinutes = cancel ? cancel.elapsedMinutes : resolved.elapsedMinutes;
  return {
    outcome: { stateChanges: resolved.stateChanges, elapsedMinutes },
    plannedDuration: elapsedMinutes,
  };
},
```

The body shrinks because `flattenToStateChanges` lives in `resolveState` now.

- [ ] **Step 2: Mirror the closure change in the test script**

`scripts/test-role-agent.ts` has the same shape closure. Replace its body identically (the only differences from SimulationRunner are: `definitions` reference is the local const, `dgsm` is the local const, language is the literal `"en"`).

```ts
resolve: async (
  step: ActionStep,
  ctx: unknown,
  cancel
): Promise<{ outcome: PlannedOutcome; plannedDuration: number }> => {
  const definition = definitions.get(step.definitionId);
  if (!definition) {
    return {
      outcome: { stateChanges: [], elapsedMinutes: 0 },
      plannedDuration: 0,
    };
  }
  const stateContext = buildStateContext(
    definition,
    {
      characterId: step.characterId,
      referencedEntities: step.referencedEntities,
    },
    dgsm,
    step.executionSceneId
  );
  const actionForResolver = cancel
    ? [
        `[CANCELLED at minute ${cancel.elapsedMinutes.toFixed(1)} of planned ${cancel.plannedDuration.toFixed(1)} due to: ${cancel.reason}]`,
        `Original intent: "${step.actionText}"`,
        cancel.plannedNarrative
          ? `Original planned outcome (had it completed): ${cancel.plannedNarrative}`
          : "",
        `Produce a SHORT memory.event reflecting ONLY what actually happened in those ${cancel.elapsedMinutes.toFixed(1)} minutes before cancellation.`,
      ]
        .filter(Boolean)
        .join("\n")
    : step.actionText;
  const resolved = await resolveState({
    action: actionForResolver,
    definition,
    outcomeSection: definition.content,
    stateContext,
    language: "en",
  });
  void ctx;
  const elapsedMinutes = cancel ? cancel.elapsedMinutes : resolved.elapsedMinutes;
  return {
    outcome: { stateChanges: resolved.stateChanges, elapsedMinutes },
    plannedDuration: elapsedMinutes,
  };
},
```

- [ ] **Step 3: Enrich JSON `TickRecord` with stateChanges**

In `scripts/test-role-agent.ts`, find the `TickRecord` interface and add a `stateChanges` field:

```ts
interface TickRecord {
  tick: number;
  gameDateTime: string;
  commits: Array<{
    characterId: string;
    actionText: string;
  }>;
  cancellations: Array<{
    characterId: string;
    actionText: string;
  }>;
  featureEvents: Array<{
    type: string;
    impact: number;
    description: string;
    characterId?: string;
    sceneId?: string;
  }>;
  /** Raw typed stateChanges that flowed through this tick's applier. Lets
   *  e2e verification confirm resolver actually emitted memory.event +
   *  item.modify entries. */
  stateChanges: Array<{ kind: string; [k: string]: unknown }>;
}
```

Note: also drop the `narrative?: string` field from the existing commits/cancellations entries (it's no longer populated). The user has already pre-emptively added narrative there in a prior session — remove it here.

In the same file, find the `runRecord.ticks.push({...})` call inside the `tickCompleted` listener. Update it to:

```ts
runRecord.ticks.push({
  tick: tickCount,
  gameDateTime: dgsm.getGameDateTime(),
  commits: report.commits.map((a) => ({
    characterId: a.characterId,
    actionText: a.actionText,
  })),
  cancellations: report.cancellations.map((c) => ({
    characterId: c.characterId,
    actionText: c.actionText,
  })),
  featureEvents: report.featureEvents.map((e) => ({
    type: e.type,
    impact: e.impact,
    description: e.description,
    characterId: e.characterId,
    sceneId: e.sceneId,
  })),
  stateChanges: report.stateChanges.map((s) => ({ ...s })),
});
```

(Remove the previous `narrative: ...` extraction lines on commits/cancellations.)

---

## Task 7: Controller `routeResolverMemories` + drop old `[result]` writes

**Files:**
- Modify: `src/roleSim/npcActionController.ts`

- [ ] **Step 1: Replace the cancellation result-write block with `routeResolverMemories` call**

In `writeAutoMemories`, find the block that starts with `// (b) "result" memories for actions that ended this tick.` and the entire `for (const a of report.commits)` + `for (const c of report.cancellations)` blocks below it. Replace those two blocks with a single call:

```ts
// (b) Resolver-emitted event/witness memories for actions that ended this
//     tick (commits + cancellations). The `[begin]` writer above already
//     handles the start-time entry; this routes the resolver's memory.event /
//     memory.witness state changes into NpcMemoryManager.
await this.routeResolverMemories(report);
```

- [ ] **Step 2: Implement `routeResolverMemories`**

Add the new private method right after `writeAutoMemories` (or after the helper `writeMemoryEntry`). The location lookup walks commits then cancellations to find the actor's executionSceneId; falls back to the actor's current position.

```ts
private async routeResolverMemories(report: TickReport): Promise<void> {
  // Build a quick map: characterId → sceneId where they ran their action this
  // tick (commit / cancellation). Used as `location` for the resolver-emitted
  // memory entries.
  const locByActor = new Map<string, string>();
  for (const a of report.commits) {
    locByActor.set(a.characterId, a.sceneId);
  }
  for (const c of report.cancellations) {
    if (!locByActor.has(c.characterId)) locByActor.set(c.characterId, c.sceneId);
  }

  // Pick game-times from commits/cancellations; fall back to current tick.
  const completedAtByActor = new Map<string, string>();
  for (const a of report.commits) {
    completedAtByActor.set(a.characterId, a.completedAt);
  }
  for (const c of report.cancellations) {
    if (!completedAtByActor.has(c.characterId)) {
      completedAtByActor.set(c.characterId, c.completedAt);
    }
  }
  const tickTime = this.dgsm.getGameDateTime();

  for (const change of report.stateChanges) {
    if (change.kind !== "memory.event" && change.kind !== "memory.witness") {
      continue;
    }
    const characterId = (change as { characterId?: string }).characterId;
    const content = (change as { content?: string }).content;
    if (typeof characterId !== "string" || typeof content !== "string") continue;

    const location =
      locByActor.get(characterId) ?? this.resolveCurrentSceneId(characterId);
    const gameDateTime =
      completedAtByActor.get(characterId) ?? tickTime;

    await this.writeMemoryEntry(
      characterId,
      change.kind === "memory.event" ? "event" : "witness",
      content,
      gameDateTime,
      location
    );
  }
}
```

- [ ] **Step 3: Confirm the `[begin]` block stays, the propagated-event witness block stays**

The existing `// (a) "begin" memories for actions that became active this tick.` block stays unchanged. The block at the bottom that writes witness memories from `eventsByNpc` (subsystem-emitted FeatureEvents propagating to bystanders) ALSO stays — that's a separate channel from resolver `memory.witness`.

After this task, `writeAutoMemories` body has three sections in order:
1. `[begin]` writes from `report.activations`
2. `routeResolverMemories(report)` for resolver-emitted memory.event / memory.witness
3. The existing FeatureEvent → witness loop (unchanged)

---

## Task 8: Final sweep — clean dead `narrative` references

**Files:**
- Sweep: all of `src/` and `scripts/`

- [ ] **Step 1: grep for residual narrative references**

Run:
```bash
grep -rn "outcome?.narrative\|outcome\.narrative\|resolution\.narrative\|PlannedOutcome.*narrative" src/ scripts/ 2>/dev/null
```
Expected: zero matches (after Tasks 5-7).

- [ ] **Step 2: grep for the dead `StateResolution` interface**

Run:
```bash
grep -rn "StateResolution" src/engine/types.ts src/ scripts/ 2>/dev/null
```

The interface in `src/engine/types.ts:139-148` is marked `@deprecated`. If grep shows zero IMPORTS (only the definition itself + `import type { StateResolution }` lines), delete the interface and all dead imports. If anything else references it as a type, leave it alone — separate cleanup.

---

## Task 9: Verification

**Files:** none

- [ ] **Step 1: Type check**

Run:
```bash
pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | grep -v node_modules | head -40
```
Expected: zero output (clean).

- [ ] **Step 2: Confirm dead refs are gone**

Run the greps from Task 8 again. All should be empty.

- [ ] **Step 3: Stop and ask user before running e2e**

Per `feedback_no_auto_run`: do NOT run `pnpm tsx scripts/test-role-agent.ts` automatically. Stop here and report:
- All 8 tasks done, types clean, no dead refs.
- Ask the user if they want to run the 10-tick e2e for behavioral verification.

If user authorizes, run:
```bash
pnpm tsx scripts/test-role-agent.ts
```

Inspect the JSON at `logs/role-agent-test-<ts>.json`:
- Each `commits[i].stateChanges` array is non-empty (at least `memory.event`).
- `memoryWrites[]` contains entries whose `content` is from the resolver LLM (not `[result] ...` template).
- Marsh's commit sequence does not repeat the same actionText 3 times in a row.
- If any commits include `item.modify`, confirm the renderer's "Items in scene" output reflects the new name/description in subsequent ticks.

---

## Self-review notes (already applied during writing)

- Spec section 1 (Architecture) → covered by tasks 1-7 collectively.
- Spec section 2 (Components → Engine) → tasks 1, 2, 3, 4.
- Spec section 2 (Components → State) → task 1.
- Spec section 2 (Components → RoleSim) → task 7.
- Spec section 2 (Components → Resolver callers) → task 6.
- Spec section 2 (Cleanup) → tasks 5, 8.
- Spec section 3 (Scenarios) → exercised by Task 9 e2e.
- Spec section 4 (Error handling) → wired into the code in tasks 1-7 (warn-don't-throw pattern, try/catch wrappers).
- Spec section 5 (Testing) → task 9.

All method signatures cross-checked: `dgsm.modifyItem(itemId, patch, from?)` consistent across tasks 1, 3, file-map. `flattenToStateChanges` only referenced internally inside task 4. `routeResolverMemories(report)` signature consistent across tasks 7. `ResolvedOutcome` type consistent across tasks 4, 6.

No placeholders. Every code step shows exact code. No "similar to Task N". No new test files (intentional per project convention).
