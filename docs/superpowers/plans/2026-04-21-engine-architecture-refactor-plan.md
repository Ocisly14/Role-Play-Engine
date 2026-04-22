# TickEngine Architecture Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 805-line `tickProcessor.ts` god function with a queue-based, phase-orchestrated `TickEngine` whose subsystems (FeatureRunner, ScriptedEventRunner, Applier, EmergentEventEmitter) are independently testable and never mutate DGSM directly.

**Architecture:** Big-bang replacement. Build new `src/engine/core/*` components standalone with unit tests (Phases A–C), migrate each existing feature to the new `WorldFeature` interface (Phase D), then flip `SimulationRunner` to drive `TickEngine` and delete `tickProcessor.ts` + `impactPipeline.ts` + legacy `actionQueue.ts` + `registry.ts` (Phase E). No backwards compatibility — existing `SimulationRuntime` rows become unloadable.

**Tech Stack:** TypeScript (strict mode, ESM + `.js` imports, NodeNext), Vitest for tests, existing GameInterpreter + StateResolver reused as-is, Prisma/DGSM for state, LangChain for LLM.

**Spec reference:** `docs/superpowers/specs/2026-04-20-engine-architecture-refactor-design.md` — see §3 for rationale, §4 for TickEngine API, §5 for internal components, §6 for WorldFeature + StateChange + ScriptedEvent definitions.

---

## User preference adjustments

Per the user's standing memory:
- **No per-task commits.** All code commits happen in a single final commit (Task E6).
- **No per-task smoke tests.** Unit tests run as part of TDD per task; integration/smoke verification runs once at the end (Task E5).
- **No mid-transition compatibility.** Old `SimulationRuntime` rows will become unloadable at cutover.

Steps inside each task are therefore: (1) write failing test, (2) implement, (3) run test to verify pass. Commits and smoke runs are batched into Phase E.

---

## File structure map

```
src/engine/
├── core/                                 [NEW] All TickEngine guts
│   ├── types.ts                          [NEW] ActionStep, ActionHandle, StateChange union, SceneCondition v2, FeatureEvent, TickReport, DamageReport, InterruptReason, GameTime type alias
│   ├── featureReadContext.ts             [NEW] FeatureReadContext interface + DGSM-backed implementation
│   ├── queue.ts                          [NEW] Global DEX-sorted queue with per-actor slot mutex
│   ├── applier.ts                        [NEW] Single DGSM mutator, two-pass flush
│   ├── actionIntake.ts                   [NEW] submitAction → interpreter → queue
│   ├── featureRunner.ts                  [NEW] Priority-sorted physics feature runner
│   ├── scriptedEventRunner.ts            [NEW] Module-authored story-beat subsystem
│   ├── emergentEventEmitter.ts           [NEW] Renamed EmergentEventScanner, no LLM
│   ├── eventBus.ts                       [NEW] Streaming + batch subscription
│   ├── tickOrchestrator.ts               [NEW] 10-phase runner
│   └── tickEngine.ts                     [NEW] Top-level class, public API
├── scriptedEvents/                       [NEW]
│   ├── types.ts                          [NEW] ScriptedEvent, Effect, Condition, Progress
│   └── loader.ts                         [NEW] Build ScriptedEvent[] from module data
├── features/                             [MODIFY each]
│   ├── fireFeature.ts                    [MODIFY] Port to new WorldFeature interface
│   ├── weatherFeature.ts                 [MODIFY]
│   ├── lightingFeature.ts                [MODIFY]
│   ├── staminaFeature.ts                 [MODIFY]
│   ├── sanityFeature.ts                  [MODIFY]
│   └── eventTriggerFeature.ts            [DELETE] Replaced by ScriptedEventRunner
├── interpreter/gameInterpreter.ts        [UNCHANGED] Reused by ActionIntake
├── resolver/                             [UNCHANGED] Reused by Queue activation
│   ├── stateResolver.ts
│   └── applyStateResolution.ts           [DELETE late] Applier supersedes this
├── runtime/
│   ├── tickProcessor.ts                  [DELETE] End of Phase E
│   ├── impactPipeline.ts                 [MOVE → src/simulation/roleSim/]
│   ├── encounterScanner.ts               [KEEP] Wrapped by EmergentEventEmitter
│   ├── discoveryPipeline.ts              [KEEP or move — unaffected]
│   ├── mapMemorySync.ts                  [KEEP]
│   ├── movementTick.ts                   [KEEP] Used by resolver
│   └── resolutionExecutionContext.ts     [KEEP]
├── queue/actionQueue.ts                  [DELETE] Legacy, replaced by core/queue.ts
├── registry.ts                           [DELETE] FeatureRunner holds features now
├── registerDefaults.ts                   [MODIFY] Register features into FeatureRunner instead
└── types.ts                              [MODIFY] Remove old WorldFeature; keep unrelated types

src/state/DynamicGameState.ts             [MODIFY] Add scope-aware feature state buckets

src/simulation/
├── SimulationRunner.ts                   [MODIFY] Drive TickEngine; consume tickCompleted batch
└── roleSim/                              [NEW]
    ├── impactGateHandler.ts              [NEW] Moved from engine; LLM-driven interrupt decisions
    └── memoryEventWriter.ts              [NEW] Subscribes to actionInterrupted/actionCancelled/featureEvent, writes NpcMemory

src/planning/types.ts                    [MODIFY] Update SceneCondition to owner-tagged form; delete legacy CharacterAction; re-export new one from core
src/simulation/SimulationEventEmitter.ts [MODIFY] Adapt to thin CharacterAction; derive missing UI fields (characterName etc.) via DGSM lookup
client/src/                              [MODIFY] Wherever WebSocket events consume CharacterAction fields removed in the refactor
```

---

## Phase A — Foundation Types and Primitives

### Task A1: Core types

**Files:**
- Create: `src/engine/core/types.ts`
- Test: `src/engine/core/__tests__/types.test.ts`

All new types introduced by §4 / §6 of the spec. Types only — no runtime behavior — but a smoke test ensures the union discriminants compile.

> **Note on `CharacterAction`:** the legacy `CharacterAction` in `src/planning/types.ts` (rich planning-layer record with `impact` / `skill` / `rollDetail` / `discoveries` / `damagedEvidence` / `perTargetResults` etc.) is **replaced** by the simplified shape defined here. Downstream consumers (`SimulationEventEmitter`, UI, movement, encounter scanner, resolution-execution context) are updated in Phase E (E4 = type move, E4.5 = emitter adaptation, E3 = delete dead builders). No parallel types — new shape is canonical.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/core/__tests__/types.test.ts
import { describe, it, expect } from "vitest";
import type {
  ActionStep,
  StateChange,
  SceneCondition,
  TickReport,
  DamageReport,
  FeatureEvent,
} from "../types.js";

