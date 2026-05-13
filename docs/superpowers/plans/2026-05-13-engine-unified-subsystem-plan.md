# Engine Unified Subsystem (Phase I) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **User preferences for this project:**
> - **No per-task commits.** All work commits once at the end via Task 12. Each task definition-of-done is "code compiles, files match plan, no runtime tests run".
> - **No mid-task test runs.** Subagents should NOT run `pnpm test` / `pnpm check` / `pnpm build:tsc` during their task. Batch verification runs once in Task 12.
> - **Review cadence: implementer + spec reviewer only.** Skip code-quality reviewer for these routine port tasks (Phase D precedent).
> - **Parallel dispatch.** Tasks 3–9 touch disjoint files (each creates one new subsystem file + one test file under `src/engine/subsystem/`). Dispatch them in parallel in one Agent message. Tasks 1, 2, 10, 11, 12 are sequential.

**Goal:** Replace `WorldFeature` + `CodeEngineSubsystem` with a unified `Subsystem` abstraction. Collapse TickOrchestrator phases 0/3.5/5/6/8/9.5 into a single per-tick `onTick` pass over all active instances.

**Architecture:** Two Subsystem flavors (`AnchorSubsystem`, `ActionSubsystem`) sharing a `SubsystemBase`. Anchor instances are dynamically managed by `shouldExist` predicate; action instances are bound to ActionSteps. All state lives in DGSM `scopedFeatureState` — `TickOrchestrator` owns spawn/destroy lifecycle. No event hooks; actions emit domain StateChanges that subsystems bridge via predicate + initialState.

**Tech Stack:** TypeScript, vitest, pnpm. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-12-engine-unified-subsystem-design.md`

---

## File Structure Map

### New files (`src/engine/subsystem/`)

- `types.ts` — `SubsystemBase`, `AnchorSubsystem`, `ActionSubsystem`, `Subsystem`, `SubsystemStepResult` interfaces. (Task 1)
- `registry.ts` — `SubsystemRegistry` class (register / get / getAll / getAnchorSubsystems / getActionSubsystem). (Task 1)
- `__tests__/registry.test.ts` — registry semantics. (Task 1)
- `weather.ts` — `weatherSubsystem` (anchor=region). (Task 3)
- `sun.ts` — `sunSubsystem` (anchor=global). (Task 4)
- `stamina.ts` — `staminaSubsystem` (anchor=character). (Task 5)
- `itemDamage.ts` — `itemDamageSubsystem` (anchor=scene). (Task 6)
- `fire.ts` — `fireSubsystem` (anchor=scene). (Task 7)
- `movement.ts` — `movementSubsystem` (ActionSubsystem). (Task 8)
- `conditionExpiry.ts` — `characterConditionExpirySubsystem` + `sceneConditionExpirySubsystem`. (Task 9)
- `__tests__/<each-subsystem>.test.ts` — per-subsystem unit tests.

### Modified files

- `src/engine/core/types.ts` — no change (FeatureStateScope already has the four anchor kinds).
- `src/engine/core/featureReadContext.ts` — add `getAllRegionIds()` helper for region anchor enumeration. (Task 2)
- `src/engine/core/tickOrchestrator.ts` — replace Phase 0/3.5/4-onCommit/5/6/8/9.5 with new Phase 5 (anchor lifecycle) + Phase 6 (unified onTick); drop `FeatureRunner`, `EmergentEventEmitter`, `sweepExpiredCharacterConditions`, `propagationTickCounter`. Replace `codeEngineRegistry.get(...).onActivate/onTick/onInterrupt` calls with `subsystemRegistry.getActionSubsystem(...).onActivate/...`. (Tasks 2 + 10)
- `src/engine/core/tickEngine.ts` — replace `features: WorldFeature[]` + `codeEngineRegistry: CodeEngineRegistry` options with `subsystemRegistry: SubsystemRegistry`. (Tasks 2 + 10)
- `src/engine/registerDefaults.ts` — replace `getDefaultFeatures()` + `createDefaultCodeEngineRegistry()` with `createDefaultSubsystemRegistry()`. (Task 10)
- `src/engine/tool_definitions/igniteFire.yaml` + `extinguishFire.yaml` — switch from `overlayFields` payload to direct StateChange emission in commit outcomes. (Task 7)

### Deleted files

- `src/engine/core/worldFeature.ts` — `WorldFeature` interface no longer used. (Task 11; keep `PlannedOutcome` — re-export from elsewhere.)
- `src/engine/core/featureRunner.ts` — `FeatureRunner` class no longer used. (Task 11)
- `src/engine/core/emergentEventEmitter.ts` — empty, deleted. (Task 11)
- `src/engine/core/emergentScanner.ts` — companion types, deleted. (Task 11)
- `src/engine/codeEngine/types.ts` — `CodeEngineSubsystem` interface no longer used; `makeCodeEngineContext` is still referenced by tickOrchestrator's code-step ctx factory — move into `src/engine/subsystem/actionContext.ts` first, then delete. (Task 11)
- `src/engine/codeEngine/registry.ts` — `CodeEngineRegistry` no longer used. (Task 11)
- `src/engine/codeEngine/movement.ts` — old class; replaced by `src/engine/subsystem/movement.ts`. (Task 8 deletes after moving content; Task 11 deletes the whole `codeEngine/` directory.)
- `src/engine/features/{fire,itemDamage,stamina,sun,weather}Feature.ts` — replaced by subsystem files. (Task 11)
- `src/engine/features/__tests__/*Feature.test.ts` — replaced by subsystem tests. (Task 11)
- `src/engine/codeEngine/__tests__/movement.test.ts` — replaced by `src/engine/subsystem/__tests__/movement.test.ts`. (Task 11)

### Preserved files (untouched)

- `src/engine/scriptedEvents/` — entirely untouched (Phase J target).
- `src/engine/core/scriptedEventRunner.ts` — entirely untouched.
- `src/engine/core/{applier,actionIntake,eventBus,queue}.ts` — untouched.
- `src/engine/handlers/` — untouched.

---

## Task 1: Subsystem Foundation Types + Registry

**Goal:** Introduce `Subsystem` types and `SubsystemRegistry` with no engine wiring. Pure addition.

**Files:**
- Create: `src/engine/subsystem/types.ts`
- Create: `src/engine/subsystem/registry.ts`
- Create: `src/engine/subsystem/__tests__/registry.test.ts`

- [ ] **Step 1: Write `src/engine/subsystem/types.ts`**

```ts
// src/engine/subsystem/types.ts
//
// Phase I unified Subsystem abstraction. Replaces WorldFeature +
// CodeEngineSubsystem. See spec at docs/superpowers/specs/2026-05-12-engine-unified-subsystem-design.md
// for design decisions.

import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { ActionStep, StateChange } from "../core/types.js";

/**
 * Anchor kind for AnchorSubsystem instances. Matches `FeatureStateScope` in
 * `src/engine/core/types.ts:7` — TickOrchestrator routes anchorId enumeration
 * and DGSM scopedFeatureState lookups through this discriminator.
 */
export type AnchorKind = "scene" | "region" | "character" | "global";

/** Common metadata for every Subsystem flavor. */
export interface SubsystemBase {
  readonly id: string;
  /** Lower runs first in Phase 6 onTick loop. Default 999. */
  readonly priority?: number;
  readonly description: string;
  readonly effectSummary: string;
  readonly affectedKinds: ReadonlyArray<StateChange["kind"]>;
  /**
   * Planner-facing prose injected into the NPCPlanningAgent prompt when this
   * subsystem is active. Mirrors WorldFeature.planningPrompt; preserved for
   * the 5 migrating features so the planner sees the same guidance text.
   */
  readonly planningPrompt?: string;
  /**
   * Renders subsystem state as human-readable prose for prompt /
   * debug surfaces. Returns "" when nothing interesting to show.
   * Mirrors WorldFeature.stateDescription. Optional.
   */
  stateDescription?(ctx: FeatureReadContext): string;
}

/**
 * Per-anchor subsystem. Spawn/destroy is driven by `shouldExist`, evaluated
 * each tick in TickOrchestrator Phase 5. Initial state is seeded by
 * `initialState` on transition false→true; bucket is cleared by TickOrchestrator
 * on transition true→false.
 *
 * Invariant: `shouldExist` MUST NOT read the subsystem's own state bucket
 * (would create cyclic spawn-destroy oscillations and break rehydration).
 * Read external DGSM state: scene/character conditions, position, etc.
 */
export interface AnchorSubsystem extends SubsystemBase {
  readonly kind: "anchor";
  readonly anchorKind: AnchorKind;

  /** Per-tick existence predicate. Pure function over DGSM. */
  shouldExist(anchorId: string, ctx: FeatureReadContext): boolean;

  /**
   * Called once when shouldExist transitions false→true OR (on rehydration)
   * when DGSM has no bucket for this (subsystemId, anchorId) yet. Must be
   * safe to no-op if bucket already exists — TickOrchestrator's Phase 5
   * checks bucket presence and skips initialState if so.
   */
  initialState(anchorId: string, ctx: FeatureReadContext): StateChange[];

  /** Called every tick while alive. */
  onTick(anchorId: string, ctx: FeatureReadContext): StateChange[];
}

export interface SubsystemStepResult {
  stateChanges: StateChange[];
  completed: boolean;
  failed?: { reason: string };
}

/**
 * Action-bound subsystem. Lifetime = ActionStep lifetime. Activated by
 * TickOrchestrator Phase 3 when an `engine: "code"` step is dequeued;
 * terminated when onTick returns { completed: true } or onInterrupt fires.
 */
export interface ActionSubsystem extends SubsystemBase {
  readonly kind: "action";

  onActivate?(
    step: ActionStep,
    ctx: FeatureReadContext
  ): SubsystemStepResult;

  onTick(step: ActionStep, ctx: FeatureReadContext): SubsystemStepResult;

