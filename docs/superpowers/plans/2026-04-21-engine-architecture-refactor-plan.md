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
├── features/                             [MODIFY each — see Phase D redesign]
│   ├── fireFeature.ts                    [MODIFY] Port to new WorldFeature interface; contributes to EnvironmentReading
│   ├── weatherFeature.ts                 [MODIFY] Same; contributes temperature + illumination cap
│   ├── lightingFeature.ts                [DELETE] Split into sunFeature (contributor) + Applier illumination aggregation
│   ├── sunFeature.ts                     [NEW] Time-of-day illumination contributor + dark/blinding scene-condition observer
│   ├── staminaFeature.ts                 [MODIFY] Reads env.temperature; emits character.san on CON fail (no sanity import)
│   ├── itemDamageFeature.ts              [NEW] Reactor: env.temperature > 200°C → emit scene.damageItem
│   ├── sanityFeature.ts                  [DELETE] Relocates to src/simulation/roleSim/sanityGuidance.ts (LLM-judged)
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
    ├── memoryEventWriter.ts              [NEW] Subscribes to actionInterrupted/actionCancelled/featureEvent, writes NpcMemory
    └── sanityGuidance.ts                 [NEW] BOUT_OF_MADNESS_TABLE + SANITY_GUIDANCE_PROMPT fragment for resolver prompt

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
## Phase D — Feature Migrations + Environmental Reading Layer

> **Phase D redesign (2026-04-22):** the original plan proposed a mechanical port of each feature to the new interface, one-to-one. Review surfaced that the current code has **7 direct cross-feature state reads** (e.g. `lightingFeature` reading `fire.intensity`, `staminaFeature` calling `applySanityLoss(...)` directly). A raw port would preserve this coupling in StateChange-output clothing — ugly features with invisible dependencies on each other's private state.
>
> Phase D is restructured around an **EnvironmentReading** intermediate layer: features contribute to shared physical quantities (temperature, illumination, oxygen, noise, airborne hazards) at each location; other features react by reading the aggregated reading. Direct feature-to-feature state reads are banned after Phase D.
>
> Additionally, **`sanityFeature` relocates to role sim** (psychology is LLM-judged narrative, not physics-modeled mechanics). The BOUT-of-madness table becomes prompt-reference text; the LLM resolver decides bouts in-context and emits both `character.san` and `character.addCondition { expiresAt }` as part of its `PlannedOutcome`.
>
> **Spec document update** (§3 "sanity in role sim", §6 "EnvironmentReading + new StateChange kinds + `scene.damageItem`", and a new section on `WorldFeature.init()` + Phase 0) is done **once** at the end of Phase D, after all Phase D tests pass and before any Phase E task begins. Not per-task. Rationale: spec should reflect the final landed design, not the in-progress drafts; Phase D is where design details get finalized via implementation feedback, so spec sync waits for that. Doc debt is acknowledged during the Phase D window — readers who hit the spec during that time should defer to the plan.

### §D-env-architecture — EnvironmentReading layer

Per-location physical reading published in DGSM, consumed by features on the next tick:

```ts
// src/engine/core/types.ts
export interface EnvironmentReading {
  temperature: number;        // °C, baseline 20
  illumination: number;       // 0–5, baseline 3
  oxygen: number;             // 0–1, baseline 1
  noise: number;              // 0–5, baseline 0
  airborneHazards: string[];  // "smoke" | "toxic_gas" | ...
}

export const DEFAULT_ENVIRONMENT_READING: EnvironmentReading = {
  temperature: 20,
  illumination: 3,
  oxygen: 1,
  noise: 0,
  airborneHazards: [],
};
```

**Three new StateChange kinds** added to the union:

```ts
| {
    kind: "environment.contribute";
    locationId: string;
    quantity: "temperature" | "illumination" | "oxygen" | "noise";
    value: number;
    sourceFeatureId: string;
  }
| {
    kind: "environment.cap";
    locationId: string;
    quantity: "illumination";            // MVP: only illumination needs capping
    value: number;                       // maximum allowed final value
    sourceFeatureId: string;
  }
| {
    kind: "environment.hazard";
    locationId: string;
    add?: string[];                      // hazards to add
    remove?: string[];                   // hazards to remove
    sourceFeatureId: string;
  }
```

`environment.cap` exists because fog / storm need to *lower* illumination — the baseline reducer (`max`) would otherwise ignore their "darkening" contribution. A cap is applied after the max aggregation.

**Applier aggregation** (new Pass 1.5, between Pass 1 and Pass 2a):

| Quantity | Reducer | Baseline |
|---|---|---|
| temperature | `baseline + sum(contributions)` | 20 |
| illumination | `min(min(caps…), max(baseline, max(contributions)))` | 3 |
| oxygen | clamp-to-[0,1] of `baseline + sum(contributions)` | 1 |
| noise | `max(baseline, max(contributions))` | 0 |
| airborneHazards | `(union_of_adds) \\ (union_of_removes)` | `[]` |

Final reading written via `dgsm.setEnvironmentReading(locationId, reading)`. Only locations receiving contributions this tick get written; unvisited locations retain their last-known reading. Features that want their contribution to decay must **re-contribute every tick** — this is the natural pattern (fire keeps contributing while burning, weather keeps contributing while active).

**FeatureReadContext** gains:

```ts
getEnvironmentReading(locationId: string): EnvironmentReading;
```

**1-tick lag**: features contribute in Phase 5 (`onTick`), Applier computes final reading in Phase 9 (`flush`), readers see the new value from their `onTick` the NEXT tick. At 1 minute per tick this is imperceptible and avoids a second flush pass.

### §D-feature-responsibilities

Responsibility matrix after Phase D — contributors vs reactors, no cross-feature state reads:

| Feature | stateScope | priority | Contributes | Reacts to |
|---|---|---|---|---|
| **weather** | region | 100 | `temperature` (rain −10·intensity·0.2, snow −20, heat +30, cold −30)<br>`illumination.cap` (fog −1, storm −2 below baseline 3) | nothing |
| **sun** (replaces lighting) | global | 150 | `illumination` (sine-like sun curve; moonlight @ night) | env.illumination → emits `[Lighting]` scene conditions outside [3,4] |
| **fire** | scene | 200 | `temperature +intensity·100`<br>`illumination +intensity+1`<br>`oxygen −intensity·0.1`<br>`hazard smoke` @ intensity ≥ 2 | env.temperature < 5°C (cold rain) → faster decay |
| **stamina** | character | 300 | nothing | env.temperature ∉ [10,30]°C → +1× fatigue accel |
| **itemDamage** (new) | global | 350 | nothing | env.temperature > 200°C → emit `scene.damageItem` for 20% of flammable items |

7 direct cross-feature reads → 0 after Phase D.

### §D-sanity-relocation

`src/engine/features/sanityFeature.ts` is **deleted**. Its logic moves to:

- **`src/simulation/roleSim/sanityGuidance.ts`** — exports `BOUT_OF_MADNESS_TABLE` (data) and `SANITY_GUIDANCE_PROMPT` (prompt fragment)
- **LLM resolver** (which already produces `PlannedOutcome.stateChanges`) — decides bouts in-context, emits both the `character.san` delta AND the insanity `character.addCondition { expiresAt }` in the same outcome
- **Condition expiry** handled generically by Task D8 (not sanity-specific)
- **Persistent phobia/mania** = `character.addCondition` without `expiresAt`. Never auto-removed.

Action restrictions (e.g. "flee_only", "incapacitated") flow via the condition's `description` + `mechanicalEffect.globalSkillPenalty`. The LLM planner reads conditions naturally; no hardcoded `actionRestriction` enum needed.

**Accepted behavior reductions** (documented, not bugs):

- Silent SAN drops from stamina (exhaustion CON failure) no longer auto-trigger bouts. Bouts are narrative events; pure mechanical fatigue drain isn't a narrative event the LLM sees.
- Cumulative SAN-over-60-min threshold becomes LLM judgment — the resolver sees recent narrative context. If this proves insufficient in Phase E smoke tests, add `ctx.getRecentSanLosses(characterId, minutes)` helper and feed into resolver prompt (deferred, YAGNI).
- Scripted events dropping SAN don't auto-trigger bouts unless the event's `onComplete` also includes an insanity `character.addCondition` effect. Event authors must declare bouts explicitly — this is more controllable than the current implicit trigger.

### §D-testing strategy

The environmental reading layer's whole point is enabling clean **cross-feature interactions**. Per-feature unit tests verify implementation details in isolation — they miss the thing the architecture is actually for. Phase D testing is organized in **three layers**:

**Layer 1 — Middle-layer correctness (D0)**
`src/engine/core/__tests__/applier.environment.test.ts` — verifies the Applier's aggregation rules: sum / max / cap / set-union per quantity, baseline fallback for untouched locations, multi-contributor scenarios per quantity.