describe("core types", () => {
  it("StateChange union discriminates by kind", () => {
    const hp: StateChange = {
      kind: "character.hp",
      characterId: "npc1",
      delta: -3,
      sourceFeatureId: "fire",
      reason: "burn",
    };
    const setBlock: StateChange = {
      kind: "connection.setBlock",
      connectionId: "c1",
      blocked: true,
      sourceFeatureId: "weather",
      reason: "storm",
    };
    expect(hp.kind).toBe("character.hp");
    expect(setBlock.kind).toBe("connection.setBlock");
  });

  it("SceneCondition v2 carries featureId + data + mechanicalEffect", () => {
    const cond: SceneCondition = {
      featureId: "fire",
      data: { intensity: 3 },
      mechanicalEffect: { skillPenalty: { Spot: -20 }, blockConnections: false },
      description: "burning intensely",
    };
    expect(cond.featureId).toBe("fire");
  });

  it("TickReport shape carries all expected collections", () => {
    const report: TickReport = {
      tickTime: { day: 1, tickTime: "08:00" },
      commits: [],
      interruptions: [],
      cancellations: [],
      featureEvents: [],
      stateChanges: [],
      damageReports: [],
    };
    expect(report.commits).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Create the types file**

```ts
// src/engine/core/types.ts
// No imports from legacy `../types.js` or `../resolver/*` — Phase B uses its
// own PlannedOutcome (defined below) as the canonical resolver output shape.
// The legacy `StateResolution` is deprecated and does NOT appear in core types.

export type FeatureStateScope = "scene" | "region" | "character" | "global";

export interface GameTime {
  day: number;
  tickTime: string; // "HH:MM"
}

export type Unsubscribe = () => void;

/**
 * Structured character-level condition. Symmetric with SceneCondition.
 * Replaces the old `status.conditions: string[]` representation.
 */
export interface CharacterCondition {
  id: string;                              // unique per character; targeted by character.removeCondition
  featureId?: string;                      // owner feature (for observability / cleanup by featureId)
  description: string;                     // human/LLM-readable
  data?: Record<string, unknown>;          // feature-private metadata
  mechanicalEffect?: {
    skillPenalty?: Record<string, number>;
    attackPenalty?: number;
  };
  expiresAt?: GameTime;                    // optional auto-expiry (not enforced by Applier — features check)
}

export interface ActionInput {
  characterId: string;
  actionText: string;
  targetCharacterIds?: string[];
  sceneId: string;
  overlayFields?: Record<string, unknown>;
}

export interface ActionHandle {
  readonly id: string;
  readonly characterId: string;
  readonly submittedAt: GameTime;
}

export type ActionStatus =
  | "queued"
  | "active"
  | "completed"
  | "interrupted"
  | "cancelled";

export interface ActionStep {
  id: string;
  handle: ActionHandle;
  stepGroupId: string;
  stepIndex: number;

  characterId: string;
  targetCharacterIds: string[];
  actionText: string;
  definitionId: string;
  executionSceneId: string;
  overlayFields?: Record<string, unknown>;

  submittedAt: GameTime;

  activatedAt?: GameTime;
  plannedDuration?: number;
  plannedOutcome?: PlannedOutcome;
  completionTime?: GameTime;

  status: ActionStatus;
}

/**
 * Canonical result of resolving an action. Produced by the injected ResolveFn
 * at activation time, consumed by Applier at commit time.
 *
 * Replaces the deprecated `StateResolution` (`src/engine/types.ts:377`), which
 * bundled "characterChanges / itemChanges / memories / narrative" and does not
 * match today's resolver output (a `Record<string, any>` keyed by the
 * `stateChangeTypes.ts` registry).
 *
 * All mutations to game state MUST be expressed as `StateChange[]` so the
 * Applier stays the single DGSM mutator.
 */
export interface PlannedOutcome {
  /** Normalized state changes — fed directly into the tick buffer at commit. */
  stateChanges: StateChange[];
  /** In-game minutes the action takes. Drives `completionTime`. */
  elapsedMinutes: number;
  /** Optional human/LLM-readable summary (UI, memory). */
  narrative?: string;
}

export interface InterruptReason {
  triggerKind: "encounter" | "featureEvent" | "stateChange" | "other";
  description: string;
}

export interface CancelResult {
  applied: boolean;
  remainingChainCancelled: number;
}

export interface InterruptResult {
  applied: boolean;
  remainingChainCancelled: number;
  partialOutcome?: PlannedOutcome;
}

export interface SceneCondition {
  featureId?: string;
  data?: Record<string, unknown>;
  mechanicalEffect?: {
    skillPenalty?: Record<string, number>;
    blockConnections?: boolean;
  };
  description: string;
}

export type ConditionPredicate = { featureId: string };

export interface FeatureEvent {
  type: string;
  characterId?: string;
  sceneId?: string;
  data?: Record<string, unknown>;
}

export type StateChange =
  | { kind: "scene.addCondition"; sceneId: string; condition: SceneCondition }
  | {
      kind: "scene.removeCondition";
      sceneId: string;
      predicate: ConditionPredicate;
    }
  | {
      kind: "character.hp";
      characterId: string;
      delta: number;
      sourceFeatureId: string;
      reason: string;
    }
  | {
      kind: "character.san";
      characterId: string;
      delta: number;
      sourceFeatureId: string;
      reason: string;
    }
  | {
      kind: "character.fatigue";
      characterId: string;
      delta: number;
      sourceFeatureId: string;
      reason: string;
    }
  | {
      kind: "character.addCondition";
      characterId: string;
      condition: CharacterCondition;
    }
  | {
      kind: "character.removeCondition";
      characterId: string;
      conditionId: string;
    }
  | {
      kind: "connection.setBlock";
      connectionId: string;
      blocked: boolean;
      sourceFeatureId: string;
      reason: string;
    }
  | {
      kind: "feature.setState";
      featureId: string;
      key: string;
      state: unknown;
    }
  | { kind: "feature.removeState"; featureId: string; key: string }
  | { kind: "event.emit"; event: FeatureEvent };

// No CharacterSkillModifier type: skill modifiers flow through
// SceneCondition.mechanicalEffect.skillPenalty and CharacterCondition.mechanicalEffect.skillPenalty.
// Resolver / skill-check tool aggregates from ctx.getScene(sceneId).conditions +
// ctx.getCharacter(charId).status.conditions at check time. No per-feature hook.

export interface CharacterAction {
  characterId: string;
  handleId: string;
  stepGroupId: string;
  stepIndex: number;
  definitionId: string;
  actionText: string;
  sceneId: string;
  targetCharacterIds: string[];
  activatedAt: GameTime;
  completedAt: GameTime;
  outcome?: PlannedOutcome;
}

export interface DamageReport {
  characterId: string;
  field: "hp" | "san" | "fatigue";
  contributors: Array<{ featureId: string; delta: number; reason: string }>;
  finalValueAfter: number;
  died: boolean;
}

// No standalone EncounterDetection type: encounters are emitted as
// FeatureEvents with type "encounter.detected", so role sim consumes a single
// unified event channel. See B4 EmergentEventEmitter.

export interface TickReport {
  tickTime: GameTime;
  commits: CharacterAction[];
  interruptions: Array<{ action: CharacterAction; reason: InterruptReason }>;
  cancellations: CharacterAction[];
  featureEvents: FeatureEvent[];
  stateChanges: StateChange[];
  damageReports: DamageReport[];
}
```

- [ ] **Step 3: Run test**

Run: `npx vitest run src/engine/core/__tests__/types.test.ts`
Expected: PASS (3 tests green).

---

### Task A2: Scope-aware feature state buckets in DGSM

**Files:**
- Modify: `src/state/DynamicGameState.ts` — delete the legacy `state.featureState` field and its four accessor methods; add a new `state.scopedFeatureStates` bucket with four scope sub-buckets plus matching accessors; add the narrow helpers (`getAllSceneIds`, `getRegionIdForScene`, `getGameDay`/`setGameDay`, `getTickTime`/`setTickTime`, `getNpcProfile`); add `fatigue` / `maxFatigue` and restructure `conditions` on `CharacterStatus`; sweep `sanity` → `san` across the codebase
- Test: `src/state/__tests__/DynamicGameState.scopedFeatureState.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/state/__tests__/DynamicGameState.scopedFeatureState.test.ts
import { describe, it, expect } from "vitest";
import { DynamicGameStateManager } from "../DynamicGameState.js";

describe("DGSM scoped feature state", () => {
  it("stores per-scope buckets independently", () => {
    const d = new DynamicGameStateManager();
    d.setScopedFeatureState("fire", "scene", "s1", { intensity: 3 });
    d.setScopedFeatureState("weather", "region", "r1", { kind: "storm" });
    d.setScopedFeatureState("stamina", "character", "npc1", { value: 80 });
    d.setScopedFeatureState("timeOfDay", "global", "", { phase: "dawn" });

    expect(d.getScopedFeatureState("fire", "scene", "s1")).toEqual({
      intensity: 3,
    });
    expect(d.getScopedFeatureState("weather", "region", "r1")).toEqual({
      kind: "storm",
    });
    expect(d.getScopedFeatureState("stamina", "character", "npc1")).toEqual({
      value: 80,
    });
    expect(d.getScopedFeatureState("timeOfDay", "global", "")).toEqual({
      phase: "dawn",
    });
  });

  it("getAllScopedFeatureStates returns all entries for a feature in a scope", () => {
    const d = new DynamicGameStateManager();
    d.setScopedFeatureState("fire", "scene", "s1", { intensity: 1 });
    d.setScopedFeatureState("fire", "scene", "s2", { intensity: 2 });
    const all = d.getAllScopedFeatureStates("fire", "scene");
    expect(all).toHaveLength(2);
    expect(new Set(all.map((e) => e.key))).toEqual(new Set(["s1", "s2"]));
  });

  it("removeScopedFeatureState deletes one entry without touching others", () => {
    const d = new DynamicGameStateManager();
    d.setScopedFeatureState("fire", "scene", "s1", { intensity: 1 });
    d.setScopedFeatureState("fire", "scene", "s2", { intensity: 2 });
    d.removeScopedFeatureState("fire", "scene", "s1");
    expect(d.getScopedFeatureState("fire", "scene", "s1")).toBeUndefined();
    expect(d.getScopedFeatureState("fire", "scene", "s2")).toEqual({
      intensity: 2,
    });
  });
});
```

- [ ] **Step 2: Replace the legacy feature-state storage with the scoped bucket**

The new bucket is the **only** feature-state storage. No wrappers, no compat shims.

**(a) Delete the legacy storage from `DynamicGameState.ts`:**

- Delete `state.featureState` field (currently `Record<string, Record<string, unknown>>`)
- Delete method `getFeatureSceneState(featureId, sceneId)` (~lines 876–881)
- Delete method `setFeatureSceneState(featureId, sceneId, data)` (~lines 884–893)
- Delete method `getFeatureState(featureId)` (~lines 896–898)
- Delete method `removeFeatureSceneState(featureId, sceneId)` (~lines 901–906)

**(b) Add the new storage in the same place:**

On `state` (not on the class body — feature state must serialize through the existing state object so `toJSON()`/`fromJSON()` pick it up):

```ts
// In DynamicGameStateInit (or equivalent initial-state shape):
scopedFeatureStates: {
  scene: Record<string /*featureId*/, Record<string /*sceneId*/,   unknown>>;
  region: Record<string /*featureId*/, Record<string /*regionId*/, unknown>>;
  character: Record<string /*featureId*/, Record<string /*charId*/, unknown>>;
  global: Record<string /*featureId*/, Record<string /*""*/,       unknown>>;
}

// createInitialDynamicGameState():
scopedFeatureStates: { scene: {}, region: {}, character: {}, global: {} },
```

And these methods on the class (straight reads/writes, no wrapping):

```ts
setScopedFeatureState(
  featureId: string,
  scope: FeatureStateScope,
  key: string,
  data: unknown,
): void {
  const bucket = this.state.scopedFeatureStates[scope];
  if (!bucket[featureId]) bucket[featureId] = {};
  bucket[featureId][key] = data;
  this.state.lastUpdated = new Date();
}

getScopedFeatureState<T>(
  featureId: string,
  scope: FeatureStateScope,
  key: string,
): T | undefined {
  return this.state.scopedFeatureStates[scope][featureId]?.[key] as T | undefined;
}

getAllScopedFeatureStates<T>(
  featureId: string,
  scope: FeatureStateScope,
): Array<{ key: string; state: T }> {
  const bucket = this.state.scopedFeatureStates[scope][featureId] ?? {};
  return Object.entries(bucket).map(([key, state]) => ({
    key,
    state: state as T,
  }));
}

removeScopedFeatureState(
  featureId: string,
  scope: FeatureStateScope,
  key: string,
): void {
  const bucket = this.state.scopedFeatureStates[scope][featureId];
  if (!bucket) return;
  delete bucket[key];
  this.state.lastUpdated = new Date();
}
```

**(c) Callers of the deleted legacy API will fail `pnpm build:tsc` at this point.** Expected callers (grep to confirm):

- `src/engine/features/fireFeature.ts` / `weatherFeature.ts` / `lightingFeature.ts` / `staminaFeature.ts` / `sanityFeature.ts` / `eventTriggerFeature.ts` — these migrate in Phase D and will switch to StateChange output (no DGSM write)
- `src/engine/runtime/tickProcessor.ts` — deleted in E3
- any other call site — fix or delete

Per user's "batch test at end" preference, **do not** try to make `pnpm build:tsc` pass after A2 — it will be broken until Phase D/E complete. Type-check is verified at E5.

Also add these narrow helpers (no new projection types — features consume raw `DynamicScene` / `DynamicNPCProfile`):

```ts
getAllSceneIds(): string[]                         // Array.from(this.state.scenes.keys())
getRegionIdForScene(sceneId: string): string | undefined
                                                    // scenes.get(id)?.parentLocationId
getGameDay(): number
setGameDay(n: number): void
getTickTime(): string
setTickTime(s: string): void
getNpcProfile(characterId: string): DynamicNPCProfile | undefined
                                                    // existing npcCharacters lookup — add or alias
```

The existing `getScene(sceneId): DynamicScene | null` stays as-is; `getCharactersInScene(sceneId): string[]` also stays. `FeatureReadContext` wraps them (see A3).

Serialize the new bucket fields in DGSM's `toJSON()` / `fromJSON()` round-trip the same way existing fields are handled. Existing JSON rows WILL break — that is the accepted trade-off (spec §3 "Backwards Compatibility").

- [ ] **Step 3: Add `fatigue` + `maxFatigue` and restructure `conditions` on `CharacterStatus`**

Two changes to `src/state/types.ts`:

**(a)** Spec §6's `StateChange` union includes `character.fatigue { delta }`. There is no `fatigue` field on `CharacterStatus` today, so add it as first-class.

**(b)** Spec §6's `character.addCondition { condition: CharacterCondition }` and `character.removeCondition { conditionId: string }` imply structured conditions with a unique `id`. Today `CharacterStatus.conditions: string[]`. Replace with `CharacterCondition[]` (imported from the new core types).

```ts
import type { CharacterCondition } from "../engine/core/types.js";

export interface CharacterStatus {
  hp: number;
  maxHp: number;
  san: number;                       // renamed in step 4
  maxSan: number;                    // renamed in step 4
  fatigue: number;                   // NEW — 0..maxFatigue, clamped by Applier
  maxFatigue: number;                // NEW — default 100 on creation
  luck: number;
  mp?: number;
  conditions: CharacterCondition[];  // CHANGED from string[]
  notes?: string;
  damageBonus?: string;
  build?: number;
  mov?: number;
  // Relax the index signature so structured condition arrays still satisfy it:
  [key: string]: number | CharacterCondition[] | string | undefined;
}
```

Every site that **creates** a `CharacterStatus` (module loader, seed data, test fixtures) must initialize:
- `fatigue: 0`
- `maxFatigue: 100` (or whatever the game design calls for)
- `conditions: []` (was `conditions: []` already in most places — shape just changes from `string[]` to `CharacterCondition[]`)

- [ ] **Step 4: Sweep: (a) rename `sanity` → `san` and `maxSanity` → `maxSan`, (b) migrate `status.conditions` shape to structured `CharacterCondition[]`**

**(a) Identifier rename.** Spec §6 uses `character.san` as the `StateChange` kind. The existing DGSM type uses `sanity` / `maxSanity`. Unify on the short name.

Run (one at a time, review diffs before accepting):
- `rg -l "\\bsanity\\b" src/ client/`
- `rg -l "\\bmaxSanity\\b" src/ client/`

In each hit, replace `sanity` → `san` and `maxSanity` → `maxSan`. Careful with:
- Property accesses (`.sanity` → `.san`, `.maxSanity` → `.maxSan`)
- Type field declarations
- JSON serialization code (if any string literal writes `"sanity"`, update it — the DB column in `gameState` JSON blob will be `"san"` after this sweep)
- LLM prompts / i18n strings — search for "sanity" in `src/i18n/` and `client/src/i18n/` separately; these are human-facing and probably stay as the English word "Sanity". **Do not mass-replace inside strings** — only replace identifiers.

**(b) Conditions shape migration.** `status.conditions` is now `CharacterCondition[]`, not `string[]`.

Run: `rg "status\\.conditions" src/ client/`

Every read / write site needs adapting:

- **Reads** that assume `string[]`:
  - `status.conditions.includes("prone")` → `status.conditions.some(c => c.description === "prone" || c.data?.kind === "prone")` (pick a consistent convention; recommend a `type`/`kind` field in `data` or the `description` field as the matcher)
  - `status.conditions.join(", ")` → `status.conditions.map(c => c.description).join(", ")`
- **Writes** that push raw strings:
  - `status.conditions.push("bleeding")` → `status.conditions.push({ id: randomUUID(), description: "bleeding" })`
  - `status.conditions = ["grappled"]` → `status.conditions = [{ id: randomUUID(), description: "grappled" }]`

These mutations are all pre-refactor code paths; in the new world, conditions only flow through `StateChange { kind: "character.addCondition" | "character.removeCondition" }` via the Applier. So many of these call sites will be deleted entirely in Phase D/E — but until then, the sites must compile with the new type.

After the sweep:
- `CharacterStatus.san` / `CharacterStatus.maxSan` — one place defines, everywhere else uses
- `CharacterStatus.conditions: CharacterCondition[]` — one place defines
- `StateChange` kind `"character.san"` — already matches
- `DamageReport.field === "san"` — already matches
- `character.addCondition` / `character.removeCondition` StateChange — already consume `CharacterCondition` / `conditionId`

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/state/__tests__/DynamicGameState.scopedFeatureState.test.ts`
Expected: PASS (3 tests).

Also run the broader DGSM-touching test suite to catch rename regressions:

Run: `npx vitest run src/state`
Expected: PASS (some tests may fail if they encode the old field name — fix as part of Step 4).

> **Sweep note for downstream tasks (B5, B6, B7, C3, D1–D5):** earlier drafts of the plan used placeholder DGSM helpers `upsertCharacter(...)` / `getCharacterView(...)` in test fixtures. These do not exist. When writing those tests, seed NPCs with the real DGSM registration method (e.g. `registerNpcProfile(...)` or whatever the existing API calls it — grep the codebase) and read back with `getNpcProfile(id)?.status.hp` instead of `getCharacterView(id)?.hp`. Same for `.san` / `.fatigue`. The "helper" names in those test code blocks are illustrative — match the real API at implementation time.

---

### Task A3: FeatureReadContext interface + DGSM-backed implementation

**Files:**
- Create: `src/engine/core/featureReadContext.ts`
- Test: `src/engine/core/__tests__/featureReadContext.test.ts`

Read-only window features use to query state. Feature code should never touch DGSM directly — all reads go through this context. Depends on Task A2 (DGSM scope buckets + helper methods are already in place).

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/core/__tests__/featureReadContext.test.ts
import { describe, it, expect } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { makeDGSMFeatureReadContext } from "../featureReadContext.js";

describe("DGSMFeatureReadContext", () => {
  it("proxies gameDay, tickTime, tickDurationMinutes", () => {
    const dgsm = new DynamicGameStateManager();
    dgsm.setGameDay(2);
    dgsm.setTickTime("09:15");
    const ctx = makeDGSMFeatureReadContext(dgsm, { callerFeatureId: "fire" });
    expect(ctx.gameDay).toBe(2);
    expect(ctx.tickTime).toBe("09:15");
    expect(ctx.tickDurationMinutes).toBe(1);
  });

  it("getFeatureState reads from the caller's declared scope bucket", () => {
    const dgsm = new DynamicGameStateManager();
    dgsm.setScopedFeatureState("fire", "scene", "scene1", { intensity: 3 });
    const ctx = makeDGSMFeatureReadContext(dgsm, {
      callerFeatureId: "fire",
      callerScope: "scene",
    });
    expect(ctx.getFeatureState<{ intensity: number }>("scene1")).toEqual({
      intensity: 3,
    });
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/engine/core/featureReadContext.ts
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { DynamicScene, DynamicNPCProfile } from "../../state/types.js";
import type { FeatureStateScope } from "./types.js";

// No projection: features consume raw DGSM types directly. Keeps the engine
// boundary simpler (one source of truth for scene/character shape) at the cost
// of features seeing fields they won't use (personality, backstory, inventory
// detail, etc.). Acceptable trade-off per the 2026-04-21 decision.

export interface FeatureReadContext {
  readonly gameDay: number;
  readonly tickTime: string;
  readonly tickDurationMinutes: number;

  getSceneIds(): string[];
  getScene(sceneId: string): DynamicScene | undefined;
  getCharacter(characterId: string): DynamicNPCProfile | undefined;
  getCharactersInScene(sceneId: string): DynamicNPCProfile[];
  getRegionId(sceneId: string): string | undefined;

  getFeatureState<T>(key: string): T | undefined;
  getAllFeatureStates<T>(): Array<{ key: string; state: T }>;
  getOtherFeatureState<T>(featureId: string, key: string): T | undefined;
}

export interface ReadContextOptions {
  callerFeatureId: string;
  callerScope?: FeatureStateScope;
}

export function makeDGSMFeatureReadContext(
  dgsm: DynamicGameStateManager,
  opts: ReadContextOptions,
): FeatureReadContext {
  const scope = opts.callerScope ?? "scene";
  return {
    get gameDay() {
      return dgsm.getGameDay();
    },
    get tickTime() {
      return dgsm.getTickTime();
    },
    tickDurationMinutes: 1,

    getSceneIds: () => dgsm.getAllSceneIds(),
    getScene: (id) => dgsm.getScene(id) ?? undefined,
    getCharacter: (id) => dgsm.getNpcProfile(id),
    getCharactersInScene: (sceneId) =>
      dgsm
        .getCharactersInScene(sceneId)
        .map((npcId) => dgsm.getNpcProfile(npcId))
        .filter((p): p is DynamicNPCProfile => p !== undefined),
    getRegionId: (sceneId) => dgsm.getRegionIdForScene(sceneId),

    getFeatureState<T>(key: string) {
      return dgsm.getScopedFeatureState<T>(
        opts.callerFeatureId,
        scope,
        key,
      );
    },
    getAllFeatureStates<T>() {
      return dgsm.getAllScopedFeatureStates<T>(opts.callerFeatureId, scope);
    },
    getOtherFeatureState<T>(featureId: string, key: string) {
      // Caller is responsible for knowing the other feature's scope; if
      // unknown, try all scopes in priority order and return first hit.
      const scopes: FeatureStateScope[] = [
        "scene",
        "region",
        "character",
        "global",
      ];
      for (const s of scopes) {
        const v = dgsm.getScopedFeatureState<T>(featureId, s, key);
        if (v !== undefined) return v;
      }
      return undefined;
    },
  };
}
```

- [ ] **Step 3: Run test**

Run: `npx vitest run src/engine/core/__tests__/featureReadContext.test.ts`
Expected: PASS. DGSM methods (`getScopedFeatureState`, `setGameDay`, `setTickTime`, `getNpcProfile`, `getAllSceneIds`, `getRegionIdForScene`, etc.) were added in Task A2, so they're available now.

---

### Task A4: Queue

**Files:**
- Create: `src/engine/core/queue.ts`
- Test: `src/engine/core/__tests__/queue.test.ts`

Global DEX-sorted queue, per-actor slot mutex, indexed lookup by handle / group / actor. Replaces legacy `src/engine/queue/actionQueue.ts` (will be deleted in Phase E).

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/core/__tests__/queue.test.ts
import { describe, it, expect } from "vitest";
import { Queue } from "../queue.js";
import type { ActionStep } from "../types.js";

function step(partial: Partial<ActionStep> & { id: string; characterId: string }): ActionStep {
  return {
    stepGroupId: partial.stepGroupId ?? partial.id,
    stepIndex: partial.stepIndex ?? 0,
    targetCharacterIds: [],
    actionText: "",
    definitionId: "noop",
    executionSceneId: "s1",
    submittedAt: { day: 1, tickTime: "08:00" },
    status: "queued",
    handle: {
      id: partial.stepGroupId ?? partial.id,
      characterId: partial.characterId,
      submittedAt: { day: 1, tickTime: "08:00" },
    },
    ...partial,
  };
}

describe("Queue", () => {
  it("insert orders by DEX desc then submittedAt asc", () => {
    const q = new Queue();
    q.insert(step({ id: "a", characterId: "slow" }), 40);
    q.insert(step({ id: "b", characterId: "fast" }), 80);
    expect(q.snapshotAll().map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("enforces per-actor slot mutex: only one active per actor", () => {
    const q = new Queue();
    q.insert(step({ id: "a1", characterId: "npc1", stepIndex: 0, stepGroupId: "g" }), 50);
    q.insert(step({ id: "a2", characterId: "npc1", stepIndex: 1, stepGroupId: "g" }), 50);
    const next = q.nextIdleForActor("npc1");
    expect(next?.id).toBe("a1");
    q.markActive("a1");
    expect(q.nextIdleForActor("npc1")).toBeUndefined();
  });

  it("isLastStepInChain derives from queue content", () => {
    const q = new Queue();
    q.insert(step({ id: "g-0", characterId: "npc1", stepIndex: 0, stepGroupId: "g" }), 50);
    q.insert(step({ id: "g-1", characterId: "npc1", stepIndex: 1, stepGroupId: "g" }), 50);
    expect(q.isLastStepInChain("g", 0)).toBe(false);
    expect(q.isLastStepInChain("g", 1)).toBe(true);
  });

  it("cancelByHandle removes all queued + active steps for that handle", () => {
    const q = new Queue();
    q.insert(step({ id: "g-0", characterId: "npc1", stepGroupId: "g" }), 50);
    q.insert(step({ id: "g-1", characterId: "npc1", stepGroupId: "g", stepIndex: 1 }), 50);
    const removed = q.cancelByHandle("g");
    expect(removed).toBe(2);
    expect(q.snapshotAll()).toHaveLength(0);
  });

  it("getDexSnapshot returns a defensive copy of the per-actor DEX table", () => {
    const q = new Queue();
    q.insert(step({ id: "a", characterId: "slow" }), 40);
    q.insert(step({ id: "b", characterId: "fast" }), 80);
    const snap = q.getDexSnapshot();
    expect(snap.get("slow")).toBe(40);
    expect(snap.get("fast")).toBe(80);
    // Mutating the snapshot must not affect the queue's internal table.
    snap.set("slow", 999);
    expect(q.getDexSnapshot().get("slow")).toBe(40);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/engine/core/queue.ts
import type { ActionStep, ActionStatus, GameTime } from "./types.js";

export class Queue {
  private steps = new Map<string, ActionStep>();
  private dexByActor = new Map<string, number>();

  insert(step: ActionStep, actorDex: number): void {
    this.dexByActor.set(step.characterId, actorDex);
    this.steps.set(step.id, { ...step, status: step.status ?? "queued" });
  }

  get(stepId: string): ActionStep | undefined {
    return this.steps.get(stepId);
  }

  markActive(stepId: string): void {
    const s = this.steps.get(stepId);
    if (!s) return;
    s.status = "active";
  }

  markCompleted(stepId: string): void {
    const s = this.steps.get(stepId);
    if (!s) return;
    s.status = "completed";
  }

  markInterrupted(stepId: string): void {
    const s = this.steps.get(stepId);
    if (!s) return;
    s.status = "interrupted";
  }

  markCancelled(stepId: string): void {
    const s = this.steps.get(stepId);
    if (!s) return;
    s.status = "cancelled";
  }

  remove(stepId: string): void {
    this.steps.delete(stepId);
  }

  hasActiveFor(characterId: string): boolean {
    for (const s of this.steps.values()) {
      if (s.characterId === characterId && s.status === "active") return true;
    }
    return false;
  }

  /** Next queued step for actor, picking lowest stepIndex in any group they own. */
  nextIdleForActor(characterId: string): ActionStep | undefined {
    if (this.hasActiveFor(characterId)) return undefined;
    const queued = [...this.steps.values()]
      .filter((s) => s.characterId === characterId && s.status === "queued")
      .sort((a, b) => {
        if (a.submittedAt.day !== b.submittedAt.day) {
          return a.submittedAt.day - b.submittedAt.day;
        }
        if (a.submittedAt.tickTime !== b.submittedAt.tickTime) {
          return a.submittedAt.tickTime.localeCompare(b.submittedAt.tickTime);
        }
        return a.stepIndex - b.stepIndex;
      });
    return queued[0];
  }

  /** All steps ordered by DEX desc then submittedAt asc — stable view used by commit phase. */
  snapshotAll(): ActionStep[] {
    return [...this.steps.values()].sort((a, b) => {
      const dexA = this.dexByActor.get(a.characterId) ?? 0;
      const dexB = this.dexByActor.get(b.characterId) ?? 0;
      if (dexA !== dexB) return dexB - dexA;
      if (a.submittedAt.day !== b.submittedAt.day) {
        return a.submittedAt.day - b.submittedAt.day;
      }
      return a.submittedAt.tickTime.localeCompare(b.submittedAt.tickTime);
    });
  }

  activeByActor(characterId: string): ActionStep | undefined {
    for (const s of this.steps.values()) {
      if (s.characterId === characterId && s.status === "active") return s;
    }
    return undefined;
  }

  entriesByGroup(stepGroupId: string): ActionStep[] {
    return [...this.steps.values()].filter(
      (s) => s.stepGroupId === stepGroupId,
    );
  }

  isLastStepInChain(stepGroupId: string, stepIndex: number): boolean {
    return !this.entriesByGroup(stepGroupId).some(
      (s) => s.stepIndex > stepIndex && s.status !== "cancelled",
    );
  }

  cancelByHandle(handleId: string): number {
    const hits = [...this.steps.values()].filter((s) => s.handle.id === handleId);
    for (const h of hits) {
      this.steps.delete(h.id);
    }
    return hits.length;
  }

  /** For persistence / resume. */
  serialize(): ActionStep[] {
    return [...this.steps.values()];
  }

  /** Snapshot the per-actor DEX table so persistence can round-trip it. */
  getDexSnapshot(): Map<string, number> {
    return new Map(this.dexByActor);
  }

  rehydrate(steps: ActionStep[], dexByActor: Map<string, number>): void {
    this.steps.clear();
    this.dexByActor = new Map(dexByActor);
    for (const s of steps) this.steps.set(s.id, s);
  }
}
```

- [ ] **Step 3: Run test**

Run: `npx vitest run src/engine/core/__tests__/queue.test.ts`
Expected: PASS (4 tests).

---

### Task A5: Applier

**Files:**
- Create: `src/engine/core/applier.ts`
- Test: `src/engine/core/__tests__/applier.test.ts`

Single DGSM mutator. Two passes: group + flush. Handles delta summing, clamping, connection refcount, death signal.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/core/__tests__/applier.test.ts
import { describe, it, expect } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { Applier } from "../applier.js";
import type { StateChange } from "../types.js";

// Build a minimal real DynamicNPCProfile. When wiring the real test, use the
// codebase's existing NPC-seeding helpers if they exist; otherwise this inline
// factory is sufficient. The point is to exercise the Applier against a real
// DGSM instance.
function seedNpc(
  d: DynamicGameStateManager,
  id: string,
  hp = 10,
  maxHp = 10,
): void {
  d.registerNpcProfile({
    id,
    name: id,
    attributes: { STR: 50, CON: 50, DEX: 50, APP: 50, POW: 50, SIZ: 50, INT: 50, EDU: 50 },
    status: { hp, maxHp, san: 50, maxSan: 50, fatigue: 0, maxFatigue: 100, luck: 50, conditions: [] },
    inventory: [],
    skills: {},
    longTermIntent: "",
    relationships: [],
  });
}

describe("Applier", () => {
  it("sums same-character hp deltas, clamps, emits DamageReport", () => {
    const d = new DynamicGameStateManager();
    seedNpc(d, "npc1", 10);
    const applier = new Applier(d, new Map([["fire", "scene"]]));
    const changes: StateChange[] = [
      { kind: "character.hp", characterId: "npc1", delta: -4, sourceFeatureId: "fire", reason: "burn" },
      { kind: "character.hp", characterId: "npc1", delta: -8, sourceFeatureId: "fire", reason: "burn-spread" },
    ];
    const report = applier.flush(changes, { tickTime: "08:00", day: 1 });
    expect(d.getNpcProfile("npc1")?.status.hp).toBe(0); // clamped from -2
    expect(report.damageReports).toHaveLength(1);
    expect(report.damageReports[0].contributors).toHaveLength(2);
    expect(report.damageReports[0].died).toBe(true);
    expect(report.featureEvents.some((e) => e.type === "character.died")).toBe(true);
  });

  it("connection.setBlock uses refcount: two voters must both withdraw", () => {
    const d = new DynamicGameStateManager();
    d.ensureConnection("c1");
    const applier = new Applier(d, new Map());
    applier.flush(
      [
        { kind: "connection.setBlock", connectionId: "c1", blocked: true, sourceFeatureId: "fire", reason: "flames" },
        { kind: "connection.setBlock", connectionId: "c1", blocked: true, sourceFeatureId: "weather", reason: "flooded" },
      ],
      { tickTime: "08:00", day: 1 },
    );
    expect(d.isConnectionBlocked("c1")).toBe(true);

    applier.flush(
      [
        { kind: "connection.setBlock", connectionId: "c1", blocked: false, sourceFeatureId: "fire", reason: "flames" },
      ],
      { tickTime: "08:01", day: 1 },
    );
    expect(d.isConnectionBlocked("c1")).toBe(true); // weather still holds

    applier.flush(
      [
        { kind: "connection.setBlock", connectionId: "c1", blocked: false, sourceFeatureId: "weather", reason: "flooded" },
      ],
      { tickTime: "08:02", day: 1 },
    );
    expect(d.isConnectionBlocked("c1")).toBe(false);
  });

  it("feature.setState routes to correct scope bucket", () => {
    const d = new DynamicGameStateManager();
    const scopes = new Map<string, "scene" | "region" | "character" | "global">([
      ["fire", "scene"],
      ["weather", "region"],
    ]);
    const applier = new Applier(d, scopes);
    applier.flush(
      [
        { kind: "feature.setState", featureId: "fire", key: "s1", state: { intensity: 3 } },
        { kind: "feature.setState", featureId: "weather", key: "r1", state: { kind: "storm" } },
      ],
      { tickTime: "08:00", day: 1 },
    );
    expect(d.getScopedFeatureState("fire", "scene", "s1")).toEqual({ intensity: 3 });
    expect(d.getScopedFeatureState("weather", "region", "r1")).toEqual({ kind: "storm" });
  });

  it("feature.setState / removeState on same key honor emission order", () => {
    const d = new DynamicGameStateManager();
    const scopes = new Map<string, "scene" | "region" | "character" | "global">([["fire", "scene"]]);
    const applier = new Applier(d, scopes);
    // [remove, set] → final state is the `set` value
    applier.flush(
      [
        { kind: "feature.removeState", featureId: "fire", key: "s1" },
        { kind: "feature.setState", featureId: "fire", key: "s1", state: { intensity: 4 } },
      ],
      { tickTime: "08:00", day: 1 },
    );
    expect(d.getScopedFeatureState("fire", "scene", "s1")).toEqual({ intensity: 4 });

    // [set, remove] → final state is gone
    applier.flush(
      [
        { kind: "feature.setState", featureId: "fire", key: "s1", state: { intensity: 9 } },
        { kind: "feature.removeState", featureId: "fire", key: "s1" },
      ],
      { tickTime: "08:01", day: 1 },
    );
    expect(d.getScopedFeatureState("fire", "scene", "s1")).toBeUndefined();
  });

  it("scene.removeCondition + scene.addCondition respect emission order (replace-wholesale pattern)", () => {
    const d = new DynamicGameStateManager();
    d.ensureScene("s1");
    d.appendSceneCondition("s1", { featureId: "fire", description: "smoldering", data: { intensity: 1 } });
    const applier = new Applier(d, new Map());
    applier.flush(
      [
        { kind: "scene.removeCondition", sceneId: "s1", predicate: { featureId: "fire" } },
        { kind: "scene.addCondition", sceneId: "s1", condition: { featureId: "fire", description: "roaring", data: { intensity: 4 } } },
      ],
      { tickTime: "08:00", day: 1 },
    );
    const conds = d.getSceneConditions("s1");
    expect(conds).toHaveLength(1);
    expect(conds[0].description).toBe("roaring");
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/engine/core/applier.ts
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type {
  DamageReport,
  FeatureEvent,
  FeatureStateScope,
  GameTime,
  StateChange,
  TickReport,
} from "./types.js";

type ConnectionVote = { featureId: string; reason: string };

export class Applier {
  private connectionVotes = new Map<string, ConnectionVote[]>();

  constructor(
    private readonly dgsm: DynamicGameStateManager,
    /** Map featureId → declared stateScope, supplied by FeatureRunner. */
    private readonly featureScopes: ReadonlyMap<string, FeatureStateScope>,
  ) {}

  flush(
    changes: readonly StateChange[],
    tickTime: GameTime,
  ): {
    damageReports: DamageReport[];
    featureEvents: FeatureEvent[];
    stateChanges: StateChange[];
  } {
    // Pass 1 — group the order-independent kinds only.
    // Order-dependent kinds (scene/character condition add/remove, feature.setState/removeState)
    // are NOT bucketed here; pass 2 replays the original changes array for them so
    // emission order is preserved (spec §5: "apply ... in order").
    const hpBuckets = new Map<string, Array<{ featureId: string; delta: number; reason: string }>>();
    const sanBuckets = new Map<string, Array<{ featureId: string; delta: number; reason: string }>>();
    const fatigueBuckets = new Map<string, Array<{ featureId: string; delta: number; reason: string }>>();
    const setBlockVotes: Array<{ connectionId: string; blocked: boolean; featureId: string; reason: string }> = [];
    const featureEmissions: FeatureEvent[] = [];

    for (const c of changes) {
      switch (c.kind) {
        case "character.hp":
          this.bucketPush(hpBuckets, c.characterId, c);
          break;
        case "character.san":
          this.bucketPush(sanBuckets, c.characterId, c);
          break;
        case "character.fatigue":
          this.bucketPush(fatigueBuckets, c.characterId, c);
          break;
        case "connection.setBlock":
          setBlockVotes.push(c);
          break;
        case "event.emit":
          featureEmissions.push(c.event);
          break;
        // scene.addCondition / scene.removeCondition / character.addCondition /
        // character.removeCondition / feature.setState / feature.removeState —
        // handled in pass 2 in emission order.
        default:
          break;
      }
    }

    // Pass 2 — flush.
    // (a) Numerical deltas and refcount votes are order-independent — apply first.
    const damageReports: DamageReport[] = [];

    for (const [charId, contribs] of hpBuckets) {
      const report = this.applyDelta(charId, "hp", contribs);
      if (report) damageReports.push(report);
    }
    for (const [charId, contribs] of sanBuckets) {
      const report = this.applyDelta(charId, "san", contribs);
      if (report) damageReports.push(report);
    }
    for (const [charId, contribs] of fatigueBuckets) {
      const report = this.applyDelta(charId, "fatigue", contribs);
      if (report) damageReports.push(report);
    }
    for (const vote of setBlockVotes) {
      this.applySetBlockVote(vote);
    }

    // (b) Order-dependent mutations: replay the original changes array once.
    // Same-key set/remove pairs now respect the feature author's emission order.
    for (const c of changes) {
      switch (c.kind) {
        case "scene.addCondition":
          this.dgsm.appendSceneCondition(c.sceneId, c.condition);
          break;
        case "scene.removeCondition":
          this.dgsm.removeSceneConditionsByFeatureId(c.sceneId, c.predicate.featureId);
          break;
        case "character.addCondition":
          this.dgsm.addCharacterCondition(c.characterId, c.condition);
          break;
        case "character.removeCondition":
          this.dgsm.removeCharacterCondition(c.characterId, c.conditionId);
          break;
        case "feature.setState": {
          const scope = this.featureScopes.get(c.featureId) ?? "scene";
          this.dgsm.setScopedFeatureState(c.featureId, scope, c.key, c.state);
          break;
        }
        case "feature.removeState": {
          const scope = this.featureScopes.get(c.featureId) ?? "scene";
          this.dgsm.removeScopedFeatureState(c.featureId, scope, c.key);
          break;
        }
        // character.hp / .san / .fatigue / connection.setBlock / event.emit — already applied in (a).
        default:
          break;
      }
    }

    const synthesizedDeaths: FeatureEvent[] = damageReports
      .filter((r) => r.died)
      .map((r) => ({ type: "character.died", characterId: r.characterId }));

    return {
      damageReports,
      featureEvents: [...featureEmissions, ...synthesizedDeaths],
      stateChanges: [...changes],
    };
  }

  private bucketPush<T extends { characterId: string; delta: number; sourceFeatureId: string; reason: string }>(
    buckets: Map<string, Array<{ featureId: string; delta: number; reason: string }>>,
    id: string,
    c: T,
  ): void {
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id)!.push({ featureId: c.sourceFeatureId, delta: c.delta, reason: c.reason });
  }

  private applyDelta(
    characterId: string,
    field: "hp" | "san" | "fatigue",
    contribs: Array<{ featureId: string; delta: number; reason: string }>,
  ): DamageReport | null {
    const profile = this.dgsm.getNpcProfile(characterId);
    if (!profile) return null;
    const status = profile.status;
    const before = status[field];
    const sum = contribs.reduce((acc, c) => acc + c.delta, 0);
    const max =
      field === "hp"
        ? status.maxHp
        : field === "san"
          ? status.maxSan
          : status.maxFatigue;
    const after = Math.max(0, Math.min(max, before + sum));

    this.dgsm.setCharacterField(characterId, field, after);

    const died = field === "hp" && before > 0 && after === 0;
    if (died) this.dgsm.markCharacterDead(characterId);

    return {
      characterId,
      field,
      contributors: contribs,
      finalValueAfter: after,
      died,
    };
  }

  private applySetBlockVote(vote: {
    connectionId: string;
    blocked: boolean;
    featureId: string;
    reason: string;
  }): void {
    if (!this.connectionVotes.has(vote.connectionId)) {
      this.connectionVotes.set(vote.connectionId, []);
    }
    const votes = this.connectionVotes.get(vote.connectionId)!;
    const existingIdx = votes.findIndex(
      (v) => v.featureId === vote.featureId && v.reason === vote.reason,
    );
    if (vote.blocked) {
      if (existingIdx === -1) {
        votes.push({ featureId: vote.featureId, reason: vote.reason });
      }
    } else if (existingIdx !== -1) {
      votes.splice(existingIdx, 1);
    }
    this.dgsm.setConnectionBlocked(vote.connectionId, votes.length > 0);
  }

  /** Serialize the refcount table (for persistence). */
  serializeConnectionVotes(): Record<string, ConnectionVote[]> {
    const out: Record<string, ConnectionVote[]> = {};
    for (const [k, v] of this.connectionVotes) out[k] = [...v];
    return out;
  }

  rehydrateConnectionVotes(data: Record<string, ConnectionVote[]>): void {
    this.connectionVotes = new Map(Object.entries(data));
  }
}
```

Adjust DGSM to add the methods the Applier relies on (`setCharacterField`, `markCharacterDead`, `upsertCharacter`, `ensureConnection`, `removeSceneConditionsByFeatureId`, `addCharacterCondition`, `removeCharacterCondition`, `setConnectionBlocked`, `isConnectionBlocked`) — most already exist; add the missing ones as thin wrappers.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/engine/core/__tests__/applier.test.ts`
Expected: PASS (3 tests).

---

## Phase B — TickEngine Core

> **⚠ Execution order note:** Run **Phase C (ScriptedEventRunner) BEFORE Phase B**. Tasks B5 (TickOrchestrator) and B6 (TickEngine) import `ScriptedEventRunner` from `src/engine/core/scriptedEventRunner.ts`, which is created in Phase C Task C3. Phase C depends only on Phase A (verified: C1 → A1+A3, C2 → C1, C3 → A1+A3+C1). Physical ordering of this document keeps Phase B before Phase C for reading continuity of the "engine core" narrative, but dependency-correct execution is **A → C → B → D → E**.


### Task B1: FeatureRunner

**Files:**
- Create: `src/engine/core/featureRunner.ts`
- Test: `src/engine/core/__tests__/featureRunner.test.ts`

Holds the new-style features in priority-sorted order. Methods: `runTick`, `runActionCommit`, `runPropagation`, `getFeatureScopeMap`.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/core/__tests__/featureRunner.test.ts
import { describe, it, expect } from "vitest";
import { FeatureRunner } from "../featureRunner.js";
import type { WorldFeature } from "../worldFeature.js";
import type { FeatureReadContext } from "../featureReadContext.js";

const lowPrio: WorldFeature = {
  id: "lo", description: "", stateScope: "global",
  affectedKinds: ["character.hp"], effectSummary: "", priority: 400,
  onTick: () => [{ kind: "character.hp", characterId: "x", delta: -1, sourceFeatureId: "lo", reason: "lo" }],
};
const highPrio: WorldFeature = {
  id: "hi", description: "", stateScope: "global",
  affectedKinds: ["character.hp"], effectSummary: "", priority: 100,
  onTick: () => [{ kind: "character.hp", characterId: "x", delta: -2, sourceFeatureId: "hi", reason: "hi" }],
};
const noTick: WorldFeature = {
  id: "noop", description: "", stateScope: "global",
  affectedKinds: [], effectSummary: "",
};

const fakeCtx = {} as FeatureReadContext;

describe("FeatureRunner", () => {
  it("runs features in priority order (low-number first) and concatenates StateChanges", () => {
    const runner = new FeatureRunner([lowPrio, noTick, highPrio]);
    const changes = runner.runTick(fakeCtx);
    expect(changes.map((c) => (c.kind === "character.hp" ? c.sourceFeatureId : ""))).toEqual(["hi", "lo"]);
  });

  it("getFeatureScopeMap returns featureId → stateScope", () => {
    const runner = new FeatureRunner([lowPrio, highPrio]);
    expect(runner.getFeatureScopeMap().get("lo")).toBe("global");
    expect(runner.getFeatureScopeMap().get("hi")).toBe("global");
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/engine/core/worldFeature.ts
import type { FeatureReadContext } from "./featureReadContext.js";
import type {
  ActionStep,
  FeatureStateScope,
  PlannedOutcome,
  StateChange,
} from "./types.js";

// Skill modifiers flow through SceneCondition / CharacterCondition
// (mechanicalEffect.skillPenalty), NOT through a per-feature hook. Features
// that want to debuff a skill emit `scene.addCondition` / `character.addCondition`
// StateChanges with the mechanicalEffect filled in. The resolver aggregates
// at skill-check time by reading ctx.getScene / ctx.getCharacter conditions.

export interface WorldFeature {
  readonly id: string;
  readonly description: string;
  readonly stateScope: FeatureStateScope;
  readonly affectedKinds: ReadonlyArray<StateChange["kind"]>;
  readonly effectSummary: string;
  readonly impactRange?: Partial<Record<StateChange["kind"], readonly [number, number]>>;
  readonly priority?: number;
  readonly propagation?: { tickInterval: number; maxHops: number };
  readonly planningPrompt?: string;
  readonly planNodeSchema?: unknown;

  stateDescription?(ctx: FeatureReadContext): string;
  onTick?(ctx: FeatureReadContext): StateChange[];
  onActionCommit?(
    step: ActionStep,
    outcome: PlannedOutcome,
    ctx: FeatureReadContext,
    opts?: { interrupted?: boolean },
  ): StateChange[];
  onPropagate?(
    source: { sceneId: string; hop: number },
    ctx: FeatureReadContext,
  ): { spreadToSceneIds: string[]; changes: StateChange[] };
}
```

```ts
// src/engine/core/featureRunner.ts
import type { FeatureReadContext } from "./featureReadContext.js";
import type { WorldFeature } from "./worldFeature.js";
import type {
  ActionStep,
  FeatureStateScope,
  PlannedOutcome,
  StateChange,
} from "./types.js";

const DEFAULT_PRIORITY = 999;

export class FeatureRunner {
  private readonly ordered: WorldFeature[];
  private readonly propagationTickCounter = new Map<string, number>();

  constructor(features: WorldFeature[]) {
    this.ordered = [...features].sort((a, b) => {
      const pa = a.priority ?? DEFAULT_PRIORITY;
      const pb = b.priority ?? DEFAULT_PRIORITY;
      return pa - pb;
    });
  }

  runTick(ctx: FeatureReadContext): StateChange[] {
    const out: StateChange[] = [];
    for (const f of this.ordered) {
      if (f.onTick) out.push(...f.onTick(ctx));
    }
    return out;
  }

  runActionCommit(
    step: ActionStep,
    outcome: PlannedOutcome,
    ctx: FeatureReadContext,
    opts?: { interrupted?: boolean },
  ): StateChange[] {
    const out: StateChange[] = [];
    for (const f of this.ordered) {
      if (f.onActionCommit) out.push(...f.onActionCommit(step, outcome, ctx, opts));
    }
    return out;
  }

  runPropagation(ctx: FeatureReadContext): StateChange[] {
    const out: StateChange[] = [];
    for (const f of this.ordered) {
      if (!f.propagation || !f.onPropagate) continue;
      const nextCount = (this.propagationTickCounter.get(f.id) ?? 0) + 1;
      this.propagationTickCounter.set(f.id, nextCount);
      if (nextCount % f.propagation.tickInterval !== 0) continue;
      // Default: propagate from every scene holding state for this feature;
      // FeatureRunner walks scenes and lets the feature decide spread targets.
      for (const sceneId of ctx.getSceneIds()) {
        const { changes } = f.onPropagate({ sceneId, hop: 0 }, ctx);
        out.push(...changes);
      }
    }
    return out;
  }

  getFeatureScopeMap(): Map<string, FeatureStateScope> {
    const out = new Map<string, FeatureStateScope>();
    for (const f of this.ordered) out.set(f.id, f.stateScope);
    return out;
  }

  listFeatures(): ReadonlyArray<WorldFeature> {
    return this.ordered;
  }
}
```

- [ ] **Step 3: Run test**

Run: `npx vitest run src/engine/core/__tests__/featureRunner.test.ts`
Expected: PASS.

---

### Task B2: EventBus

**Files:**
- Create: `src/engine/core/eventBus.ts`
- Test: `src/engine/core/__tests__/eventBus.test.ts`

Backs `TickEngine.on(...)`. Typed channels: `actionCompleted`, `actionInterrupted`, `actionCancelled`, `featureEvent`, `tickCompleted`. The last one is awaitable so SimulationRunner can apply backpressure.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/core/__tests__/eventBus.test.ts
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../eventBus.js";
import type { CharacterAction, TickReport } from "../types.js";

describe("EventBus", () => {
  it("emits streaming events to all subscribers", () => {
    const bus = new EventBus();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    bus.on("actionCompleted", cb1);
    bus.on("actionCompleted", cb2);
    const action = { characterId: "npc1" } as CharacterAction;
    bus.emitActionCompleted(action);
    expect(cb1).toHaveBeenCalledWith(action);
    expect(cb2).toHaveBeenCalledWith(action);
  });

  it("awaits async tickCompleted handlers", async () => {
    const bus = new EventBus();
    let resolved = false;
    bus.on("tickCompleted", async () => {
      await new Promise((r) => setTimeout(r, 5));
      resolved = true;
    });
    await bus.emitTickCompleted({} as TickReport);
    expect(resolved).toBe(true);
  });

  it("unsubscribe removes the listener", () => {
    const bus = new EventBus();
    const cb = vi.fn();
    const off = bus.on("featureEvent", cb);
    off();
    bus.emitFeatureEvent({ type: "x" });
    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/engine/core/eventBus.ts
import type {
  CharacterAction,
  FeatureEvent,
  InterruptReason,
  TickReport,
  Unsubscribe,
} from "./types.js";

type AnyCB = (...a: unknown[]) => unknown | Promise<unknown>;

export class EventBus {
  private listeners: Record<string, Set<AnyCB>> = {};

  on(ev: "actionCompleted", cb: (a: CharacterAction) => void): Unsubscribe;
  on(ev: "actionInterrupted", cb: (a: CharacterAction, r: InterruptReason) => void): Unsubscribe;
  on(ev: "actionCancelled", cb: (a: CharacterAction) => void): Unsubscribe;
  on(ev: "featureEvent", cb: (e: FeatureEvent) => void): Unsubscribe;
  on(ev: "tickCompleted", cb: (r: TickReport) => Promise<void> | void): Unsubscribe;
  on(ev: string, cb: AnyCB): Unsubscribe {
    if (!this.listeners[ev]) this.listeners[ev] = new Set();
    this.listeners[ev].add(cb);
    return () => this.listeners[ev]?.delete(cb);
  }

  /** Snapshot-and-iterate so listeners can safely subscribe / unsubscribe
   *  inside their own callback. New subscriptions take effect on the NEXT
   *  emit; unsubscribes during the current emit still see the rest of the
   *  snapshot list invoked. (Same guarantee as Node's EventEmitter.) */
  private snapshotListeners(channel: string): AnyCB[] {
    return [...(this.listeners[channel] ?? [])];
  }

  emitActionCompleted(a: CharacterAction): void {
    for (const cb of this.snapshotListeners("actionCompleted")) cb(a);
  }
  emitActionInterrupted(a: CharacterAction, r: InterruptReason): void {
    for (const cb of this.snapshotListeners("actionInterrupted")) cb(a, r);
  }
  emitActionCancelled(a: CharacterAction): void {
    for (const cb of this.snapshotListeners("actionCancelled")) cb(a);
  }
  emitFeatureEvent(e: FeatureEvent): void {
    for (const cb of this.snapshotListeners("featureEvent")) cb(e);
  }
  async emitTickCompleted(r: TickReport): Promise<void> {
    for (const cb of this.snapshotListeners("tickCompleted")) await cb(r);
  }
}
```

- [ ] **Step 3: Run test**

Run: `npx vitest run src/engine/core/__tests__/eventBus.test.ts`
Expected: PASS.

---

### Task B3: ActionIntake

**Files:**
- Create: `src/engine/core/actionIntake.ts`
- Test: `src/engine/core/__tests__/actionIntake.test.ts`

Runs `GameInterpreter` at submit time, expands into N `ActionStep`s with shared `stepGroupId`, returns one `ActionHandle`.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/core/__tests__/actionIntake.test.ts
import { describe, it, expect, vi } from "vitest";
import { ActionIntake } from "../actionIntake.js";
import { Queue } from "../queue.js";
import type { InterpretedStep } from "../../types.js";

const fakeInterpret = vi.fn<
  [unknown],
  Promise<{ steps: InterpretedStep[] }>
>();

describe("ActionIntake", () => {
  it("expands interpreter output into ActionSteps sharing stepGroupId", async () => {
    const queue = new Queue();
    fakeInterpret.mockResolvedValueOnce({
      steps: [
        { definitionId: "walk", actionText: "walk to bar" } as InterpretedStep,
        { definitionId: "order", actionText: "order whisky" } as InterpretedStep,
      ],
    });
    const intake = new ActionIntake({
      queue,
      interpretAction: fakeInterpret,
      getActorDex: () => 60,
      getNow: () => ({ day: 1, tickTime: "08:00" }),
    });
    const handle = await intake.submit({
      characterId: "npc1",
      actionText: "go to bar and order whisky",
      sceneId: "s1",
    });
    const steps = queue.snapshotAll();
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.stepGroupId === handle.id)).toBe(true);
    expect(steps.map((s) => s.stepIndex).sort()).toEqual([0, 1]);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/engine/core/actionIntake.ts
import { randomUUID } from "node:crypto";
import type { Queue } from "./queue.js";
import type { ActionHandle, ActionInput, ActionStep, GameTime } from "./types.js";
import type { InterpretedStep } from "../types.js";

export interface ActionIntakeDeps {
  queue: Queue;
  interpretAction: (input: ActionInput) => Promise<{ steps: InterpretedStep[] }>;
  getActorDex: (characterId: string) => number;
  getNow: () => GameTime;
}

export class ActionIntake {
  constructor(private deps: ActionIntakeDeps) {}

  async submit(input: ActionInput): Promise<ActionHandle> {
    const submittedAt = this.deps.getNow();
    const handleId = randomUUID();
    const handle: ActionHandle = {
      id: handleId,
      characterId: input.characterId,
      submittedAt,
    };
    const { steps } = await this.deps.interpretAction(input);
    const dex = this.deps.getActorDex(input.characterId);

    steps.forEach((s, i) => {
      const step: ActionStep = {
        id: `${handleId}#${i}`,
        handle,
        stepGroupId: handleId,
        stepIndex: i,
        characterId: input.characterId,
        targetCharacterIds: input.targetCharacterIds ?? [],
        actionText: s.actionText ?? input.actionText,
        definitionId: s.definitionId,
        executionSceneId: input.sceneId,
        overlayFields: input.overlayFields,
        submittedAt,
        status: "queued",
      };
      this.deps.queue.insert(step, dex);
    });

    return handle;
  }
}
```

- [ ] **Step 3: Run test**

Run: `npx vitest run src/engine/core/__tests__/actionIntake.test.ts`
Expected: PASS.

---

### Task B4: EmergentEventEmitter (scanner aggregator)

**Files:**
- Create: `src/engine/core/emergentScanner.ts` — `EmergentScanner` interface + `ScannerContext` interface
- Create: `src/engine/core/emergentEventEmitter.ts` — aggregator class
- Create: `src/engine/core/scanners/encounterScanner.ts` — `EncounterScanner` class wrapping the existing runtime scanner
- Modify: `src/engine/runtime/encounterScanner.ts` — rewrite `scanUnplannedEncounters(...)` to return `Array<{ event: FeatureEvent; signature: string }>` (drops the legacy fake `CharacterAction[]` with `characterId: "__encounter__"`)
- Test: `src/engine/core/__tests__/emergentEventEmitter.test.ts`

**Design intent (spec §2 "Scan phase" + §5 EmergentEventEmitter):** This is the aggregation point for **all non-feature deterministic emergent detection** (encounters, discoveries, world-event triggers, future scanners). Currently only the encounter scanner plugs in; the aggregator shape is deliberate so future scanners (e.g., `discoveryPipeline`, `mapMemorySync`, world-event triggers) can register without touching TickOrchestrator.

Encounters are emitted as `FeatureEvent { type: "encounter.detected", sceneId, data: { observedNpcIds, description } }` so role sim's impact gate consumes a single unified event channel. No LLM, no impact gate.

- [ ] **Step 1: Define `EmergentScanner` + `ScannerContext`**

Create `src/engine/core/emergentScanner.ts`:

```ts
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterAction, FeatureEvent, GameTime } from "./types.js";

/** Per-tick context handed to every scanner. Scanners keep their own per-scanner
 *  state (e.g., dedup caches, previous-signature sets) as instance fields. */
export interface ScannerContext {
  dgsm: DynamicGameStateManager;
  tickTime: GameTime;
  committedActionsThisTick: readonly CharacterAction[];
  lang: string;
}

/** Engine-internal passive observer. Runs in TickOrchestrator's Scan phase
 *  (phase 8) — after feature ticks, propagation, and scripted events, before
 *  Applier flush. Scanners must not mutate DGSM; they only produce events. */
export interface EmergentScanner {
  readonly id: string;
  scan(ctx: ScannerContext): FeatureEvent[];
}
```

- [ ] **Step 2: Rewrite `src/engine/runtime/encounterScanner.ts`**

The existing scanner returns legacy `CharacterAction[]` shaped objects with fields (`characterName`, `action`, `impact`, `outcome`, `type`) that don't exist after the P0-1 simplification. Keep its detection logic (co-presence, hidden-character reveal, dedup via `shouldEmitEncounter`) and change only the output shape.

New signature:

```ts
export function scanUnplannedEncounters(params: {
  dgsm: DynamicGameStateManager;
  tickTime: string;
  movedNpcIds: ReadonlySet<string>;
  previousEncounterSignatures: ReadonlySet<string>;
  lang: string;
}): Array<{ event: FeatureEvent; signature: string }>;
```

Returns `{ event, signature }` pairs so the wrapper class can update its dedup set. Each event has shape:

```ts
{
  type: "encounter.detected",
  sceneId: locationId,
  data: {
    observedNpcIds: [...allNpcIds],
    description: t("npcs_are_at", lang, { names: allNpcNames.join(", "), scene: sceneName }),
  },
}
```

`signature` is the dedup key computed via the existing `shouldEmitEncounter` logic (typically `sortedNpcIds.join("|") + "@" + locationId`).

Delete `personalizeEncounterForNpc` if it's only used by the legacy CharacterAction path — confirm via grep; if role sim needs per-NPC personalization, it can filter the single `featureEvent` stream itself.

- [ ] **Step 3: Write the `EncounterScanner` wrapper class**

Create `src/engine/core/scanners/encounterScanner.ts`:

```ts
import type { EmergentScanner, ScannerContext } from "../emergentScanner.js";
import type { FeatureEvent } from "../types.js";
import { scanUnplannedEncounters } from "../../runtime/encounterScanner.js";

export class EncounterScanner implements EmergentScanner {
  readonly id = "encounter";
  private previousSignatures: Set<string> = new Set();

  scan(ctx: ScannerContext): FeatureEvent[] {
    const movedNpcIds = new Set<string>(
      ctx.committedActionsThisTick
        .filter((a) => a.definitionId === "movement" || a.definitionId.startsWith("movement."))
        .map((a) => a.characterId),
    );

    const results = scanUnplannedEncounters({
      dgsm: ctx.dgsm,
      tickTime: ctx.tickTime.tickTime,
      movedNpcIds,
      previousEncounterSignatures: this.previousSignatures,
      lang: ctx.lang,
    });

    this.previousSignatures = new Set(results.map((r) => r.signature));
    return results.map((r) => r.event);
  }
}
```

- [ ] **Step 4: Write the aggregator**

Create `src/engine/core/emergentEventEmitter.ts`:

```ts
import type { EmergentScanner, ScannerContext } from "./emergentScanner.js";
import type { FeatureEvent } from "./types.js";

export class EmergentEventEmitter {
  private readonly scanners: EmergentScanner[] = [];

  constructor(scanners: EmergentScanner[] = []) {
    for (const s of scanners) this.register(s);
  }

  register(scanner: EmergentScanner): void {
    this.scanners.push(scanner);
  }

  scan(ctx: ScannerContext): { featureEvents: FeatureEvent[] } {
    const featureEvents: FeatureEvent[] = [];
    for (const s of this.scanners) {
      featureEvents.push(...s.scan(ctx));
    }
    return { featureEvents };
  }

  listScannerIds(): readonly string[] {
    return this.scanners.map((s) => s.id);
  }
}
```

- [ ] **Step 5: Test**

```ts
// src/engine/core/__tests__/emergentEventEmitter.test.ts
import { describe, it, expect } from "vitest";
import { EmergentEventEmitter } from "../emergentEventEmitter.js";
import type { EmergentScanner, ScannerContext } from "../emergentScanner.js";
import type { FeatureEvent } from "../types.js";

class FakeScanner implements EmergentScanner {
  constructor(readonly id: string, private events: FeatureEvent[]) {}
  scan(): FeatureEvent[] {
    return this.events;
  }
}

const fakeCtx = {} as ScannerContext;

describe("EmergentEventEmitter", () => {
  it("concatenates events from all registered scanners in registration order", () => {
    const emitter = new EmergentEventEmitter([
      new FakeScanner("a", [{ type: "a.evt" }]),
      new FakeScanner("b", [{ type: "b.evt1" }, { type: "b.evt2" }]),
    ]);
    const { featureEvents } = emitter.scan(fakeCtx);
    expect(featureEvents.map((e) => e.type)).toEqual(["a.evt", "b.evt1", "b.evt2"]);
  });

  it("register() adds scanners after construction", () => {
    const emitter = new EmergentEventEmitter();
    emitter.register(new FakeScanner("late", [{ type: "late.evt" }]));
    const { featureEvents } = emitter.scan(fakeCtx);
    expect(featureEvents).toHaveLength(1);
    expect(emitter.listScannerIds()).toEqual(["late"]);
  });
});
```

Run: `npx vitest run src/engine/core/__tests__/emergentEventEmitter.test.ts`
Expected: 2 PASS.

---

### Task B5: TickOrchestrator

**Files:**
- Create: `src/engine/core/tickOrchestrator.ts`
- Test: `src/engine/core/__tests__/tickOrchestrator.test.ts`

10 phases per tick (spec §5 "TickOrchestrator"). Accumulates `StateChange[]` into a tick buffer; only `applier.flush()` touches DGSM. Resolver called at activation, not at submit.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/core/__tests__/tickOrchestrator.test.ts
import { describe, it, expect, vi } from "vitest";
import { TickOrchestrator } from "../tickOrchestrator.js";
import { Queue } from "../queue.js";
import { Applier } from "../applier.js";
import { FeatureRunner } from "../featureRunner.js";
import { EmergentEventEmitter } from "../emergentEventEmitter.js";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { WorldFeature } from "../worldFeature.js";

describe("TickOrchestrator", () => {
  it("runs phases in order and produces a TickReport", async () => {
    const dgsm = new DynamicGameStateManager();
    dgsm.registerNpcProfile({
      id: "npc1",
      name: "npc1",
      attributes: { STR: 50, CON: 50, DEX: 50, APP: 50, POW: 50, SIZ: 50, INT: 50, EDU: 50 },
      status: { hp: 10, maxHp: 10, san: 50, maxSan: 50, fatigue: 0, maxFatigue: 100, luck: 50, conditions: [] },
      inventory: [],
      skills: {},
      longTermIntent: "",
      relationships: [],
    });

    const queue = new Queue();
    const feature: WorldFeature = {
      id: "fire",
      description: "",
      stateScope: "scene",
      affectedKinds: ["character.hp"],
      effectSummary: "",
      onTick: () => [{ kind: "character.hp", characterId: "npc1", delta: -1, sourceFeatureId: "fire", reason: "burn" }],
    };
    const featureRunner = new FeatureRunner([feature]);
    const applier = new Applier(dgsm, featureRunner.getFeatureScopeMap());
    const scriptedRunner = { run: vi.fn().mockReturnValue([]) };
    const emitter = new EmergentEventEmitter();  // no scanners registered for this test

    const orch = new TickOrchestrator({
      dgsm,
      queue,
      featureRunner,
      scriptedEventRunner: scriptedRunner as never,
      emergentEventEmitter: emitter,
      applier,
      resolve: vi.fn(),
      tickDurationMinutes: 1,
      lang: "en",
    });

    const report = await orch.tick();
    expect(dgsm.getNpcProfile("npc1")!.status.hp).toBe(9);
    expect(report.damageReports).toHaveLength(1);
    expect(report.damageReports[0].finalValueAfter).toBe(9);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/engine/core/tickOrchestrator.ts
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { Queue } from "./queue.js";
import type { Applier } from "./applier.js";
import type { FeatureRunner } from "./featureRunner.js";
import type { ScriptedEventRunner } from "./scriptedEventRunner.js";
import type { EmergentEventEmitter } from "./emergentEventEmitter.js";
import type {
  ActionStep,
  CharacterAction,
  FeatureStateScope,
  GameTime,
  InterruptReason,
  PlannedOutcome,
  StateChange,
  TickReport,
} from "./types.js";
import { makeDGSMFeatureReadContext } from "./featureReadContext.js";

export interface PendingInterrupt {
  handleId: string;
  reason: InterruptReason;
  activeStepId: string;  // must exist; queued-only interrupts are handled as cancel sync
}

export interface ResolveFn {
  (step: ActionStep, ctx: unknown): Promise<{
    outcome: PlannedOutcome;
    plannedDuration: number;
  }>;
}

export interface OrchestratorDeps {
  dgsm: DynamicGameStateManager;
  queue: Queue;
  featureRunner: FeatureRunner;
  scriptedEventRunner: ScriptedEventRunner;
  emergentEventEmitter: EmergentEventEmitter;
  applier: Applier;
  resolve: ResolveFn;
  tickDurationMinutes: number;
  lang: string;                  // passed through to ScannerContext
}

export class TickOrchestrator {
  // Pending interrupt requests — only store "active step needs C-compromise" work.
  // Queued-sibling cancels and full-chain cancels are applied synchronously by
  // TickEngine.cancelAction / interruptAction (see Option Y decision).
  private pendingInterrupts: PendingInterrupt[] = [];
  // Sync-cancelled ActionSteps waiting to be surfaced as CharacterAction events.
  // TickEngine.cancelAction pushes here at call time; orchestrator drains into
  // TickReport.cancellations at the start of the next tick.
  private pendingCancelledSteps: ActionStep[] = [];

  constructor(private deps: OrchestratorDeps) {}

  /** Called by TickEngine.interruptAction when the active step needs C-compromise
   *  resolution next tick. Queued siblings are cancelled synchronously by the caller;
   *  this only queues the one active-step entry. */
  queuePendingInterrupt(req: PendingInterrupt): void {
    this.pendingInterrupts.push(req);
  }

  /** Called by TickEngine.cancelAction (or interruptAction on a queued-only handle)
   *  after marking the step cancelled in the queue. The orchestrator surfaces it as
   *  a CharacterAction in the next tick's TickReport.cancellations. */
  recordCancelledStep(step: ActionStep): void {
    this.pendingCancelledSteps.push(step);
  }

  async tick(): Promise<TickReport> {
    const { dgsm, queue, featureRunner, scriptedEventRunner, emergentEventEmitter, applier, resolve } = this.deps;

    // Phase 1: advance clock
    const nextTickTime = this.advanceClock();

    const buffer: StateChange[] = [];
    const interruptions: TickReport["interruptions"] = [];
    const cancellations: CharacterAction[] = [];
    const commitsThisTick: CharacterAction[] = [];

    // Phase 2a: surface sync-cancelled steps into TickReport.cancellations
    for (const step of this.pendingCancelledSteps) {
      cancellations.push(this.stepToAction(step, nextTickTime));
    }
    this.pendingCancelledSteps = [];

    // Phase 2b: apply deferred interrupts (active-step C-compromise)
    for (const pend of this.pendingInterrupts) {
      this.applyPendingInterrupt(pend, nextTickTime, buffer, interruptions);
    }
    this.pendingInterrupts = [];

    // Phase 3: activate idle actors
    const actorIds = this.getIdleActorIds();
    for (const actorId of actorIds) {
      const next = queue.nextIdleForActor(actorId);
      if (!next) continue;
      const readCtx = makeDGSMFeatureReadContext(dgsm, {
        callerFeatureId: "__resolver__",
        callerScope: "global",
      });
      const resolved = await resolve(next, readCtx);
      next.activatedAt = nextTickTime;
      next.plannedDuration = resolved.plannedDuration;
      next.plannedOutcome = resolved.outcome;
      next.completionTime = this.addMinutes(nextTickTime, resolved.plannedDuration);
      queue.markActive(next.id);
    }

    // Phase 4: commit due steps
    const due = queue
      .snapshotAll()
      .filter((s) => s.status === "active" && this.timeIsAtOrBefore(s.completionTime, nextTickTime));

    for (const step of due) {
      const ctx = makeDGSMFeatureReadContext(dgsm, {
        callerFeatureId: "__commit__",
        callerScope: "global",
      });
      const outcome = step.plannedOutcome;
      // `plannedOutcome` is set in Phase 3 before markActive, so a missing
      // value here is a programmer error (resolver returned nothing / step
      // reached Phase 4 without going through activation). Skip to keep the
      // tick alive rather than crashing with a non-null assertion.
      if (!outcome) {
        queue.markCompleted(step.id);
        continue;
      }
      const featureChanges = featureRunner.runActionCommit(step, outcome, ctx);
      buffer.push(...featureChanges);
      // Resolver's own state changes flow directly — no cast, no deprecated
      // `StateResolution` bridge.
      buffer.push(...outcome.stateChanges);
      queue.markCompleted(step.id);
      const committed: CharacterAction = {
        characterId: step.characterId,
        handleId: step.handle.id,
        stepGroupId: step.stepGroupId,
        stepIndex: step.stepIndex,
        definitionId: step.definitionId,
        actionText: step.actionText,
        sceneId: step.executionSceneId,
        targetCharacterIds: step.targetCharacterIds,
        activatedAt: step.activatedAt!,
        completedAt: nextTickTime,
        outcome,
      };
      commitsThisTick.push(committed);
    }

    // Phase 5: feature onTick
    const featureCtx = makeDGSMFeatureReadContext(dgsm, {
      callerFeatureId: "__tick__",
      callerScope: "global",
    });
    buffer.push(...featureRunner.runTick(featureCtx));

    // Phase 6: feature propagation
    buffer.push(...featureRunner.runPropagation(featureCtx));

    // Phase 7: scripted events
    const scriptedChanges = scriptedEventRunner.run({
      baseCtx: featureCtx,
      committedActionsThisTick: commitsThisTick,
      accumulatedStateChanges: buffer,
    });
    buffer.push(...scriptedChanges);

    // Phase 8: emergent events scan — aggregator runs all registered scanners
    const scannerCtx = {
      dgsm,
      tickTime: nextTickTime,
      committedActionsThisTick: commitsThisTick,
      lang: this.deps.lang,
    };
    const { featureEvents: emergentEvents } = emergentEventEmitter.scan(scannerCtx);

    // Phase 9: applier flush
    const applied = applier.flush(buffer, nextTickTime);

    // Phase 10: build report (event emission is the caller's job via TickEngine + EventBus)
    return {
      tickTime: nextTickTime,
      commits: commitsThisTick,
      interruptions,
      cancellations,
      featureEvents: [...applied.featureEvents, ...emergentEvents],
      stateChanges: applied.stateChanges,
      damageReports: applied.damageReports,
    };
  }

  // --- helpers ---

  /** Processes a deferred interrupt on an active step. At call time the queue
   *  already has `activeStepId` in `"active"` status (TickEngine didn't mark it
   *  cancelled synchronously because features may need to react). This helper
   *  runs the C-compromise (<50% discard / ≥50% partial outcome via
   *  `runActionCommit({ interrupted: true })`) and marks the step interrupted. */
  private applyPendingInterrupt(
    req: PendingInterrupt,
    nowTickTime: GameTime,
    buffer: StateChange[],
    interruptions: TickReport["interruptions"],
  ): void {
    const active = this.deps.queue.get(req.activeStepId);
    if (!active || active.status !== "active") {
      // Step was completed / otherwise resolved between the interruptAction
      // call and this tick phase. Spec says "first wins" — silently drop.
      return;
    }

    if (active.activatedAt === undefined) {
      throw new Error(
        `TickOrchestrator: active step ${active.id} has no activatedAt (queue corruption)`,
      );
    }

    const elapsed = this.minutesBetween(active.activatedAt, nowTickTime);
    const planned = active.plannedDuration ?? 1;
    const ratio = elapsed / planned;
    if (ratio >= 0.5 && active.plannedOutcome) {
      const ctx = makeDGSMFeatureReadContext(this.deps.dgsm, {
        callerFeatureId: "__interrupt__",
        callerScope: "global",
      });
      const partialChanges = this.deps.featureRunner.runActionCommit(
        active,
        active.plannedOutcome,
        ctx,
        { interrupted: true },
      );
      buffer.push(...partialChanges);
    }
    this.deps.queue.markInterrupted(active.id);
    interruptions.push({
      action: this.stepToAction(active, nowTickTime),
      reason: req.reason,
    });
  }

  private stepToAction(step: ActionStep, now: GameTime): CharacterAction {
    return {
      characterId: step.characterId,
      handleId: step.handle.id,
      stepGroupId: step.stepGroupId,
      stepIndex: step.stepIndex,
      definitionId: step.definitionId,
      actionText: step.actionText,
      sceneId: step.executionSceneId,
      targetCharacterIds: step.targetCharacterIds,
      activatedAt: step.activatedAt ?? step.submittedAt,
      completedAt: now,
      outcome: step.plannedOutcome,
    };
  }

  private advanceClock(): GameTime {
    const before = { day: this.deps.dgsm.getGameDay(), tickTime: this.deps.dgsm.getTickTime() };
    const next = this.addMinutes(before, this.deps.tickDurationMinutes);
    this.deps.dgsm.setGameDay(next.day);
    this.deps.dgsm.setTickTime(next.tickTime);
    return next;
  }

  private getIdleActorIds(): string[] {
    const all = new Set<string>();
    for (const s of this.deps.queue.snapshotAll()) all.add(s.characterId);
    return [...all].filter((id) => !this.deps.queue.hasActiveFor(id));
  }

  private addMinutes(t: GameTime, minutes: number): GameTime {
    const [h, m] = t.tickTime.split(":").map(Number);
    let total = h * 60 + m + minutes;
    let day = t.day;
    while (total >= 24 * 60) {
      total -= 24 * 60;
      day += 1;
    }
    const hh = String(Math.floor(total / 60)).padStart(2, "0");
    const mm = String(total % 60).padStart(2, "0");
    return { day, tickTime: `${hh}:${mm}` };
  }

  private minutesBetween(a: GameTime, b: GameTime): number {
    const [ah, am] = a.tickTime.split(":").map(Number);
    const [bh, bm] = b.tickTime.split(":").map(Number);
    return (b.day - a.day) * 1440 + (bh * 60 + bm) - (ah * 60 + am);
  }

  private timeIsAtOrBefore(t: GameTime | undefined, now: GameTime): boolean {
    if (!t) return false;
    if (t.day < now.day) return true;
    if (t.day > now.day) return false;
    return t.tickTime <= now.tickTime;
  }
}
```

- [ ] **Step 3: Run test**

Run: `npx vitest run src/engine/core/__tests__/tickOrchestrator.test.ts`
Expected: PASS.

---

### Task B6: TickEngine (public API)

**Files:**
- Create: `src/engine/core/tickEngine.ts`
- Test: `src/engine/core/__tests__/tickEngine.test.ts`

Top-level class. Composes Queue + ActionIntake + TickOrchestrator + Applier + FeatureRunner + ScriptedEventRunner + EmergentEventEmitter + EventBus behind the §4 API.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/core/__tests__/tickEngine.test.ts
import { describe, it, expect, vi } from "vitest";
import { createTickEngine } from "../tickEngine.js";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";

describe("TickEngine", () => {
  it("submitAction → tick → actionCompleted event fires", async () => {
    const dgsm = new DynamicGameStateManager();
    // Use real DGSM.registerNpcProfile in the real test; see Phase A sweep note.

    const engine = createTickEngine({
      dgsm,
      features: [],
      scriptedEvents: [],
      interpretAction: async () => ({ steps: [{ definitionId: "idle", actionText: "wait" }] }),
      resolve: async () => ({ outcome: { stateChanges: [] } as never, plannedDuration: 0 }),
      emergentScanners: [],
      getActorDex: () => 50,
      tickDurationMinutes: 1,
      lang: "en",
    });

    const completedSpy = vi.fn();
    engine.on("actionCompleted", completedSpy);

    const handle = await engine.submitAction({
      characterId: "npc1",
      actionText: "wait",
      sceneId: "s1",
    });
    await engine.tick();
    expect(completedSpy).toHaveBeenCalled();
    expect(engine.getActionStatus(handle)).toBe("completed");
  });

  it("cancelAction removes all chain steps and fires actionCancelled", async () => {
    const dgsm = new DynamicGameStateManager();

    const engine = createTickEngine({
      dgsm,
      features: [],
      scriptedEvents: [],
      interpretAction: async () => ({ steps: [{ definitionId: "idle", actionText: "" }, { definitionId: "idle2", actionText: "" }] }),
      resolve: async () => ({ outcome: { stateChanges: [] } as never, plannedDuration: 5 }),
      emergentScanners: [],
      getActorDex: () => 50,
      tickDurationMinutes: 1,
      lang: "en",
    });

    const cancelledSpy = vi.fn();
    engine.on("actionCancelled", cancelledSpy);

    const handle = await engine.submitAction({
      characterId: "npc1",
      actionText: "chain",
      sceneId: "s1",
    });
    const result = engine.cancelAction(handle);
    expect(result.applied).toBe(true);
    expect(result.remainingChainCancelled).toBe(2);
    await engine.tick();
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/engine/core/tickEngine.ts
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { WorldFeature } from "./worldFeature.js";
import type {
  ActionHandle,
  ActionInput,
  ActionStatus,
  ActionStep,
  CancelResult,
  CharacterAction,
  FeatureEvent,
  InterruptReason,
  InterruptResult,
  TickReport,
  Unsubscribe,
} from "./types.js";
import type { ScriptedEvent } from "../scriptedEvents/types.js";
import type { EmergentScanner } from "./emergentScanner.js";
import { Queue } from "./queue.js";
import { ActionIntake } from "./actionIntake.js";
import { FeatureRunner } from "./featureRunner.js";
import { ScriptedEventRunner } from "./scriptedEventRunner.js";
import { EmergentEventEmitter } from "./emergentEventEmitter.js";
import { Applier } from "./applier.js";
import { EventBus } from "./eventBus.js";
import { TickOrchestrator, type ResolveFn } from "./tickOrchestrator.js";

export interface TickEngine {
  submitAction(input: ActionInput): Promise<ActionHandle>;
  cancelAction(handle: ActionHandle): CancelResult;
  interruptAction(handle: ActionHandle, reason: InterruptReason): InterruptResult;
  tick(): Promise<void>;

  on(ev: "actionCompleted", cb: (a: CharacterAction) => void): Unsubscribe;
  on(ev: "actionInterrupted", cb: (a: CharacterAction, r: InterruptReason) => void): Unsubscribe;
  on(ev: "actionCancelled", cb: (a: CharacterAction) => void): Unsubscribe;
  on(ev: "featureEvent", cb: (e: FeatureEvent) => void): Unsubscribe;
  on(ev: "tickCompleted", cb: (r: TickReport) => Promise<void> | void): Unsubscribe;

  getActionStatus(handle: ActionHandle): ActionStatus;
  getActorQueue(characterId: string): ReadonlyArray<ActionStep>;
}

export interface CreateTickEngineOptions {
  dgsm: DynamicGameStateManager;
  features: WorldFeature[];
  scriptedEvents: ScriptedEvent[];
  /** Pre-instantiated emergent scanners (EncounterScanner, DiscoveryScanner, etc.).
   *  Order in the array = order of events in TickReport.featureEvents. */
  emergentScanners: EmergentScanner[];
  interpretAction: (input: ActionInput) => Promise<{ steps: import("../types.js").InterpretedStep[] }>;
  resolve: ResolveFn;
  getActorDex: (characterId: string) => number;
  tickDurationMinutes: number;
  /** Session language code (e.g., "en", "zh") — passed through to ScannerContext for i18n. */
  lang: string;
}

export function createTickEngine(opts: CreateTickEngineOptions): TickEngine {
  const queue = new Queue();
  const featureRunner = new FeatureRunner(opts.features);
  const applier = new Applier(opts.dgsm, featureRunner.getFeatureScopeMap());
  const scriptedRunner = new ScriptedEventRunner(opts.scriptedEvents);
  const emergent = new EmergentEventEmitter(opts.emergentScanners);
  const bus = new EventBus();
  const intake = new ActionIntake({
    queue,
    interpretAction: opts.interpretAction,
    getActorDex: opts.getActorDex,
    getNow: () => ({ day: opts.dgsm.getGameDay(), tickTime: opts.dgsm.getTickTime() }),
  });
  const orchestrator = new TickOrchestrator({
    dgsm: opts.dgsm,
    queue,
    featureRunner,
    scriptedEventRunner: scriptedRunner,
    emergentEventEmitter: emergent,
    applier,
    resolve: opts.resolve,
    tickDurationMinutes: opts.tickDurationMinutes,
    lang: opts.lang,
  });

  /** Returns all queued + active steps for a handle. Used by cancel/interrupt
   *  to decide (a) whether the chain is still live and (b) which steps to mark. */
  function liveSteps(handleId: string): ActionStep[] {
    return queue
      .serialize()
      .filter(
        (s) =>
          s.handle.id === handleId &&
          (s.status === "queued" || s.status === "active"),
      );
  }

  return {
    submitAction: (input) => intake.submit(input),

    cancelAction(handle) {
      const live = liveSteps(handle.id);
      if (live.length === 0) {
        // Either the chain already finished, or a prior cancel/interrupt
        // already marked every step terminal. Idempotent: second call is a
        // no-op.
        return { applied: false, remainingChainCancelled: 0 };
      }
      // Sync-mark every live step cancelled so subsequent calls see no live
      // steps and return applied:false naturally (Option Y). Pick a
      // representative step for the event payload (prefer active, else the
      // lowest stepIndex queued).
      const rep =
        live.find((s) => s.status === "active") ??
        [...live].sort((a, b) => a.stepIndex - b.stepIndex)[0];
      for (const s of live) queue.markCancelled(s.id);
      orchestrator.recordCancelledStep(rep);
      return { applied: true, remainingChainCancelled: live.length };
    },

    interruptAction(handle, reason) {
      const live = liveSteps(handle.id);
      if (live.length === 0) {
        return { applied: false, remainingChainCancelled: 0 };
      }
      const active = live.find((s) => s.status === "active");
      const queuedSibs = live.filter((s) => s.status === "queued");

      // Sync: cancel queued siblings (no resolver work needed).
      for (const s of queuedSibs) queue.markCancelled(s.id);

      if (!active) {
        // Spec §3 edge case: interrupt on queued-only handle behaves as cancel.
        // Fire actionCancelled via the same recordCancelledStep path.
        const rep = [...queuedSibs].sort((a, b) => a.stepIndex - b.stepIndex)[0];
        orchestrator.recordCancelledStep(rep);
        return { applied: true, remainingChainCancelled: queuedSibs.length };
      }

      // Deferred: active step needs C-compromise (<50% discard / ≥50% partial
      // outcome). TickOrchestrator phase 2b handles it next tick. The step
      // stays in "active" status until then so features still see it as the
      // owner's active slot until the orchestrator marks it "interrupted".
      orchestrator.queuePendingInterrupt({
        handleId: handle.id,
        reason,
        activeStepId: active.id,
      });
      return { applied: true, remainingChainCancelled: queuedSibs.length };
    },

    async tick() {
      const report = await orchestrator.tick();
      for (const a of report.commits) bus.emitActionCompleted(a);
      for (const i of report.interruptions) bus.emitActionInterrupted(i.action, i.reason);
      for (const c of report.cancellations) bus.emitActionCancelled(c);
      for (const e of report.featureEvents) bus.emitFeatureEvent(e);
      await bus.emitTickCompleted(report);
    },

    on: bus.on.bind(bus),

    getActionStatus(handle) {
      const found = queue
        .serialize()
        .filter((s) => s.handle.id === handle.id)
        .sort((a, b) => b.stepIndex - a.stepIndex)[0];
      return found?.status ?? "completed"; // absent ⇒ all cleaned up (completed)
    },

    getActorQueue(characterId) {
      return queue.serialize().filter((s) => s.characterId === characterId);
    },
  };
}
```

- [ ] **Step 3: Run test**

Run: `npx vitest run src/engine/core/__tests__/tickEngine.test.ts`
Expected: PASS.

---

### Task B7: Persistence — round-trip TickEngine state in `SimulationRuntime.gameState` JSON

**Files:**
- Modify: `src/engine/core/tickEngine.ts` — add `serialize()` / `rehydrate()` that round-trip queue contents + connection refcounts. Extend `createTickEngine` to accept an optional `persistedState` blob.
- Modify: `src/simulation/SimulationRunner.ts` (deferred to Task E2) — actual DGSM/TickEngine JSON round-trip at session save/load. For now just expose the hooks.
- Test: `src/engine/core/__tests__/tickEngine.persistence.test.ts`

Decision (resolves §10 item "ActionStep persistence strategy"): persist inside `SimulationRuntime.gameState` JSON blob — no new Prisma table. JSON blob is already a semi-structured workspace; adding a sibling key `tickEngine: { queue: ActionStep[]; connectionVotes: {...} }` is the simplest path. Resume behavior: if `gameState.tickEngine` is present, `createTickEngine` rehydrates; otherwise fresh state.

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/core/__tests__/tickEngine.persistence.test.ts
import { describe, it, expect } from "vitest";
import { createTickEngine } from "../tickEngine.js";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";

describe("TickEngine persistence", () => {
  it("round-trips queue + connection refcounts", async () => {
    const dgsm1 = new DynamicGameStateManager();
    // Use DGSM.registerNpcProfile for real NPCs; see Phase A sweep note.

    const engine1 = createTickEngine({
      dgsm: dgsm1,
      features: [],
      scriptedEvents: [],
      emergentScanners: [],
      interpretAction: async () => ({ steps: [{ definitionId: "wait", actionText: "" }] }),
      resolve: async () => ({ outcome: { stateChanges: [] } as never, plannedDuration: 10 }),
      getActorDex: () => 50,
      tickDurationMinutes: 1,
      lang: "en",
    });
    await engine1.submitAction({ characterId: "npc1", actionText: "wait", sceneId: "s1" });

    const snapshot = engine1.serialize();

    const dgsm2 = new DynamicGameStateManager();
    const engine2 = createTickEngine({
      dgsm: dgsm2,
      features: [],
      scriptedEvents: [],
      emergentScanners: [],
      interpretAction: async () => ({ steps: [] }),
      resolve: async () => ({ outcome: { stateChanges: [] } as never, plannedDuration: 0 }),
      getActorDex: () => 50,
      tickDurationMinutes: 1,
      lang: "en",
      persistedState: snapshot,
    });
    expect(engine2.getActorQueue("npc1")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Extend TickEngine with serialize/rehydrate**

Add to `createTickEngine`:

```ts
// inside createTickEngine, after constructing queue and applier:
if (opts.persistedState) {
  queue.rehydrate(
    opts.persistedState.queue,
    new Map(Object.entries(opts.persistedState.dexByActor)),
  );
  applier.rehydrateConnectionVotes(opts.persistedState.connectionVotes);
}

// expose on returned object:
serialize() {
  return {
    queue: queue.serialize(),
    dexByActor: Object.fromEntries(queue.getDexSnapshot()),
    connectionVotes: applier.serializeConnectionVotes(),
  };
}
```

Add `getDexSnapshot(): Map<string, number>` to `Queue` (reads `dexByActor` private map).

Extend `CreateTickEngineOptions`:

```ts
export interface CreateTickEngineOptions {
  // ...existing
  persistedState?: {
    queue: ActionStep[];
    dexByActor: Record<string, number>;
    connectionVotes: Record<string, { featureId: string; reason: string }[]>;
  };
}
```

Extend the `TickEngine` interface with `serialize(): PersistedState`.

- [ ] **Step 3: Run test**

Run: `npx vitest run src/engine/core/__tests__/tickEngine.persistence.test.ts`
Expected: PASS.

---

## Phase C — ScriptedEventRunner

> **STATUS — under design (2026-04-21).** The original Phase C plan (idealized DSL: `daily/cumulative/prerequisite` enum + `predicate: "witnesses"|"global"`) was found insufficient after auditing `src/engine/features/eventTriggerFeature.ts` (731 lines) — it doesn't model multi-condition tracking, day rollover, fail-after-missed, prerequisite, or conductor-NPC witness exclusion. Replaced with a clean-slate **unified Predicate DSL** (sections C-overview + new C1 below). C2 and C3 task bodies are placeholders pending the runtime/evaluator + persistence + loader sections being completed.

---

### Phase C Design Overview

#### Architecture role

```
NPC (lives via memory + intent)
  ↓ submitAction(...)
TickEngine
  Phase 4: commit actions
  Phase 5–6: features
  Phase 7: ScriptedEventRunner ← invisible to NPC (no introspection API)
  Phase 8: emergent scanners
  Phase 9: applier flush
DGSM
```

#### Design principles

1. **GM-only viewpoint.** ScriptedEventRunner observes and reacts; it does **not** participate in NPC decision-making. NPCs guide their own behavior via memory + intent + personality. Modules that need NPCs to do specific things give them appropriate intents — they do **not** rely on the planner LLM seeing the tracker state. Runner exposes only `run(input)`; **no `describe()`, no `getActiveEventsSnapshot()`, no introspection.** State persistence is handled implicitly via DGSM (state lives in `state.scriptedEventStates`, rides DGSM's existing JSON round-trip), so no `serialize()`/`rehydrate()` on the Runner either.
2. **Pure unified Predicate DSL.** All conditions (action-driven, state-match, time-based, cross-event) and all effect filters (NPC target, scene target) use a single closed-form predicate language. No sugar layer / shortcuts — module authors compose predicates explicitly. Maximum extensibility (new predicate kind = additive change).
3. **Declarative module data.** Module YAML/JSON contains `scriptedEvents: ScriptedEvent[]`. Loader does structural validation (schema + reference resolution) at load time; runner trusts the loaded data at runtime.
4. **Same-tick cascade with `maxCascade=8`.** Effect-driven cascade (event A's `onComplete` includes `event.transition: B`) and predicate-driven cascade (event B's `fireWhen` is `eventStatus(A, completed)`) both fire same tick. Cascade loop re-evaluates all active events until no status changes OR cap reached. Overflow logs warning + drops further triggers.
5. **Effects are predicate-filtered StateChanges.** `Effect.targetFilter: CharacterPredicate` and `Effect.sceneFilter: ScenePredicate` are evaluated at fire time; runner expands one Effect into N StateChanges (one per matched character / scene).

#### Use case coverage (A/B/C/D)

A unified predicate language covers all four use-case categories:

- **A** Action-driven (daily/cumulative/invoke/prerequisite/fail-after-missed): via `Tracker` + `actionCommittedThisTick` + `trackerCount` / `trackerSinceFulfillment` / `trackerNeverFulfilled` predicates. "Daily" semantics expressed as `trackerSinceFulfillment(cmp: lte, value: 1440)`; "missed 3 days in a row" as `trackerSinceFulfillment(cmp: gte, value: 4320)`.
- **B** State-match (NPC died, item at scene, gameDay reached): via `characterAlive` / `characterAt` / `characterHasItem` / `gameDay` / `sceneHasConditionFromFeature` predicates.
- **C** Composition: via `and` / `or` / `not` predicate operators.
- **D** Cross-event cascading: via `eventStatus` predicate (predicate-driven) + `event.transition` effect (effect-driven).

#### Design decision log

| Topic | Chosen | Rejected |
|---|---|---|
| Use case scope | A+B+C+D unified | A only (closed enum), separate systems for state vs action conditions |
| DSL style | Pure unified Predicate | Sugar layer over predicate (loader transforms shortcuts) |
| Cascade timing | Same tick + maxCascade=8 cap | Next-tick cascade (1-tick latency per hop), explicit `delayTicks` per effect |
| Effect target | Pure CharacterPredicate / ScenePredicate | Enum shortcuts ("witnesses" / "global") + predicate fallback |
| Planner integration | None — Runner invisible to planner | Runner exposes `describe(ctx) → string`, `getActiveEventsSnapshot()` |
| Tracker `failAfterMissed` field | Removed; threshold lives in `failWhen` predicate | Keep as a hint/shortcut |
| `lastActionDay` Tracker | Removed — redundant with the new `lastFulfillment` Tracker, which records `lastFulfilledTick` and supports any time-window query via `trackerSinceFulfillment` | Keep as a separate Tracker variant |
| `sceneHasCondition` matcher | Match by `featureId` | Match by `description` text |
| `narrative.broadcast` Effect | Removed; use `event.emit` instead | Keep as separate Effect kind |
| `CharacterPredicate.isNpc` naming | Rename to `is` (symmetric with ScenePredicate) | Keep as `isNpc` |
| Per-event timing | DSL has 2 fields: `fireDelayTicks` + `durationTicks` | One field only; per-effect delay |
| Runtime status states | 5 states: `active` / `pending` / `completed` / `failed` / `disabled` | 6 states (separate `delayed` and `in_progress`); 4 states (no `disabled`) |
| Phase distinction (delay vs duration) | Runtime collapses both into `pending` via `scheduledCompleteTick = now + delay + duration`. Module authors that need "visible duration" semantics decompose into two events linked by cascade. | Engine tracks separate `delayed` / `in_progress` phases |
| Failure during pending | `failWhen` priority over completion in same tick — `failed` wins | Race condition undefined |
| Schedule stickiness | Sticky — `fireWhen` becoming false after schedule does NOT cancel | Re-evaluate `fireWhen` each tick during pending |
| `event.transition` vs `fireDelayTicks`/`durationTicks` | `event.transition` (effect-driven) skips delay/duration, immediate. Predicate-driven cascade respects the target event's own delay/duration | Both paths apply delay |
| Time semantics for "daily" / "missed N days" | Continuous tick-based (`lastFulfillment` Tracker + `trackerSinceFulfillment` Predicate) | Discrete day boundary (`dailyFlag` + `trackerFulfilledToday` + day rollover handler) |
| `consecutiveMissed` storage | Removed — derived from `(currentTick - lastFulfilledTick) / 1440` at predicate eval time | Stored alongside `fulfilledToday` |
| `lastCheckedDay` field on event state | Removed — no day rollover, no need to track | Required for day-rollover detection |
| `ScriptedEventState` storage location | DGSM (new dedicated bucket `scriptedEventStates`) — narrative state belongs in the world store; rides DGSM's existing serialization automatically | Runner-owned `Map<id, ScriptedEventState>` with separate `serialize()`/`rehydrate()` methods (mirrors Applier.connectionVotes, but ScriptedEvent state is more "world" than "engine bookkeeping") |
| Per-Runner `serialize()` / `rehydrate()` | Removed — state lives in DGSM, persistence is automatic via DGSM's existing JSON round-trip | Required if Runner owned the state |
| `persistedState.scriptedEvents` field on `CreateTickEngineOptions` | Removed — no separate Runner state to persist | Required if Runner owned the state |
| Module data file layout | Multi-file directory `data/Mods/<modName>/scripted-events/*.json` (each file root = `ScriptedEvent[]`); files grouped by author preference (storyline / NPC / region) | Single file `scripted-events.json`; embed in existing `setup.json` JSON blob |
| Loader error reporting | Aggregate all errors before throwing (one `ScriptedEventLoadError` listing every issue with file + path locations) | Fail-fast on first error |
| Validation library | Hand-written recursive validator | `zod` / `valibot` / similar schema lib |
| Semantic-sanity validation | Skipped — runner's `MAX_CASCADE` cap covers infinite-cascade module bugs at runtime | Detect "fireWhen always false", "self-trigger event.transition: self", etc. at load time |
| DB persistence of module data | Merged `ScriptedEvent[]` array stored on `ModuleSetup.data.scriptedEvents` (existing Prisma `Json` field); original multi-file structure not persisted | Persist file-by-file structure for re-export; load directly from disk each session |

---

### Task C1: ScriptedEvent types

**Files:**
- Create: `src/engine/scriptedEvents/types.ts`
- Test: none — type-only file, covered by C3 behavior tests.

> **Note:** A stub version of this file already exists at `src/engine/scriptedEvents/types.ts` (created during Phase B pre-work to unblock B5/B6 import). Replace its contents wholesale with the version below.

- [ ] **Step 1: Replace the file**

```ts
// src/engine/scriptedEvents/types.ts
import type {
  CharacterCondition,
  FeatureEvent,
  SceneCondition,
} from "../core/types.js";

// ─── Top-level Event ────────────────────────────────────────────
export interface ScriptedEvent {
  id: string;
  label: string;                          // human-readable, debug/log only
  initialStatus?: "active" | "disabled";  // default "active"

  // Timing — DSL distinguishes "delay before event manifests" vs "duration the
  // event takes". Runtime collapses both into one `pending` phase whose
  // scheduledCompleteTick = currentTick + (fireDelayTicks ?? 0) + (durationTicks ?? 0).
  // Module authors that need to query "is X visibly happening now?" decompose into
  // two events linked by cascade — the engine doesn't track separate phases.
  fireDelayTicks?: number;                // default 0; ticks before the event starts manifesting
  durationTicks?: number;                 // default 0; ticks the event takes once started

  trackers?: Tracker[];                   // optional; needed if predicates reference trackers
  fireWhen: Predicate;                    // when true → transition to "pending" (or "completed" if delay+duration = 0)
  failWhen?: Predicate;                   // optional; when true → transition to "failed" (priority over completion)
  onComplete: Effect[];
  onFail?: Effect[];
}

// ─── Trackers (cross-tick state) ────────────────────────────────
// All time semantics are continuous (tick-based). No day-boundary special case;
// "daily" / "missed N days" predicates are derived from tick deltas in the
// trackerSinceFulfillment predicate.
export type Tracker =
  | { id: string; kind: "actionCount"; match: ActionMatch }
  | { id: string; kind: "lastFulfillment"; match: ActionMatch };

export interface ActionMatch {
  definitionId?: string;     // omit = any action kind
  byNpcId?: string;          // omit = any NPC
  atSceneId?: string;        // omit = any scene
  withTargetId?: string;     // omit = any/no target
}

// ─── Predicate (tick-level boolean) ─────────────────────────────
export type Predicate =
  // ── Tracker queries ────────────────────────────────────
  | { op: "trackerCount"; trackerId: string; cmp: "gte" | "lte" | "eq"; value: number }
  // ticks since the matching action last committed; for "daily" use cmp:lte,value:1440;
  // for "missed N days" use cmp:gte,value:N*1440. Returns false (and treats as +∞)
  // if the tracker has never been fulfilled.
  | { op: "trackerSinceFulfillment"; trackerId: string; cmp: "gte" | "lte" | "eq"; value: number }
  | { op: "trackerNeverFulfilled"; trackerId: string }
  // ── This-tick events ───────────────────────────────────
  | { op: "actionCommittedThisTick"; match: ActionMatch }
  // ── World state ────────────────────────────────────────
  | { op: "characterAt"; characterId: string; sceneId: string }
  | { op: "characterAlive"; characterId: string; expectedAlive: boolean }
  | { op: "characterHasItem"; characterId: string; itemName: string }
  | { op: "sceneHasConditionFromFeature"; sceneId: string; featureId: string }
  | { op: "gameDay"; cmp: "gte" | "lte" | "eq"; value: number }
  // ── Cross-event (D) ────────────────────────────────────
  | {
      op: "eventStatus";
      otherEventId: string;
      isStatus: ScriptedEventStatus;       // see ScriptedEventState below
    }
  // ── Composition (C) ────────────────────────────────────
  | { op: "and"; children: Predicate[] }
  | { op: "or"; children: Predicate[] }
  | { op: "not"; child: Predicate };

// ─── CharacterPredicate (filter a single NPC) ───────────────────
// Used in Effect.targetFilter. Not unified with Predicate because the
// leaf operations are subject-bound (operate on a specific character).
export type CharacterPredicate =
  | { op: "atScene"; sceneId: string }
  | { op: "alive"; expectedAlive: boolean }
  | { op: "hasItem"; itemName: string }
  | { op: "is"; characterId: string }
  | { op: "and"; children: CharacterPredicate[] }
  | { op: "or"; children: CharacterPredicate[] }
  | { op: "not"; child: CharacterPredicate };

// ─── ScenePredicate (filter a single scene) ─────────────────────
// Used in Effect.sceneFilter. Subject-bound like CharacterPredicate.
export type ScenePredicate =
  | { op: "is"; sceneId: string }
  | { op: "inRegion"; regionId: string }
  | { op: "hasConditionFromFeature"; featureId: string }
  | { op: "and"; children: ScenePredicate[] }
  | { op: "or"; children: ScenePredicate[] }
  | { op: "not"; child: ScenePredicate };

// ─── Effects (Runner expands → StateChange[]) ───────────────────
export type Effect =
  // Filtered by CharacterPredicate
  | { kind: "character.san"; targetFilter: CharacterPredicate; delta: number }
  | { kind: "character.hp"; targetFilter: CharacterPredicate; delta: number }
  | { kind: "character.fatigue"; targetFilter: CharacterPredicate; delta: number }
  | { kind: "character.addCondition"; targetFilter: CharacterPredicate; condition: CharacterCondition }
  | { kind: "character.removeCondition"; targetFilter: CharacterPredicate; conditionId: string }
  // Filtered by ScenePredicate
  | { kind: "scene.addCondition"; sceneFilter: ScenePredicate; condition: SceneCondition }
  | { kind: "scene.removeCondition"; sceneFilter: ScenePredicate; predicate: { featureId: string } }
  // Direct (no filter)
  | { kind: "connection.setBlock"; connectionId: string; blocked: boolean; reason: string }
  | { kind: "event.emit"; event: FeatureEvent }
  // Cross-event (D)
  | {
      kind: "event.transition";
      otherEventId: string;
      to: "active" | "completed" | "failed" | "disabled";
    };

// ─── Runtime state (lives in DGSM) ──────────────────────────────
// All state below is stored as a record in DGSM (`state.scriptedEventStates`,
// keyed by event id) — NOT in the ScriptedEventRunner instance. Persistence
// rides on DGSM's existing JSON round-trip; no separate serialize/rehydrate
// path on the Runner.

export type ScriptedEventStatus =
  | "active"     // being evaluated; waiting for fireWhen
  | "pending"    // fireWhen met; scheduled to complete at scheduledCompleteTick
  | "completed"  // terminal: success (onComplete fired)
  | "failed"     // terminal: failure (onFail fired)
  | "disabled";  // not evaluated; can be re-activated via event.transition

export interface ScriptedEventState {
  id: string;
  status: ScriptedEventStatus;
  scheduledCompleteTick: number | null;          // set when status = "pending"; null otherwise
  trackerStates: Record<string, TrackerState>;   // keyed by Tracker.id
}

export type TrackerState =
  | { kind: "actionCount"; count: number }
  | { kind: "lastFulfillment"; lastFulfilledTick: number | null };  // null = never fulfilled
```

**Notes on the type design:**

- **No `failAfterMissed` field on Tracker** — the threshold is expressed in the `failWhen` predicate (e.g., `{ op: "trackerSinceFulfillment", trackerId, cmp: "gte", value: 4320 }`). Keeps Tracker as pure data tracking; no dual declaration.
- **Three separate predicate types** (`Predicate` / `CharacterPredicate` / `ScenePredicate`) instead of one generic `Predicate<S>` — leaf operations are subject-bound. Generic-over-subject increases TS complexity without ergonomic gain.
- **No `narrative.broadcast` Effect** — module authors use `event.emit` with `{ type: "narrative", description: "..." }`; `memoryEventWriter` (E1) picks these up and writes NPC memory.
- **`sourceFeatureId` on emitted StateChanges** is set automatically by Runner to `"scripted:<eventId>"` — module authors don't write it.
- **`ScriptedEventReadContext` type is removed** vs the old plan — the runner's evaluator takes a structured `EvaluatorContext` (defined in C3) instead of extending FeatureReadContext.

- [ ] **Step 2: Type-check**

Run: `pnpm build:tsc`
Expected: no new TS errors. (Project-wide errors from legacy code are still expected per the batch-test-at-end policy.)

---

### §C-runtime — State Machine + Tick Algorithm

Runtime design is settled (state machine + cascade loop + tick algorithm + predicate evaluators + tracker updater). Cascade cycle-detection details are inline in the C3 implementation step (mirror `MAX_CASCADE = 8` for the recursive `applyTransitionEffects` helper).

#### State Machine

```
[active]
   ↓ fireWhen first becomes true
   ↓ scheduledCompleteTick = now + (fireDelayTicks ?? 0) + (durationTicks ?? 0)
   ↓
   ├─ if scheduledCompleteTick == now → directly to [completed] (same hop)
   │
   ├─ else → [pending]
   │       ↓ currentTick >= scheduledCompleteTick
   │       ↓
   │     [completed]   (fire onComplete)
   │
   └─ at any non-terminal state: failWhen true → [failed]   (fire onFail; cancel any pending schedule)
```

`failWhen` always takes priority over `fireWhen` and over completion in the same tick — `failed` wins races.

`scheduledCompleteTick` becomes "sticky" once set: subsequent `fireWhen` flickers (true → false → true) do NOT cancel the schedule. Only `failWhen` can cancel a pending event.

#### Cascade Loop

Within one tick, repeat the evaluator until no event status changed OR `maxCascade=8` hops reached. Each hop re-evaluates all non-terminal events because:

1. **Effect-driven cascade:** event A's `event.transition` effect explicitly forces event B to a new status (skips B's `fireWhen` and B's `fireDelayTicks`/`durationTicks` — immediate transition).
2. **Predicate-driven cascade:** event B's `fireWhen` includes `eventStatus(A, ...)`; A's transition this hop changes B's `fireWhen` value, which the next hop notices.

Both paths fire same tick. Maxcascade overflow logs a warning and drops further triggers (prevents infinite loops if author writes `A → B → A → ...`).

For the predicate-driven cascade case where the activated event has its own `fireDelayTicks`/`durationTicks`, those still apply (B is scheduled `pending`, completes later). For the effect-driven case (`event.transition: B → completed`), B's effects fire immediately the same hop — this is the explicit "skip the timer" path.

#### Tick Algorithm Pseudocode

All event state lives in DGSM (`dgsm.scriptedEventStates`). The Runner only owns the
event definitions Map (loaded from module data, not persisted). Reads and writes
go through `dgsm.getScriptedEventState(id)` / `dgsm.setScriptedEventState(id, state)`.

```python
def run(self, input):
  # input has: { dgsm, currentTick, gameDay, tickTime, committedActionsThisTick }
  out: StateChange[] = []
  # Lazy init: any event without a DGSM record yet gets one (initial status
  # from the event's initialStatus, default "active").
  for event_id, event in self.events.items():
    if input.dgsm.getScriptedEventState(event_id) is None:
      input.dgsm.setScriptedEventState(event_id, init_event_state(event, input.gameDay))

  # No day-rollover step — time is continuous and tick-based throughout.
  self.update_trackers(input.dgsm, input.committed_actions, input.current_tick)

  for hop in range(MAX_CASCADE):
    changed = False
    for event_id in self.events.keys():
      state = input.dgsm.getScriptedEventState(event_id)  # mutable reference
      if self.evaluate_event(event_id, state, input, out):
        # Mutations to `state` are by-reference; DGSM's record is updated in place.
        # If the impl returns a new object, write it back via setScriptedEventState.
        changed = True
    if not changed:
      break
  else:
    log.warn(f"[ScriptedEventRunner] cascade cap ({MAX_CASCADE}) reached")

  return out

def evaluate_event(self, event_id, state, input, out):
  event = self.events[event_id]
  # Terminals don't move
  if state.status in TERMINAL:  # completed / failed / disabled
    return False

  ctx = self.make_evaluator_context(input)  # wraps dgsm.getScriptedEventState

  # failWhen has priority; can interrupt pending events
  if event.failWhen and self.eval_predicate(event.failWhen, ctx, state):
    state.status = "failed"
    state.scheduledCompleteTick = None
    out.extend(self.expand_effects(event.onFail or [], event, ctx))
    return True

  if state.status == "active":
    if self.eval_predicate(event.fireWhen, ctx, state):
      total_wait = (event.fireDelayTicks or 0) + (event.durationTicks or 0)
      if total_wait > 0:
        state.status = "pending"
        state.scheduledCompleteTick = input.current_tick + total_wait
      else:
        state.status = "completed"
        out.extend(self.expand_effects(event.onComplete, event, ctx))
      return True

  elif state.status == "pending":
    if input.current_tick >= state.scheduledCompleteTick:
      state.status = "completed"
      state.scheduledCompleteTick = None
      out.extend(self.expand_effects(event.onComplete, event, ctx))
      return True

  return False
```

`update_trackers(committed_actions, current_tick)` walks `committedActionsThisTick` and, for each matching action:

- `actionCount` tracker: `state.count += 1` per matching action
- `lastFulfillment` tracker: `state.lastFulfilledTick = current_tick` if any matching action this tick (idempotent — multiple matches in one tick still set it once)

There is **no `handle_day_rollover`**. "Daily" / "missed N days" semantics are derived in the predicate evaluator at query time:

- `trackerSinceFulfillment(trackerId, cmp, value)`: if `lastFulfilledTick == null` → returns the result of comparing `+∞` (i.e., `cmp == "gte"` returns true, `cmp == "lte"` returns false). Otherwise `cmp(currentTick - lastFulfilledTick, value)`.
- `trackerNeverFulfilled(trackerId)`: returns `lastFulfilledTick == null`.

Effects are expanded inside `expand_effects`: target/scene predicates are evaluated against all NPCs / scenes; one StateChange is produced per match. The effect's `sourceFeatureId` is auto-set to `"scripted:<eventId>"` by the runner — module authors don't write it.

---

### §C-loader — Module Data Path + Validation

#### Physical layout

Per-module directory:

```
data/Mods/<modName>/
  scripted-events/
    ritual.json          # ScriptedEvent[] for ritual storyline
    cult.json            # ScriptedEvent[] for cult NPCs
    ending.json          # ScriptedEvent[] for endgame
    ...
```

- Each `*.json` file's root is a `ScriptedEvent[]` array (1+ events per file)
- Filename has no semantic meaning — author groups by storyline / NPC / region as preferred
- File loading order: dictionary order (sort), so behavior is deterministic across runs
- `*.json` filter: non-JSON files in the directory are ignored

If `scripted-events/` doesn't exist or is empty → loader returns `[]` (module is valid with no scripted events).

#### moduleLoader.ts integration

`src/state/moduleLoader.ts` gains a step:

```ts
import { loadScriptedEvents } from "../engine/scriptedEvents/loader.js";

async function loadModule(modName: string) {
  // ...existing: load setup.json, NPCs, scenes, etc.

  const eventsDir = path.join(modPath, "scripted-events");
  const allRawFiles: ScriptedEventFile[] = [];
  if (fs.existsSync(eventsDir)) {
    const files = fs.readdirSync(eventsDir).filter(f => f.endsWith(".json")).sort();
    for (const file of files) {
      const filePath = path.join(eventsDir, file);
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      allRawFiles.push({ file, raw });
    }
  }
  const scriptedEvents = loadScriptedEvents(allRawFiles);  // throws on validation failure

  return { ...existing, scriptedEvents };
}
```

#### Loader API

```ts
// src/engine/scriptedEvents/loader.ts
import type { ScriptedEvent } from "./types.js";

export interface ScriptedEventFile {
  file: string;          // filename for error reporting (e.g., "ritual.json")
  raw: unknown;          // parsed JSON content (root is array)
}

export interface LoaderError {
  file: string;          // which file the error is in
  path: string;          // path within the file (e.g., "[2].fireWhen.children[1].trackerId")
  message: string;
}

export class ScriptedEventLoadError extends Error {
  constructor(public errors: LoaderError[]) {
    super(`Invalid scripted events: ${errors.length} error(s)`);
  }
}

export function loadScriptedEvents(files: ScriptedEventFile[]): ScriptedEvent[];
// throws ScriptedEventLoadError if any validation fails. All errors collected,
// not fail-fast — author sees full list in one go.
```

#### Validation layers

**Layer 1 — Structural (per file, per event):**
- Root of each file is an array
- Each event has required fields (`id`, `label`, `fireWhen`, `onComplete`)
- Field types match the spec (e.g., `id` is string, `fireWhen` is a valid Predicate tree)
- Predicate / CharacterPredicate / ScenePredicate / Effect leaf nodes use known `op` / `kind` values
- Tracker `kind` is `"actionCount"` or `"lastFulfillment"`
- Status enum values are valid

Hand-written recursive validator (no schema library dep). Each validation step builds a path string for error reporting (`"[2].fireWhen.children[1].trackerId"`).

**Layer 2 — Reference integrity (cross-event, second pass after structural validation):**
- All `Predicate.eventStatus.otherEventId` resolve to a known event id (across all files)
- All `Effect.event.transition.otherEventId` resolve to a known event id
- All `Predicate.trackerCount` / `trackerSinceFulfillment` / `trackerNeverFulfilled` `trackerId` resolve to a tracker declared on the SAME event (not cross-event)
- Event IDs are unique across all files (duplicate id is fatal):
  ```
  Duplicate event id "altar_ritual":
    ritual.json [0]
    cult.json [3]
  ```

**Layer 3 — Semantic sanity (skipped):**
- Out of scope: detecting "fireWhen always evaluates false", "onComplete is empty", "self-trigger event.transition: self", etc.
- Runner's `MAX_CASCADE` cap covers infinite-cascade module bugs at runtime.

#### Error aggregation strategy

**Collect ALL errors before throwing.** Author should see the full list in one re-parse, not fix-and-rerun-and-fix-and-rerun.

Example error report:

```
Module "haunted_house" — invalid scripted-events:
  ritual.json:
    [2] (id="cult_ritual"):
      fireWhen.children[1].trackerId = "ritua" — no such tracker.
      Available trackers on this event: [pray, sacrifice]
  cult.json:
    [0] (id="awakening"):
      onComplete[2].otherEventId = "altar_finale" — no such event.
      Available events: [pray_daily, awakening, betrayal, ending]
  Duplicate event id "altar_ritual":
    ritual.json [0]
    cult.json [3]
```

#### Persistence to DB

`ModuleSetup.data.scriptedEvents: ScriptedEvent[]` — the merged, validated array is stored in the module setup record (the existing `Json` field on the Prisma `ModuleSetup` table). The original multi-file structure is not persisted; only the merged + validated output.

Module re-import (when author edits any `*.json`) re-runs the loader and overwrites `ModuleSetup.data.scriptedEvents`. SimulationRunner reads from DB at session start.

#### Future extension (NOT in MVP)

- Single-file fallback: `data/Mods/<modName>/scripted-events.json` if author prefers everything in one file. Loader could check for either form. **Not included in MVP — start with directory only.**

---

### §C-testing — Test Strategy

**Single integration test file. No separate unit tests for predicate evaluator, tracker updater, loader, or state machine.** Coverage comes from end-to-end scenarios that exercise multiple subsystems together.

Rationale (consistent with `feedback_skip_trivial_tests.md`): the unified Predicate DSL + simple Runner have low surface area. Comprehensive unit tests (one per leaf op × 3 evaluators × 7 status transitions × ...) would add ~1000 lines of tests for marginal regression-protection value. A focused integration test exercises the real behavior at ~200 lines.

#### Test file

`src/engine/core/__tests__/scriptedEventRunner.integration.test.ts` — three `it` blocks under one `describe`.

#### Scenarios

**1. `it("fires onComplete when fireWhen + tracker condition met across ticks")`**

- Set up: one event with `actionCount` tracker (`match: { definitionId: "pray" }`), `fireWhen: trackerCount(gte, 3)`, `onComplete: [character.san targetFilter atScene("altar") delta -10]`
- Seed DGSM: 1 priest NPC + 2 witnesses at "altar" scene
- Submit "pray" action 3 times across 3 separate ticks
- Assert: tracker count goes 1 → 2 → 3 in DGSM `scriptedEventStates`
- Assert tick 3: event status flips to `completed`, witnesses' san dropped by 10 each, priest's san unchanged (caller is conductor — but we use targetFilter not exclude-conductor explicitly here for simplicity; test that `atScene("altar")` predicate matches all 3 NPCs at the scene including priest)

Covers: tracker accumulation, fireWhen evaluation, Effect.character.san expansion via CharacterPredicate, StateChange application to DGSM via Applier.

**2. `it("cascade: event A completion triggers event B same tick via eventStatus predicate")`**

- Set up: event A (`fireWhen: actionCommittedThisTick(definitionId: "ritual")`, `onComplete: [event.transition: B → active]`) + event B (`initialStatus: "disabled"`, `fireWhen: eventStatus(A, "completed")`, `onComplete: [character.san targetFilter alive(true) delta -5]`)
- Seed DGSM: 1 NPC at any scene
- Submit "ritual" action; tick once
- Assert: A is `completed`, B is `completed` (NOT `active` waiting for next tick — same-tick cascade), NPC san dropped by 5
- Assert exactly 1 tick: cascade did not stretch across ticks

Covers: cascade loop, `event.transition` effect-driven cascade, `eventStatus` predicate-driven cascade, multi-hop cascade in one tick.

**3. `it("DGSM persistence: state survives serialize/rehydrate cycle")`**

- Set up: same event as Scenario 1 (cumulative pray, requires 3)
- Submit "pray" 2 times across 2 ticks; assert tracker count = 2 in DGSM
- "Save": call `dgsm.toJSON()` (or whatever DGSM's serialize is) → JSON
- Build a NEW `DynamicGameStateManager` from that JSON; build a NEW `TickEngine` referencing the new DGSM (with same events config)
- "Load": call `dgsm.fromJSON()` (or however)
- Submit "pray" once more on the new engine; tick once
- Assert: tracker count = 3 (rehydrated from 2 + new pray); event status is `completed`; SAN effects applied

Covers: `ScriptedEventState` round-trip through DGSM JSON (no separate runner serialize path), lazy-init of events that already have rehydrated state, end-to-end persistence happy path.

#### Shared helper

```ts
function makeTestEngine(events: ScriptedEvent[]): {
  dgsm: DynamicGameStateManager;
  engine: TickEngine;
  seedNpc: (id: string, sceneId: string) => void;
  submitAndTick: (npcId: string, actionText: string, definitionId: string, sceneId: string) => Promise<void>;
}
```

The 3 scenarios share this setup — keeps each `it` body tight on the actual assertion logic.

#### Coverage trade-offs (accepted)

- **Not covered:** maxCascade overflow logging, `failWhen` / `onFail` path (symmetric to fireWhen / onComplete), `delay`/`duration` pending state explicitly (Scenario 3 indirectly stresses pending-state persistence), individual predicate leaf ops beyond the 3 used (`actionCommittedThisTick`, `trackerCount`, `eventStatus`).
- **Acceptable risks:** failure-path regressions and edge-case predicate bugs may slip through; Phase E end-to-end smoke test (booting a real session) catches most integration-level regressions.

#### Code size estimate

~200 lines: 3 scenarios × ~50 lines + helper ~50 lines.

---

### Task C2: ScriptedEvent loader

**Files:**
- Create: `src/engine/scriptedEvents/loader.ts`
- Modify: `src/state/moduleLoader.ts` — scan `scripted-events/` directory, call loader

Implements §C-loader above. No standalone test (covered by C3 integration test loading a fake module via injected `ScriptedEventFile[]`).

- [ ] **Step 1: Implement loader**

Create `src/engine/scriptedEvents/loader.ts` per §C-loader signature:
- Hand-written recursive validator (no schema lib)
- Two-pass validation: structural first, then reference integrity
- Aggregate all errors before throwing `ScriptedEventLoadError`

- [ ] **Step 2: Integrate into moduleLoader**

In `src/state/moduleLoader.ts`, after existing setup loading:
- Check for `data/Mods/<modName>/scripted-events/` directory
- Read all `*.json` files (sorted by filename)
- Call `loadScriptedEvents(files)`
- Add result to module data record

- [ ] **Step 3: DB persistence wiring**

When module is imported via existing tooling, `ModuleSetup.data.scriptedEvents` gets the merged array. SimulationRunner reads from there at session start.

---

### Task C3: ScriptedEventRunner + DGSM extensions

**Files:**
- Modify: `src/state/types.ts` — add `scriptedEventStates: Record<string, ScriptedEventState>` to state shape
- Modify: `src/state/DynamicGameState.ts` — add 4 accessor methods + state init
- Replace: `src/engine/core/scriptedEventRunner.ts` (currently stub from Phase B pre-work)
- Create: `src/engine/core/__tests__/scriptedEventRunner.integration.test.ts` (per §C-testing)
- Modify: `src/engine/core/tickEngine.ts` — pass `scriptedEvents` from `opts` into Runner constructor (already done by Phase B's `createTickEngine`; just verify wiring)

- [ ] **Step 1: Extend DGSM**

Add to `state` shape in `src/state/types.ts`:
```ts
scriptedEventStates: Record<string /* eventId */, ScriptedEventState>;
```
(import `ScriptedEventState` from `src/engine/scriptedEvents/types.js`)

In `createInitialDynamicGameState()`: initialize `scriptedEventStates: {}`.

Add to `DynamicGameStateManager`:
```ts
getScriptedEventState(eventId: string): ScriptedEventState | undefined;
setScriptedEventState(eventId: string, state: ScriptedEventState): void;
getAllScriptedEventStates(): Record<string, ScriptedEventState>;
removeScriptedEventState(eventId: string): void;
```
Methods read/write `this.state.scriptedEventStates[eventId]`. `setScriptedEventState` bumps `lastUpdated`.

- [ ] **Step 2: Implement ScriptedEventRunner per §C-runtime**

Replace the stub at `src/engine/core/scriptedEventRunner.ts` with the full implementation per §C-runtime spec:
- `run(input)` per pseudocode
- `evaluatePredicate` / `evaluateCharacterPredicate` / `evaluateScenePredicate` (per §C-runtime evaluator definitions)
- `update_trackers` (per §C-runtime spec)
- `expand_effects` (per §C-runtime + §6 effect kinds)
- `applyTransitionEffects` recursive helper for `event.transition` cascade (with own depth cap matching `MAX_CASCADE = 8`)
- All state reads/writes go through `input.dgsm.getScriptedEventState` / `setScriptedEventState`. **No private `eventStates` Map on the Runner.**

- [ ] **Step 3: Write integration test**

Create `src/engine/core/__tests__/scriptedEventRunner.integration.test.ts` with the 3 scenarios from §C-testing (cumulative+effect, cascade, persistence).

- [ ] **Step 4: Run test**

```
npx vitest run src/engine/core/__tests__/scriptedEventRunner.integration.test.ts
```
Expected: 3 PASS.

---
## Phase D — Feature Migrations

Each feature migration task has the same shape:

1. Read the existing feature to understand its current behavior (DGSM calls, state keys, propagation).
2. Write a new-interface test case that exercises the core behavior.
3. Rewrite the feature as a new `WorldFeature` returning `StateChange[]` — no DGSM writes.
4. Run the test.

Priorities (per spec §3 convention):

| Feature | stateScope | priority |
|---|---|---|
| weather | region | 100 |
| lighting | scene | 150 |
| fire | scene | 200 |
| stamina | character | 300 |
| sanity | character | 310 |

### Task D1: Fire feature

**Files:**
- Modify: `src/engine/features/fireFeature.ts` (full rewrite)
- Test: `src/engine/features/__tests__/fireFeature.test.ts` (rewrite if exists)

- [ ] **Step 1: Read the current file**

Run: `cat src/engine/features/fireFeature.ts` (in your head — use `Read` tool). Note every DGSM mutation.

- [ ] **Step 2: Write the failing test**

```ts
// src/engine/features/__tests__/fireFeature.test.ts
import { describe, it, expect } from "vitest";
import { fireFeature } from "../fireFeature.js";
import type { FeatureReadContext } from "../../core/featureReadContext.js";

function ctxFor(sceneId: string, intensity?: number): FeatureReadContext {
  return {
    gameDay: 1,
    tickTime: "08:00",
    tickDurationMinutes: 1,
    getSceneIds: () => [sceneId],
    getScene: (id) => id === sceneId ? { sceneId, characterIds: ["npc1"], conditions: [] } : undefined,
    getCharacter: (id) => id === "npc1" ? { characterId: id, sceneId, hp: 10, maxHp: 10, san: 50, maxSan: 50, fatigue: 0, dex: 50, alive: true } : undefined,
    getCharactersInScene: (id) => id === sceneId ? [{ characterId: "npc1", sceneId: id, hp: 10, maxHp: 10, san: 50, maxSan: 50, fatigue: 0, dex: 50, alive: true }] : [],
    getRegionId: () => undefined,
    getFeatureState: <T,>(k: string) => (k === sceneId && intensity !== undefined ? ({ intensity } as unknown as T) : undefined),
    getAllFeatureStates: () => (intensity !== undefined ? [{ key: sceneId, state: { intensity } as unknown }] : []),
    getOtherFeatureState: () => undefined,
  } as FeatureReadContext;
}

describe("fireFeature", () => {
  it("onTick produces hp deltas for characters in burning scenes proportional to intensity", () => {
    const changes = fireFeature.onTick!(ctxFor("s1", 3));
    const hp = changes.filter((c) => c.kind === "character.hp");
    expect(hp).toHaveLength(1);
    expect(hp[0]).toMatchObject({ characterId: "npc1", sourceFeatureId: "fire" });
    expect(hp[0].delta).toBeLessThan(0);
  });

  it("declares correct scope + affectedKinds", () => {
    expect(fireFeature.stateScope).toBe("scene");
    expect(fireFeature.affectedKinds).toContain("character.hp");
  });
});
```

- [ ] **Step 3: Rewrite the feature**

Template (numeric constants chosen to roughly match current behavior — adjust based on what the existing file does):

```ts
// src/engine/features/fireFeature.ts
import type { WorldFeature } from "../core/worldFeature.js";
import type { StateChange } from "../core/types.js";

interface FireSceneState {
  intensity: number; // 0–5
  ignitedOnDay: number;
  ignitedAtTime: string;
}

const DAMAGE_PER_INTENSITY_PER_TICK = 1; // ≈1 hp per intensity per minute tick

export const fireFeature: WorldFeature = {
  id: "fire",
  description: "Localized fire that damages characters and can spread.",
  stateScope: "scene",
  affectedKinds: ["character.hp", "scene.addCondition", "scene.removeCondition", "feature.setState", "feature.removeState", "event.emit"],
  effectSummary:
    "Burns characters in the scene proportional to intensity; spreads to adjacent scenes when intensity is high.",
  impactRange: { "character.hp": [-5, 0] },
  priority: 200,
  propagation: { tickInterval: 3, maxHops: 2 },

  stateDescription(ctx) {
    const states = ctx.getAllFeatureStates<FireSceneState>();
    if (states.length === 0) return "No active fires.";
    return states
      .map((s) => `Scene ${s.key}: intensity ${s.state.intensity}`)
      .join("; ");
  },

  onTick(ctx) {
    const out: StateChange[] = [];
    const states = ctx.getAllFeatureStates<FireSceneState>();
    for (const { key: sceneId, state } of states) {
      const chars = ctx.getCharactersInScene(sceneId);
      for (const c of chars) {
        out.push({
          kind: "character.hp",
          characterId: c.characterId,
          delta: -state.intensity * DAMAGE_PER_INTENSITY_PER_TICK,
          sourceFeatureId: "fire",
          reason: "burn",
        });
      }
    }
    return out;
  },

  onActionCommit(step, _outcome, _ctx) {
    // If a character's action is "douse", reduce intensity by 1 (or snuff if 0)
    if (step.definitionId === "douse_fire") {
      return [
        {
          kind: "feature.setState",
          featureId: "fire",
          key: step.executionSceneId,
          state: { intensity: 0 }, // simplest form
        },
      ];
    }
    return [];
  },

  onPropagate(source, ctx) {
    const state = ctx.getFeatureState<FireSceneState>(source.sceneId);
    if (!state || state.intensity < 3) {
      return { spreadToSceneIds: [], changes: [] };
    }
    // Simplified: caller will iterate adjacent scenes via DGSM topology.
    // For now, signal spread by emitting a featureEvent; actual adjacent
    // logic can be kept in DGSM helpers or an injected helper.
    return {
      spreadToSceneIds: [],
      changes: [
        {
          kind: "event.emit",
          event: {
            type: "fire.spreadPressure",
            sceneId: source.sceneId,
            data: { intensity: state.intensity },
          },
        },
      ],
    };
  },
};
```

- [ ] **Step 4: Run test**

Run: `npx vitest run src/engine/features/__tests__/fireFeature.test.ts`
Expected: PASS.

---

### Task D2: Weather feature

Same shape as D1. Read `src/engine/features/weatherFeature.ts`. Port to:

- `stateScope: "region"` (weather is per-region, not per-scene)
- `priority: 100` (runs first: environment affects everything downstream)
- `affectedKinds`: `["connection.setBlock", "scene.addCondition", "scene.removeCondition", "feature.setState", "feature.removeState"]`
- `propagation`: weather fronts can move between regions — use `{ tickInterval: 10, maxHops: 3 }` or whatever the current file uses
- **Skill modifiers:** emitted via `scene.addCondition` with `mechanicalEffect.skillPenalty` (e.g., storm → `{ Spot: -10, Listen: -20 }`). Resolver aggregates conditions at skill-check time; no per-feature hook.

Write a new-interface test that exercises `onTick` → producing scene conditions over all scenes in a storming region. Rewrite and run.

- [ ] **Step 1: Read** `src/engine/features/weatherFeature.ts`
- [ ] **Step 2: Write failing test** at `src/engine/features/__tests__/weatherFeature.test.ts` asserting (a) `stateScope === "region"`, (b) `onTick` returns `scene.addCondition` for every scene in the region that has active weather state, (c) at least one such condition carries `mechanicalEffect.skillPenalty` with Spot/Listen entries when weather is active.
- [ ] **Step 3: Rewrite**
- [ ] **Step 4: Run** `npx vitest run src/engine/features/__tests__/weatherFeature.test.ts`

---

### Task D3: Lighting feature

- [ ] **Step 1: Read** `src/engine/features/lightingFeature.ts`
- [ ] **Step 2: Write failing test** asserting (a) `stateScope === "scene"`, `priority: 150`, `affectedKinds` includes `scene.addCondition`; (b) dark scenes get a `scene.addCondition` whose `mechanicalEffect.skillPenalty.Spot` is negative; (c) no state changes if torch lit.
- [ ] **Step 3: Rewrite** to new interface.
- [ ] **Step 4: Run** `npx vitest run src/engine/features/__tests__/lightingFeature.test.ts`

---

### Task D4: Stamina feature

- [ ] **Step 1: Read** `src/engine/features/staminaFeature.ts`
- [ ] **Step 2: Write failing test** asserting (a) `stateScope === "character"`, `priority: 300`; (b) `onActionCommit` increases fatigue for strenuous action definitions; (c) `onTick` slowly regenerates fatigue for resting characters via `character.fatigue` with negative delta.
- [ ] **Step 3: Rewrite** — key wrinkle: `stateScope === "character"` means the feature stores per-NPC state under the character's id, not the scene's.
- [ ] **Step 4: Run** `npx vitest run src/engine/features/__tests__/staminaFeature.test.ts`

---

### Task D5: Sanity feature

- [ ] **Step 1: Read** `src/engine/features/sanityFeature.ts`
- [ ] **Step 2: Write failing test** asserting (a) `stateScope === "character"`, `priority: 310`; (b) on a `character.san` delta arriving via a feature event (e.g., "saw corpse"), san drops — but note sanity feature is typically reactive: it translates *witnessed events* into san deltas. Since `onEvent` is removed, sanity now observes `committed actions` via DGSM state or through its own `onActionCommit` hook.
- [ ] **Step 3: Rewrite** — the sanity feature becomes simpler: it uses `onActionCommit` to check whether a committed action involved a horror-tagged target (based on DGSM state queried via context) and emits `character.san` deltas.
- [ ] **Step 4: Run** `npx vitest run src/engine/features/__tests__/sanityFeature.test.ts`

---

### Task D6: Delete `eventTriggerFeature.ts` + obsolete shared helpers

**Files:**
- Delete: `src/engine/features/eventTriggerFeature.ts`
- Modify: `src/engine/registerDefaults.ts` — remove the import + registration (will be further overhauled in Task E2)
- Delete: any eventTrigger-specific exports from `src/engine/types.ts`

- [ ] **Step 1: Search for all imports of eventTriggerFeature**

Run: `rg -l eventTriggerFeature src/` — record paths.

- [ ] **Step 2: Remove all those imports and references**

In `registerDefaults.ts`, delete the `registerFeature(eventTriggerFeature)` line and its import. Anywhere else, delete.

- [ ] **Step 3: Delete the file**

Run: `rm src/engine/features/eventTriggerFeature.ts`

- [ ] **Step 4: Type-check**

Run: `pnpm build:tsc`
Expected: no new errors. (Existing `tickProcessor.ts` still references the old-interface features; that's addressed in Phase E.)

---

## Phase E — Integration, Cutover, Cleanup

### Task E1: Role-sim impact gate handler

**Files:**
- Create: `src/simulation/roleSim/impactGateHandler.ts`
- Create: `src/simulation/roleSim/memoryEventWriter.ts`
- Move: `src/engine/runtime/impactPipeline.ts` → `src/simulation/roleSim/impactPipeline.ts`
- Test: `src/simulation/roleSim/__tests__/impactGateHandler.test.ts`

Role sim subscribes to `TickEngine.on("tickCompleted")` and runs the impact gate LLM. For each affected NPC, decides whether to interrupt — and if so, calls `tickEngine.interruptAction(handle, reason)`. Also subscribes to `actionInterrupted` / `actionCancelled` / `featureEvent` for NPC memory writes.

- [ ] **Step 1: Write the failing test**

```ts
// src/simulation/roleSim/__tests__/impactGateHandler.test.ts
import { describe, it, expect, vi } from "vitest";
import { ImpactGateHandler } from "../impactGateHandler.js";

describe("ImpactGateHandler", () => {
  it("calls tickEngine.interruptAction when LLM says interrupt", async () => {
    const interruptFn = vi.fn().mockReturnValue({ applied: true, remainingChainCancelled: 1 });
    const handler = new ImpactGateHandler({
      runImpactGate: vi.fn().mockResolvedValue({
        decisions: [
          {
            characterId: "npc1",
            shouldInterrupt: true,
            reason: { triggerKind: "featureEvent", description: "fire nearby" },
            handleId: "h1",
          },
        ],
      }),
      tickEngine: { interruptAction: interruptFn } as never,
      getActiveHandleFor: () => ({ id: "h1", characterId: "npc1", submittedAt: { day: 1, tickTime: "00:00" } }),
    });
    await handler.onTickReport({
      tickTime: { day: 1, tickTime: "08:00" },
      commits: [],
      interruptions: [],
      cancellations: [],
      featureEvents: [{ type: "fire.spreadPressure", sceneId: "s1" }],
      stateChanges: [],
      damageReports: [],
    });
    expect(interruptFn).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/simulation/roleSim/impactGateHandler.ts
import type { TickEngine } from "../../engine/core/tickEngine.js";
import type { TickReport } from "../../engine/core/types.js";

export interface ImpactGateDeps {
  runImpactGate: (report: TickReport) => Promise<{
    decisions: Array<{
      characterId: string;
      shouldInterrupt: boolean;
      reason?: import("../../engine/core/types.js").InterruptReason;
      handleId: string;
    }>;
  }>;
  tickEngine: Pick<TickEngine, "interruptAction">;
  getActiveHandleFor: (characterId: string, handleId: string) => import("../../engine/core/types.js").ActionHandle | undefined;
}

export class ImpactGateHandler {
  constructor(private deps: ImpactGateDeps) {}

  async onTickReport(report: TickReport): Promise<void> {
    if (report.featureEvents.length === 0) {
      return; // fast path: no events → no LLM call
    }
    const result = await this.deps.runImpactGate(report);
    for (const d of result.decisions) {
      if (!d.shouldInterrupt || !d.reason) continue;
      const handle = this.deps.getActiveHandleFor(d.characterId, d.handleId);
      if (!handle) continue;
      this.deps.tickEngine.interruptAction(handle, d.reason);
    }
  }
}
```

```ts
// src/simulation/roleSim/memoryEventWriter.ts
import type { TickEngine } from "../../engine/core/tickEngine.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";

/** Subscribes to engine events and writes NpcMemory rows. */
export function wireMemoryEventWriter(
  tickEngine: TickEngine,
  memory: NpcMemoryManager,
): () => void {
  const offs = [
    tickEngine.on("actionInterrupted", async (action, reason) => {
      await memory.recordEvent({
        characterId: action.characterId,
        type: "event",
        content: `Interrupted while ${action.actionText}: ${reason.description}`,
        gameDay: action.completedAt.day,
        gameTime: action.completedAt.tickTime,
      });
    }),
    tickEngine.on("actionCancelled", async (action) => {
      await memory.recordEvent({
        characterId: action.characterId,
        type: "event",
        content: `Cancelled plan to ${action.actionText}`,
        gameDay: action.completedAt.day,
        gameTime: action.completedAt.tickTime,
      });
    }),
    tickEngine.on("featureEvent", async () => {
      // Feature-event → memory routing is per-event-type; skip for MVP
    }),
  ];
  return () => offs.forEach((off) => off());
}
```

- [ ] **Step 3: Move `impactPipeline.ts`**

Run: `mv src/engine/runtime/impactPipeline.ts src/simulation/roleSim/impactPipeline.ts`

Update all imports to the new path.

- [ ] **Step 4: Run test**

Run: `npx vitest run src/simulation/roleSim/__tests__/impactGateHandler.test.ts`
Expected: PASS.

---

### Task E2: Rewire SimulationRunner

**Files:**
- Modify: `src/simulation/SimulationRunner.ts`
- Modify: `src/engine/registerDefaults.ts` — produce the `WorldFeature[]` array for TickEngine

The old `runSimulationTick` is replaced by a `TickEngine` instance owned by `SimulationRunner`. Each external tick cadence call becomes `await this.tickEngine.tick()`.

- [ ] **Step 1: Update `registerDefaults.ts`**

```ts
// src/engine/registerDefaults.ts
import { fireFeature } from "./features/fireFeature.js";
import { weatherFeature } from "./features/weatherFeature.js";
import { lightingFeature } from "./features/lightingFeature.js";
import { staminaFeature } from "./features/staminaFeature.js";
import { sanityFeature } from "./features/sanityFeature.js";
import type { WorldFeature } from "./core/worldFeature.js";

export function getDefaultFeatures(): WorldFeature[] {
  return [weatherFeature, lightingFeature, fireFeature, staminaFeature, sanityFeature];
}
```

Delete the old class-based `GameEngineRegistry` exports.

- [ ] **Step 2: Rewrite `SimulationRunner.executeTick`**

In `SimulationRunner`:

- In the constructor, construct the `TickEngine` with `createTickEngine({ ... })`, passing the DGSM, the features array from `getDefaultFeatures()`, the scripted events via `loadScriptedEventsFromModuleData(moduleData)`, and wiring the interpreter + resolver as `interpretAction` / `resolve` callbacks.
- Subscribe the `ImpactGateHandler` to `tickCompleted`.
- Subscribe the memory event writer.
- In `executeTick()`, replace the call to `runSimulationTick` with `await this.tickEngine.tick()`.
- For action submission: NPC planning agent's per-NPC `"what's next"` loop now calls `this.tickEngine.submitAction(...)`. Replace the old `in_progress + due` node scheduling machinery (the parts of tickProcessor Phase 1) with per-NPC submission driven by a thin role-sim controller.

Skeleton:

```ts
// inside SimulationRunner constructor
import { EncounterScanner } from "../engine/core/scanners/encounterScanner.js";

this.tickEngine = createTickEngine({
  dgsm: this.dgsm,
  features: getDefaultFeatures(),
  scriptedEvents: loadScriptedEventsFromModuleData(moduleData),
  emergentScanners: [
    new EncounterScanner(),
    // future: new DiscoveryScanner(), new WorldEventScanner(), ...
  ],
  interpretAction: (input) => interpretAction(input, this.ctx),
  resolve: (step, ctx) => resolveState(step, ctx, this.ctx),
  getActorDex: (id) => this.dgsm.getNpcProfile(id)?.attributes.DEX ?? 0,
  tickDurationMinutes: 1,
  lang: this.language,
  persistedState: initialPersistedTickEngineState,
});

this.impactHandler = new ImpactGateHandler({
  runImpactGate: (report) => runImpactPipeline(report, this.dgsm, this.ctx),
  tickEngine: this.tickEngine,
  getActiveHandleFor: (cid, hid) => this.activeHandles.get(`${cid}:${hid}`),
});
this.tickEngine.on("tickCompleted", (r) => this.impactHandler.onTickReport(r));
wireMemoryEventWriter(this.tickEngine, this.memoryManager);
```

Adapt NPC planning layer to `submitAction` calls. Specifically: replace `ensureNpcNodesAvailable` + `getInProgressNodes` + `getDueNpcNodes` with a new per-NPC loop that:

1. Queries the planning agent for the next action text.
2. Calls `tickEngine.submitAction({ characterId, actionText, sceneId, ... })`.
3. Stores the returned handle in `this.activeHandles` keyed by `characterId:handleId`.

Save persisted state at appropriate checkpoints: when `SimulationRunner` writes `SimulationRuntime.gameState`, include `tickEngine: this.tickEngine.serialize()` in the blob.

- [ ] **Step 3: Type-check**

Run: `pnpm build:tsc`
Expected: no errors. (There will be. Fix them until there aren't.)

---

### Task E3: Delete dead code

**Files:**
- Delete: `src/engine/runtime/tickProcessor.ts`
- Delete: `src/engine/queue/actionQueue.ts`
- Delete: `src/engine/registry.ts`
- Delete: `src/engine/resolver/applyStateResolution.ts` (superseded by Applier)
- Delete: `src/engine/shared/nodeHelpers.ts`'s `makeAction()` (obsolete — built legacy `CharacterAction` shape from `PlanNode`; no callers after tickProcessor removal)
- Delete: `src/planning/revisionHelpers.ts`'s `buildInterruptedAction()` (same reason)
- Delete or gut: `src/engine/runtime/movementTick.ts`'s `buildMovementAction()` (produces legacy shape; verify whether the resolver still needs this helper or if the new commit flow suffices — delete if not called)
- Modify: `src/engine/types.ts` — remove old `WorldFeature` type; keep unrelated types
- Modify: `src/engine/shared/impactPropagation.ts` — any reference to legacy `CharacterAction` fields (`impact`, `successLevel`, `rollDetail`) must be removed or rewritten; this file's role may shrink since impact gate moved to role sim
- Modify: `src/engine/runtime/resolutionExecutionContext.ts` — same; strip legacy field usage

- [ ] **Step 1: Search for consumers of each to be deleted**

Run (one per file):
- `rg -l 'runtime/tickProcessor' src/ client/ tests/`
- `rg -l 'queue/actionQueue' src/ client/ tests/`
- `rg -l "from.*engine/registry" src/ client/ tests/`
- `rg -l 'applyStateResolution' src/ client/ tests/`
- `rg -l 'makeAction\b' src/ client/ tests/`
- `rg -l 'buildInterruptedAction\b' src/ client/ tests/`
- `rg -l 'buildMovementAction\b' src/ client/ tests/`

Each path that appears must be either fixed (replace import with new-path equivalent), flagged, or included in this task's deletions.

- [ ] **Step 2: Delete files and obsolete helpers**

Run: `rm src/engine/runtime/tickProcessor.ts src/engine/queue/actionQueue.ts src/engine/registry.ts src/engine/resolver/applyStateResolution.ts`

For files that are kept but have obsolete helpers (`nodeHelpers.ts`, `revisionHelpers.ts`, `movementTick.ts`), delete just the obsolete function(s) — not the whole file.

- [ ] **Step 3: Type-check**

Run: `pnpm build:tsc`
Expected: no errors. Fix any remaining stale imports.

---

### Task E4: Re-home `SceneCondition` and `CharacterAction` in `src/planning/types.ts`

**Files:**
- Modify: `src/planning/types.ts` — delete legacy `SceneCondition` and legacy `CharacterAction`; re-export both from `src/engine/core/types.ts`

Both types now have a single canonical definition in `src/engine/core/types.ts`. `planning/types.ts` only re-exports, so existing imports like `import type { CharacterAction } from "../planning/types.js"` continue to resolve.

- [ ] **Step 1: Delete legacy definitions**

In `src/planning/types.ts`:
- Remove the `interface SceneCondition { ... }` block (currently lines 12–18 — owner-less, uses old `skillPenalty: Array<...>` / `blocked: boolean`)
- Remove the `export interface CharacterAction { ... }` block (currently lines 201–235 — rich shape with `impact` / `skill` / `rollDetail` / `discoveries` / `damagedEvidence` / `perTargetResults` / `stateMemories` / `characterName` / `status` / `outcome: string` etc.)

- [ ] **Step 2: Add re-exports**

```ts
// src/planning/types.ts (near the top)
export type { SceneCondition, CharacterAction } from "../engine/core/types.js";
```

- [ ] **Step 3: Type-check**

Run: `pnpm build:tsc`
Expected: errors at every call site that still reads legacy fields (`impact`, `skill`, `rollDetail`, `successLevel`, `status`, `outcome` as string, `characterName`, `discoveries`, `damagedEvidence`, `stateMemories`, `perTargetResults`, `type: PlanNodeType`, or the old `skillPenalty: Array<...>` / `blocked: boolean`).

Fix each error by either:
- Looking the value up from DGSM at the call site (e.g., `characterName` ← `dgsm.getNpcProfile(characterId)?.name`)
- Moving the semantic into a new place (e.g., `outcome: string` human text now lives as `CharacterAction.outcome?.description` if present, or derived from `StateResolution`)
- Deleting the code path entirely if it was tied to the old pipeline that's gone

SimulationEventEmitter's adaptation is in E4.5; most non-emitter fixes happen here.

- [ ] **Step 4: Re-run type-check**

Run: `pnpm build:tsc`
Expected: no errors.

---

### Task E4.5: Adapt `SimulationEventEmitter` to the simplified `CharacterAction`

**Files:**
- Modify: `src/simulation/SimulationEventEmitter.ts`
- Modify: `src/simulation/__tests__/SimulationEventEmitter.test.ts`
- Modify (follow-up): `client/src/**` — any component reading WebSocket event fields that changed

The old emitter packaged every legacy `CharacterAction` field (`characterName`, `impact`, `skill`, `rollDetail`, `successLevel`, `status`, human `outcome`) directly into the WebSocket payload. The new `CharacterAction` doesn't carry those fields; the emitter must derive them from DGSM and the accompanying `PlannedOutcome` (`outcome.narrative`, `outcome.stateChanges`, `outcome.elapsedMinutes`).

- [ ] **Step 1: Add DGSM dependency to the emitter**

Update the constructor signature so the emitter has a `DynamicGameStateManager` handle:

```ts
// src/simulation/SimulationEventEmitter.ts
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { CharacterAction } from "../engine/core/types.js";

export class SimulationEventEmitter {
  constructor(
    private readonly broadcaster: Broadcaster,
    private readonly dgsm: DynamicGameStateManager,
  ) {}
  // ...
}
```

Update the site(s) that instantiate it (most likely `SimulationRunner`) to pass `this.dgsm`.

- [ ] **Step 2: Rewrite the action-to-event converter**

Replace the current helper (likely `actionsToEvents(actions: CharacterAction[], dayBefore: number)` or similar) with a version that computes the legacy-style fields on the fly:

```ts
private toWireEvent(action: CharacterAction): WireSimulationEvent {
  const character = this.dgsm.getNpcProfile(action.characterId);
  const outcomeText = action.outcome?.description ?? "";
  return {
    characterId: action.characterId,
    characterName: character?.name ?? action.characterId,
    gameTime: action.completedAt.tickTime,
    gameDay: action.completedAt.day,
    action: action.actionText,
    location: action.sceneId,
    definitionId: action.definitionId,
    targetCharacterIds: action.targetCharacterIds,
    outcome: outcomeText,
    // `impact`, `skill`, `rollDetail`, `successLevel`, `status` intentionally omitted;
    // the impact-gate event stream carries those now, not the action-completion event.
  };
}
```

If UI code relies on any removed field, see Step 4.

- [ ] **Step 3: Update the emitter test**

`src/simulation/__tests__/SimulationEventEmitter.test.ts` currently builds `CharacterAction` fixtures with the old rich shape. Rewrite the `makeAction(...)` helper and assertions against the new fields (`actionText`, `sceneId`, `completedAt`, `definitionId`, `outcome?.description`) plus the injected DGSM stub.

Run: `npx vitest run src/simulation/__tests__/SimulationEventEmitter.test.ts`
Expected: PASS.

- [ ] **Step 4: Reconcile client consumers**

Search the frontend for references to removed wire fields:

- `rg "impact" client/src/`
- `rg "rollDetail" client/src/`
- `rg "successLevel" client/src/`
- `rg "\\bstatus\\b" client/src/ --type=ts --type=tsx | rg -i "action|event"`
- `rg "characterName" client/src/`

For each hit, either:
- Drop the field from the UI (if the UI lives fine without it — e.g., `impact` was for server-side gating, not display),
- Derive it client-side from other data already broadcast (e.g., character roster is cached client-side, `characterName` can be looked up by `characterId`),
- Extend the wire event in Step 2 to include what the UI truly needs.

Do this surgically — only touch components that actually rendered the removed fields. The goal is a working UI, not a full redesign.

- [ ] **Step 5: Final type-check + build**

Run: `pnpm build:tsc && cd client && pnpm build`
Expected: both exit 0.

---

### Task E5: End-to-end smoke verification

**Files:**
- No new files; run existing test suite + a small scripted session.

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test -- --run`
Expected: all tests pass. Fix any failures.

- [ ] **Step 2: Run the type-checker**

Run: `pnpm build:tsc`
Expected: exits 0.

- [ ] **Step 3: Run the Biome linter**

Run: `pnpm check`
Expected: exits 0 (auto-fix applies formatting / import sort).

- [ ] **Step 4: Boot the dev server + run a short simulated session**

Run: `pnpm chat:dev` (or `pnpm chat`)

Confirm via UI or server logs:
- A fresh session boots.
- NPC actions flow: submitted → activated → committed → emitted.
- Feature ticks fire (set a small fire, watch hp deltas arrive).
- Trigger a scripted event (pray at the altar in a test module) → observe sanity loss effect.
- Trigger an interrupt (run the impact gate) → observe `actionInterrupted` event + NPC memory entry.

If anything misbehaves, fix before proceeding.

- [ ] **Step 5: Verify existing `SimulationRuntime` rows are unloadable (expected)**

Boot the server, try to resume an old session (pre-refactor row in DB). Expect: loading throws with a type/shape error. This is the accepted break per §3 "Backwards Compatibility".

Note any thrown error and confirm the failure is at load time (not silent data corruption).

---

### Task E6: Final commit

- [ ] **Step 1: Review git status + diff**

Run: `git status` and `git diff --stat`
Confirm the expected file set: ~20 new files under `src/engine/core/`, ~5 new files under `src/engine/scriptedEvents/` + `src/simulation/roleSim/`, ~5 modified features, 4 deletions, a few modified top-level files.

- [ ] **Step 2: Stage and commit**

Run (all changes in one commit per user preference):

```bash
git add src/ docs/superpowers/plans/2026-04-21-engine-architecture-refactor-plan.md docs/superpowers/specs/2026-04-20-engine-architecture-refactor-design.md
git commit -m "$(cat <<'EOF'
refactor(engine): replace tickProcessor god function with TickEngine

Rebuild the tick loop as a queue-based orchestrator composed of focused
subsystems (Applier, FeatureRunner, ScriptedEventRunner, EmergentEventEmitter,
TickOrchestrator) behind the TickEngine API. Features now return StateChange[]
instead of mutating DGSM, scripted story beats move into a dedicated subsystem
with declarative module data, and the impact gate moves out to role sim. No
backwards compatibility with pre-refactor SimulationRuntime rows.

See docs/superpowers/specs/2026-04-20-engine-architecture-refactor-design.md
for full rationale and decisions; implementation plan in
docs/superpowers/plans/2026-04-21-engine-architecture-refactor-plan.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Verify commit landed**

Run: `git log --oneline -1`
Expected: one line showing the new commit.

---

## Self-review notes

### Spec coverage

| Spec section | Implemented by task |
|---|---|
| §3 Decisions — Resolver lazy per-step | B5 (activate phase calls resolve per step) |
| §3 Decisions — Interruption C 妥协版 | B5 `applyPendingInterrupt` + opts.interrupted pass-through |
| §3 Decisions — Global session queue | A4 |
| §3 Decisions — Multi-step chained entries | B3 ActionIntake fanout + A4 isLastStepInChain |
| §3 Decisions — Declarative WorldFeature | B1 + Phase D rewrites |
| §3 Decisions — Priority ordering | B1 constructor sorts by priority |
| §3 Decisions — TickEngine ignorant of NPC AI | B6 + E1 move impact gate to role sim |
| §3 Decisions — Interpreter at submit time | B3 ActionIntake |
| §3 Decisions — Sum + clamp + damageReport | A5 Applier.applyDelta |
| §3 Decisions — Connection refcount | A5 applySetBlockVote |
| §3 Decisions — No onEvent cross-feature | B1 FeatureRunner has no onEvent dispatch |
| §3 Decisions — Owner-only SceneCondition | A1 + E4 |
| §3 Decisions — No mid-chain modification | B6 only cancel/interrupt |
| §3 Decisions — No backwards compat | E5 step 5 confirms break is at load time |
| §3 Decisions — Impact gate in role sim | E1 |
| §3 Decisions — Streaming + batch events | B2 EventBus + B6 wiring |
| §3 Decisions — Cancel vs Interrupt APIs | B6 two distinct calls |
| §3 Decisions — ActionStep name | Everywhere |
| §3 Decisions — Feature state scope | A2 DGSM buckets + A3 context + A5 Applier routing |
| §3 Decisions — Skill-style metadata | B1 WorldFeature has affectedKinds / effectSummary / impactRange |
| §3 Decisions — ScriptedEventRunner subsystem | Phase C |
| §4 TickEngine API | B6 |
| §5 Internal Components | A4, A5, B1, B3, B4, B5 |
| §6 WorldFeature / StateChange / SceneCondition / ScriptedEvent types | A1, B1, C1 |
| §6 ScriptedEventReadContext | C3 `makeCtx` |
| §7 Deletions table | E3 + D6 |
| Legacy `CharacterAction` replacement | A1 canonical shape, E4 re-export, E4.5 emitter adaptation, E3 deletes obsolete builders |
| §8 "What stays" | Unchanged files |
| §10 tickProcessor file layout | File structure map above |
| §10 Migration plan | Phases A–E strangler → big-bang |
| §10 Per-feature migration cost | One task per feature (D1–D5) |
| §10 ActionStep persistence | B7 — JSON blob in SimulationRuntime.gameState |
| §10 Session resume | B7 `persistedState` + E2 wiring |
| §10 Handlers disposition | Not applicable — no `handlers/` directory exists in current codebase; handler-like logic lives in interpreter/resolver/tool_definitions and stays untouched |

### Placeholder scan

No "TBD" / "TODO" / "add validation" placeholders in the task bodies. D2–D5 reference "adjust based on what the existing file does" for numeric constants — this is unavoidable since the current fire/weather/lighting numeric behavior isn't a spec decision and shouldn't drift silently during refactor. The implementer is expected to read the existing feature before writing the new one.

### Type consistency

- `ActionStep` / `ActionHandle` / `StateChange` / `SceneCondition` / `FeatureEvent` / `TickReport` / `DamageReport` / `CharacterAction` / `InterruptReason` / `CancelResult` / `InterruptResult` / `FeatureStateScope` / `GameTime` — all defined once in `src/engine/core/types.ts` (Task A1), imported everywhere else.
- `WorldFeature` — defined in `src/engine/core/worldFeature.ts` (Task B1). No per-feature skill-modifier hook; skill modifiers flow through `SceneCondition.mechanicalEffect.skillPenalty` and `CharacterCondition.mechanicalEffect.skillPenalty`, aggregated by resolver / skill-check tool.
- `FeatureReadContext` — defined in `src/engine/core/featureReadContext.ts` (Task A3). No `CharacterView` / `SceneView` types — features consume raw `DynamicScene` / `DynamicNPCProfile`.
- `ScriptedEvent*` — defined in `src/engine/scriptedEvents/types.ts` (Task C1).
- DGSM method names used across tasks: `getScopedFeatureState`, `setScopedFeatureState`, `getAllScopedFeatureStates`, `removeScopedFeatureState`, `getAllSceneIds`, `getRegionIdForScene`, `getGameDay`, `setGameDay`, `getTickTime`, `setTickTime`, `getNpcProfile`, `registerNpcProfile`, `setCharacterField`, `markCharacterDead`, `addCharacterCondition`, `removeCharacterCondition`, `appendSceneCondition`, `removeSceneConditionsByFeatureId`, `ensureConnection`, `setConnectionBlocked`, `isConnectionBlocked` — all introduced/consolidated in Task A2. Consistency enforced by type-check at E5 (per the "batch test at end" preference, intermediate type-check failures between A2 and Phase D/E completion are expected and tolerated).