  onInterrupt?(
    step: ActionStep,
    ctx: FeatureReadContext
  ): { stateChanges: StateChange[] };
}

export type Subsystem = AnchorSubsystem | ActionSubsystem;
```

- [ ] **Step 2: Write `src/engine/subsystem/registry.ts`**

```ts
// src/engine/subsystem/registry.ts
//
// Map-backed Subsystem collection. Mirrors the pattern of
// ActionDefinitionRegistry and the pre-Phase-I CodeEngineRegistry.

import type {
  ActionSubsystem,
  AnchorSubsystem,
  Subsystem,
} from "./types.js";

export class SubsystemRegistry {
  private subsystems = new Map<string, Subsystem>();

  register(subsystem: Subsystem): void {
    if (this.subsystems.has(subsystem.id)) {
      console.warn(
        `[SubsystemRegistry] Overwriting subsystem: ${subsystem.id}`
      );
    }
    this.subsystems.set(subsystem.id, subsystem);
  }

  get(id: string): Subsystem | undefined {
    return this.subsystems.get(id);
  }

  getAll(): Subsystem[] {
    return [...this.subsystems.values()];
  }

  /** All AnchorSubsystems, sorted by priority asc (lower first). */
  getAnchorSubsystems(): AnchorSubsystem[] {
    return this.getAll()
      .filter((s): s is AnchorSubsystem => s.kind === "anchor")
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  }

  /**
   * Lookup an ActionSubsystem by id. Caller (TickOrchestrator Phase 3) maps
   * `ActionStep.codeSubsystem` → subsystem id. Returns undefined if no match
   * or the registered subsystem is an AnchorSubsystem (caller treats as
   * configuration error).
   */
  getActionSubsystem(id: string): ActionSubsystem | undefined {
    const s = this.subsystems.get(id);
    return s?.kind === "action" ? s : undefined;
  }
}
```

- [ ] **Step 3: Write `src/engine/subsystem/__tests__/registry.test.ts`**

```ts
// src/engine/subsystem/__tests__/registry.test.ts
import { describe, expect, it } from "vitest";
import { SubsystemRegistry } from "../registry.js";
import type { AnchorSubsystem, ActionSubsystem } from "../types.js";

const fakeAnchor = (id: string, priority: number): AnchorSubsystem => ({
  id,
  kind: "anchor",
  anchorKind: "scene",
  priority,
  description: "test anchor",
  effectSummary: "",
  affectedKinds: [],
  shouldExist: () => true,
  initialState: () => [],
  onTick: () => [],
});

const fakeAction = (id: string): ActionSubsystem => ({
  id,
  kind: "action",
  description: "test action",
  effectSummary: "",
  affectedKinds: [],
  onTick: () => ({ stateChanges: [], completed: false }),
});

describe("SubsystemRegistry", () => {
  it("stores and retrieves subsystems by id", () => {
    const reg = new SubsystemRegistry();
    const a = fakeAnchor("a", 100);
    reg.register(a);
    expect(reg.get("a")).toBe(a);
    expect(reg.get("missing")).toBeUndefined();
  });

  it("getAnchorSubsystems filters and sorts by priority", () => {
    const reg = new SubsystemRegistry();
    reg.register(fakeAnchor("late", 500));
    reg.register(fakeAction("act"));
    reg.register(fakeAnchor("early", 100));
    const anchors = reg.getAnchorSubsystems();
    expect(anchors.map((s) => s.id)).toEqual(["early", "late"]);
  });

  it("getActionSubsystem returns only action-kind matches", () => {
    const reg = new SubsystemRegistry();
    reg.register(fakeAction("mv"));
    reg.register(fakeAnchor("fire", 200));
    expect(reg.getActionSubsystem("mv")?.id).toBe("mv");
    expect(reg.getActionSubsystem("fire")).toBeUndefined();
    expect(reg.getActionSubsystem("missing")).toBeUndefined();
  });

  it("overwriting a registered id warns but accepts the new one", () => {
    const reg = new SubsystemRegistry();
    const first = fakeAnchor("x", 100);
    const second = fakeAnchor("x", 200);
    reg.register(first);
    reg.register(second);
    expect(reg.get("x")).toBe(second);
  });
});
```

- [ ] **Step 4: Verify the new files compile in isolation (no runtime test).**

Run nothing. Definition of done: files exist with the content above and match the imports of `FeatureReadContext` / `ActionStep` / `StateChange` from the cited source files. No commits.

---

## Task 2: TickOrchestrator + TickEngine Dual-Execution Wiring

**Goal:** Add `SubsystemRegistry` to OrchestratorDeps + CreateTickEngineOptions. Implement Phase 5 (anchor lifecycle) and Phase 6 (unified onTick) in TickOrchestrator, running BEFORE the existing `featureRunner.runTick` so both paths coexist. With an empty registry (default until Task 10), behavior is unchanged.

This is the foundation for the per-feature migration tasks. Old `featureRunner` / `codeEngineRegistry` / `emergentEventEmitter` paths remain untouched here — Task 10 removes them.

**Files:**
- Modify: `src/engine/core/featureReadContext.ts` — add `getAllRegionIds()` to the interface + the DGSM implementation.
- Modify: `src/engine/core/tickOrchestrator.ts` — extend `OrchestratorDeps`, add `activeAnchorInstances: Set<string>`, add Phase 5 + Phase 6 methods.
- Modify: `src/engine/core/tickEngine.ts` — extend `CreateTickEngineOptions` with optional `subsystemRegistry?`, default to `new SubsystemRegistry()` when absent.

- [ ] **Step 1: Add `getAllRegionIds()` to FeatureReadContext.**

In `src/engine/core/featureReadContext.ts`, add to the `FeatureReadContext` interface:

```ts
  /**
   * Enumerate every region ID currently known to DGSM (deduplicated parent
   * locations of scenes). Used by AnchorSubsystem.shouldExist when anchorKind
   * is "region" — TickOrchestrator iterates this set each Phase 5.
   */
  getAllRegionIds(): string[];
```

In the `makeDGSMFeatureReadContext` implementation, add after `getRegionId`:

```ts
    getAllRegionIds: () => {
      const out = new Set<string>();
      for (const sceneId of dgsm.getAllSceneIds()) {
        const rid = dgsm.getRegionIdForScene(sceneId);
        if (rid) out.add(rid);
      }
      return Array.from(out).sort();
    },
```

- [ ] **Step 2: Add `subsystemRegistry?: SubsystemRegistry` to OrchestratorDeps + `activeAnchorInstances` set + helper methods.**

In `src/engine/core/tickOrchestrator.ts`, add the import:

```ts
import type { SubsystemRegistry } from "../subsystem/registry.js";
import type { AnchorSubsystem } from "../subsystem/types.js";
```

Add to `OrchestratorDeps`:

```ts
  /**
   * Phase I unified subsystem registry. Optional during the migration window
   * — when absent or empty, the new Phase 5/6 paths are no-ops and the
   * legacy featureRunner/codeEngineRegistry drives everything.
   */
  subsystemRegistry?: SubsystemRegistry;
```

Add a private field to `TickOrchestrator`:

```ts
  /**
   * Active anchor subsystem instances, keyed by `${subsystemId}:${anchorId}`.
   * Reconstructed lazily on first tick from DGSM scopedFeatureState (see
   * Phase 5 implementation). Action subsystem instances are NOT tracked here
   * — their lifetime is managed by the queue + onTick.completed signal.
   */
  private activeAnchorInstances = new Set<string>();
  private anchorInstancesRehydrated = false;
```

Add private helpers (paste below `recordCancelledStep`):

```ts
  /** Enumerate anchor ids for a subsystem's anchor kind. */
  private anchorIdsFor(kind: AnchorSubsystem["anchorKind"]): string[] {
    const dgsm = this.deps.dgsm;
    switch (kind) {
      case "scene":
        return dgsm.getAllSceneIds().slice().sort();
      case "region": {
        const out = new Set<string>();
        for (const sid of dgsm.getAllSceneIds()) {
          const r = dgsm.getRegionIdForScene(sid);
          if (r) out.add(r);
        }
        return Array.from(out).sort();
      }
      case "character":
        return dgsm
          .getState()
          .npcCharacters.filter((n) => dgsm.isNpcAlive(n.id))
          .map((n) => n.id)
          .sort();
      case "global":
        return ["global"];
    }
  }

  /**
   * Reconstruct activeAnchorInstances from DGSM scopedFeatureState. Called
   * once on the first tick after construction — both fresh and rehydrated
   * sessions go through this path. For fresh sessions, DGSM has no scoped
   * feature buckets yet, so activeAnchorInstances stays empty and Phase 5
   * will spawn fresh instances. For rehydrated sessions, every existing
   * bucket maps to a live instance.
   */
  private rehydrateAnchorInstancesFromDGSM(
    registry: SubsystemRegistry
  ): void {
    if (this.anchorInstancesRehydrated) return;
    this.anchorInstancesRehydrated = true;
    const dgsm = this.deps.dgsm;
    for (const sub of registry.getAnchorSubsystems()) {
      const all = dgsm.getAllScopedFeatureStates<unknown>(
        sub.id,
        sub.anchorKind
      );
      for (const { key } of all) {
        this.activeAnchorInstances.add(`${sub.id}:${key}`);
      }
    }
  }

  /** Phase 5 — anchor lifecycle pass. */
  private runAnchorLifecyclePass(
    registry: SubsystemRegistry,
    buffer: StateChange[]
  ): void {
    const dgsm = this.deps.dgsm;
    const ctxFactory = (sub: AnchorSubsystem) =>
      makeDGSMFeatureReadContext(dgsm, {
        callerFeatureId: sub.id,
        callerScope: sub.anchorKind,
      });
    for (const sub of registry.getAnchorSubsystems()) {
      const ctx = ctxFactory(sub);
      const anchorIds = this.anchorIdsFor(sub.anchorKind);
      for (const anchorId of anchorIds) {
        const key = `${sub.id}:${anchorId}`;
        const shouldBe = sub.shouldExist(anchorId, ctx);
        const isActive = this.activeAnchorInstances.has(key);
        if (shouldBe && !isActive) {
          this.activeAnchorInstances.add(key);
          // Skip initialState if a bucket already exists (rehydrated session
          // hand-edited, or LLM pre-seeded state). Idempotency guard from D9.
          const existing = dgsm.getScopedFeatureState<unknown>(
            sub.id,
            sub.anchorKind,
            anchorId
          );
          if (existing === undefined) {
            buffer.push(...sub.initialState(anchorId, ctx));
          }
        } else if (!shouldBe && isActive) {
          this.activeAnchorInstances.delete(key);
          buffer.push({
            kind: "feature.removeState",
            featureId: sub.id,
            key: anchorId,
          });
        }
      }
    }
  }

  /** Phase 6 — unified onTick pass (anchor subsystems only here; action
   *  subsystems are still driven by the old codeEngine path during the
   *  migration window). */
  private runUnifiedOnTickPass(
    registry: SubsystemRegistry,
    buffer: StateChange[]
  ): void {
    const dgsm = this.deps.dgsm;
    for (const sub of registry.getAnchorSubsystems()) {
      const ctx = makeDGSMFeatureReadContext(dgsm, {
        callerFeatureId: sub.id,
        callerScope: sub.anchorKind,
      });
      for (const anchorId of this.anchorIdsFor(sub.anchorKind)) {
        if (!this.activeAnchorInstances.has(`${sub.id}:${anchorId}`))
          continue;
        buffer.push(...sub.onTick(anchorId, ctx));
      }
    }
  }