**Layer 2 — Feature interactions via the middle layer (Task D11)**
`src/engine/__tests__/integration/*.test.ts` — each test focuses on **one cross-feature chain** through the env layer. Specific chains are chosen during implementation (representative examples: fire → temperature → stamina-accel; weather(rain) → low-temp → fire decay; fire + weather(heat) → compound temperature → stamina ×2 accel; sun + fire → illumination max → no dark condition; stamina CON fail → SAN drop → condition expiry; sun's day/night curve → scene conditions over 24h). Each test uses real DGSM + real Applier + real feature set (no mocks), runs multi-tick scenarios, and asserts on the observable downstream effect — not on intermediate feature state.

**Layer 3 — Feature-internal invariants (embedded in D1/D2/D3/D4/D7 tasks)**
Only the algorithmic logic that interaction tests cannot naturally exercise:
- D1 fire: lifecycle (intensity 1→5→0 over correct tick counts), topology spread (scene→junction→road handoff, road burnRange endpoint triggers), aftermath threshold bucketing
- D2 weather: Markov transition row sums ≈ 1 over 1000 trials; `init()` fires once on fresh session, skipped on rehydrated
- D3 sun: time-of-day curve produces expected values at 04:00 / 12:00 / 18:00 / 22:00
- D4 stamina: fatigue level transition thresholds (480 / 960 min), exhaustion CON fail chance formula
- D7 itemDamage: 20% sample rate over 10 items → exactly 2 damaged; skips already-damaged items

Each Layer 3 test is deliberately narrow (~50-80 LOC) and avoids duplicating what Layer 2 tests already cover via real scenarios.

**Out of scope:**
- Old mock-DGSM feature tests at `src/engine/features/__tests__/*.test.ts` (~3000 LOC) are **deleted** — they test old-interface implementation details and cannot be ported cleanly.
- Exhaustive branch coverage of every intensity × weather-type × scene-indoor/outdoor combination. Phase E module smoke runs catch the edge cases that matter.

**Additional test cases:**
- **D5** — snapshot test on `SANITY_GUIDANCE_PROMPT` verifying BOUT table content
- **D8** — condition expiry case added to tickOrchestrator integration test
- **D9** — `globalSkillPenalty` aggregation case added to existing skill-check test

**Target total**: ~1000 LOC of new test code across layers. Net change: −2000 LOC (old 3000 → new ~1000). Test value shifts from isolated-feature branch coverage to architecturally-aligned interaction coverage.

### Revised task list

| Task | Action | Target LOC |
|---|---|---|
| **D0** | **[NEW]** EnvironmentReading + Applier aggregation + 3 new StateChange kinds + Layer-1 middle-layer test | ~250 prod + ~100 test |
| **D1** | Rewrite `fireFeature.ts` + Layer-3 internal-invariants test (lifecycle + topology + aftermath thresholds) | ~200 prod + ~150 test |
| **D2** | Rewrite `weatherFeature.ts`; add `WorldFeature.init()` hook + `TickOrchestrator` Phase 0; loader passthrough for `moduleSetup.featureInit.weather` + Layer-3 test (Markov + init fresh/rehydrated) | ~250 prod + ~100 test |
| **D3** | **[NEW]** `sunFeature.ts` (replaces `lightingFeature.ts`) + Layer-3 test (time-of-day curve) | ~100 prod + ~50 test |
| **D4** | Rewrite `staminaFeature.ts` (no sanity coupling) + Layer-3 test (level transitions + fail-chance formula) | ~150 prod + ~80 test |
| **D5** | **[DELETE]** `sanityFeature.ts`; create `src/simulation/roleSim/sanityGuidance.ts` + prompt snapshot test | ~150 prod + ~30 test |
| **D6** | **[DELETE]** `eventTriggerFeature.ts` | — |
| **D7** | **[NEW]** `itemDamageFeature.ts` + `scene.damageItem` StateChange kind + Layer-3 test (sample rate + skip-damaged) | ~100 prod + ~50 test |
| **D8** | **[NEW]** Condition expiry sweep in TickOrchestrator + test | ~30 prod + ~30 test |
| **D9** | **[NEW]** `CharacterCondition.mechanicalEffect.globalSkillPenalty` + skill-check aggregation + test | ~20 prod + ~20 test |
| **D11** | **[NEW]** Layer-2 interaction test suite at `src/engine/__tests__/integration/*.test.ts` | ~400 test |

Total Phase D: ~1250 LOC production + ~1000 LOC tests. Original plan: ~2900 LOC mechanical port + old per-feature tests kept. Cross-feature coupling: 7 → 0.

---

### Task D0: EnvironmentReading + Applier aggregation

**Files:**
- Modify: `src/engine/core/types.ts` — add `EnvironmentReading` + `DEFAULT_ENVIRONMENT_READING` + 3 new StateChange kinds
- Modify: `src/state/DynamicGameState.ts` — add `environmentReadings: Record<string, EnvironmentReading>` state field + accessors
- Modify: `src/engine/core/featureReadContext.ts` — add `getEnvironmentReading`
- Modify: `src/engine/core/applier.ts` — add Pass 1.5 env aggregation
- Test: `src/engine/core/__tests__/applier.environment.test.ts`

- [ ] **Step 1: Add types**

Add to `src/engine/core/types.ts`:

```ts
export interface EnvironmentReading {
  temperature: number;
  illumination: number;
  oxygen: number;
  noise: number;
  airborneHazards: string[];
}

export const DEFAULT_ENVIRONMENT_READING: EnvironmentReading = {
  temperature: 20,
  illumination: 3,
  oxygen: 1,
  noise: 0,
  airborneHazards: [],
};
```

Extend `StateChange` union with the three kinds in §D-env-architecture.

- [ ] **Step 2: DGSM storage**

On the `DynamicGameState` interface:

```ts
environmentReadings: Record<string /* locationId */, EnvironmentReading>;
```

Initialize to `{}` in `createInitialDynamicGameState()`. Serialize as plain object. Deserialize defaults missing field to `{}`.

Accessors:

```ts
getEnvironmentReading(locationId: string): EnvironmentReading {
  return this.state.environmentReadings[locationId] ?? DEFAULT_ENVIRONMENT_READING;
}

setEnvironmentReading(locationId: string, reading: EnvironmentReading): void {
  this.state.environmentReadings[locationId] = reading;
  this.state.lastUpdated = new Date();
}
```

- [ ] **Step 3: FeatureReadContext wire-up**

Add to interface + `makeDGSMFeatureReadContext`:

```ts
getEnvironmentReading: (locationId: string) => dgsm.getEnvironmentReading(locationId),
```

- [ ] **Step 4: Applier Pass 1.5 aggregation**

Between existing Pass 1 and Pass 2(a):

```ts
// pseudocode in Applier.flush()
const envBuckets = new Map<string, {
  temperature: number[];
  illumination: number[];
  illuminationCaps: number[];
  oxygen: number[];
  noise: number[];
  hazardAdds: Set<string>;
  hazardRemoves: Set<string>;
}>();

for (const c of changes) {
  if (c.kind === "environment.contribute") {
    getOrCreate(envBuckets, c.locationId)[c.quantity].push(c.value);
  } else if (c.kind === "environment.cap") {
    getOrCreate(envBuckets, c.locationId).illuminationCaps.push(c.value);
  } else if (c.kind === "environment.hazard") {
    const b = getOrCreate(envBuckets, c.locationId);
    (c.add ?? []).forEach((h) => b.hazardAdds.add(h));
    (c.remove ?? []).forEach((h) => b.hazardRemoves.add(h));
  }
}

for (const [locationId, b] of envBuckets) {
  const base = DEFAULT_ENVIRONMENT_READING;
  const temperature = base.temperature + sum(b.temperature);
  const illumPreCap = Math.max(base.illumination, ...b.illumination);
  const illumination = b.illuminationCaps.length > 0
    ? Math.min(illumPreCap, ...b.illuminationCaps)
    : illumPreCap;
  const oxygen = clamp(0, 1, base.oxygen + sum(b.oxygen));
  const noise = Math.max(base.noise, ...b.noise);
  const hazards = [...b.hazardAdds].filter((h) => !b.hazardRemoves.has(h));
  this.dgsm.setEnvironmentReading(locationId, {
    temperature, illumination, oxygen, noise, airborneHazards: hazards,
  });
}
```

- [ ] **Step 5: Test**

```ts
// src/engine/core/__tests__/applier.environment.test.ts — 4 scenarios
describe("Applier env aggregation", () => {
  it("single contribution raises temperature above baseline", () => { /* 320°C */ });
  it("multi-quantity from multiple features aggregates per-quantity rule", () => {
    // fire (temp +300, illum +4, oxygen −0.3, hazard smoke)
    // + sun (illum +5) → {temp:320, illum:5 (max), oxygen:0.7, hazards:[smoke]}
  });
  it("illumination cap lowers final value below max contribution", () => {
    // sun contributes 5, storm caps at 2 → final 2
  });
  it("untouched location returns DEFAULT_ENVIRONMENT_READING", () => { /* baseline */ });
});
```

Run: `npx vitest run src/engine/core/__tests__/applier.environment.test.ts`
Expected: 4 PASS.

---

### Task D1: Fire feature

**Files:**
- Rewrite: `src/engine/features/fireFeature.ts` (full rewrite)
- Delete: `src/engine/features/__tests__/fireFeature.test.ts` (old mock-based test)
- Create: `src/engine/features/__tests__/fireFeature.test.ts` (new integration test)

**Responsibilities (post-refactor):**

`stateScope: "scene"`, `priority: 200`, `propagation: { tickInterval: 10, maxHops: 3 }`.

Per-scene feature state (stored via `feature.setState`):

```ts
interface FireSceneState {
  intensity: number;              // 1–5
  phase: "growing" | "decaying";
  minutesInPhase: number;
  totalBurnMinutes: number;
  burnRange?: { start: number; end: number };  // road-only
  ignitedOnDay: number;
  ignitedAtTime: string;
}
```

**`onActionCommit(step)`:**
- `step.overlayFields.fireIntensity` set → if no fire at `step.executionSceneId`, emit `feature.setState` to create fire + initial `scene.addCondition { featureId: "fire", description: "[Fire] Light smoke", mechanicalEffect: { skillPenalty: {...} } }`. If fire exists and new intensity higher, boost.
- `step.overlayFields.fireExtinguish === true` → if fire exists, reduce intensity by 2. If ≤0 emit `feature.removeState` + `scene.removeCondition { predicate: { featureId: "fire" } }` + aftermath `scene.addCondition`.

**`onTick(ctx)`:**

For each burning scene (`ctx.getAllFeatureStates<FireSceneState>()`):
- Advance `totalBurnMinutes` + `minutesInPhase` by `ctx.tickDurationMinutes`
- When `minutesInPhase >= 10`, advance intensity (growing +1 up to 5 then flip to decaying; decaying −1 down to 0)
- Emit `feature.setState` for updated state
- Emit `environment.contribute` (temperature, illumination, oxygen) and `environment.hazard { add: ["smoke"] }` when intensity ≥ 2
- On intensity level-change, emit `scene.removeCondition { featureId: "fire" }` + new `scene.addCondition`
- On extinguish (intensity reaches 0) emit `feature.removeState` + aftermath condition sized by `totalBurnMinutes` (minor / partial / severe / destroyed)
- At intensity ≥ 3 emit `connection.setBlock { blocked: true }` for each neighbor connection; below 3 emit `blocked: false` (Applier refcount resolves conflicts)
- Read `ctx.getEnvironmentReading(sceneId).temperature` — if < 5°C (cold rain has been contributing), double decay rate

**`onPropagate({ sceneId, hop }, ctx)`:**

Topology-aware spread when intensity ≥ 3. Use `ctx.getTopology()` (add to `FeatureReadContext` if missing) or new helper `ctx.getSceneNeighbors(sceneId)`:
- Scene → parent road (with burnRange start = along-position) or parent junction
- Junction → connected roads (burnRange anchored at junction end: 0.0 or 1.0) + connected scenes
- Road → endpoint junctions when `burnRange.start <= 0.05` / `burnRange.end >= 0.95`
- Road burnRange expands by `0.4 × tickDurationMinutes / travelTimeMinutes`, modulated by cold/heat via env.temperature

Return `{ spreadToSceneIds, changes }` where `changes` emit `feature.setState` for new fire + initial `scene.addCondition`.

**Key change from current:** no direct reads of weather state or item state. Item damage migrates entirely to D7.

- [ ] **Step 1: Delete old test** — `rm src/engine/features/__tests__/fireFeature.test.ts`
- [ ] **Step 2: Rewrite feature** (~200 LOC)
- [ ] **Step 3: Write Layer-3 internal-invariants test** (~150 LOC) covering lifecycle (intensity 1→5→0 over correct tick counts), topology spread (scene→junction→road handoff, road burnRange endpoint triggers), and aftermath threshold bucketing. Cross-feature behavior (fire raises temperature, fire + sun compounds illumination, etc.) is NOT tested here — covered by Task D11's Layer-2 suite.
- [ ] **Step 4: Run test**

---

### Task D2: Weather feature + `init()` hook infrastructure

**Files:**
- Rewrite: `src/engine/features/weatherFeature.ts`
- Delete + rewrite: `src/engine/features/__tests__/weatherFeature.test.ts`
- Modify: `src/engine/core/worldFeature.ts` — add optional `init(ctx): StateChange[]` to `WorldFeature`
- Modify: `src/engine/core/tickOrchestrator.ts` — add Phase 0 that runs feature `init()` once on fresh sessions
- Modify: `src/engine/core/tickEngine.ts` — accept `featureInitConfigs: Record<string, unknown>` in opts, thread through to orchestrator
- Modify: `src/engine/core/featureReadContext.ts` — add `getFeatureInitConfig<T>(featureId)`
- Modify: `src/state/moduleLoader.ts` — populate `moduleSetup.featureInit.weather` from module data (pure passthrough; loader has zero knowledge of weather state shape)

**Responsibilities (post-refactor):**

`stateScope: "region"`, `priority: 100`, no `propagation`.

Per-region state (shape preserved from current):

```ts
interface WeatherRegionState {
  weatherType: WeatherType;
  intensity: number;         // 0–5
  minutesInState: number;
  affectedSceneIds: string[];
}
```

**`init(ctx)` — NEW, fires once per TickEngine lifecycle on fresh sessions:**

Reads preset configs via `ctx.getFeatureInitConfig<WeatherInitConfig[]>("weather")`. For each `{ regionId, weatherType, intensity }` entry, returns:
- `feature.setState` for the region's initial `WeatherRegionState` (compute `affectedSceneIds` from topology)
- `environment.contribute` / `environment.cap` for each affected scene per the contribution rules in `onTick` below
- `scene.addCondition` for the initial `[Weather]` condition
- `connection.setBlock` for intensity-4 storm/snow at outdoor connections

Returns `[]` if no preset config or if `WeatherType === "clear"` everywhere.

**`onTick(ctx)`:**

For each region in feature state:
- Advance `minutesInState` by `ctx.tickDurationMinutes`
- When ≥ 120, sample Markov transition (unchanged logic); possibly update `weatherType` / `intensity`
- Emit `feature.setState` for updated state
- For each scene in `affectedSceneIds`, emit contributions:
  - `rain`: `temperature −10 · intensity · 0.2`
  - `storm`: `temperature −15`, `illumination.cap = 3 − (intensity ≥ 4 ? 2 : 1)`
  - `snow`: `temperature −20`
  - `extreme_heat`: `temperature +30`
  - `extreme_cold`: `temperature −30`
  - `fog`: `illumination.cap = 3 − (intensity ≥ 3 ? 2 : 1)`
  - `clear`: no contribution
- On weatherType / intensity change, emit `scene.removeCondition { featureId: "weather" }` + new `scene.addCondition` with `[Weather]` descriptor + weather-skill-penalty map (port penalty tables from current code)
- At intensity ≥ 4 with `storm` / `snow`, emit `connection.setBlock { blocked: true }` for outdoor connections

### §D2-init-infrastructure — `init()` hook + Phase 0

New optional method on `WorldFeature`:

```ts
interface WorldFeature {
  // ...existing
  init?(ctx: FeatureReadContext): StateChange[];
}
```

TickOrchestrator gains Phase 0:

```ts
// TickOrchestrator
private hasInitialized = this.deps.persistedState !== undefined;

async tick(): Promise<TickReport> {
  // Phase 0 — one-shot init on fresh session only
  if (!this.hasInitialized) {
    const currentTickTime = {
      day: dgsm.getGameDay(),
      tickTime: dgsm.getTickTime(),
    };
    const ctx = makeDGSMFeatureReadContext(dgsm, {
      callerFeatureId: "__init__",
      callerScope: "global",
    });
    const initChanges: StateChange[] = [];
    for (const f of featureRunner.listFeatures()) {
      if (f.init) initChanges.push(...f.init(ctx));
    }
    applier.flush(initChanges, currentTickTime);
    this.hasInitialized = true;
  }

  // Phase 1 — advance clock (existing)
  // ... rest unchanged
}
```

`FeatureReadContext` gains:

```ts
getFeatureInitConfig<T>(featureId: string): T | undefined;
// implementation: returns dgsm.getModuleSetup()?.featureInit?.[featureId] as T | undefined;
```

`createTickEngine` gains:

```ts
featureInitConfigs?: Record<string, unknown>;
// passed into DGSM's moduleSetup.featureInit via a setter, OR stored on orchestrator
// and exposed via ctx.getFeatureInitConfig — same effect, pick whichever matches
// existing ModuleSetup plumbing
```

**moduleLoader responsibility**: read `moduleData.weatherPresets` (or wherever the JSON stores them) and populate `moduleSetup.featureInit.weather = [{ regionId, weatherType, intensity }, ...]`. Loader has **zero knowledge** of weather's internal state shape — pure passthrough. Future features follow the same convention: `moduleSetup.featureInit.<featureId> = <feature-specific-config-blob>`.

**Rehydration behavior**: `persistedState !== undefined` ⇒ `hasInitialized = true` from construction ⇒ Phase 0 skipped. State is already in DGSM from the rehydrated JSON, no re-init needed.

### Steps

- [ ] **Step 1**: Add `init?(ctx): StateChange[]` to `WorldFeature` interface
- [ ] **Step 2**: Add `getFeatureInitConfig<T>` to `FeatureReadContext` interface + `makeDGSMFeatureReadContext`
- [ ] **Step 3**: Add `featureInitConfigs` threading to `createTickEngine` and `TickOrchestrator` (pick whether to go via `moduleSetup.featureInit` on DGSM or a standalone orchestrator field; former is easier if DGSM already has `moduleSetup`)
- [ ] **Step 4**: Add Phase 0 to `TickOrchestrator.tick()` with `hasInitialized` gating
- [ ] **Step 5**: Update `moduleLoader.ts` to copy module's weather presets into `moduleSetup.featureInit.weather`
- [ ] **Step 6**: Delete old weather test
- [ ] **Step 7**: Rewrite `weatherFeature.ts` including `init()` (~220 LOC)
- [ ] **Step 8**: Write Layer-3 internal-invariants test (~100 LOC) covering Markov transition row-sum ≈ 1 over 1000 trials AND init firing on fresh session / skipping on rehydrated session. Cross-feature behavior (rain cooling fire, fog darkening scenes, etc.) NOT tested here — covered by Task D11's Layer-2 suite.
- [ ] **Step 9**: Run test

---

### Task D3: Sun feature (replaces lightingFeature)

**Files:**
- Create: `src/engine/features/sunFeature.ts`
- Delete: `src/engine/features/lightingFeature.ts`
- Delete: `src/engine/features/__tests__/lightingFeature.test.ts`
- Create: `src/engine/features/__tests__/sunFeature.test.ts`

**Responsibilities:**

`stateScope: "global"`, `priority: 150`. No persistent feature state.

**`onTick(ctx)`:**

1. **Sun contribution** — compute sun level from `ctx.tickTime` (port `lightingFeature.computeSunLevel` sine-like curve). For each outdoor location (scenes where `scene.indoor !== true`, plus all roads and junctions — add `ctx.getRoadIds()` / `ctx.getJunctionIds()` to `FeatureReadContext` if missing):
   - Emit `environment.contribute { quantity: "illumination", value: sunLevel }`
   - At night (sunLevel = 1), also emit `value: 2` with the same quantity (moonlight; reducer takes max)

2. **Item light sources** — for each scene with `scene.items`, scan for `item.isLightSource && !item.damaged`, emit `environment.contribute { quantity: "illumination", value: item.lightLevel }` for each.

3. **Illumination-based scene conditions** — reading **last tick's** aggregated `env.illumination` (1-tick lag is fine), for each scene/road/junction:
   - `illumination === 1` → emit `scene.addCondition { featureId: "sun", description: "[Lighting] Pitch black", mechanicalEffect: { skillPenalty: {...} } }`
   - `illumination === 2` → `[Lighting] Dark` with lighter penalties
   - `illumination === 5` → `[Lighting] Blinding` with glare penalties
   - `illumination ∈ {3, 4}` → emit `scene.removeCondition { featureId: "sun" }` (no condition; normal visibility)
   - Port the full skill-penalty tables from current `lightingFeature.LIGHT_LEVEL_PENALTIES`

- [ ] **Step 1: Delete old lightingFeature + its test**
- [ ] **Step 2: Create sunFeature** (~100 LOC)
- [ ] **Step 3: Write Layer-3 internal-invariants test** (~50 LOC) — time-of-day curve produces expected illumination contribution at 04:00 / 12:00 / 18:00 / 22:00; moonlight kicks in when sun ≤ 1. Cross-feature (fire illuminates dark scene, fog caps illumination, etc.) NOT tested here.
- [ ] **Step 4: Run test**

---

### Task D4: Stamina feature

**Files:**
- Rewrite: `src/engine/features/staminaFeature.ts`
- Delete + rewrite: `src/engine/features/__tests__/staminaFeature.test.ts`

**Responsibilities (post-refactor):**

`stateScope: "character"`, `priority: 300`. No propagation.

Per-character state:

```ts
interface StaminaCharacterState {
  fatigue: number;
  fatigueLevel: 0 | 1 | 2;        // 0 rested, 1 tired, 2 exhausted
  exhaustedDrainTicks: number;
}
```

**`onTick(ctx)`:**

For each alive NPC (iterate via `ctx.getCharacter` over known ids; add `ctx.getAllCharacterIds()` if missing):
- Resolve current locationId via character position + topology (add `ctx.getCharacterLocationId(characterId)` helper if not already present)
- Read `ctx.getEnvironmentReading(locationId).temperature`
- `accel = 1`; if `temperature < 10 || > 30` → `accel = 2`
- `effectiveMinutes = ctx.tickDurationMinutes × accel`
- Compute new fatigue; emit `feature.setState` for updated character state
- On fatigueLevel transition:
  - Emit `character.removeCondition { conditionId: "stamina:tired" | "stamina:exhausted" }` (remove old level's condition)
  - For new level ≥ 1, emit `character.addCondition { id: "stamina:tired" / "stamina:exhausted", description: "Tired — ..." | "Exhausted — ...", mechanicalEffect: { globalSkillPenalty: -10 | -20 } }`
- At `fatigueLevel === 2`, every 6 ticks roll CON:
  - Fail chance = `min(0.6, 0.3 + (fatigue - 960) / 960 × 0.3)`
  - On fail: emit `character.hp { delta: -1 }` + `character.san { delta: -rollD3() }`
  - **No sanity import.** The SAN drop flows through Applier normally; the LLM resolver is not in the loop; consequently no bout triggers. This is the accepted behavior reduction documented in §D-sanity-relocation.

**No direct reads of fire / weather state** — temperature comes from env reading which aggregates fire + weather contributions.

- [ ] **Step 1: Delete old test**
- [ ] **Step 2: Rewrite feature** (~150 LOC)
- [ ] **Step 3: Write Layer-3 internal-invariants test** (~80 LOC) — fatigue level transitions at 480 / 960 min under normal temp; CON-fail chance formula at representative fatigue values; globalSkillPenalty -10 / -20 on the emitted condition. Cross-feature (fire or heat env raises accel, SAN drop routes through Applier and doesn't trigger bout) NOT tested here.
- [ ] **Step 4: Run test**

---

### Task D5: Relocate sanity to role sim

**Files:**
- Delete: `src/engine/features/sanityFeature.ts`
- Delete: `src/engine/features/__tests__/sanityFeature.test.ts`
- Create: `src/simulation/roleSim/sanityGuidance.ts`
- Create: `src/simulation/roleSim/__tests__/sanityGuidance.test.ts` (snapshot only)
- Modify: `src/engine/registerDefaults.ts` — remove sanity registration
- (Deferred) Modify: resolver prompt assembly — inject sanity guidance (exact integration located during D5 or deferred to Phase E if no clean hook)

**`sanityGuidance.ts` contents:**

```ts
// src/simulation/roleSim/sanityGuidance.ts

export interface BoutOfMadnessEntry {
  roll: number;
  label: string;
  description: string;
  actionRestriction: "none" | "incapacitated" | "flee_only" | "attack_only" | "impaired";
  persistent?: boolean;
}

export const BOUT_OF_MADNESS_TABLE: readonly BoutOfMadnessEntry[] = [
  // Port the 10 entries verbatim from current sanityFeature.ts:BOUT_OF_MADNESS_TABLE
];

export const SANITY_GUIDANCE_PROMPT = `
## Sanity effects (guidance)

When resolving an action that causes a SAN drop, consider whether it should also trigger a bout of madness. If so, emit a \`character.addCondition\` alongside the \`character.san\` delta in your state changes:

- **Temporary insanity** — a single SAN loss of 5 or more may trigger a bout. Use \`expiresAt\` 1–10 hours from current game time.
- **Indefinite insanity** — a cumulative SAN loss exceeding (current SAN / 5) within the last hour may trigger an indefinite bout. Use \`expiresAt\` 1–10 days out with optional onset delay described in the condition.
- **Persistent phobia/mania** — emit \`character.addCondition\` WITHOUT \`expiresAt\`. It never auto-removes.

Style reference (10 bout types from the CoC 7e table):
${BOUT_OF_MADNESS_TABLE.map((b) => \`- **\${b.label}**: \${b.description}\`).join("\\n")}

Tailor the condition \`description\` to the specific situation — don't copy the table verbatim.

Use \`mechanicalEffect.globalSkillPenalty\` on the bout condition:
- \`incapacitated\` → \`-100\` (can't effectively act)
- \`impaired\` → \`-15\`
- \`flee_only\` / \`attack_only\` → no global penalty; the condition \`description\` alone drives NPC planner behavior
`;

export function buildSanityContextForResolver(
  _dgsm: unknown,
  _characterId: string,
): string {
  // MVP: empty. Follow-up: surface recent SAN history / persistent conditions / current SAN here.
  return "";
}
```

- [ ] **Step 1: Port `BOUT_OF_MADNESS_TABLE`** from current `sanityFeature.ts`
- [ ] **Step 2: Delete `sanityFeature.ts` + its test file**
- [ ] **Step 3: Remove sanity registration** from `registerDefaults.ts`
- [ ] **Step 4: Create `sanityGuidance.ts`** per above
- [ ] **Step 5: Locate resolver prompt assembly** (grep `rg 'buildResolverPrompt|resolverPrompt|stateResolver' src/`) — if a clean injection point exists, add `SANITY_GUIDANCE_PROMPT` to the prompt. If not, defer to Phase E1 resolver rewiring.
- [ ] **Step 6: Snapshot test**

```ts
// src/simulation/roleSim/__tests__/sanityGuidance.test.ts
import { describe, it, expect } from "vitest";
import { SANITY_GUIDANCE_PROMPT, BOUT_OF_MADNESS_TABLE } from "../sanityGuidance.js";

describe("sanityGuidance", () => {
  it("BOUT_OF_MADNESS_TABLE has 10 entries covering the 1d10 range", () => {
    expect(BOUT_OF_MADNESS_TABLE).toHaveLength(10);
    expect(BOUT_OF_MADNESS_TABLE.map((e) => e.roll).sort()).toEqual([1,2,3,4,5,6,7,8,9,10]);
  });
  it("SANITY_GUIDANCE_PROMPT includes bout names", () => {
    for (const entry of BOUT_OF_MADNESS_TABLE) {
      expect(SANITY_GUIDANCE_PROMPT).toContain(entry.label);
    }
  });
});
```

---

### Task D6: Delete `eventTriggerFeature.ts` + obsolete shared helpers

**Files:**
- Delete: `src/engine/features/eventTriggerFeature.ts`
- Delete: `src/engine/features/__tests__/eventTriggerFeature.test.ts`
- Modify: `src/engine/registerDefaults.ts` — remove the import + registration (further overhauled in Task E2)
- Delete: any eventTrigger-specific exports from `src/engine/types.ts`

- [ ] **Step 1: Search for all imports**

Run: `rg -l eventTriggerFeature src/` — record paths.

- [ ] **Step 2: Remove imports and references**

In `registerDefaults.ts`, delete the `registerFeature(eventTriggerFeature)` line and its import. Anywhere else, delete.

- [ ] **Step 3: Delete files**

Run: `rm src/engine/features/eventTriggerFeature.ts src/engine/features/__tests__/eventTriggerFeature.test.ts`

- [ ] **Step 4: Type-check**

Run: `pnpm build:tsc`
Expected: no new errors beyond those already introduced by D3 (lighting deletion) and D5 (sanity deletion) and the ongoing dependency of `tickProcessor.ts` on the old-interface features (addressed in Phase E).

---

### Task D7: itemDamageFeature

**Files:**
- Create: `src/engine/features/itemDamageFeature.ts`
- Create: `src/engine/features/__tests__/itemDamageFeature.test.ts`
- Modify: `src/engine/core/types.ts` — add `scene.damageItem` StateChange kind
- Modify: `src/engine/core/applier.ts` — handle `scene.damageItem` in Pass 2 (b)
- Modify: `src/state/DynamicGameState.ts` — add `markItemDamaged(sceneId, itemId, damagedBy, reason)` helper if not present

**New StateChange kind:**

```ts
| {
    kind: "scene.damageItem";
    sceneId: string;
    itemId: string;
    damagedBy: string;           // "fire" | "moisture" | "weapon" | ...
    reason: string;
    sourceFeatureId: string;
  }
```

Applier handles by looking up `scene.items`, marking `item.damaged = true` + stamping `damageDetails: { damagedBy, damagedAt: now, reason }`.

**itemDamageFeature responsibilities:**

`stateScope: "global"`, `priority: 350`. No persistent state.

**`onTick(ctx)`:**

For each scene / road / junction:
- Read `ctx.getEnvironmentReading(locationId).temperature`
- If `temperature > 200°C`:
  - Find undamaged items in scene (roads/junctions currently have no items; skip)
  - Emit `scene.damageItem` for ~20% of them (rounded, RNG-sampled)
  - `damagedBy: "fire"`, `reason: \`Damaged by heat (temperature \${temperature}°C)\``
- (Future extensions: moisture, cold — not in MVP)

Heat contribution from weather alone caps at +30°C (extreme_heat) → doesn't reach 200°C threshold; only fire's +intensity·100 contribution can.

- [ ] **Step 1: Add `scene.damageItem` StateChange kind + Applier handler**
- [ ] **Step 2: Create feature** (~100 LOC)
- [ ] **Step 3: Write Layer-3 internal-invariants test** (~50 LOC) — with env.temperature = 300°C (directly seeded, no fire involvement), scene with 10 undamaged items → exactly 2 damaged; already-damaged items are skipped from sampling. Cross-feature (fire raising temperature → items damage) NOT tested here.
- [ ] **Step 4: Run test**

---

### Task D8: Condition expiry sweep

**Files:**
- Modify: `src/engine/core/tickOrchestrator.ts` — add Phase 9.5 condition expiry
- Modify: `src/state/DynamicGameState.ts` — ensure `removeCharacterCondition(characterId, conditionId)` exists
- Test: add case to `tickOrchestrator.test.ts`

**Placement:** after `applier.flush(...)` (Phase 9), before `return TickReport` (Phase 10). Kept out of the Applier because the Applier only applies StateChanges — lifecycle management of existing conditions is orchestration.

```ts
// Inside TickOrchestrator.tick(), after applier.flush:
this.sweepExpiredCharacterConditions(nextTickTime);

// ...

private sweepExpiredCharacterConditions(now: GameTime): void {
  const npcs = this.deps.dgsm.getState().npcCharacters;
  for (const npc of npcs) {
    const conditions = npc.status.conditions;
    if (!conditions || conditions.length === 0) continue;
    const expired = conditions.filter(
      (c) => c.expiresAt && this.timeIsAtOrBefore(c.expiresAt, now),
    );
    for (const c of expired) {
      this.deps.dgsm.removeCharacterCondition(npc.id, c.id);
    }
  }
}
```

Scene conditions have no `expiresAt` field in the current schema — out of scope for D8.

- [ ] **Step 1: Implement sweep** in TickOrchestrator
- [ ] **Step 2: Test**

```ts
it("sweeps expired character conditions", async () => {
  // seed: npc1 with condition { id: "bout1", expiresAt: { day: 1, tickTime: "08:00" } }
  // advance tickTime to 09:00
  // assert: condition removed after tick
});
```

---

### Task D9: `globalSkillPenalty` on `CharacterCondition`

**Files:**
- Modify: `src/engine/core/types.ts` — extend `CharacterCondition.mechanicalEffect`
- Modify: skill-check aggregation site (located during execution via `rg 'conditions.*skillPenalty|CharacterCondition.*mechanicalEffect' src/engine/`)
- Test: add case to existing skill-check test

Add field:

```ts
export interface CharacterCondition {
  // ...existing
  mechanicalEffect?: {
    skillPenalty?: Record<string, number>;
    globalSkillPenalty?: number;   // NEW — adds to every skill check
    attackPenalty?: number;
  };
}
```

**Aggregation update:**

Locate the existing code that sums `skillPenalty` from active character conditions (likely in the resolver or skill-roll helper). Add:

```ts
const globalDelta = conditions.reduce(
  (acc, c) => acc + (c.mechanicalEffect?.globalSkillPenalty ?? 0),
  0,
);
// Apply globalDelta to every skill in the effective skill map
for (const skill of Object.keys(skills)) {
  skills[skill] += globalDelta;
}
```

- [ ] **Step 1: Extend type**
- [ ] **Step 2: Locate + update aggregation**
- [ ] **Step 3: Test** — character with two conditions each carrying `globalSkillPenalty: -10` → effective skill = base - 20

---

### Task D11: Layer-2 interaction test suite

**Files:**
- Create: `src/engine/__tests__/integration/*.test.ts` — one file per interaction chain
- Create: `src/engine/__tests__/integration/makeIntegrationEngine.ts` — shared helper (~80 LOC) that builds a real TickEngine with real DGSM, real Applier, real feature set, minimal seed (scenes / NPCs / optional weather presets)

**Purpose:**
Verify that the env middle layer correctly mediates cross-feature interactions. Each test focuses on **one chain** through the env layer, exercises it over multiple ticks via real `TickEngine.tick()` calls, and asserts on observable downstream effects (DGSM state, scene conditions, damage reports) — not on intermediate feature state.

**Implementation approach (decided at execution time, not pre-specified):**

Write one test file per chain that falls out of the feature responsibility matrix in §D-feature-responsibilities. Representative candidates (list is illustrative; final set chosen during implementation based on what the matrix actually surfaces and which chains have the most coupling risk):

- `fire-stamina.test.ts` — fire raises temperature; stamina's accel kicks in
- `fire-itemDamage.test.ts` — fire pushes temperature > 200°C; itemDamage marks items damaged
- `fire-sun-illumination.test.ts` — fire + sun both contribute illumination; max reducer wins; `[Lighting] Dark` condition drops
- `weather-fire-decay.test.ts` — rain lowers temperature; fire onTick sees low temp, decays faster
- `weather-sun-fog.test.ts` — fog caps illumination; sun's condition observer writes `[Lighting] Dark` even at midday
- `compound-temperature.test.ts` — fire + extreme_heat add to give temperature around 150°C; stamina sees accumulated env reading
- `stamina-san-condition-expiry.test.ts` — stamina CON fail emits SAN drop via Applier (verifies no bout triggered, §D-sanity-relocation behavior reduction); manually-injected bout with expiresAt swept by D8 sweep
- `sun-daynight.test.ts` — run 24h worth of ticks, assert illumination + conditions at dawn / noon / dusk / midnight

Target: 6-10 files, ~50-100 LOC each, ~400 LOC total.

- [ ] **Step 1**: Build `makeIntegrationEngine.ts` helper — real TickEngine + DGSM, parameterized seed (scenes, NPCs, feature init configs), returns `{ engine, dgsm, tick(n) }` convenience API
- [ ] **Step 2**: Pick the chains to cover. Start with the 2-3 highest-risk ones (fire-stamina, weather-fire-decay, fire-sun-illumination — they touch the most features each). Add more as needed for coverage.
- [ ] **Step 3**: For each chosen chain, write one focused test file with 1-3 scenarios exercising that chain. Assertion surface: DGSM state after N ticks, no assertions on feature-internal state.
- [ ] **Step 4**: Run the full suite: `npx vitest run src/engine/__tests__/integration/`

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