```

In the `tick()` method, immediately before the existing `featureRunner.runTick(...)` call (around `tickOrchestrator.ts:262`), insert:

```ts
    // Phase 5/6 (new) — subsystem lifecycle + onTick. Empty until Task 10
    // wires the default registry; running alongside the legacy featureRunner
    // during the migration window.
    if (this.deps.subsystemRegistry) {
      this.rehydrateAnchorInstancesFromDGSM(this.deps.subsystemRegistry);
      this.runAnchorLifecyclePass(this.deps.subsystemRegistry, buffer);
      this.runUnifiedOnTickPass(this.deps.subsystemRegistry, buffer);
    }
```

- [ ] **Step 3: Wire subsystemRegistry through TickEngine.**

In `src/engine/core/tickEngine.ts`, add to `CreateTickEngineOptions`:

```ts
  /**
   * Phase I unified Subsystem registry. Optional during migration — when
   * undefined the engine builds an empty registry and runs only the legacy
   * feature + codeEngine paths. Task 10 makes this required and removes
   * the legacy paths.
   */
  subsystemRegistry?: SubsystemRegistry;
```

Add import:

```ts
import { SubsystemRegistry } from "../subsystem/registry.js";
```

In `createTickEngine`, in the `TickOrchestrator` constructor call, add the dep:

```ts
      subsystemRegistry: opts.subsystemRegistry ?? new SubsystemRegistry(),
```

- [ ] **Step 4: Write a regression test for the new no-op path.**

Create `src/engine/core/__tests__/tickOrchestrator.subsystem.test.ts`:

```ts
// src/engine/core/__tests__/tickOrchestrator.subsystem.test.ts
//
// Sanity test that Phase 5/6 wiring is a no-op when the registry is empty.
// Real coverage of subsystem behavior lives in the per-subsystem tests.

import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { SubsystemRegistry } from "../../subsystem/registry.js";
import type { AnchorSubsystem } from "../../subsystem/types.js";
import { Applier } from "../applier.js";
import { TickOrchestrator } from "../tickOrchestrator.js";
import { Queue } from "../queue.js";

describe("TickOrchestrator subsystem wiring", () => {
  it("empty registry produces zero subsystem state changes", async () => {
    const dgsm = new DynamicGameStateManager();
    const registry = new SubsystemRegistry();

    // Build a minimal orchestrator. We don't need the full surface; just
    // confirm Phase 5/6 runs without throwing and emits no state changes.
    // (Implementer: read existing tickOrchestrator tests for the standard
    // dep-construction pattern. Skip if the boilerplate is too large; the
    // anchor-spawn behavior is covered in Task 3+ tests where the registry
    // is populated.)
  });

  it("anchor subsystem with shouldExist=true spawns instance and runs initialState", async () => {
    const dgsm = new DynamicGameStateManager();
    const registry = new SubsystemRegistry();

    const seeded: AnchorSubsystem = {
      id: "_test",
      kind: "anchor",
      anchorKind: "global",
      description: "",
      effectSummary: "",
      affectedKinds: ["feature.setState"],
      shouldExist: () => true,
      initialState: (anchorId) => [
        {
          kind: "feature.setState",
          featureId: "_test",
          key: anchorId,
          state: { spawned: true },
        },
      ],
      onTick: () => [],
    };
    registry.register(seeded);

    // (Implementer: build TickOrchestrator with this registry as in
    // existing test fixtures, run one tick, assert dgsm.getScopedFeatureState
    // returns { spawned: true } for ("_test", "global", "global"). The exact
    // fixture wiring follows tickOrchestrator.phaseZero.test.ts patterns.)
  });
});
```

Note for implementer: keep this file lightweight. If the TickOrchestrator boilerplate is too involved, leave the test bodies as comments referencing the pattern — Task 3 weather test will exercise the same code path with a real subsystem.

- [ ] **Step 5: Verify compile.**

No test run, no commit. Definition of done: `tickOrchestrator.ts` changes apply cleanly, all type imports resolve.

---

## Task 3: weatherSubsystem (anchor=region)

**Goal:** Port `weatherFeature` to `weatherSubsystem`. Anchor = region. `shouldExist` = always true (weather exists wherever a region exists). `initialState` reads `moduleSetup.featureInit.weather` config. `onTick` ports the existing transition logic.

**Read first:** `src/engine/features/weatherFeature.ts` (488 lines) — copy `init` logic into `initialState` and `onTick` logic verbatim. Adapt the function signatures: `init(ctx) → initialState(anchorId, ctx)` where `anchorId` is the regionId; `onTick(ctx)` → `onTick(anchorId, ctx)` where `anchorId` is the regionId. The existing code iterates `ctx.getAllRegionIds()`-equivalent loops internally — for the subsystem version, each call is scoped to ONE region (`anchorId`).

**Files:**
- Create: `src/engine/subsystem/weather.ts`
- Create: `src/engine/subsystem/__tests__/weather.test.ts`

- [ ] **Step 1: Write `src/engine/subsystem/weather.ts`.**

Skeleton (implementer fills body from `weatherFeature.ts`):

```ts
// src/engine/subsystem/weather.ts
//
// Per-region weather state machine. Phase I migration of weatherFeature.
// State shape, transition logic, and config consumption are preserved
// verbatim from src/engine/features/weatherFeature.ts; only the lifecycle
// shape changes (init → initialState, single-region scope per call).

import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { StateChange } from "../core/types.js";
import type { AnchorSubsystem } from "./types.js";

// Copy these from weatherFeature.ts lines 1-200 (constants, types, helpers):
//   - WeatherRegionState interface
//   - WeatherType union
//   - transition table, modifier maps, etc.
//   - decideNextWeather, applyTransitionEffects, emitContributions helpers

const SUBSYSTEM_ID = "weather";

export const weatherSubsystem: AnchorSubsystem = {
  id: SUBSYSTEM_ID,
  kind: "anchor",
  anchorKind: "region",
  description:
    "Per-region weather state machine — sunny / cloudy / rainy / stormy transitions, emits temperature + humidity contributions to outdoor locations.",
  effectSummary:
    "Weather rotates per region; outdoors temperature and humidity follow the active type.",
  affectedKinds: [
    "feature.setState",
    "environment.contribute",
    "scene.addCondition",
    "scene.removeCondition",
  ],
  priority: 100,
  planningPrompt: /* COPY from weatherFeature.ts:381 verbatim */ "",

  shouldExist(_anchorId: string, _ctx: FeatureReadContext): boolean {
    // Weather always exists wherever a region exists. The orchestrator's
    // anchorIdsFor("region") enumerates the actual set; this predicate
    // is the always-true case.
    return true;
  },

  initialState(anchorId: string, ctx: FeatureReadContext): StateChange[] {
    // Port from weatherFeature.init(ctx). The original init() loops every
    // region; here we receive ONE regionId. Compute the initial
    // WeatherRegionState for THIS region from moduleSetup.featureInit.weather,
    // emit a single feature.setState + the initial scene.addCondition for
    // the affected scenes + environment.contribute baseline. Implementer:
    // extract the per-region branch from the existing init() body.
    return [];
  },

  onTick(anchorId: string, ctx: FeatureReadContext): StateChange[] {
    // Port from weatherFeature.onTick(ctx). Original iterates every region;
    // here we process ONE regionId. Read current state via
    // ctx.getFeatureState<WeatherRegionState>(anchorId), decide whether to
    // transition, emit feature.setState + scene conditions + env contribs.
    return [];
  },

  stateDescription(ctx: FeatureReadContext): string {
    // Port from weatherFeature.stateDescription verbatim — it already loops
    // all feature states across the bucket, no per-anchor scoping needed.
    return "";
  },
};
```

- [ ] **Step 2: Write `src/engine/subsystem/__tests__/weather.test.ts`.**

Mirror the patterns in `src/engine/features/__tests__/weatherFeature.test.ts`. Key cases to preserve:

```ts
// src/engine/subsystem/__tests__/weather.test.ts
import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { makeDGSMFeatureReadContext } from "../../core/featureReadContext.js";
import type { StateChange } from "../../core/types.js";
import { weatherSubsystem } from "../weather.js";

// Mini-applier helper for state persistence across simulated ticks.
function applyFeatureChanges(dgsm: DynamicGameStateManager, changes: StateChange[]): void {
  for (const c of changes) {
    if (c.kind === "feature.setState") {
      dgsm.setScopedFeatureState(c.featureId, "region", c.key, c.state);
    } else if (c.kind === "feature.removeState") {
      dgsm.removeScopedFeatureState(c.featureId, "region", c.key);
    }
  }
}

describe("weatherSubsystem", () => {
  it("initialState seeds region state from moduleSetup.featureInit.weather", () => {
    const dgsm = new DynamicGameStateManager();
    // (implementer: build a region in DGSM + plant featureInit.weather config
    // mirroring weatherFeature.test.ts:N. Then:)
    const ctx = makeDGSMFeatureReadContext(dgsm, {
      callerFeatureId: "weather",
      callerScope: "region",
    });
    const out = weatherSubsystem.initialState("region-A", ctx);
    applyFeatureChanges(dgsm, out);
    const state = dgsm.getScopedFeatureState("weather", "region", "region-A");
    expect(state).toBeDefined();
  });

  it("onTick transitions weatherType when transition table fires", () => {
    // Port the deterministic-transition tests from the old weather feature.
  });

  it("onTick emits environment.contribute matching active weatherType modifiers", () => {
    // Port outdoor-temperature contribution test.
  });

  it("shouldExist returns true for any region", () => {
    const dgsm = new DynamicGameStateManager();
    const ctx = makeDGSMFeatureReadContext(dgsm, {
      callerFeatureId: "weather",
      callerScope: "region",
    });
    expect(weatherSubsystem.shouldExist("region-A", ctx)).toBe(true);
    expect(weatherSubsystem.shouldExist("region-doesnt-exist", ctx)).toBe(true);
  });
});
```

- [ ] **Step 3: Verify compile.**

No test run, no commit. Definition of done: `weather.ts` re-uses the same constants and logic as `weatherFeature.ts` line-for-line where possible; only the function signatures change.

---

## Task 4: sunSubsystem (anchor=global)

**Goal:** Port `sunFeature` to `sunSubsystem`. Anchor = global. Stateless observer — `initialState` returns `[]`, `onTick` emits `environment.contribute` for every outdoor location based on time-of-day. The single instance has anchorId = `"global"`.

**Read first:** `src/engine/features/sunFeature.ts` (237 lines).

**Files:**
- Create: `src/engine/subsystem/sun.ts`
- Create: `src/engine/subsystem/__tests__/sun.test.ts`

- [ ] **Step 1: Write `src/engine/subsystem/sun.ts`.**

```ts
// src/engine/subsystem/sun.ts
//
// Sun / daylight contributor. Anchor=global, stateless. Phase I migration
// of sunFeature.

import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { StateChange } from "../core/types.js";
import type { AnchorSubsystem } from "./types.js";

// COPY from sunFeature.ts:1-135 verbatim:
//   - constants (sunrise hour, sunset hour, light curves, etc.)
//   - helpers (computeLightLevel, computeBaseTemperature, etc.)

const SUBSYSTEM_ID = "sun";

export const sunSubsystem: AnchorSubsystem = {
  id: SUBSYSTEM_ID,
  kind: "anchor",
  anchorKind: "global",
  description: "Daylight + sun-driven temperature contribution to outdoor locations.",
  effectSummary: "Contributes light and ambient temperature to every outdoor scene / road / junction based on game-time-of-day.",
  affectedKinds: ["environment.contribute"],
  priority: 150,
  planningPrompt: /* COPY from sunFeature.ts:149 verbatim */ "",

  shouldExist(): boolean {
    return true;
  },

  initialState(): StateChange[] {
    // Stateless — no bucket needed. Return empty; engine still records the
    // instance as active (the absent bucket is the "default state").
    return [];
  },

  onTick(_anchorId: string, ctx: FeatureReadContext): StateChange[] {
    // PORT from sunFeature.onTick(ctx) verbatim — its body already iterates
    // every outdoor location and emits contributions. Single global instance
    // makes this a 1:1 copy.
    return [];
  },
};
```

- [ ] **Step 2: Write `src/engine/subsystem/__tests__/sun.test.ts`.**

Port relevant cases from `sunFeature.test.ts` — mainly:
- `onTick` emits `environment.contribute` for every outdoor scene + road + junction.
- Light level matches expected curve at midnight / noon / sunset.
- Indoor scenes are excluded.

Use the same fixture style as `weather.test.ts`. Skip `shouldExist` tests beyond a single sanity check (always true).

- [ ] **Step 3: Verify compile.** No commit.

---

## Task 5: staminaSubsystem (anchor=character)

**Goal:** Port `staminaFeature` to `staminaSubsystem`. Anchor = character. `shouldExist` = character is alive. `initialState` seeds zero fatigue. `onTick` increments fatigue per tick using the existing transition logic.

**Read first:** `src/engine/features/staminaFeature.ts` (319 lines).

**Files:**
- Create: `src/engine/subsystem/stamina.ts`
- Create: `src/engine/subsystem/__tests__/stamina.test.ts`

- [ ] **Step 1: Write `src/engine/subsystem/stamina.ts`.**

```ts
// src/engine/subsystem/stamina.ts
import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { StateChange } from "../core/types.js";
import type { AnchorSubsystem } from "./types.js";

// COPY from staminaFeature.ts:1-200 verbatim:
//   - StaminaCharacterState interface
//   - FATIGUE_LABELS, DRAIN_TICK_INTERVAL, etc.
//   - computeFatigueLevel, getAccelerationMultiplier, emitConditionTransition,
//     computeFailChance, rollD3, computeFatigueBarScore helpers

const SUBSYSTEM_ID = "stamina";

export const staminaSubsystem: AnchorSubsystem = {
  id: SUBSYSTEM_ID,
  kind: "anchor",
  anchorKind: "character",
  description: "Per-character fatigue tracker — accumulates over time, accelerated by hostile temperatures, drains HP/SAN at exhausted level on CON failure.",
  effectSummary: "Tracks per-character fatigue, emits Tired/Exhausted conditions, rolls CON drain at exhausted.",
  affectedKinds: [
    "feature.setState",
    "character.addCondition",
    "character.removeCondition",
    "character.hp",
    "character.san",
  ],
  priority: 300,
  planningPrompt: /* COPY from staminaFeature.ts:221 verbatim */ "",

  shouldExist(anchorId: string, ctx: FeatureReadContext): boolean {
    // Character must exist and be alive. ctx.getCharacter returns undefined
    // for unknown ids; isNpcAlive logic is encoded in getAllAliveCharacterIds
    // which is already what anchorIdsFor returns — so this predicate is just
    // a re-verification (defensive, in case the anchor enumeration changes).
    return ctx.getCharacter(anchorId) !== undefined;
  },

  initialState(anchorId: string, _ctx: FeatureReadContext): StateChange[] {
    return [
      {
        kind: "feature.setState",
        featureId: SUBSYSTEM_ID,
        key: anchorId,
        state: { fatigue: 0, fatigueLevel: 0, exhaustedDrainTicks: 0 },
      },
    ];
  },

  onTick(anchorId: string, ctx: FeatureReadContext): StateChange[] {
    // PORT from staminaFeature.onTick(ctx) — the body already inlines the
    // per-character branch (lines 242-318). Extract the loop body for ONE
    // characterId = anchorId.
    return [];
  },

  stateDescription(ctx: FeatureReadContext): string {
    // PORT from staminaFeature.stateDescription verbatim.
    return "";
  },
};
```

- [ ] **Step 2: Write `src/engine/subsystem/__tests__/stamina.test.ts`.**

Port cases from `staminaFeature.test.ts`. Key behavior: fatigue accumulates correctly, level transitions emit conditions, exhausted drain produces HP/SAN deltas on CON failure.

- [ ] **Step 3: Verify compile.** No commit.

---

## Task 6: itemDamageSubsystem (anchor=scene)

**Goal:** Port `itemDamageFeature` to `itemDamageSubsystem`. Anchor = scene. `shouldExist` = scene has items (or always true — simpler). Stateless: `initialState` returns `[]`. `onTick` checks `getEnvironmentReading(sceneId).temperature` and emits `scene.damageItem` changes.

**Read first:** `src/engine/features/itemDamageFeature.ts` (63 lines — small and self-contained).

**Files:**
- Create: `src/engine/subsystem/itemDamage.ts`
- Create: `src/engine/subsystem/__tests__/itemDamage.test.ts`

- [ ] **Step 1: Write `src/engine/subsystem/itemDamage.ts`.**

```ts
// src/engine/subsystem/itemDamage.ts
import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { StateChange } from "../core/types.js";
import type { AnchorSubsystem } from "./types.js";

const SUBSYSTEM_ID = "itemDamage";
const HEAT_DAMAGE_THRESHOLD = 200; // °C; matches itemDamageFeature.ts:13
const DAMAGE_SAMPLE_RATE = 0.2;   // matches itemDamageFeature.ts:17

export const itemDamageSubsystem: AnchorSubsystem = {
  id: SUBSYSTEM_ID,
  kind: "anchor",
  anchorKind: "scene",
  description: "Damages items in scenes exposed to extreme heat (env.temperature > 200°C).",
  effectSummary: "20% of undamaged items per tick take fire damage when scene env.temperature > 200°C.",
  affectedKinds: ["scene.damageItem"],
  priority: 350,

  shouldExist(anchorId: string, ctx: FeatureReadContext): boolean {
    // Always exist for every scene — onTick is the no-op fast path when
    // temperature is below threshold. Keeps the predicate trivial.
    return ctx.getScene(anchorId) !== undefined;
  },

  initialState(): StateChange[] {
    return [];
  },

  onTick(anchorId: string, ctx: FeatureReadContext): StateChange[] {
    const reading = ctx.getEnvironmentReading(anchorId);
    if (reading.temperature <= HEAT_DAMAGE_THRESHOLD) return [];

    const scene = ctx.getScene(anchorId);
    if (!scene?.items || scene.items.length === 0) return [];

    const undamaged = scene.items.filter((it) => !it.damaged);
    if (undamaged.length === 0) return [];

    const sampleCount = Math.round(undamaged.length * DAMAGE_SAMPLE_RATE);
    if (sampleCount === 0) return [];

    const shuffled = [...undamaged].sort(() => Math.random() - 0.5);
    const reason = `Damaged by heat (env.temperature ${reading.temperature.toFixed(0)}°C)`;
    const out: StateChange[] = [];
    for (let i = 0; i < sampleCount; i++) {
      out.push({
        kind: "scene.damageItem",
        sceneId: anchorId,
        itemId: shuffled[i].id,
        damagedBy: "fire",
        reason,
        sourceFeatureId: SUBSYSTEM_ID,
      });
    }
    return out;
  },
};
```

- [ ] **Step 2: Write `src/engine/subsystem/__tests__/itemDamage.test.ts`.**

```ts
// src/engine/subsystem/__tests__/itemDamage.test.ts
import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { makeDGSMFeatureReadContext } from "../../core/featureReadContext.js";
import { itemDamageSubsystem } from "../itemDamage.js";

describe("itemDamageSubsystem", () => {
  it("emits no changes when temperature is below threshold", () => {
    // (implementer: build a scene with items + env.temperature=20 in DGSM)
    const dgsm = new DynamicGameStateManager();
    const ctx = makeDGSMFeatureReadContext(dgsm, {
      callerFeatureId: "itemDamage",
      callerScope: "scene",
    });
    // const out = itemDamageSubsystem.onTick("scene-A", ctx);
    // expect(out).toEqual([]);
  });

  it("emits scene.damageItem for sampled items when temperature exceeds 200°C", () => {
    // (implementer: stub env.temperature to 300, place 10 items, assert ~2 sample)
  });

  it("excludes already-damaged items from the sample pool", () => {
    // ...
  });
});
```

- [ ] **Step 3: Verify compile.** No commit.

---

## Task 7: fireSubsystem (anchor=scene) + ActionDefinition rework

**Goal:** Port `fireFeature` to `fireSubsystem` (most complex feature). Also rework `igniteFire` and `extinguishFire` ActionDefinitions to emit domain StateChange directly (per spec D6), instead of planting `overlayFields.fireExtinguish` / `fireIntensity`.

**Read first:**
- `src/engine/features/fireFeature.ts` (587 lines)
- `src/engine/tool_definitions/*.yaml` for the ignite / extinguish actions (search for `fireIntensity` and `fireExtinguish`)

### Subsystem design

- `anchorKind: "scene"`
- `shouldExist(sceneId)` = scene has `burning` condition (from feature "fire") OR (only at the spawning moment) scene was just lit. Use the `burning` SceneCondition as the truth signal: `ctx.getScene(sceneId).activeConditions.some(c => c.fromFeature === "fire")`.
- `initialState(sceneId)` = seed `FireSceneState` with `intensity: 1, phase: "growing"`, plus emit `scene.addCondition: burning` (only if it wasn't already added by the action's commit — guard via `ctx.getScene`).
- `onTick(sceneId)` = port the existing onTick body (intensity growth, propagation countdown, condition refresh, etc.).
- Propagation: replace `onPropagate` hook with internal countdown in `FireSceneState.propagationCountdown` (decremented in `onTick`; when 0, emit `scene.addCondition: burning` on adjacent scenes derived from topology).
- Action-coupled mutations (extinguish reducing intensity, ignite boosting intensity): handled by reworked ActionDefinitions emitting StateChanges directly — NOT by an `onActionCommit` hook (per spec D6).

### ActionDefinition rework

For `igniteFire`:
- **Before:** action commits with `overlayFields.fireIntensity: 30`.
- **After:** action commits with planned outcome stateChanges = `[{ kind: "scene.addCondition", sceneId, condition: { id: "fire-burning-<sceneId>", fromFeature: "fire", … } }]`. The `fireSubsystem.shouldExist` predicate then returns true next tick, spawn occurs, `initialState` seeds the fire state with default starting intensity. No fine-grained "intensity 30 vs 50" control from the action — the LLM can describe magnitude in narrative, but engine-wise it's "fire is now burning".

For `extinguishFire`:
- **Before:** action commits with `overlayFields.fireExtinguish: true`; fireFeature's onActionCommit reduces intensity by 2 (or extinguishes if intensity ≤ 0).
- **After:** action commits with `[{ kind: "scene.removeCondition", sceneId, predicate: { featureId: "fire" } }]`. `fireSubsystem.shouldExist` returns false next tick → instance destroyed → bucket cleared automatically by Phase 5.

If finer control (e.g. "reduce intensity by N rather than fully extinguish") is needed, that's the escape hatch (b) from spec D6 — a per-action `commitHandler` that emits `feature.setState fire { intensity: existing - 2 }`. For the initial migration, use the simpler "remove burning condition" semantics; revisit if game design needs intensity steps.

**Files:**
- Create: `src/engine/subsystem/fire.ts`
- Create: `src/engine/subsystem/__tests__/fire.test.ts`
- Modify: action definitions for ignite / extinguish (locate via `grep -rn fireIntensity src/engine/tool_definitions`)

- [ ] **Step 1: Locate ignite/extinguish action definitions.**

```bash
grep -rln "fireIntensity\|fireExtinguish" /Users/sunyining/project_SentiEdge/CoC-AI-agent/src/engine/tool_definitions
```

For each match: read the YAML, find the commit outcome StateChange block, replace `overlayFields: { fireIntensity: … }` with the appropriate `scene.addCondition` or `scene.removeCondition` shape.

- [ ] **Step 2: Write `src/engine/subsystem/fire.ts`.**

Skeleton — full implementation requires porting fireFeature.ts's onTick (lines 369-470) and onPropagate (500-585) bodies. Implementer reads those and adapts:

```ts
// src/engine/subsystem/fire.ts
import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { SceneCondition, StateChange } from "../core/types.js";
import type { AnchorSubsystem } from "./types.js";

// COPY from fireFeature.ts:1-234 verbatim:
//   - FireSceneState, FireRoadState interfaces (add `propagationCountdown: number`)
//   - FIRE_INTENSITY_MAX, GROWTH_RATE, etc. constants
//   - createFireState, emitFireConditionRefresh, emitFireExtinguish helpers
//   - planningPrompt + planNodeSchema literals

const SUBSYSTEM_ID = "fire";
const PROPAGATION_INTERVAL = 10; // matches fireFeature.propagation.tickInterval

export const fireSubsystem: AnchorSubsystem = {
  id: SUBSYSTEM_ID,
  kind: "anchor",
  anchorKind: "scene",
  description: "Per-scene fire state machine — grows, decays, spreads to adjacent scenes via topology.",
  effectSummary: "Burning scenes accumulate intensity, emit temperature + smoke, may spread to neighbors every ~10 ticks at intensity ≥ spreadThreshold.",
  affectedKinds: [
    "feature.setState",
    "scene.addCondition",
    "scene.removeCondition",
    "scene.damageItem",
    "environment.contribute",
    "connection.setBlock",
  ],
  priority: 200,
  planningPrompt: /* COPY */ "",

  shouldExist(anchorId: string, ctx: FeatureReadContext): boolean {
    // Truth signal: scene has a "burning" condition fromFeature="fire".
    // The condition is what the LLM ignite action emits; the fire bucket
    // is what THIS subsystem owns. Reading the condition (external) avoids
    // the cyclic-predicate invariant from D6.
    const scene = ctx.getScene(anchorId);
    if (!scene?.activeConditions) return false;
    return scene.activeConditions.some(
      (c) => (c as SceneCondition).fromFeature === SUBSYSTEM_ID
    );
  },

  initialState(anchorId: string, _ctx: FeatureReadContext): StateChange[] {
    // Default starting intensity = 1 (matches fireFeature's "fresh ignition"
    // branch at lines 352-358 of fireFeature.ts).
    return [
      {
        kind: "feature.setState",
        featureId: SUBSYSTEM_ID,
        key: anchorId,
        state: {
          intensity: 1,
          maxIntensity: 5,
          growthRate: 0.05,
          decayRate: 0.02,
          spreadThreshold: 3,
          phase: "growing",
          minutesInPhase: 0,
          totalBurnMinutes: 0,
          propagationCountdown: PROPAGATION_INTERVAL,
        },
      },
    ];
  },

  onTick(anchorId: string, ctx: FeatureReadContext): StateChange[] {
    // PORT from fireFeature.onTick body (lines 369-470). Adapt to per-scene
    // call (existing body already iterates scenes; extract one branch).
    //
    // Additional propagation logic (replacing the deleted onPropagate hook):
    //   - decrement state.propagationCountdown each tick
    //   - if countdown reaches 0 AND intensity >= spreadThreshold:
    //       enumerate adjacent scenes via ctx.getTopology() + sceneId
    //       emit scene.addCondition { fromFeature: "fire", sceneId: adjacent }
    //       reset countdown to PROPAGATION_INTERVAL
    //   - else: emit feature.setState with decremented countdown
    //
    // Implementer: study fireFeature.onPropagate (lines 500-585) for the
    // adjacency-walk logic — port it inline here.
    return [];
  },

  stateDescription(ctx: FeatureReadContext): string {
    // PORT from fireFeature.stateDescription (lines 287-299) verbatim.
    return "";
  },
};
```

- [ ] **Step 3: Modify igniteFire / extinguishFire YAML.**

For each ignite-style action found in Step 1, edit the commit outcome block. Example transformation:

Before:
```yaml
commitOutcome:
  stateChanges:
    - kind: feature.setState
      featureId: fire
      key: ${sceneId}
      state:
        # filled by resolver via overlayFields
  overlayFields:
    fireIntensity: 30
```

After:
```yaml
commitOutcome:
  stateChanges:
    - kind: scene.addCondition
      sceneId: ${sceneId}
      condition:
        id: fire-burning-${sceneId}
        fromFeature: fire
        # condition fields per SceneCondition type — implementer fills
        # per the canonical "burning" condition shape used in fireFeature.ts
```

Exact YAML structure depends on the project's tool_definitions schema; implementer reads one existing action with `overlayFields` to mirror the pattern.

Similar for extinguish: replace `overlayFields.fireExtinguish` with `scene.removeCondition { sceneId, predicate: { featureId: "fire" } }`.

- [ ] **Step 4: Write `src/engine/subsystem/__tests__/fire.test.ts`.**

Port the full `fireFeature.test.ts` test suite, adapting:
- Tests that called `fireFeature.onActionCommit(...)` are removed — that path no longer exists. Replace with tests that emit a `scene.addCondition burning` via a simulated action commit, then run one tick, assert `shouldExist` returns true and `initialState` seeded the bucket.
- Tests for propagation (called `onPropagate` directly) are replaced by tests that call `onTick` repeatedly across PROPAGATION_INTERVAL ticks, asserting the `scene.addCondition` for adjacent scene appears at the right tick.

- [ ] **Step 5: Verify compile.** No commit.

---

## Task 8: movementSubsystem (ActionSubsystem)

**Goal:** Port `MovementSubsystem` from `src/engine/codeEngine/movement.ts` to `src/engine/subsystem/movement.ts` as an `ActionSubsystem`. Signature change only — same logic.

**Read first:** `src/engine/codeEngine/movement.ts` (310 lines), `src/engine/codeEngine/types.ts` for `CodeEngineSubsystem` (which we're replacing).

**Files:**
- Create: `src/engine/subsystem/movement.ts`
- Create: `src/engine/subsystem/__tests__/movement.test.ts`

- [ ] **Step 1: Write `src/engine/subsystem/movement.ts`.**

```ts
// src/engine/subsystem/movement.ts
//
// Per-step movement processor. Phase I migration of MovementSubsystem from
// src/engine/codeEngine/movement.ts. Logic preserved verbatim; only the
// interface signature changes (CodeEngineSubsystem.onActivate/onTick/onInterrupt
// return CodeEngineStepResult → ActionSubsystem.onActivate/onTick/onInterrupt
// return SubsystemStepResult; same shape, different name).

import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { ActionStep, StateChange } from "../core/types.js";
import type { ActionSubsystem, SubsystemStepResult } from "./types.js";

// COPY from movement.ts:1-52 verbatim:
//   - MovementRouteState interface
//   - imports (topology helpers)
//   - constants

const SUBSYSTEM_ID = "movement";

export const movementSubsystem: ActionSubsystem = {
  id: SUBSYSTEM_ID,
  kind: "action",
  description: "Step-by-step movement along a planned route via topology.",
  effectSummary: "Advances character position along a precomputed route, one topology hop per several ticks.",
  affectedKinds: ["character.position"],
  priority: 250,

  onActivate(step: ActionStep, ctx: FeatureReadContext): SubsystemStepResult {
    // PORT from MovementSubsystem.onActivate (lines 57-153 of movement.ts) verbatim.
    // Return type field names are identical (stateChanges, completed, failed).
    return { stateChanges: [], completed: false };
  },

  onTick(step: ActionStep, ctx: FeatureReadContext): SubsystemStepResult {
    // PORT from MovementSubsystem.onTick (lines 155-237 of movement.ts) verbatim.
    return { stateChanges: [], completed: false };
  },

  onInterrupt(step: ActionStep, ctx: FeatureReadContext): { stateChanges: StateChange[] } {
    // PORT from MovementSubsystem.onInterrupt (lines 239-279 of movement.ts) verbatim.
    return { stateChanges: [] };
  },
};
```

Note: `MovementSubsystem` was a class; `movementSubsystem` is a plain object. The class held no instance state (per-step state is in `ActionStep.subsystemState`, lookup via ctx). Convert the class methods to plain functions on the object literal.

Note 2: The old `makeCodeEngineContext` helper from `codeEngine/types.ts` wrapped `FeatureReadContext` with a private `_dgsm` channel. Movement uses this for raw position/topology reads that `FeatureReadContext` doesn't expose. Carry this forward by creating `src/engine/subsystem/actionContext.ts`:

```ts
// src/engine/subsystem/actionContext.ts
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { FeatureReadContext } from "../core/featureReadContext.js";

export function makeActionSubsystemContext(
  base: FeatureReadContext,
  dgsm: DynamicGameStateManager
): FeatureReadContext {
  return Object.assign(Object.create(null), base, { _dgsm: dgsm }) as FeatureReadContext;
}

export function getActionSubsystemDgsm(
  ctx: FeatureReadContext
): DynamicGameStateManager | undefined {
  return (ctx as unknown as { _dgsm?: DynamicGameStateManager })._dgsm;
}
```

(This is a 1:1 copy of `codeEngine/types.ts` lines 12-26 — just renamed and relocated. The old file will be deleted in Task 11.)

- [ ] **Step 2: Write `src/engine/subsystem/__tests__/movement.test.ts`.**

Port `src/engine/codeEngine/__tests__/movement.test.ts` verbatim, updating imports:
- `import { MovementSubsystem } from "../movement.js"` → `import { movementSubsystem } from "../movement.js"`
- `new MovementSubsystem()` → `movementSubsystem`
- `import { makeCodeEngineContext } from "../types.js"` → `import { makeActionSubsystemContext } from "../actionContext.js"`
- All return values use the same field names so test assertions stay identical.

- [ ] **Step 3: Verify compile.** No commit.

---

## Task 9: characterConditionExpirySubsystem + sceneConditionExpirySubsystem

**Goal:** Migrate the Phase 9.5 `sweepExpiredCharacterConditions` sweep into two AnchorSubsystems. Each scans its anchor for expired conditions and emits `character.removeCondition` / `scene.removeCondition` StateChanges. shouldExist is always true.

**Read first:** `src/engine/core/tickOrchestrator.ts:460-485` for `sweepExpiredCharacterConditions` implementation.

**Files:**
- Create: `src/engine/subsystem/conditionExpiry.ts` (both subsystems in one file — they share the time-comparison helper)
- Create: `src/engine/subsystem/__tests__/conditionExpiry.test.ts`

- [ ] **Step 1: Write `src/engine/subsystem/conditionExpiry.ts`.**

```ts
// src/engine/subsystem/conditionExpiry.ts
//
// Per-character + per-scene condition expiry. Phase I migration of
// TickOrchestrator.sweepExpiredCharacterConditions (Phase 9.5).
//
// Both subsystems are stateless — they scan their anchor each tick and
// emit removeCondition StateChanges for any condition whose `expiresAt`
// is at or before the current game time.

import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { CharacterCondition, SceneCondition, StateChange } from "../core/types.js";
import type { AnchorSubsystem } from "./types.js";

/** GameTime ISO comparison (matches tickOrchestrator.timeIsAtOrBefore semantics). */
function isExpired(expiresAt: string | undefined, now: string): boolean {
  if (!expiresAt) return false;
  return expiresAt <= now;
}

export const characterConditionExpirySubsystem: AnchorSubsystem = {
  id: "characterConditionExpiry",
  kind: "anchor",
  anchorKind: "character",
  description: "Removes character conditions whose expiresAt has passed.",
  effectSummary: "Per-tick cleanup of timed conditions on each character.",
  affectedKinds: ["character.removeCondition"],
  priority: 900,

  shouldExist(anchorId: string, ctx: FeatureReadContext): boolean {
    return ctx.getCharacter(anchorId) !== undefined;
  },

  initialState(): StateChange[] {
    return [];
  },

  onTick(anchorId: string, ctx: FeatureReadContext): StateChange[] {
    const character = ctx.getCharacter(anchorId);
    if (!character?.activeConditions) return [];
    const now = ctx.gameDateTime;
    const out: StateChange[] = [];
    for (const c of character.activeConditions as CharacterCondition[]) {
      if (isExpired(c.expiresAt, now)) {
        out.push({
          kind: "character.removeCondition",
          characterId: anchorId,
          conditionId: c.id,
        });
      }
    }
    return out;
  },
};

export const sceneConditionExpirySubsystem: AnchorSubsystem = {
  id: "sceneConditionExpiry",
  kind: "anchor",
  anchorKind: "scene",
  description: "Removes scene conditions whose expiresAt has passed.",
  effectSummary: "Per-tick cleanup of timed conditions on each scene.",
  affectedKinds: ["scene.removeCondition"],
  priority: 900,

  shouldExist(anchorId: string, ctx: FeatureReadContext): boolean {
    return ctx.getScene(anchorId) !== undefined;
  },

  initialState(): StateChange[] {
    return [];
  },

  onTick(anchorId: string, ctx: FeatureReadContext): StateChange[] {
    const scene = ctx.getScene(anchorId);
    if (!scene?.activeConditions) return [];
    const now = ctx.gameDateTime;
    const out: StateChange[] = [];
    for (const c of scene.activeConditions as SceneCondition[]) {
      // SceneCondition.expiresAt may not exist in the current type — check
      // src/engine/core/types.ts at SceneCondition definition. If the field
      // doesn't exist, this subsystem is a no-op; add the field as part of
      // this task (it's tiny — see implementer note below).
      if (isExpired((c as { expiresAt?: string }).expiresAt, now)) {
        out.push({
          kind: "scene.removeCondition",
          sceneId: anchorId,
          predicate: { conditionId: c.id },
        });
      }
    }
    return out;
  },
};
```

**Implementer note on scene `expiresAt`:** the current spec D7 says "Scene conditions don't have expiresAt today." Two options:
1. Skip the scene subsystem in Task 9 (only ship characterConditionExpiry). The spec says "Phase 9.5 (condition expiry) is now Phase 6 (anchor=character + anchor=scene expiry subsystems)" — keeping it as a placeholder is fine; sceneConditionExpiry's onTick is a guaranteed no-op until SceneCondition gains `expiresAt`.
2. Add `expiresAt?: string` to `SceneCondition` now. Small addition, future-proof.

Go with option (1) — keep both subsystems shipping, sceneConditionExpiry's loop checks for an optional field that's currently always undefined. The shape stays stable for when scene conditions gain timing later. This matches the spec.

- [ ] **Step 2: Write `src/engine/subsystem/__tests__/conditionExpiry.test.ts`.**

```ts
// src/engine/subsystem/__tests__/conditionExpiry.test.ts
import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { makeDGSMFeatureReadContext } from "../../core/featureReadContext.js";
import {
  characterConditionExpirySubsystem,
  sceneConditionExpirySubsystem,
} from "../conditionExpiry.js";

describe("characterConditionExpirySubsystem", () => {
  it("emits character.removeCondition for an expired condition", () => {
    const dgsm = new DynamicGameStateManager();
    // (implementer: register an NPC with an activeCondition whose
    // expiresAt is in the past; set dgsm.gameDateTime to current time;
    // call onTick, assert one character.removeCondition StateChange.)
  });

  it("leaves non-expired conditions alone", () => {
    // (analogous, expiresAt in the future)
  });

  it("ignores conditions without expiresAt (permanent)", () => {
    // ...
  });
});

describe("sceneConditionExpirySubsystem", () => {
  it("is a no-op when scene conditions have no expiresAt field", () => {
    const dgsm = new DynamicGameStateManager();
    const ctx = makeDGSMFeatureReadContext(dgsm, {
      callerFeatureId: "sceneConditionExpiry",
      callerScope: "scene",
    });
    // (implementer: build a scene with a SceneCondition that has no
    // expiresAt; assert onTick returns [].)
  });
});
```

- [ ] **Step 3: Verify compile.** No commit.

---

## Task 10: Switchover — registerDefaults + tickEngine + tickOrchestrator phase cleanup

**Goal:** Flip the engine from "legacy + new running in parallel" to "new only". Replace `getDefaultFeatures()` / `createDefaultCodeEngineRegistry()` with `createDefaultSubsystemRegistry()`. Remove `featureRunner`, `codeEngineRegistry`, `emergentEventEmitter`, `sweepExpiredCharacterConditions` from TickOrchestrator. Wire `subsystemRegistry` as required (not optional).

**Files:**
- Modify: `src/engine/registerDefaults.ts`
- Modify: `src/engine/core/tickEngine.ts`
- Modify: `src/engine/core/tickOrchestrator.ts`

- [ ] **Step 1: Replace `getDefaultFeatures` + `createDefaultCodeEngineRegistry` with `createDefaultSubsystemRegistry`.**

Rewrite `src/engine/registerDefaults.ts`:

```ts
import { fireSubsystem } from "./subsystem/fire.js";
import { itemDamageSubsystem } from "./subsystem/itemDamage.js";
import { movementSubsystem } from "./subsystem/movement.js";
import {
  characterConditionExpirySubsystem,
  sceneConditionExpirySubsystem,
} from "./subsystem/conditionExpiry.js";
import { staminaSubsystem } from "./subsystem/stamina.js";
import { sunSubsystem } from "./subsystem/sun.js";
import { weatherSubsystem } from "./subsystem/weather.js";
import { SubsystemRegistry } from "./subsystem/registry.js";
import { ActionDefinitionRegistry } from "./definitions/registry.js";
import { loadActionDefinitions } from "./tool_definitions/loader.js";

export function createDefaultSubsystemRegistry(): SubsystemRegistry {
  const reg = new SubsystemRegistry();
  reg.register(weatherSubsystem);
  reg.register(sunSubsystem);
  reg.register(staminaSubsystem);
  reg.register(itemDamageSubsystem);
  reg.register(fireSubsystem);
  reg.register(movementSubsystem);
  reg.register(characterConditionExpirySubsystem);
  reg.register(sceneConditionExpirySubsystem);
  return reg;
}

export function createDefaultDefinitions(): ActionDefinitionRegistry {
  const reg = new ActionDefinitionRegistry();
  for (const def of loadActionDefinitions()) reg.register(def);
  return reg;
}
```

The old `getDefaultFeatures` export is gone. Any callers (search via `grep -rn "getDefaultFeatures" src client`) will be updated by Task 11's cleanup pass.

- [ ] **Step 2: Update `src/engine/core/tickEngine.ts` — require subsystemRegistry, drop features + codeEngineRegistry.**

In `CreateTickEngineOptions`, **remove** these fields:
- `features: WorldFeature[]`
- `codeEngineRegistry?: CodeEngineRegistry`

**Make required:**
- `subsystemRegistry: SubsystemRegistry`

Replace the FeatureRunner construction (around `tickEngine.ts:94`) — delete it. Replace the `codeEngineRegistry` resolution (around line 114) — delete it.

Pass `subsystemRegistry: opts.subsystemRegistry` to the orchestrator. **Also pass it to ActionIntake** if any other component currently depends on FeatureRunner / codeEngineRegistry (implementer: grep for `featureRunner` and `codeEngineRegistry` in `src/engine/` and route through subsystemRegistry where needed).

Also drop `emergentScanners` from CreateTickEngineOptions (it's a Phase E artifact for the now-deleted EmergentEventEmitter).

- [ ] **Step 3: Update `src/engine/core/tickOrchestrator.ts` — drop legacy phases.**

In `OrchestratorDeps`:
- **Remove:** `featureRunner: FeatureRunner`
- **Remove:** `emergentEventEmitter: EmergentEventEmitter`
- **Remove:** `codeEngineRegistry: CodeEngineRegistry`
- **Make required (drop the `?`):** `subsystemRegistry: SubsystemRegistry`
- Keep: `hasInitialized` for backward compatibility — but now it's only used for diagnostics; the Phase 0 init path is gone.

In `tick()`:
- **Delete Phase 0** (lines ~109-117 — the `for (const f of features) f.init?.(ctx)` block).
- **Delete Phase 3 codeEngine route** at line ~339 (`this.deps.codeEngineRegistry.get(...).onActivate/...`). Replace with `this.deps.subsystemRegistry.getActionSubsystem(...).onActivate/...` — the call signature is identical (`(step, ctx) → SubsystemStepResult`).
- **Delete Phase 4 onActionCommit dispatch** (`featureRunner.runActionCommit(...)` at line ~229). No replacement — actions emit StateChanges directly now per spec D6.
- **Delete Phase 5/6 legacy** (`featureRunner.runTick` line ~262, `featureRunner.runPropagation` line ~265). The new Phase 5 + Phase 6 from Task 2 stays — promote them to mandatory.
- **Delete Phase 8** (`emergentEventEmitter.scan(scannerCtx)` line ~291).
- **Delete Phase 9.5** (`this.sweepExpiredCharacterConditions(nextTickTime)` line ~299). The helper method itself is also deleted.

Remove the now-orphan helper methods: `sweepExpiredCharacterConditions`, `timeIsAtOrBefore`.

Remove imports for `FeatureRunner`, `EmergentEventEmitter`, `WorldFeature`, `CodeEngineRegistry`, `makeCodeEngineContext` from tickOrchestrator. Add imports for `SubsystemRegistry`, `getActionSubsystemDgsm`, `makeActionSubsystemContext`.

For action subsystem context construction (where the old code called `makeCodeEngineContext(base, dgsm)` to expose the private `_dgsm` channel for movement), call the new `makeActionSubsystemContext(base, dgsm)` instead.

- [ ] **Step 4: Update callers of `getDefaultFeatures` to use `createDefaultSubsystemRegistry`.**

Search:
```bash
grep -rln "getDefaultFeatures\|emergentScanners\|createDefaultCodeEngineRegistry" \
  /Users/sunyining/project_SentiEdge/CoC-AI-agent/src \
  /Users/sunyining/project_SentiEdge/CoC-AI-agent/client \
  /Users/sunyining/project_SentiEdge/CoC-AI-agent/__tests__
```

Likely callers: `client/server/simulation/*`, `src/simulation/SimulationRunner.ts`, test fixtures. For each, replace:

```ts
const features = getDefaultFeatures();
const codeEngineRegistry = createDefaultCodeEngineRegistry();
// ... new TickEngine({ features, codeEngineRegistry, emergentScanners: [], ... })
```

With:

```ts
const subsystemRegistry = createDefaultSubsystemRegistry();
// ... new TickEngine({ subsystemRegistry, ... })
```

- [ ] **Step 5: Verify compile.** No test run, no commit.

---

## Task 11: Final Cleanup — Delete Legacy Code

**Goal:** Delete the now-unused legacy types and files. Pure deletion pass (no behavior change).

**Files deleted:**
- `src/engine/core/worldFeature.ts` — but FIRST: `PlannedOutcome` is exported from here and is still used by other modules (resolver, action commit pipeline, types). **Move `PlannedOutcome` to `src/engine/core/types.ts`** (add it next to the other exported interfaces). Update all imports.
- `src/engine/core/featureRunner.ts`
- `src/engine/core/emergentEventEmitter.ts`
- `src/engine/core/emergentScanner.ts`
- `src/engine/codeEngine/types.ts`
- `src/engine/codeEngine/registry.ts`
- `src/engine/codeEngine/movement.ts`
- `src/engine/codeEngine/__tests__/movement.test.ts`
- `src/engine/features/fireFeature.ts`
- `src/engine/features/itemDamageFeature.ts`
- `src/engine/features/staminaFeature.ts`
- `src/engine/features/sunFeature.ts`
- `src/engine/features/weatherFeature.ts`
- `src/engine/features/__tests__/fireFeature.test.ts`
- `src/engine/features/__tests__/itemDamageFeature.test.ts`
- `src/engine/features/__tests__/staminaFeature.test.ts`
- `src/engine/features/__tests__/sunFeature.test.ts`
- `src/engine/features/__tests__/weatherFeature.test.ts`

Directories that become empty: `src/engine/codeEngine/`, `src/engine/codeEngine/__tests__/`, `src/engine/features/`, `src/engine/features/__tests__/`. Delete them too.

- [ ] **Step 1: Move `PlannedOutcome` interface.**

In `src/engine/core/types.ts`, add (near the other exported interfaces):

```ts
/**
 * Output of the resolver pipeline for a single action step. Consumed by
 * Phase 4 commit (applier processes stateChanges) and by EventBus emission
 * (narrative surfaces). Moved here from worldFeature.ts in Phase I.
 */
export interface PlannedOutcome {
  stateChanges: StateChange[];
  elapsedMinutes: number;
  narrative?: string;
}
```

Update all importers (search via `grep -rn "from.*worldFeature.js" src` and `grep -rn "PlannedOutcome" src`) to import from `core/types.js` instead of `core/worldFeature.js`.

- [ ] **Step 2: Delete the files listed above.**

```bash
cd /Users/sunyining/project_SentiEdge/CoC-AI-agent
rm src/engine/core/worldFeature.ts
rm src/engine/core/featureRunner.ts
rm src/engine/core/emergentEventEmitter.ts
rm src/engine/core/emergentScanner.ts
rm -r src/engine/codeEngine/
rm -r src/engine/features/
```

- [ ] **Step 3: Sweep dangling imports.**

```bash
grep -rln "from.*worldFeature.js\|from.*featureRunner.js\|from.*emergentEventEmitter.js\|from.*emergentScanner.js\|from.*codeEngine/\|from.*features/\(fire\|item\|stamina\|sun\|weather\)Feature" \
  /Users/sunyining/project_SentiEdge/CoC-AI-agent/src \
  /Users/sunyining/project_SentiEdge/CoC-AI-agent/client \
  /Users/sunyining/project_SentiEdge/CoC-AI-agent/__tests__
```

Every match must be rewritten — either to the new subsystem path or removed entirely (e.g., test fixtures that used `MovementSubsystem` directly should now import `movementSubsystem` from `src/engine/subsystem/movement.ts`).

- [ ] **Step 4: Sweep dangling exports.**

Check that nothing else imports `getDefaultFeatures` or `createDefaultCodeEngineRegistry` — these no longer exist.

```bash
grep -rln "getDefaultFeatures\|createDefaultCodeEngineRegistry" \
  /Users/sunyining/project_SentiEdge/CoC-AI-agent/src \
  /Users/sunyining/project_SentiEdge/CoC-AI-agent/client
```

Zero results expected.

- [ ] **Step 5: Verify compile.** No commit yet.

---

## Task 12: Batch Verification + Commit

**Goal:** Run `pnpm test`, `pnpm check`, `pnpm build:tsc`. Fix any failures. Then commit everything in a single commit.

- [ ] **Step 1: Type-check.**

```bash
cd /Users/sunyining/project_SentiEdge/CoC-AI-agent
pnpm build:tsc
```

Expected: no errors. If errors, fix them (likely stale imports from missed-references in Task 11 sweeps, or signature mismatches from subsystem ports).

- [ ] **Step 2: Lint + format.**

```bash
pnpm check
```

Auto-applies fixes. Expected: clean exit.

- [ ] **Step 3: Tests.**

```bash
pnpm test
```

Expected: all green. Failures to anticipate:
- Tests that hand-constructed `WorldFeature[]` for engine fixtures: update to `SubsystemRegistry`.
- Tests that called `feature.onActionCommit` directly: gone in Phase I (D6) — these tests are superseded by Task 7's fire tests where applicable. Just delete them if they no longer make sense.
- Integration tests that exercise fire ignite/extinguish via overlayFields: rewrite to use the new domain StateChange path (scene.addCondition / scene.removeCondition).

- [ ] **Step 4: Sim smoke test (optional but recommended).**

Start a real sim session (`pnpm chat` or equivalent) and observe one tick to confirm:
- Weather doesn't crash on first tick.
- Fire ignite action followed by one tick visibly shows fire in scene state.
- Movement still moves NPCs.

If this surfaces issues, fix and re-run the test suite.

- [ ] **Step 5: Stage and commit.**

```bash
git checkout -b engine-phase-i-unified-subsystem
git add -A
git status   # eyeball: only Phase I files; no stray edits
git commit -m "$(cat <<'EOF'
refactor(engine): Phase I — unified Subsystem abstraction

Collapse WorldFeature + CodeEngineSubsystem into a single Subsystem
interface with two flavors (AnchorSubsystem, ActionSubsystem). Replace
TickOrchestrator phases 0/3.5/5/6/8/9.5 with one anchor lifecycle pass
+ one unified onTick pass.

- New: src/engine/subsystem/{types,registry,weather,sun,stamina,
  itemDamage,fire,movement,conditionExpiry,actionContext}.ts
- TickOrchestrator: per-tick predicate-driven spawn/destroy of anchor
  instances; instance state lives in DGSM scopedFeatureState; legacy
  FeatureRunner / EmergentEventEmitter / sweepExpiredCharacterConditions
  removed.
- Action coupling: fire ignite/extinguish now emit domain StateChanges
  (scene.addCondition / scene.removeCondition) directly; the
  overlayFields → onActionCommit translation layer is gone.
- Deleted: worldFeature.ts, featureRunner.ts, emergentEventEmitter.ts,
  emergentScanner.ts, codeEngine/, features/.

Spec: docs/superpowers/specs/2026-05-12-engine-unified-subsystem-design.md
Plan: docs/superpowers/plans/2026-05-13-engine-unified-subsystem-plan.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Verify with `git status` (clean) and `git log -1` (commit landed).

---

## Self-Review Notes

### Spec coverage

| Spec section | Implemented by task |
|---|---|
| D1 (registry as source of truth) | Task 1 |
| D2 (anchor multi-cardinality) | Task 1 (types), Task 2 (orchestrator instance set) |
| D3 (shouldExist predicate) | Task 1 (interface), Task 2 (Phase 5) |
| D4 (state in DGSM, lifecycle by orchestrator) | Task 2 (Phase 5 spawn/destroy + initialState seeding + feature.removeState clear) |
| D5 (two flavors, shared base) | Task 1 |
| D6 (no event hooks; domain StateChanges) | Task 7 (fire + action YAML rework); also implicitly Tasks 3-6 (none of them have onActionCommit) |
| D7 (1-tick lag) | inherent to Phase 5 reading post-flush DGSM; no task needed |
| D7 (scope) | Tasks 3-9 (all in-scope subsystems); Task 11 (deletes EmergentEventEmitter) |
| D8 (phase structure) | Task 2 (adds new Phase 5/6) + Task 10 (removes old phases) |
| D9 (bootstrap from DGSM, no separate persisted active set) | Task 2 (`rehydrateAnchorInstancesFromDGSM`) |
| D10 (priority + tie-break by registration / anchor-id sort) | Task 2 (`getAnchorSubsystems` sort + `anchorIdsFor` sort) |
| D11 (TickReport unchanged, no schema change) | Task 10 (preserves TickReport shape — no edits to it) |

### Placeholder scan

The plan tells implementers to "PORT from <file>:<lines> verbatim" in several places (Tasks 3-9). This is intentional — the existing features are stable, well-tested code; line-for-line copy is the right move. The implementer has the cited source file at hand. The interface signatures + new wiring are spelled out completely; only the per-feature business logic is "see existing code".

No "TBD" / "TODO" / "add error handling" placeholders.

### Type consistency

- `Subsystem`, `AnchorSubsystem`, `ActionSubsystem`, `SubsystemBase`, `SubsystemStepResult`, `AnchorKind` — all defined in Task 1; used consistently across Tasks 2-11.
- `SubsystemRegistry` — defined Task 1; used in Tasks 2, 10.
- `movementSubsystem`, `weatherSubsystem`, `sunSubsystem`, `staminaSubsystem`, `itemDamageSubsystem`, `fireSubsystem`, `characterConditionExpirySubsystem`, `sceneConditionExpirySubsystem` — exported variable names, consistent across Tasks 3-9, 10 (registry registration), 11 (deletion of old).
- `makeActionSubsystemContext`, `getActionSubsystemDgsm` — exported from Task 8's new actionContext.ts, used in Task 10's tickOrchestrator.
- `getAllRegionIds` — added in Task 2 to FeatureReadContext, used in Task 2's `anchorIdsFor("region")`.
- `PlannedOutcome` — moved in Task 11 from `worldFeature.ts` to `core/types.ts`; importers updated in same task.

### Parallel dispatch grouping

- **Sequential**: Task 1 → Task 2 → (Tasks 3-9 parallel) → Task 10 → Task 11 → Task 12.
- **Parallel-safe** (Tasks 3-9): each creates ONLY `src/engine/subsystem/<name>.ts` + `src/engine/subsystem/__tests__/<name>.test.ts`. Task 7 additionally edits YAML files in `tool_definitions/` — disjoint from other tasks. Task 8 additionally creates `src/engine/subsystem/actionContext.ts` — only Task 8 touches it (Task 10 imports it but doesn't conflict because Task 10 runs after).
- Task 10 is the choke point — it edits tickOrchestrator + tickEngine + registerDefaults, all of which need every subsystem to exist first.
