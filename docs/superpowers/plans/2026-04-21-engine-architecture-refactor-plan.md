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

> **Phase E redesign (2026-04-23):** Audit of the original Phase E surfaced (a) `GameEngineRegistry` / `src/engine/runtime/` file dispositions weren't fully specified; (b) several pieces of "per-NPC perspective" logic (`discoveryPipeline`, `mapMemorySync`, `impactPipeline`'s perspective-text block) were independent ad-hoc solutions to the same underlying problem (the missing abstraction is a per-NPC perception/rendering layer).
>
> **Fix (Phase E scope):** ship the engine cutover + dual-engine dispatch + roleSim controller skeleton + delete legacy perception code. The **Renderer Layer is deferred** to a separate post-Phase-E discussion (placeholder kept in §E-renderer-layer). During Phase E NPCs run their planned actions to completion without perception-driven interrupts — the same effective behavior as the old impact gate when no events broke threshold; perception/interrupt support returns when the renderer ships.
>
> **Phase E vs Phase F:** Phase E ships engine + dual-engine + roleSim glue; Phase F rewrites NPCPlanningAgent into a tool-driven `RoleSimAgent`. Renderer is its own follow-on (no number assigned yet).
>
> **Spec sync** (§3 dual-engine + deletions table) happens **once** at the end of Phase E, mirroring Phase D's approach.

### §E-architecture-decisions — Decisions consolidated

| Topic | Decision | Why |
|---|---|---|
| **Dual-engine dispatch** | `ActionDefinition` declares `engine: "code" \| "llm"` (+ optional `codeSubsystem`). Interpreter copies it onto each `ActionStep`. TickOrchestrator dispatches per-step: code-engine steps run a deterministic subsystem; llm-engine steps run the existing resolver path. Both emit `StateChange[]` to the same Applier. See §E-dual-engine for the full model. | First principles: routing is per-action-type metadata, not a runtime concern. The interpreter already picks the definition; making it the dispatcher costs nothing and keeps a **single TickEngine.tick() loop** (no parallel runtimes, no async sync). Movement-style intents become `CodeEngine` subsystems, not `ActionStep` handlers — `ActionStep` stays immutable. |
| **Top-level architectural directories** | Promote `engine/`, `renderer/`, `roleSim/` to be **siblings under `src/`** (not nested under `simulation/`). `src/simulation/` shrinks to pure orchestration glue (`SimulationRunner`, `SimulationEventEmitter`). Existing `src/simulation/roleSim/sanityGuidance.ts` moves to `src/roleSim/sanityGuidance.ts`. | First principles: the three architectural concerns — objective world (engine), subjective perception (renderer), NPC psychology/behavior (roleSim) — are peer-level; the file layout should reflect that. Hiding `roleSim` under `simulation` and putting `renderer` next to it suggests a hierarchy that doesn't exist. |
| **Phase split: E vs F vs Renderer follow-on** | Phase E ships engine cutover + dual-engine dispatch + roleSim controller skeleton + a **thin adapter** that lets the existing `NPCPlanningAgent` satisfy the new `RoleSimAgent` interface. **Phase F replaces the adapter with a true tool-driven `RoleSimAgent`** (4-tool MVP: `act` / `plan` / `interrupt` / `wait`); migrates plan storage from `NpcDailyPlan` to `NpcMemory` with `type: "plan"`; deletes `NPCPlanningAgent` (1865 LOC) + `PlanNode` / `ScheduleEntry` types + `NpcDailyPlan` Prisma table. **Renderer layer ships in a separate post-Phase-E follow-on** — architecture is decided (see §E-renderer-layer) but implementation is held back so each milestone is independently shippable and testable. | First principles: each phase needs an independently-shippable, testable milestone. Cramming renderer + agent rewrite into Phase E means a 4-6 week monolithic landing where any subsystem failure rolls back everything. Splitting gives Phase E a 2-3 week scope with smoke-testable checkpoints; Phase F is a focused agent redesign on stable engine substrate; the renderer follow-on is a focused perception-layer build with its own design loop. |
| `GameEngineRegistry` | **Split.** Create `src/engine/definitions/registry.ts` exporting `ActionDefinitionRegistry`. Delete `src/engine/registry.ts`. Rename `ExecutionContext.registry` → `ExecutionContext.definitions`. Update all 33 callers. | First principles: after Phase D removed feature-registration from the registry, only action definitions remain. "Registry" is a vague container word; `definitions` describes contents truthfully. |
| `discoveryPipeline.ts` | **Delete.** Subsumed by Renderer Layer. | The pipeline existed to extract "what NPC noticed" from raw events using embedding similarity + skill-gating. The renderer does this generically with LLM judgment, applying skill-roll constraints as explicit prompt inputs. |
| `mapMemorySync.ts` | **Delete.** Subsumed by Renderer Layer. | "NPC learned this location" is a special case of "NPC perceived this event." |
| `impactPipeline.ts` perspective-text logic (~150 of 431 LOC) | **Delete.** Subsumed by Renderer Layer. | Hand-written `buildImpactEventText` / `classifyImpactPerspective` templates replaced by LLM rendering. Remaining impact-pipeline pieces (event collection, NPC fan-out plumbing) move into the role-sim controller. |
| Phase E vs Phase F | **Merged into Phase E.** | Phase boundary was bureaucratic; the renderer touches enough of Phase E's surface (CharacterAction shape, impact gate, memory writer) that doing them sequentially would mean rewriting the same code twice. |

### §E-renderer-layer — Per-NPC perception via LLM rendering

> **🚧 Phase E execution: DO NOT IMPLEMENT.** Architecture is decided, but renderer implementation is deferred out of Phase E to keep cutover scope manageable. The full design below is preserved for the post-Phase-E discussion; Phase E creates `src/renderer/` as an empty placeholder directory only. The legacy perception modules listed in the deletion table **are still deleted in Task E7** (they're tied to the old `CharacterAction` shape and would block cutover) — perception/interrupt functionality returns when the renderer ships.

**Three-layer model:**

```
┌─────────────────────────────────────────────────────────────┐
│ LAYER 1 — Engine (objective truth)                          │
│   Produces:  StateChange[] + FeatureEvent[] + commits        │
│   Each event carries an intrinsic `impact` (0–5)            │
│   = audibility/visibility = how loud/bright the event is     │
└──────────────────────────┬──────────────────────────────────┘
                           ↓ per-NPC perceptibility threshold filter
┌─────────────────────────────────────────────────────────────┐
│ LAYER 2 — Renderer (LLM, per NPC, per tick when needed)     │
│   Lives in:  src/renderer/                                   │
│   Input:   perceived events + NPC profile + scene state      │
│   Output:  { narrative, perceivedFacts }                     │
│   Job:     "what does this NPC see/hear/feel" — pure         │
│            perception; no behavioral decisions                │
└──────────────────────────┬──────────────────────────────────┘
                           ↓ pass perception to NPC's mind
┌─────────────────────────────────────────────────────────────┐
│ LAYER 3 — Role (post-Phase-F: RoleSimAgent's interrupt tool) │
│   Lives in:  src/roleSim/                                    │
│   Input:   current action + plan + perceivedFacts            │
│   Output:  continue / interrupt / replan                     │
│   Phase F replaces interim adapter with the unified agent;   │
│   perception-driven interrupt becomes `tool: "interrupt"`.  │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
                  tickEngine.interruptAction() / no-op
```

**Why three separate layers (and not two):**

1. **Engine doesn't know NPC perspectives** — it produces objective truth. Mixing per-NPC view into engine output (the legacy `CharacterAction.discoveries` / `perTargetResults` approach) is the original sin Phase E undoes.
2. **Renderer doesn't make decisions** — same perception fires different reactions across personalities (a soldier reacts to gunshots; a coward freezes). Auto-interrupt-on-perception collapses this.
3. **Role owns behavior** — interruption is a behavioral choice. The `NPCPlanningAgent` already knows the NPC's plan and personality; the renderer doesn't and shouldn't.

**Impact = perceptibility threshold (not "importance"):**

The `impact` field on events becomes a **physical property** — how loud / visible / radiant the event is. It is set by the engine when the event is created (a gunshot is intrinsically impact 5; a falling leaf is intrinsically impact 0). NPCs have an `attentionThreshold` based on what they're currently doing (`sleep` → 4; `guard_post` → 1). Only events with `impact ≥ threshold` enter the renderer for that NPC.

This collapses two prior questions ("did NPC perceive it?" and "is it important?") into one ("did it pass the threshold?").

**Cost / fast path:**

- If no event passes the threshold for a given NPC → renderer is **not invoked** for that NPC this tick.
- If renderer produces empty `perceivedFacts` → role layer is **not invoked**.
- Quiet ticks → **zero LLM calls**.

Illustrative call rates:

| Tick scenario | Renderer calls | Role-layer calls |
|---|---|---|
| Quiet tick (nothing above threshold for any NPC) | 0 | 0 |
| One mid-impact event in 10-NPC scene; ~3 NPCs perceive | 3 | 3 |
| Major event (impact 5), all 10 NPCs perceive | 10 | 10 |

Role-layer call can use a smaller/cheaper model (its input is structured: `current action + perceivedFacts`; its output is bounded: `continue | interrupt | replan` with reason string). Renderer uses the primary model for narrative quality.

**Determinism / testability:**

Renderer is non-deterministic (LLM temperature). To keep replay/testing tractable:
- Renderer prompt is given dice rolls + skill check results as **explicit constraints** ("the NPC's Spot Hidden roll FAILED — they cannot see hidden clues this tick"), not left to LLM judgment.
- Role-layer interrupt decision is **structured output** (`{ shouldInterrupt: bool, reason: string }`), not free-form prose, so it's loggable and replayable.
- Role-layer subscribers can be unit-tested by feeding fixed renderer outputs and asserting on `tickEngine.interruptAction` calls.

**What gets deleted as a result (still in scope for Task E7 even though renderer is deferred — these legacy modules block the new `CharacterAction` shape regardless):**

| Module | LOC | Disposition |
|---|---|---|
| `src/engine/runtime/discoveryPipeline.ts` | 263 | DELETE — renderer will handle when shipped |
| `src/engine/runtime/mapMemorySync.ts` | 62 | DELETE — renderer will handle when shipped |
| `src/engine/runtime/impactPipeline.ts` perspective-text block (incl. `personalizeEncounterForNpc`) | ~150 of 431 | DELETE — renderer will handle when shipped |
| `src/engine/runtime/encounterScanner.ts` | 137 | DELETE — encounter is just position-change perception under renderer model; no separate detector needed |
| `src/engine/core/scanners/encounterScanner.ts` (wrapper) | ~35 | DELETE — its only client (the legacy scanner) is gone |
| `src/engine/shared/encounterDedup.ts` (`buildEncounterSignature`, `shouldEmitEncounter`, `buildEncounterSnapshot`) | full file | DELETE — dedup is implicit in per-tick renderer perception |
| `encounter.detected` FeatureEvent type + `encounterSignatures: string[]` field on `SimulationTickResult` | n/a | DELETE — no scripted event predicate watches it (audit 2026-04-23 confirmed); all current callers are inside Phase E's deletion/rewrite scope (`tickProcessor`, `SimulationRunner`, `impactPipeline`, legacy `planning/types.ts`) |
| `triggerKind: "encounter"` enum value on `InterruptReason` (string label only) | n/a | RENAME to `"perception"` — encounter under renderer is a special case of perception, not its own trigger category. (Done in Task E1 with the other type changes; remains valid even though Phase E has no consumer firing it.) |
| Legacy `CharacterAction` fields: `discoveries`, `damagedEvidence`, `stateMemories`, `perTargetResults`, `characterName`, `outcome: string` | n/a | DELETE — these existed only to ferry per-NPC perspective data through a shared structure; renderer output replaces all of them |

**Open questions (for the post-Phase-E discussion):**

1. ~~Auto-interrupt vs role decides~~ → **Resolved.** Role decides. Renderer is pure perception.
2. ~~Role-layer placement~~ → **Resolved.** Phase F's unified `RoleSimAgent` with `interrupt` tool — separate "RoleReactor" module is not built; the agent IS the reactor (see §F).
3. **`chooseToIgnore` field** in renderer output — would let an NPC perceive but consciously suppress (selective attention). MVP: omit; can add later if narrative requires.
4. **NPC `attentionThreshold` schema** — defined per ActionDefinition (e.g., `definitionId: "sleep"` → 4; `"guard_post"` → 1). Where this lives in the ActionDefinition schema is an implementation detail deferred to the renderer task.
5. **Renderer prompt design** (system prompt + user prompt structure + JSON schema for `PerceivedFact`) — full design happens in the post-Phase-E discussion.
6. **Batching strategy** when many NPCs perceive the same event — single batched LLM call vs per-NPC parallel calls.

### §E-dual-engine — Per-step dispatch via ActionDefinition

**Insight:** the new architecture already has two distinct execution models hiding inside `TickEngine`:

| | Code-driven | LLM-driven |
|---|---|---|
| **Currently embodied by** | `FeatureRunner` (fire/weather/sun/stamina/itemDamage), `Applier`, `ScriptedEventRunner`, `EmergentEventEmitter` | `Resolver` (state resolver), `NPCPlanningAgent`, upcoming `Renderer`, upcoming `RoleReactor` |
| **Characteristics** | Pure functions → `StateChange[]`; no LLM; deterministic; cheap; testable with fixtures | Calls LLM; non-deterministic; latency + token cost; tested with prompt fixtures |
| **Triggered by** | Per-tick orchestrator, scripted predicates, event scanners | Action completion (resolver), NPC planning cycles, perception events (renderer) |

These run **side by side** today but the boundary is implicit. Phase E makes it explicit, **without introducing a second runtime loop**: dispatch is per-step, not per-engine.

**Mechanism:** `ActionDefinition` declares which engine handles it.

```ts
// src/engine/definitions/types.ts
interface ActionDefinition {
  id: string;
  // ... existing fields ...

  engine: "code" | "llm";           // NEW — declared in the definition JSON
  codeSubsystem?: string;            // NEW — present iff engine = "code", names the handler ("movement", "combat", ...)
  // resolver-related fields stay as today; only consulted when engine = "llm"
}
```

**Lifecycle:**

```
NPC plan: "go to library, then read the book"
   ↓ Interpreter — picks definition per phrase
ActionStep[
  { definitionId: "movement", engine: "code", codeSubsystem: "movement", target: "library" },
  { definitionId: "read",     engine: "llm",  target: "book" },
]
   ↓ TickOrchestrator processes active steps each tick
   ├─ engine == "code" → CodeEngine.process(step, ctx) → returns { stateChanges, completed? }
   └─ engine == "llm"  → countdown durationTicks; on completion → call Resolver(step, ctx) → returns StateResolution
   ↓
Applier flushes both kinds uniformly (same StateChange[] protocol)
```

**Why this is simpler than two runtime engines:**

- Single `TickEngine.tick()` loop — no parallel ticking, no message queues, no distributed-systems problems.
- Engine type is **declarative metadata** on each definition. Adding a new code-driven action = a new definition with `engine: "code"` + a subsystem registration. No architectural change.
- ActionStep stays immutable: `{ definitionId, engine, target, ... }` describes intent only. State that needs to evolve per-tick (e.g., `routeSnapshot`, `progress`, `minutesIntoStep` for movement) lives in the `CodeEngine` subsystem itself, exactly the same pattern as features holding `fire.intensity`.

**What gets added:**

- `ActionDefinition.engine` + `codeSubsystem` fields.
- `src/engine/codeEngine/` directory housing per-subsystem state + per-step processors (initial inhabitant: `movement.ts`).
- `CodeEngineSubsystem` interface (per-step processor contract; analogous to but distinct from `WorldFeature`).
- TickOrchestrator dispatch branch on `step.engine`.

**What stays unchanged:**

- `WorldFeature` interface and the Phase D feature set (features are global ambient systems, not action handlers — different concept, kept separate).
- Renderer / RoleReactor designs from §E-renderer-layer (those are LLM-side, orthogonal).
- `Applier`, `StateChange` protocol, `DGSM` shape.
- Existing `Resolver` for `engine: "llm"` steps.

**Where movement lands (resolves Q2e):**

Movement is no longer an ActionStep handler at all. It becomes a CodeEngine subsystem (`src/engine/codeEngine/movement.ts`) that:

- Keeps per-character `MovementState` (`routeSnapshot`, `currentStepIndex`, `minutesIntoStep`, `lastReachablePosition`) in scoped feature-state-style storage.
- On step activation, calls `buildMovementRouteIgnoringBlocks` (kept from `engine/shared/pathfinding.ts`) to populate the route.
- On each tick, advances `minutesIntoStep`, computes interpolated position, emits `character.position` StateChanges through the Applier (no direct DGSM mutation).
- On blocked connection, emits a step-failure signal; on arrival, emits step-completion signal.

The algorithm is preserved from `movementTick.ts`; the **shape** is now subsystem-internal-state + StateChange-out, not in-place PlanNode/ActionStep mutation.

### §E-runtime-disposition — Files in `src/engine/runtime/` (all resolved)

| File | LOC | Disposition |
|---|---|---|
| `discoveryPipeline.ts` | 263 | DELETE (legacy `CharacterAction` shape blocks cutover; functionality returns with renderer — see §E-renderer-layer) |
| `mapMemorySync.ts` | 62 | DELETE (same reason) |
| `encounterScanner.ts` | 137 | DELETE (audit confirmed no scripted-event consumer; functionality returns with renderer) |
| `resolutionExecutionContext.ts` | 88 | DELETE (entire file — legacy `PlanNode → fat-CharacterAction prompt` plumbing; only caller is `tickProcessor.ts` which is also being deleted; new resolver builds prompts from `(ActionStep, ctx)` with no "execution context" intermediate object) |
| `movementTick.ts` | 584 | **SPLIT BY CLUSTER** (see §E-dual-engine for the movement-handler design): (a) Cluster A pure time utilities (`timeToMinutes`, `minutesToTimeLabel`, `getNodeDurationMinutes`, `startNode`, `TICK_DURATION_MINUTES` — ~30 LOC) → DELETE; planning layer already has its own copies (`planning/NPCPlanningAgent.ts:29-34`, `planning/autoMovementHelpers.ts:4-19`), and runtime no longer needs them. (b) Cluster B perception dice (`rollStealthForMovement`, `tryDetectHidden`, helpers — ~80 LOC) → MOVE to `src/engine/shared/perceptionDice.ts`; called by renderer's perceptibility-threshold computation (per §E-renderer-layer). (c) Cluster C per-tick movement processor (`initializeMovementNode`, `advanceMovementNodeOneMinute`, `interpolateMovementPosition`, `processImmediateMovementTransitions`, `buildMovementAction` — ~470 LOC) → DELETE; replaced by `src/engine/codeEngine/movement.ts` per §E-dual-engine. Pathfinding helpers (`engine/shared/pathfinding.ts`) are kept and reused by the new subsystem. |
| `tickProcessor.ts` | 812 | DELETE (already in original Task E3) |
| `impactPipeline.ts` | 431 (~150 deleted; remaining migrates) | partial DELETE + relocate; see §E-renderer-layer |

### §E-npc-controller — NPC action submission loop

> **Note:** the controller skeleton below shows the **post-renderer end state** — `decide(npcId, opts?: { perceivedFacts? })` + `onRendered()`. Phase E ships a simpler variant **without the perception path** (see Task E5): only the engine-event-driven `decide(npcId)` half. The renderer follow-on adds back the `opts.perceivedFacts` parameter and the `onRendered` method without changing the rest.

**Lives in** `src/roleSim/npcActionController.ts` (~80 LOC).

**Role:** thin event-driven glue between TickEngine and the role layer. Subscribes to engine completion events, asks the role layer "what's next for this NPC?", submits the result back to engine. Stateless — engine is the source of truth for which actions are in flight.

**Phase E shape:**

```ts
// src/roleSim/npcActionController.ts
export class NpcActionController {
  constructor(
    private engine: TickEngine,
    private agent: RoleSimAgent,           // Phase E = NpcAgentAdapter; Phase F = real RoleSimAgent
    private memory: NpcMemoryManager,
    private dgsm: DynamicGameStateManager,
  ) {
    engine.on("actionCompleted",   (a) => this.decide(a.characterId));
    engine.on("actionInterrupted", (a) => this.decide(a.characterId));
    engine.on("actionCancelled",   (a) => this.decide(a.characterId));
  }

  async bootstrap(): Promise<void> {
    for (const npcId of this.dgsm.getAliveNpcIds()) {
      await this.decide(npcId);
    }
  }

  async decide(npcId: string, opts?: { perceivedFacts?: PerceivedFact[] }): Promise<void> {
    if (!this.dgsm.isNpcAlive(npcId)) return;
    const ctx = await this.buildContext(npcId, opts);

    for (let i = 0; i < MAX_TOOL_LOOP_ITERATIONS; i++) {
      const decision = await this.agent.decideNext(ctx);
      switch (decision.tool) {
        case "act":
          this.engine.submitAction(decision.input);
          return;
        case "interrupt":
          // Phase E: only fires from rule-based reactor; Phase F: from agent
          const handle = this.findActiveHandle(npcId);
          if (handle) this.engine.interruptAction(handle, decision.reason);
          return;
        case "plan":
          await this.memory.write({ npcId, type: "plan", content: decision.planText });
          ctx.recentMemory = await this.loadRecentMemory(npcId);
          continue;  // re-prompt agent with the updated plan in context
        case "wait":
          return;
      }
    }
    console.warn(`[NpcActionController] tool loop exceeded for ${npcId}`);
  }
}
```

**Phase E vs Phase F:**

| | Phase E | Phase F |
|---|---|---|
| `agent: RoleSimAgent` | `NpcAgentAdapter` (wraps existing `NPCPlanningAgent`; only emits `act` decisions; calls `generateNextAction` internally and converts the returned `PlanNode` to `ActionInput`) | True LLM-driven `RoleSimAgent` that can emit any of the 4 tools |
| `tool: "plan"` | Never returned by adapter; controller's `plan` branch is dead code initially | Live; agent writes plans to memory |
| `tool: "interrupt"` | Returned by an interim rule-based reactor (impact ≥ N → interrupt) running before adapter | Returned by agent when it judges the perception warrants stopping |
| `tool: "wait"` | Returned by adapter when `NPCPlanningAgent` has no next action (e.g., end of day) | Same |
| `perceivedFacts` in ctx | Renderer fires; ctx carries facts; rule-based reactor reads `impact` and decides | Agent reads facts and judges contextually |

**Persistence:** controller is stateless; it never writes anything itself. Engine owns `persistedState`; agent owns its own DB tables (current `NpcDailyPlan` in Phase E; migrated to memory-only in Phase F). On session restart, controller re-runs `bootstrap()` for any NPC the engine has no in-flight handle for.

---

> **Task E1–E10 are post-revision (2026-04-23).** The original Task E1–E6 from this plan have been entirely rewritten to reflect the §E-architecture-decisions: top-level directories, dual-engine dispatch, registry split, renderer layer, NpcAgentAdapter (instead of full agent rewrite — that's Phase F), and the new runtime-disposition table. Old task numbering is **discarded**; do not refer to "Task E4.5" etc. from prior versions.

---

### Task E1: ActionDefinition `engine` field + ActionDefinitionRegistry split

**Goal:** add the dual-engine discriminator to `ActionDefinition`, extract definition management into its own registry class, delete the legacy `GameEngineRegistry`, update all callers.

**Files:**
- Modify: `src/engine/types.ts:298-310` — add `engine: "code" | "llm"` and optional `codeSubsystem?: string` to `ActionDefinition`
- Modify: `src/engine/types.ts:314-317` — add `engine` and `codeSubsystem` to `InterpretedStep` (interpreter copies them through)
- Create: `src/engine/definitions/registry.ts` — `ActionDefinitionRegistry` (only register/get/getAll for `ActionDefinition`)
- Create: `src/engine/definitions/__tests__/registry.test.ts`
- Modify: `src/engine/registerDefaults.ts` — strip out `GameEngineRegistry` construction; `getDefaultFeatures()` already returns features array (Phase D); add new `createDefaultDefinitions()` returning `ActionDefinitionRegistry`
- Modify: `src/engine/executionContext.ts` — drop the unused `_registry` parameter from `createExecutionContext`
- Modify: `src/engine/tool_definitions/loader.ts` and every action-definition JSON file under `src/engine/tool_definitions/` — declare `"engine": "llm"` for every existing definition (movement gets `"engine": "code", "codeSubsystem": "movement"` in Task E2)
- Modify: `src/engine/interpreter/gameInterpreter.ts` — when constructing `InterpretedStep`, copy `engine` + `codeSubsystem` from the matched `ActionDefinition`
- Modify: `src/planning/NPCPlanningAgent.ts` — replace 8 `registry?: GameEngineRegistry` parameters with `definitions?: ActionDefinitionRegistry`; rename `registry.getDefinition(...)` → `definitions.get(...)` at every call site inside the agent
- Modify: `src/simulation/SimulationRunner.ts:63,92` — replace `registry: GameEngineRegistry` field/param with `definitions: ActionDefinitionRegistry`
- Modify: `src/engine/index.ts` and `src/planning/index.ts` — drop `GameEngineRegistry` / `createDefaultRegistry` from public API; export `ActionDefinitionRegistry` / `createDefaultDefinitions` instead
- Modify: `client/server/simulation/service.ts`, `scripts/run-cassandra.ts`, `scripts/run-simple-town.ts`, `scripts/test-game-interpreter-skill-flow.ts` — update construction call sites
- Delete: `src/engine/registry.ts` (308 LOC; propagation-state methods are dead code — only the legacy `tickProcessor.ts` consumed them, and that's deleted in Task E7)

- [ ] **Step 1: Write the failing registry test**

```ts
// src/engine/definitions/__tests__/registry.test.ts
import { describe, it, expect } from "vitest";
import { ActionDefinitionRegistry } from "../registry.js";
import type { ActionDefinition } from "../../types.js";

const stub = (id: string, engine: "code" | "llm" = "llm"): ActionDefinition => ({
  id, engine, title: id, description: "", content: "", guidanceBody: "",
});

describe("ActionDefinitionRegistry", () => {
  it("registers and retrieves a definition by id", () => {
    const r = new ActionDefinitionRegistry();
    const def = stub("examine");
    r.register(def);
    expect(r.get("examine")).toBe(def);
  });

  it("returns undefined for unknown id", () => {
    expect(new ActionDefinitionRegistry().get("missing")).toBeUndefined();
  });

  it("warns on overwrite, keeps the most recent", () => {
    const r = new ActionDefinitionRegistry();
    const a = stub("dup"); const b = stub("dup");
    r.register(a); r.register(b);
    expect(r.get("dup")).toBe(b);
  });

  it("getAll returns every registered definition", () => {
    const r = new ActionDefinitionRegistry();
    r.register(stub("a")); r.register(stub("b"));
    expect(r.getAll().map(d => d.id).sort()).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Implement `ActionDefinitionRegistry`**

```ts
// src/engine/definitions/registry.ts
import type { ActionDefinition } from "../types.js";

export class ActionDefinitionRegistry {
  private definitions = new Map<string, ActionDefinition>();

  register(def: ActionDefinition): void {
    if (this.definitions.has(def.id)) {
      console.warn(`[ActionDefinitionRegistry] Overwriting definition: ${def.id}`);
    }
    this.definitions.set(def.id, def);
  }

  get(id: string): ActionDefinition | undefined {
    return this.definitions.get(id);
  }

  getAll(): ActionDefinition[] {
    return [...this.definitions.values()];
  }
}
```

- [ ] **Step 3: Add `engine` field to `ActionDefinition` and `InterpretedStep`; rename `InterruptReason.triggerKind` enum value `"encounter"` → `"perception"`**

In `src/engine/types.ts`, extend the interfaces:

```ts
export interface ActionDefinition {
  id: string;
  title: string;
  description: string;
  content: string;
  guidanceBody: string;
  engine: "code" | "llm";          // NEW — required
  codeSubsystem?: string;           // NEW — required iff engine = "code"
  // ... existing optional fields
}

export interface InterpretedStep {
  definitionId: string;
  impact: 0 | 1 | 2 | 3 | 4 | 5;
  engine: "code" | "llm";           // NEW — copied from definition
  codeSubsystem?: string;           // NEW
}
```

In `src/engine/core/types.ts` (`InterruptReason.triggerKind`), rename:

```diff
-  triggerKind: "encounter" | "featureEvent" | "stateChange" | "other";
+  triggerKind: "perception" | "featureEvent" | "stateChange" | "other";
```

Reason: `encounter` was the legacy term tied to `encounterScanner` (deleted in Task E7). The semantics — "an NPC noticed something that warrants stopping" — are perception under the renderer model. No active consumer fires the value during Phase E (impactPipeline is gone), but keeping the enum coherent now avoids a churn point when the renderer ships.

- [ ] **Step 4: Update every JSON definition file under `src/engine/tool_definitions/` to declare `"engine": "llm"`**

For each `*.json` definition file, add `"engine": "llm"` (movement gets the code-engine settings in Task E2). Run a single search to enumerate:

Run: `find src/engine/tool_definitions -name '*.json'`

For each, add the field. Example diff:

```diff
   "id": "examine",
+  "engine": "llm",
   "title": "Examine",
```

- [ ] **Step 5: Update `gameInterpreter.ts` to copy fields onto `InterpretedStep`**

When the interpreter resolves an action text to a definition, propagate the engine fields into the step.

- [ ] **Step 6: Update `registerDefaults.ts`**

```ts
// src/engine/registerDefaults.ts
import { fireFeature } from "./features/fireFeature.js";
import { itemDamageFeature } from "./features/itemDamageFeature.js";
import { staminaFeature } from "./features/staminaFeature.js";
import { sunFeature } from "./features/sunFeature.js";
import { weatherFeature } from "./features/weatherFeature.js";
import type { WorldFeature } from "./core/worldFeature.js";
import { ActionDefinitionRegistry } from "./definitions/registry.js";
import { loadActionDefinitions } from "./tool_definitions/loader.js";

export function getDefaultFeatures(): WorldFeature[] {
  return [weatherFeature, sunFeature, fireFeature, staminaFeature, itemDamageFeature];
}

export function createDefaultDefinitions(): ActionDefinitionRegistry {
  const reg = new ActionDefinitionRegistry();
  for (const def of loadActionDefinitions()) reg.register(def);
  return reg;
}
```

- [ ] **Step 7: Migrate every caller**

Run: `rg "GameEngineRegistry|createDefaultRegistry" src/ client/ scripts/` — list every hit. For each:
- If the caller uses `registry.getDefinition(id)` → switch to `definitions.get(id)` and accept `definitions: ActionDefinitionRegistry` instead.
- If the caller uses `registry.getAllFeatures()` → switch to receiving `features: WorldFeature[]` from `getDefaultFeatures()`.
- If the caller uses `registry.registerFeature` / propagation methods → delete the call (already replaced by the Phase D engine).

- [ ] **Step 8: Delete `src/engine/registry.ts`**

Run: `rm src/engine/registry.ts`

- [ ] **Step 9: Type-check and run the unit test**

Run:
- `pnpm build:tsc` — must exit 0 (any remaining stale import is a real bug; fix at site)
- `npx vitest run src/engine/definitions/__tests__/registry.test.ts` — must pass

---

### Task E2: CodeEngine framework + Movement subsystem + perception dice

**Goal:** introduce the per-step CodeEngine dispatch path; implement the first `CodeEngineSubsystem` (movement) replacing legacy `movementTick.ts` Cluster C; relocate Cluster B perception dice; wire the orchestrator to dispatch.

**Files:**
- Create: `src/engine/codeEngine/types.ts` — `CodeEngineSubsystem` interface
- Create: `src/engine/codeEngine/movement.ts` — movement subsystem (~350 LOC; algorithm ported from `src/engine/runtime/movementTick.ts` — specifically the functions `initializeMovementNode` (lines 140–258), `advanceMovementNodeOneMinute` (lines 306–584), `interpolateMovementPosition` (lines 100–114), and `processImmediateMovementTransitions` (lines 260–304); the `buildMovementAction` helper at lines 116–138 is dropped — Phase E doesn't construct legacy CharacterAction)
- Create: `src/engine/codeEngine/__tests__/movement.test.ts`
- Create: `src/engine/codeEngine/registry.ts` — keyed `Map<codeSubsystem, CodeEngineSubsystem>` (small)
- Create: `src/engine/shared/perceptionDice.ts` — `rollStealthForMovement`, `tryDetectHidden`, helpers (Cluster B; copy verbatim from `src/engine/runtime/movementTick.ts:25-76`)
- Create: `src/engine/shared/__tests__/perceptionDice.test.ts`
- Modify: `src/engine/core/tickOrchestrator.ts` — in the activate-step branch, dispatch on `step.engine`: `"code"` → `codeEngineRegistry.get(step.codeSubsystem).process(step, ctx)`; `"llm"` → existing resolver path (no behavior change)
- Modify: `src/engine/core/types.ts:54+` — extend `ActionStep` with `engine` + `codeSubsystem` fields propagated from `InterpretedStep`
- Move: `MovementStep` interface from `src/planning/types.ts:108` → `src/engine/core/types.ts` (the type is engine-internal now that Movement is a CodeEngine subsystem; `planning/types.ts` re-exports for any straggling caller). `MovementExecutionState` (lines 120-127) stays in `planning/types.ts` for now; it's only used by the legacy `executionMeta.movement` field which goes away with `tickProcessor.ts`.
- Modify: `src/engine/interpreter/gameInterpreter.ts` — when the interpreter matches the movement definition, parse the destination scene/junction from the action text and write it into `overlayFields: { destination: <id> }` on the resulting step. Convention: **`overlayFields.destination: string`** is how movement actions carry their destination from role sim → engine → code subsystem (no new top-level `ActionInput.destination` field; `overlayFields` is the existing escape hatch for action-specific extras).
- Modify: `src/engine/tool_definitions/movement.json` (or wherever movement is defined) — set `"engine": "code", "codeSubsystem": "movement"`
- Modify: `src/engine/core/applier.ts` — confirm `character.position` StateChange is handled; if not, add a Pass-2(b) handler that calls `dgsm.setCharacterPosition(...)` once

**Subsystem contract:**

```ts
// src/engine/codeEngine/types.ts
import type { ActionStep, FeatureReadContext, StateChange } from "../core/types.js";

export interface CodeEngineSubsystem {
  readonly id: string;            // matches ActionDefinition.codeSubsystem

  /** Called when the step is first activated. Returns initial StateChanges + per-step internal state to seed. */
  onActivate(step: ActionStep, ctx: FeatureReadContext): {
    stateChanges: StateChange[];
    completed: boolean;
    failed?: { reason: string };
  };

  /** Called every tick after activation, until the subsystem reports completed/failed. */
  onTick(step: ActionStep, ctx: FeatureReadContext): {
    stateChanges: StateChange[];
    completed: boolean;
    failed?: { reason: string };
  };

  /** Optional: called when the step is interrupted by role sim. Cleanup, emit final StateChanges. */
  onInterrupt?(step: ActionStep, ctx: FeatureReadContext): { stateChanges: StateChange[] };
}
```

Subsystem state lives **inside the subsystem instance** (e.g., `private routes = new Map<characterId, MovementRouteState>()`). Same pattern as features holding `fire.intensity` per scene.

- [ ] **Step 1: Write the perception dice tests** (Cluster B port)

```ts
// src/engine/shared/__tests__/perceptionDice.test.ts
import { describe, it, expect, vi } from "vitest";
import { rollStealthForMovement, tryDetectHidden } from "../perceptionDice.js";

// Tests verify that opposed roll uses Spot Hidden vs Stealth, and that defaults apply when skills missing
// (full test bodies elided here — preserve existing coverage from any pre-existing tests on movementTick)
```

- [ ] **Step 2: Implement `perceptionDice.ts`**

Copy verbatim from `src/engine/runtime/movementTick.ts:25-76` — the `getNpcSkillValue`, `getDetectionSkillValue`, `rollStealthForMovement`, `tryDetectHidden` functions. No behavior changes.

- [ ] **Step 3: Write the movement subsystem tests**

Cover at minimum:
1. `onActivate` builds a route from character's current position to destination; emits no StateChanges yet.
2. `onTick` advances 1 minute; emits a `character.position` StateChange interpolating along the road.
3. Reaching the final route step → `completed: true`.
4. A blocked connection mid-route → `failed: { reason: "blocked-by-X" }`.
5. Interpolation along a road segment of `durationMinutes: 4` → 4 ticks each emitting a fractional position.

- [ ] **Step 4: Implement `movement.ts`**

Port the algorithm from `movementTick.ts` (`initializeMovementNode` + `advanceMovementNodeOneMinute`) but change the shape:

- Input: `ActionStep` (carries `targetCharacterIds` and other fields; movement target lives in `step.overlayFields?.destination`)
- State: `private routes = new Map<characterId, MovementRouteState>()` — internal subsystem state
- Output: `StateChange[]` (use `character.position` kind), never call `dgsm.setCharacterPosition` directly
- Reuse: `engine/shared/pathfinding.ts` (`buildMovementRouteIgnoringBlocks`, `resolveTargetPosition`) — pure functions, no migration needed

```ts
// src/engine/codeEngine/movement.ts (skeleton — full implementation by porting the algorithm)
import type { CodeEngineSubsystem } from "./types.js";
import type { ActionStep, FeatureReadContext, StateChange, CharacterPosition } from "../core/types.js";
import { buildMovementRouteIgnoringBlocks, resolveTargetPosition } from "../shared/pathfinding.js";

// MovementStep was moved from planning/types.ts to engine/core/types.ts in this task.
interface MovementRouteState {
  routeSnapshot: import("../core/types.js").MovementStep[];
  currentStepIndex: number;
  minutesIntoStep: number;
  lastReachablePosition: CharacterPosition;
  targetPosition: CharacterPosition;
}

export class MovementSubsystem implements CodeEngineSubsystem {
  readonly id = "movement";
  private routes = new Map<string, MovementRouteState>();

  onActivate(step: ActionStep, ctx: FeatureReadContext) {
    // Resolve current position → destination → route via pathfinding
    // Store in this.routes; return { stateChanges: [], completed: false }
  }

  onTick(step: ActionStep, ctx: FeatureReadContext) {
    // Pull route from this.routes; advance minutesIntoStep; check blocked;
    // emit character.position StateChange with interpolated position;
    // detect arrival → { completed: true }
  }
}
```

- [ ] **Step 5: Implement the codeEngine registry**

```ts
// src/engine/codeEngine/registry.ts
import type { CodeEngineSubsystem } from "./types.js";
import { MovementSubsystem } from "./movement.js";

export class CodeEngineRegistry {
  private subsystems = new Map<string, CodeEngineSubsystem>();
  register(s: CodeEngineSubsystem): void { this.subsystems.set(s.id, s); }
  get(id: string): CodeEngineSubsystem | undefined { return this.subsystems.get(id); }
}

export function createDefaultCodeEngineRegistry(): CodeEngineRegistry {
  const r = new CodeEngineRegistry();
  r.register(new MovementSubsystem());
  return r;
}
```

- [ ] **Step 6: Wire dispatch in `tickOrchestrator.ts`**

When activating a step, branch on `step.engine`:

```ts
if (step.engine === "code") {
  const sub = this.codeEngineRegistry.get(step.codeSubsystem!);
  if (!sub) throw new Error(`Unknown code subsystem: ${step.codeSubsystem}`);
  const result = sub.onActivate(step, ctx);
  // accumulate result.stateChanges into Applier; complete/fail step accordingly
} else {
  // existing resolver-based path
}
```

Same pattern in the per-tick advance branch (call `onTick` for in-flight code steps).

- [ ] **Step 7: Update `tickEngine.ts` to construct + thread the codeEngineRegistry**

Add `codeEngineRegistry?: CodeEngineRegistry` to `CreateTickEngineOptions`; default to `createDefaultCodeEngineRegistry()` if omitted.

- [ ] **Step 8: Update movement definition JSON**

In whichever `*.json` file defines the movement action:

```diff
   "id": "movement",
-  "engine": "llm",
+  "engine": "code",
+  "codeSubsystem": "movement",
```

- [ ] **Step 9: Run all new tests + type-check**

Run:
- `npx vitest run src/engine/codeEngine/__tests__/ src/engine/shared/__tests__/perceptionDice.test.ts`
- `pnpm build:tsc`

Expected: green. Movement now flows through the code engine; LLM-based actions still flow through the resolver. Both produce StateChange[] for the Applier.

---

### Task E3: Top-level directory scaffold (`src/renderer/`, `src/roleSim/`)

**Goal:** create the new top-level directories and migrate the one existing inhabitant. Pure structural change — no behavior.

**Files:**
- Create: `src/renderer/` (empty placeholder; populated by Task E4)
- Create: `src/roleSim/` (top-level)
- Move: `src/simulation/roleSim/sanityGuidance.ts` → `src/roleSim/sanityGuidance.ts`
- Move: `src/simulation/roleSim/__tests__/sanityGuidance.test.ts` → `src/roleSim/__tests__/sanityGuidance.test.ts`
- Modify: every importer of `simulation/roleSim/sanityGuidance` → update path to `roleSim/sanityGuidance`
- Delete: `src/simulation/roleSim/` (empty after move)

- [ ] **Step 1: Move the files**

Run:
```bash
mkdir -p src/roleSim/__tests__ src/renderer
git mv src/simulation/roleSim/sanityGuidance.ts src/roleSim/sanityGuidance.ts
git mv src/simulation/roleSim/__tests__/sanityGuidance.test.ts src/roleSim/__tests__/sanityGuidance.test.ts
rmdir src/simulation/roleSim/__tests__ src/simulation/roleSim
```

- [ ] **Step 2: Update import paths**

Run: `rg "simulation/roleSim" src/ client/` to find all importers; rewrite each path to `roleSim/...`.

- [ ] **Step 3: Type-check + run sanity test**

Run:
- `pnpm build:tsc`
- `npx vitest run src/roleSim/__tests__/sanityGuidance.test.ts`

Expected: green.

---

### Task E4: Renderer layer — DEFERRED

> **🚧 SKIP this task during Phase E execution.**
>
> Architecture is decided (see §E-renderer-layer above) but implementation is held back so each Phase E milestone is independently shippable. Phase E creates `src/renderer/` as an empty placeholder directory only (Task E3 already covers that).
>
> **What this means in practice for the rest of Phase E:**
> - Task E5 builds the `NpcActionController` **without** the perception path: no `perceptionReactor.ts`, no `onRendered()` method on the controller. Controller is purely event-driven on engine completion events (`actionCompleted` / `actionInterrupted` / `actionCancelled`).
> - Task E6 (`SimulationRunner` rewire) does **not** construct a `Renderer` or wire any perception dispatcher.
> - Task E7 still deletes the legacy perception files (`discoveryPipeline.ts`, `mapMemorySync.ts`, `encounterScanner.ts`, `impactPipeline.ts`, `shared/encounterDedup.ts`) — they're tied to the old `CharacterAction` shape and would block cutover. Functionality returns when the renderer ships.
> - Task E9 smoke test does **not** assert on rendered narrative or perception-driven interrupts — those scenarios are out of scope until the renderer ships.
>
> **Resumption:** the renderer ships in a separate post-Phase-E phase with its own design doc + implementation plan. The architecture content in §E-renderer-layer is the starting brief for that work.

---

### Task E5: roleSim layer (RoleSimAgent interface, NpcAgentAdapter, NpcActionController)

**Goal:** define the `RoleSimAgent` interface; implement the Phase E adapter that wraps existing `NPCPlanningAgent`; implement the controller wiring engine events to the adapter.

> **🚧 Renderer-related parts deferred:** §E-npc-controller's full skeleton (with `decide(npcId, opts?)` taking `perceivedFacts` and `onRendered()` method calling `decideInterrupt`) describes the post-renderer end state. **In Phase E, ship only the engine-event-driven path** — no `perceptionReactor.ts`, no `onRendered()` method, no `perceivedFacts` field on the controller's `decide()` signature. The controller is purely event-driven on `actionCompleted` / `actionInterrupted` / `actionCancelled`. The renderer follow-on adds the perception path.

**Files:**
- Create: `src/roleSim/agent.ts` — `RoleSimAgent`, `RoleSimContext`, `RoleSimDecision` types (interface only; full agent ships in Phase F)
- Create: `src/roleSim/npcAgentAdapter.ts` — wraps `NPCPlanningAgent`; satisfies `RoleSimAgent`; only ever returns `{ tool: "act" | "wait" }`
- Create: `src/roleSim/npcActionController.ts` — per §E-npc-controller (Phase E variant); subscribes to engine completion events; orchestrates `decide(npcId)` loop
- Create: `src/roleSim/__tests__/npcAgentAdapter.test.ts`
- Create: `src/roleSim/__tests__/npcActionController.test.ts`

**Type definitions** (Phase E variant — `perceivedFacts` field omitted; will be added back when renderer ships):

```ts
// src/roleSim/agent.ts
import type { ActionInput, GameTime, ActionHandle, InterruptReason } from "../engine/core/types.js";
import type { DynamicNPCProfile } from "../state/types.js";

export interface RoleSimContext {
  npcId: string;
  currentTime: GameTime;
  npcProfile: DynamicNPCProfile;
  currentScene: string;
  currentAction?: { handle: ActionHandle; actionText: string };
  recentMemory: ReadonlyArray<{ type: string; content: string; gameDay: number; gameTime: string }>;
  longTermIntent?: string;
  // perceivedFacts?: PerceivedFact[];  // ← added back when renderer ships
}

export type RoleSimDecision =
  | { tool: "act"; input: ActionInput }
  | { tool: "plan"; planText: string }
  | { tool: "interrupt"; reason: InterruptReason }
  | { tool: "wait"; untilTime?: GameTime; reason?: string };

export interface RoleSimAgent {
  decideNext(ctx: RoleSimContext): Promise<RoleSimDecision>;
}
```

The discriminated union is kept as-is (`interrupt` and `plan` variants stay declared so the type doesn't churn when Phase F + renderer arrive). Phase E's `NpcAgentAdapter` simply never returns those two variants.

- [ ] **Step 1: Write adapter test**

Verify:
- When `NPCPlanningAgent.ensureNpcNodesAvailable` succeeds and a `PlanNode` is available → adapter returns `{ tool: "act", input: {...} }` with `actionText` from the PlanNode.
- When no plan node available (e.g., end of day) → adapter returns `{ tool: "wait" }`.
- Adapter never returns `plan` or `interrupt` (those need Phase F + renderer).

- [ ] **Step 2: Implement `NpcAgentAdapter`**

```ts
// src/roleSim/npcAgentAdapter.ts
import type { RoleSimAgent, RoleSimContext, RoleSimDecision } from "./agent.js";
import type { NPCPlanningAgent } from "../planning/NPCPlanningAgent.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { ActionDefinitionRegistry } from "../engine/definitions/registry.js";

export class NpcAgentAdapter implements RoleSimAgent {
  constructor(
    private agent: NPCPlanningAgent,
    private dgsm: DynamicGameStateManager,
    private definitions: ActionDefinitionRegistry,
    private sessionId: string,
    private language: string,
  ) {}

  async decideNext(ctx: RoleSimContext): Promise<RoleSimDecision> {
    await this.agent.ensureNpcNodesAvailable(
      this.dgsm, this.sessionId, ctx.npcId, ctx.currentTime.day,
      ctx.currentTime.tickTime, this.language, this.definitions,
    );
    const inProgress = await this.agent.getInProgressNodes(this.sessionId, ctx.currentTime.day, this.dgsm);
    const due = await this.agent.getDueNpcNodes(this.sessionId, ctx.currentTime.day, ctx.currentTime.tickTime, this.dgsm);
    const node = inProgress.find((n) => n.characterId === ctx.npcId) ?? due.find((n) => n.characterId === ctx.npcId);
    if (!node) return { tool: "wait" };
    return {
      tool: "act",
      input: {
        characterId: ctx.npcId,
        actionText: node.action,
        targetCharacterIds: node.targetCharacterIds,
        sceneId: ctx.currentScene,
      },
    };
  }
}
```

- [ ] **Step 3: Implement `NpcActionController`** (Phase E variant — engine-events only)

```ts
// src/roleSim/npcActionController.ts
import type { TickEngine } from "../engine/core/types.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { RoleSimAgent } from "./agent.js";

const MAX_TOOL_LOOP_ITERATIONS = 5;

export class NpcActionController {
  constructor(
    private engine: TickEngine,
    private agent: RoleSimAgent,
    private memory: NpcMemoryManager,
    private dgsm: DynamicGameStateManager,
  ) {
    engine.on("actionCompleted",   (a) => this.decide(a.characterId));
    engine.on("actionInterrupted", (a) => this.decide(a.characterId));
    engine.on("actionCancelled",   (a) => this.decide(a.characterId));
  }

  async bootstrap(): Promise<void> {
    for (const npcId of this.dgsm.getAliveNpcIds()) {
      await this.decide(npcId);
    }
  }

  async decide(npcId: string): Promise<void> {
    if (!this.dgsm.isNpcAlive(npcId)) return;
    const ctx = await this.buildContext(npcId);

    for (let i = 0; i < MAX_TOOL_LOOP_ITERATIONS; i++) {
      const decision = await this.agent.decideNext(ctx);
      switch (decision.tool) {
        case "act":
          this.engine.submitAction(decision.input);
          return;
        case "interrupt":
          // Phase E: adapter never returns interrupt, but switch is exhaustive
          return;
        case "plan":
          await this.memory.write({ npcId, type: "plan", content: decision.planText });
          ctx.recentMemory = await this.loadRecentMemory(npcId);
          continue;
        case "wait":
          return;
      }
    }
    console.warn(`[NpcActionController] tool loop exceeded for ${npcId}`);
  }

  private async buildContext(npcId: string): Promise<import("./agent.js").RoleSimContext> {
    // build RoleSimContext from DGSM + memory; details depend on existing helpers
    // ...
  }

  private async loadRecentMemory(npcId: string): Promise<ReadonlyArray<{ type: string; content: string; gameDay: number; gameTime: string }>> {
    // call NpcMemoryManager
    // ...
  }
}
```

- [ ] **Step 4: Write controller test**

Cover:
- Bootstrap: every alive NPC gets `submitAction` called once.
- Event-driven continuation: `actionCompleted` → `decide(characterId)` → `submitAction` for that NPC.
- Dead NPC: no `submitAction`.
- Adapter returns `wait` → controller does not call `submitAction`.

- [ ] **Step 5: Run roleSim tests + type-check**

Run:
- `npx vitest run src/roleSim/__tests__/`
- `pnpm build:tsc`

Expected: green.

---

### Task E6: Rewire `SimulationRunner`

**Goal:** replace the legacy `runSimulationTick` flow with a `TickEngine` instance; wire roleSim controller; ship a single end-to-end runtime path.

> **🚧 Renderer wiring deferred:** the construction shown below intentionally **omits** Renderer + RendererDispatcher. They land in the post-Phase-E renderer phase. During Phase E, NPCs run their planned actions to completion without perception-driven interrupts.

**Files:**
- Modify: `src/simulation/SimulationRunner.ts` — significant rewrite of constructor, `executeTick`, and persistence handling
- Modify: `src/simulation/runtimePersistence.ts` — include `tickEngine: tickEngine.serialize()` in the persisted blob; rehydrate on resume by passing `persistedState` to `createTickEngine`
- Modify: `client/server/simulation/service.ts` — update construction call sites if signatures changed

**Key changes inside `SimulationRunner`:**

```ts
// constructor (excerpt) — Phase E variant; renderer wiring deferred
import { loadScriptedEventsForSession } from "../engine/scriptedEvents/loader.js";
//                            ^^ exact symbol/name to be confirmed against the loader API
//                            shipped in Phase C; the historical name
//                            `loadScriptedEventsFromModuleData` referenced in earlier
//                            drafts of this plan does not exist.

const features = getDefaultFeatures();
const definitions = createDefaultDefinitions();
const codeEngineRegistry = createDefaultCodeEngineRegistry();

this.tickEngine = createTickEngine({
  dgsm: this.dgsm,
  features,
  definitions,
  codeEngineRegistry,
  scriptedEvents: loadScriptedEventsForSession(moduleData),
  interpretAction: (input) => interpretAction(input, /* ctx with definitions */),
  resolve: (step, ctx) => resolveState(step, ctx),
  getActorDex: (id) => this.dgsm.getNpcProfile(id)?.attributes.DEX ?? 0,
  tickDurationMinutes: 1,
  lang: this.language,
  persistedState: persistedTickEngineBlob,  // null on fresh session
});

this.npcController = new NpcActionController(
  this.tickEngine,
  new NpcAgentAdapter(this.npcPlanningAgent, this.dgsm, definitions, this.sessionId, this.language),
  this.memoryManager,
  this.dgsm,
);
await this.npcController.bootstrap();
// NOTE: Renderer + RendererDispatcher construction omitted — see §E-renderer-layer.
```

`executeTick()` becomes essentially `await this.tickEngine.tick()`. All node scheduling / `ensureNpcNodesAvailable` / `getDueNpcNodes` calls move out of `SimulationRunner` (they live inside `NpcAgentAdapter` now).

- [ ] **Step 1: Resolve the scripted-events loader symbol**

The original Phase E plan referenced `loadScriptedEventsFromModuleData` which doesn't exist. Look up the actual loader exported by `src/engine/scriptedEvents/loader.ts` (Phase C) and use its real name + signature in the construction snippet above.

- [ ] **Step 2: Map every legacy `runSimulationTick` parameter to its new home**

Before deleting the call, audit `SimulationRunner.executeTick` and confirm each input has a destination:
- module data → constructor (already wired)
- registry → split into features + definitions + codeEngineRegistry (constructor)
- ctx → constructed inside the engine
- previous encounter signatures → DELETE (encounter scanner is gone per Q2c)

- [ ] **Step 2: Rewrite the constructor and `executeTick`**

Largest single edit in Phase E. Implementer note: this is too large to write atomically — split into commits at natural boundaries (constructor wiring | executeTick rewrite | persistence rewire).

- [ ] **Step 3: Rewire persistence**

```ts
// src/simulation/runtimePersistence.ts (excerpt)
export interface PersistedSimulationRuntime {
  // ... existing fields ...
  tickEngine: import("../engine/core/types.js").SerializedTickEngineState;
}
```

On bootstrap rehydrate: extract `tickEngine` blob → pass to `createTickEngine({ ..., persistedState })`.

- [ ] **Step 4: Type-check**

Run: `pnpm build:tsc`
Expected: 0 errors. Many will surface; fix at site. Critical guidance: never silence a type error with `as any` — if a field doesn't exist on the new type, find where it should now come from (DGSM lookup, engine query, removed concept).

- [ ] **Step 5: Smoke run a single tick**

Boot the dev server (`pnpm chat:dev`); start a fresh session; observe a single tick advance. Don't worry about long-term stability yet; that's Task E9.

---

### Task E7: Delete dead code

**Goal:** remove every file enumerated in §E-runtime-disposition + the spec deletions table. Type-check after each batch.

Per §E-runtime-disposition (now fully resolved):

| File | LOC | Disposition |
|---|---|---|
| `src/engine/runtime/tickProcessor.ts` | 812 | DELETE |
| `src/engine/runtime/discoveryPipeline.ts` | 263 | DELETE (renderer subsumes) |
| `src/engine/runtime/mapMemorySync.ts` | 62 | DELETE (renderer subsumes) |
| `src/engine/runtime/encounterScanner.ts` | 137 | DELETE (renderer subsumes) |
| `src/engine/core/scanners/encounterScanner.ts` | ~35 | DELETE (wrapper of above) |
| `src/engine/runtime/resolutionExecutionContext.ts` | 88 | DELETE |
| `src/engine/runtime/movementTick.ts` | 584 | DELETE (Cluster A → planning copies, Cluster B → `engine/shared/perceptionDice.ts` already in E2, Cluster C → `engine/codeEngine/movement.ts` already in E2) |
| `src/engine/runtime/impactPipeline.ts` | 431 | DELETE entirely (perspective-text block subsumed by renderer; remaining impact-event collection logic absorbed into RendererDispatcher) |
| `src/engine/queue/actionQueue.ts` | n/a | DELETE (legacy action queue) |
| `src/engine/resolver/applyStateResolution.ts` | n/a | DELETE (superseded by Applier) |
| `src/engine/shared/encounterDedup.ts` | n/a | DELETE (`buildEncounterSignature`, `shouldEmitEncounter`, `buildEncounterSnapshot` — all dead with encounter scanner gone) |

**Helpers within retained files:**
- Delete `makeAction()` from `src/engine/shared/nodeHelpers.ts`
- Delete `buildInterruptedAction()` from `src/planning/revisionHelpers.ts`
- Delete `encounter.detected` `FeatureEvent` type entry; rename `triggerKind: "encounter"` → `"perception"` in `InterruptReason` (already done in Task E5 if not earlier; this task confirms)
- Delete `encounterSignatures` field from `SimulationTickResult` (legacy `planning/types.ts`)

- [ ] **Step 1: Audit each file's external consumers**

For each file in the table, run:
```bash
rg -l "<filename without extension>" src/ client/ scripts/ tests/
```

Expected: every hit should be either inside the file itself, inside another file already in this deletion list, or already migrated by Tasks E1–E6. If anything else surfaces, stop and resolve.

- [ ] **Step 2: Delete in batches**

Batch A (engine runtime):
```bash
rm src/engine/runtime/tickProcessor.ts \
   src/engine/runtime/discoveryPipeline.ts \
   src/engine/runtime/mapMemorySync.ts \
   src/engine/runtime/encounterScanner.ts \
   src/engine/runtime/resolutionExecutionContext.ts \
   src/engine/runtime/movementTick.ts \
   src/engine/runtime/impactPipeline.ts
```

Batch B (engine misc):
```bash
rm src/engine/queue/actionQueue.ts \
   src/engine/resolver/applyStateResolution.ts \
   src/engine/shared/encounterDedup.ts \
   src/engine/core/scanners/encounterScanner.ts
```

After each batch: `pnpm build:tsc` → fix any straggler imports.

- [ ] **Step 3: Strip helpers from retained files**

Edit `src/engine/shared/nodeHelpers.ts`, `src/planning/revisionHelpers.ts` per the table. Strip the encounter event type and rename trigger.

- [ ] **Step 4: Delete legacy `SimulationTickResult.encounterSignatures` field**

Search: `rg "encounterSignatures" src/ client/`
Remove every reference.

- [ ] **Step 5: Final type-check**

Run: `pnpm build:tsc`
Expected: 0 errors.

---

### Task E8: Re-home `CharacterAction` + adapt `SimulationEventEmitter`

**Goal:** delete legacy `CharacterAction` from `src/planning/types.ts`; re-export the canonical type from `src/engine/core/types.ts`; rewrite `SimulationEventEmitter` to derive UI-facing fields from DGSM + outcome instead of from the legacy fat shape.

**Files:**
- Modify: `src/planning/types.ts` — delete the legacy `CharacterAction` interface (lines 194–228); replace with `export type { CharacterAction } from "../engine/core/types.js"`
- Modify: `src/simulation/SimulationEventEmitter.ts` — accept DGSM in constructor; rewrite `actionsToEvents` to compute `characterName`, `outcome`, etc. from canonical action + DGSM
- Modify: `src/simulation/__tests__/SimulationEventEmitter.test.ts` — rewrite fixtures using new `CharacterAction` shape
- Modify: `client/src/**` — search for usages of removed wire fields (`impact`, `rollDetail`, `successLevel`, `status`, `characterName`); fix or remove per UI need

(Same body as the original Task E4 + E4.5, but now executed after E1–E7 have already cleared most callers — the surface should be smaller.)

- [ ] **Step 1: Delete legacy `CharacterAction`, add re-export**
- [ ] **Step 2: Run `pnpm build:tsc`**: every error names a place where legacy fields were read. Fix each at site (lookup from DGSM, derive from outcome, or delete the code path).
- [ ] **Step 3: Update `SimulationEventEmitter` constructor signature + `toWireEvent` derivation**
- [ ] **Step 4: Update emitter test**: `npx vitest run src/simulation/__tests__/SimulationEventEmitter.test.ts`
- [ ] **Step 5: Reconcile client consumers**: surgical fixes only; goal is a working UI, not a rewrite.
- [ ] **Step 6: Final type-check + frontend build**: `pnpm build:tsc && cd client && pnpm build`

---

### Task E9: End-to-end smoke verification

**Files:** none new; runs the full suite.

- [ ] **Step 1: Full test suite**: `pnpm test -- --run` → all green. Fix any failures (the 13 currently-failing Blackwood Manor integration tests are explicit Phase E targets — fix or delete-with-replacement).
- [ ] **Step 2: Type-check**: `pnpm build:tsc` → exits 0.
- [ ] **Step 3: Biome**: `pnpm check` → exits 0.
- [ ] **Step 4: Boot dev server, run a scripted session**: `pnpm chat:dev`. Confirm via UI/logs:
  - Fresh session boots; NPC actions submitted → activated → committed → emitted.
  - Movement actions advance position smoothly across ticks (CodeEngine subsystem path).
  - LLM actions (e.g., "examine the desk") complete via resolver.
  - Feature ticks fire (set a small fire; observe environment + hp deltas).
  - Trigger a scripted event (pray at altar) → observe sanity loss.
  - **Out of scope for Phase E** (returns with renderer follow-on): perception-driven NPC behavior — events that previously caused NPCs to notice clues, see other NPCs, or get interrupted by nearby happenings will not fire during Phase E. NPCs run their planned actions to completion regardless of world events. This is an accepted regression that lifts when the renderer ships.
- [ ] **Step 5: Confirm legacy `SimulationRuntime` rows are unloadable** (per spec §3 "Backwards Compatibility"). Boot the server, try to resume a pre-refactor session: expect a load-time type/shape error — not silent corruption.

---

### Task E10: Final commit

- [ ] **Step 1**: `git status` and `git diff --stat`. Confirm expected file set roughly:
  - New: `src/engine/definitions/`, `src/engine/codeEngine/`, `src/engine/shared/perceptionDice.ts`, `src/renderer/`, `src/roleSim/` (with multiple files)
  - Deleted: `src/engine/registry.ts`, multiple files under `src/engine/runtime/`, `src/engine/queue/`, `src/engine/resolver/applyStateResolution.ts`, `src/engine/shared/encounterDedup.ts`
  - Modified: `src/engine/types.ts`, `src/simulation/SimulationRunner.ts`, `src/simulation/SimulationEventEmitter.ts`, `src/planning/NPCPlanningAgent.ts`, `src/simulation/runtimePersistence.ts`, JSON definition files
  - Net LOC: ~3000–4000 deleted, ~1500 added (net deletion is the win)
- [ ] **Step 2: Stage and commit** (single commit per user preference):

```bash
git add src/ client/ docs/superpowers/plans/2026-04-21-engine-architecture-refactor-plan.md docs/superpowers/specs/2026-04-20-engine-architecture-refactor-design.md
git commit -m "$(cat <<'EOF'
refactor(engine): Phase E — TickEngine cutover, dual-engine dispatch, renderer layer

Replaces the legacy tickProcessor pipeline with TickEngine; introduces per-step
dual-engine dispatch (code vs llm) routed by ActionDefinition.engine; ships the
per-NPC Renderer perception layer with a rule-based interim reactor; threads a
thin NpcAgentAdapter so the existing NPCPlanningAgent satisfies the new
RoleSimAgent interface (full agent rewrite is Phase F). Movement migrates from
runtime mutation to a CodeEngine subsystem emitting StateChanges. ~3K LOC of
legacy runtime deleted (tickProcessor, discoveryPipeline, mapMemorySync,
encounterScanner, impactPipeline, applyStateResolution, encounterDedup,
movementTick); top-level src/renderer/ and src/roleSim/ directories established.

See docs/superpowers/specs/2026-04-20-engine-architecture-refactor-design.md
for full rationale; implementation plan in
docs/superpowers/plans/2026-04-21-engine-architecture-refactor-plan.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Verify commit landed**: `git log --oneline -1` → one new commit line.

---

## Phase F — RoleSimAgent rewrite + plan storage migration

> **Phase F intent (2026-04-23):** Phase E ships engine + renderer + dual-engine + a thin adapter that lets the existing `NPCPlanningAgent` satisfy the new `RoleSimAgent` interface. Phase F replaces the adapter with a real tool-driven LLM agent and migrates plan storage from `NpcDailyPlan` to `NpcMemory`. Net effect: ~2100 LOC removed (1865-LOC `NPCPlanningAgent` + helpers + Prisma table), ~400 LOC added (`RoleSimAgent` + prompt fragments).

> **Phase F brainstorm iteration (2026-04-24, complete):** Architecture brainstorm produced 29 decisions; logged in §F-brainstorm-2026-04-24 below. The older §F-architecture / §F-storage / §F-deletions sections' details are superseded by these decisions; the brainstorm summary table at the end of §F-brainstorm-2026-04-24 indexes which decision covers each topic. F1 prompt design is explicitly deferred to a separate post-Phase-F brainstorm (Decision 29). Next step: transform decisions into an F1–F7 implementation plan.

> **Phase F status (2026-05-06): SHIPPED.** F1–F7 landed in commit `5eb9d9e refactor(engine): Phase F — RoleSimAgent + memory-only storage + dead-code purge`. Follow-on refinements: `cae27ac` (persona prompt framework — closes Decision 29 / F1 prompt design), `cf95385` + `aeeec12` (collapse `gameDay`/`tickTime` → ISO 8601 `gameDateTime`), `1edf22b` (unify tool output shapes + tighten `writeMemory` allowed-types). Remaining deferred work: Renderer Layer (Phase G) and `observe` / `reviseLongTermIntent` tools — see §F-out-of-scope.

### §F-architecture — Tool-driven agent shape

**Single entry point:**
```ts
// src/roleSim/agent.ts
export interface RoleSimAgent {
  decideNext(ctx: RoleSimContext): Promise<RoleSimDecision>;
}

export interface RoleSimContext {
  npcId: string;
  currentTime: GameTime;
  npcProfile: DynamicNPCProfile;
  currentScene: string;
  currentAction?: { handle: ActionHandle; actionText: string };  // present iff in-flight
  perceivedFacts?: PerceivedFact[];                              // present iff renderer fired
  recentMemory: NpcMemoryEntry[];                                // includes type="plan" entries
  longTermIntent?: string;
}

export type RoleSimDecision =
  | { tool: "act"; input: ActionInput }
  | { tool: "plan"; planText: string }
  | { tool: "interrupt"; reason: InterruptReason }
  | { tool: "wait"; untilTime?: GameTime; reason?: string };
```

**4-tool MVP:**
- `act` — submit an action to the engine (the only tool that produces world change)
- `plan` — write a plan note to NpcMemory; controller re-prompts agent immediately so it can then choose `act`
- `interrupt` — when ctx has `currentAction` + `perceivedFacts`, agent can decide to break focus and replan
- `wait` — explicitly do nothing this round (returns control to controller; agent gets re-prompted at next event or after `untilTime`)

Future tools (deferred): `recallMemory` (active retrieval), `observe` (focus attention), `reviseLongTermIntent`.

**Roles dissolved:** the renderer plan's separate "RoleReactor" module is **not built**; perception-driven interrupts are just `tool: "interrupt"`. Same agent, same LLM call, different tool branch.

**Daily schedule dissolved:** there's no `ScheduleEntry[]` data structure anymore. If an agent wants to "plan the day", it returns `tool: "plan"` with free-form text; that text goes into NpcMemory and shows up in `ctx.recentMemory` next call.

### §F-storage — Plan storage = NpcMemory entries

`NpcMemory` already supports `type: "plan"` (one of the 7 types) and decay. Phase F:

- Agent's `plan` tool writes through `NpcMemoryManager.write({ npcId, type: "plan", content: planText, gameDay, gameTime })`.
- Agent's context loader pulls recent `plan` memories alongside other types via existing memory query API.
- Decay handled by existing decay engine.

Removed:
- Prisma table `NpcDailyPlan` (drop after Phase F migration).
- `ScheduleEntry`, `PlanNode`, `PlanNodeStatus`, `PlanNodeExecutionMeta` types (`src/planning/types.ts`).
- `NpcLongTermIntent` table — ~~unchanged?~~ kept as long-term intent is still useful and lives separately from plans.

### §F-deletions — What goes away

| File | LOC | Disposition |
|---|---|---|
| `src/planning/NPCPlanningAgent.ts` | 1865 | DELETE — replaced by `src/roleSim/agent.ts` (~300 LOC) |
| `src/planning/autoMovementHelpers.ts` | 63 | DELETE — agent emits movement actions directly via `tool: "act"` |
| `src/planning/revisionHelpers.ts` | 50 | DELETE — replan = agent calls `tool: "plan"` then `tool: "act"` |
| `src/planning/types.ts` | varies | SHRINK — keep only types still used by other systems (e.g., `MovementStep` if engine movement subsystem uses it) |
| `src/roleSim/npcAgentAdapter.ts` (Phase E temp) | n/a | DELETE — no longer needed once real agent ships |
| `prisma/schema.prisma` `NpcDailyPlan` table | n/a | DROP — migration script truncates after backup |

### §F-tasks — Task outline (to be expanded into Phase F's own implementation plan)

> **Note:** Phase F gets its own brainstorm + spec + plan cycle once Phase E is shipped and stable. The list below is scope-setting, not a final task list.

1. **F1** — Design and document the agent prompt (system prompt + tool schemas + example interactions). Iterate against real NPC scenarios.
2. **F2** — Implement `RoleSimAgent` (`src/roleSim/agent.ts`): construct context, call LLM with tools, parse decision, validate.
3. **F3** — Migrate `NpcAgentAdapter` callers to the new agent. Initially: feature-flag the old adapter so we can A/B compare in dev.
4. **F4** — Plan-storage migration: write `NpcDailyPlan` rows out as `NpcMemory` entries (one-time migration); add `plan`-type memory query helper if not already present.
5. **F5** — Delete `NPCPlanningAgent` + helpers; remove `NpcDailyPlan` from Prisma schema; `prisma db push`; run smoke tests.
6. **F6** — Type-check + Biome + smoke session boot. Verify NPCs behave plausibly across a multi-tick session including `plan` → `act` chains and `interrupt` from perception.
7. **F7** — Final commit.

### §F-brainstorm-2026-04-24 — In-progress decisions

> Brainstorm is mid-discussion. Items below are confirmed; everything else (tool catalog, loop semantics, prompt design, migration details) is still open.

#### Decision 1: Architecture model — agent-loop with tools

The original §F-architecture treats each `controller.decide(npcId)` as a single LLM call returning one of 4 decisions. **Replaced by an agent-loop model**: agent self-selects tools across multiple LLM turns per decision, similar to the Anthropic SDK tool_use pattern (Claude Code itself works this way). Each tool execution returns a result that flows back into the next LLM call; loop ends when agent picks a "terminal" tool.

Lifecycle hooks (`seedLongTermIntent`, `onIntentRevised`, `onNewDay`, etc.) dissolve — the agent decides when to do these by selecting tools.

#### Decision 2: Long-term intent storage

Drop the `NpcLongTermIntent` Prisma table. Long-term intent becomes a new `NpcMemory` type:

```ts
{ type: "long_term_intent", content: <intent text>, gameDay, gameTime }
```

Consequences:
- No separate `reviseLongTermIntent` tool — agent revises its own intent by writing a new memory entry of `type: "long_term_intent"`.
- Agent gets free intent-evolution history.
- One-time migration in Phase F: write each existing `NpcLongTermIntent` row out as a memory entry, then drop the table.
- UI queries that read "current long-term intent for NPC X" change from `prisma.npcLongTermIntent.findFirst` to "latest NpcMemory where `type = 'long_term_intent'`".

#### Decision 3: `plan` is short-term, written to memory

A `plan` is a short-term intention that the agent writes to its own `NpcMemory` so future LLM calls (in later ticks) can see what the NPC was planning. It does **not** change the world — only `act` does.

#### Decision 4: No typed sugar tool for `plan` — folded into generic `writeMemory`

`plan` does not get its own tool. The agent writes a plan via `writeMemory({ type: "plan", content: "..." })`, same shape as any other memory write. Rationale: symmetric with the long-term-intent decision (Decision 2), and avoids tool-list asymmetry where only one memory type would be privileged.

Tool list so far: **`act`, `wait`, `writeMemory`** (3 tools).

#### Decision 5: `writeMemory` accepts 6 memory types

Agent-writable: `plan`, `belief`, `secret`, `long_term_intent`, `information`, `map`.

Not agent-writable (system-only): `event`, `witness`, `summary`.
- `event` — written by engine when actions complete (objective fact)
- `witness` — written by renderer when ships (perception layer)
- `summary` — written by background summarization task
- Rationale: prevents agent from fabricating objective records; preserves separation of concerns.

#### Decision 6: `map` memory — structured-incremental, by location name

`map` is the one type where `writeMemory` accepts a structured (non-text) payload. Agent **does not** provide free text for map; instead it provides incremental additions:

```ts
writeMemory({
  type: "map",
  add: {
    sceneNames?: string[],          // e.g. ["the library", "main street"]
    junctionNames?: string[],       // e.g. ["intersection of Oak and Main"]
    roadNames?: string[],           // e.g. ["Oak Street"]
    revealHiddenConnection?: string // e.g. "from library to cellar"
  }
})
```

Rules:
- **Incremental, not replacement.** Agent says only what it newly learned. System merges into the existing `KnownMapSnapshot`. Agent cannot accidentally cause amnesia by omitting known places.
- **Names, not IDs.** Agent uses natural location names (`"the library"`), not internal scene IDs (`"scene_blackwood_library"`). Name → ID mapping is the system's responsibility.
- **Existing `KnownMapSnapshot` graph structure is preserved.** Movement gating, UI rendering, Spot Hidden reveals continue to work against the structured snapshot — nothing about those mechanics changes.
- **System writers stay** (entering scene auto-adds to snapshot, Spot Hidden reveals connections). Agent's `writeMemory({ type: "map", ... })` is an additional path, not a replacement.

Open implementation detail: how name → ID mapping behaves when agent's name is ambiguous, unknown, or matches multiple scenes. Resolved during F1/F2.

#### Decision 7: `writeMemory` schema is polymorphic by type (option P)

Tool surface stays at 3 (act, wait, writeMemory). The `writeMemory` schema is a discriminated union:

```ts
writeMemory(input:
  | { type: "plan" | "belief" | "secret" | "long_term_intent" | "information"; content: string }
  | { type: "map"; add: { sceneNames?, junctionNames?, roadNames?, revealHiddenConnection? } }
)
```

Claude's `tool_use` schema supports discriminated unions natively. Rejected alternative (option Q): a separate `updateMap` tool — would have grown the tool count and broken symmetry with the rest of the writeMemory contract.

#### Decision 8: Hybrid context model — basics pre-loaded, memory reads via tools

Pre-load basic situational context into `RoleSimContext`; expose memory queries as read tools the agent can invoke when it needs to dig deeper.

Rationale: average decision is one LLM turn (basics in ctx are enough); complex decisions can deepen via memory queries. Avoids two extremes — bloated ctx (path 1) and chatty agent loops (path 2).

Open: exact ctx field set + exact memory read tool set (next decisions).

#### Decision 9: Memory read tools — `recallMemory` + `getMapSnapshot`

Two read tools, mirroring the writeMemory split:

```ts
recallMemory({
  query?: string,           // semantic search if provided; chronological listing if omitted
  types?: NpcMemoryType[],  // restrict to certain types
  gameDay?: number,         // restrict to a specific day
  limit?: number,
})
// Returns memory entries (chronological or by relevance).

getMapSnapshot()
// Returns the merged current KnownMapSnapshot (structured), not memory entries.
// Special-cased because map is the one structured memory type.
```

Tool list now: **`act`, `wait`, `writeMemory`, `recallMemory`, `getMapSnapshot`** (5 tools).

Rejected:
- One unified `recallMemory` covering map (returns mismatched shape — entries vs snapshot).
- Per-type read tools (`recallEvents`, `recallBeliefs`, ...) — would explode tool count and break symmetry with writeMemory's unified type enum.

#### Decision 10: `RoleSimContext` shape — self info + perception block

The pre-loaded ctx splits into two zones, mirroring the architectural distinction between "what the NPC IS" and "what the NPC SEES":

```ts
RoleSimContext = {
  // === Self (always present) ===
  npcId: string,
  currentTime: GameTime,
  npcProfile: DynamicNPCProfile,    // self-knowledge: full attributes, skills, status
  longTermIntent: string,           // pinned: latest long_term_intent memory content
  recentMemory: NpcMemoryEntry[],   // short-term: last ~10 entries across all types
  currentAction?: { handle, actionText },  // what's in flight, if anything

  // === Perception (renderer output; structure NOT pre-defined here) ===
  perception?: {
    narrative: string,                    // descriptive text of what the NPC perceives
    perceivedFacts?: PerceivedFact[],     // structured atoms (renderer-defined shape)
  }
}
```

Key principle: **the contents of `perception` are whatever the renderer produces** — engine code does not pre-impose a structured `scene / nearbyCharacters / items` schema. The renderer owns the shape; ctx is just a passthrough channel.

#### Decision 11: Phase F ships with `perception` empty (renderer deferred)

Phase F does not introduce a perception stub. The `perception` field is `undefined` for the entire Phase F lifetime. Agents make decisions purely from self info + memory queries. When the renderer ships (post-Phase-F follow-on), it fills `perception` and agents start receiving situational awareness without any agent-side code change.

Consequences for Phase F NPC behavior:
- NPCs cannot react to "what's right in front of them" — they're effectively blind to the immediate scene.
- NPCs decide via `longTermIntent` + `recentMemory` + `recallMemory` + `getMapSnapshot`.
- NPCs find out what happened by reading their own `event` memories (engine writes these on action completion).
- This is an **accepted limitation** for Phase F's scope: Phase F's goal is the agent infrastructure rewrite + storage migration, not full NPC behavior quality. Behavior gets richer when renderer ships.

#### Decision 12: No `inspectCharacter` (or other engine-read tools) in Phase F MVP

Without perception, agent has no situational target to "look at" — `inspectCharacter` would only work on characters the agent already remembers, which `recallMemory({ query: "<name>" })` already covers. Engine-read tools (`inspectCharacter`, `getSceneInfo`, `getRelationship`, etc.) re-enter the design when the renderer ships and agents have actual situational targets.

#### Decision 13: Mid-flight interrupt — agent-driven via revise event injection

Re-examined the existing revise system and found two distinct legacy paths:

| Legacy path | Trigger | Mechanism |
|---|---|---|
| **A. Player edit** | Player updates NPC intent in UI | Force-call `reviseSchedule()` on resume/step (no LLM gate) |
| **B. Engine event + impact gate** | Engine fires action / FeatureEvent | `impactPipeline` finds affected NPCs → `runImpactGateForNpc()` LLM judges {shouldUpdateIntent, shouldInterruptCurrentNode, shouldReviseSchedule} → execute |

Phase F's redesign:

- **Path A is deleted entirely.** Player editing intent becomes a pure memory write (`writeMemory({type:"long_term_intent",...})` from the system side). Agent sees the new intent on its next natural `decide()` call. No force-interrupt of in-flight actions on player edits — players who want immediate effect should `pause` first.
- **Path B is merged into the agent loop.** Controller subscribes to engine `tickCompleted`; for each tick's TickReport it computes affected NPCs (per impactPropagation), batches that tick's events into `ctx.reviseTriggers` (plural, Decision 16), and calls `decide()` once per affected NPC even if they have an in-flight action. Agent then chooses (via tools) whether to switch action (call `act` — Decision 14: this auto-cancels the in-flight action) or stay the course (call `continue`).

Removed code (in addition to NPCPlanningAgent itself): `runImpactGateForNpc`, `reviseSchedule`, `generateImpactObservationForNpc`, `modifiedCharacterIds` field on SimulationRunner, the `updateIntent`-triggers-revise pathway. Their combined responsibilities collapse into the agent's tool selection.

#### Decision 14: No separate `interrupt` tool; `act` absorbs cancellation; `wait` renamed to `continue`

Originally Phase F brainstorm proposed a 6-tool list including `interrupt({ reason: string })` to cancel an in-flight action. Re-examination found `interrupt` is only ever meaningful when **both** `ctx.currentAction` and `ctx.reviseTrigger` are present (the engine-event-driven revise flow) — otherwise `currentAction` is undefined (post-action-complete decide) and there's nothing to interrupt. In that single useful scenario, the agent always wants to cancel + start a new action, never cancel and do nothing.

Decision: **delete `interrupt` from the tool list**; merge its semantic into `act`:

```
act, continue, writeMemory, recallMemory, getMapSnapshot   (5 tools)
```

`act` dispatcher logic:
- If `ctx.currentAction` is undefined → submit new action (normal case)
- If `ctx.currentAction` is defined → cancel current via `engine.cancelAction(currentAction.handle)`, then submit new action

From the agent's perspective: it just calls `act({ actionText, ... })` whenever it wants to do something. Whether that means "start fresh" or "interrupt and switch" is invisible — the dispatcher handles it.

**Loss accepted:** no way for agent to "cancel current action without replacement". To approximate, agent calls `act({ actionText: "rest in place" })` or similar. Acceptable because:
- Real NPC behavior almost always replaces an interrupted action with a new one (the NPC stops because they want to do something else)
- Agent can write to memory before deciding (instant tools), so deliberation is preserved
- Engine cancellation without replacement was never a clean state anyway

**`wait` → `continue` rename**: more accurate verb. With revise events potentially firing during in-flight actions, the agent's "do nothing" choice means "keep current state" (continue the in-flight action OR continue idling) — not literally "wait for X". Same terminal-tool semantics as before; just clearer name.

#### Decision 15: "Affected NPCs" judgment uses `impactPropagation.findAffectedCharacters`

For each engine event, controller determines which NPCs to revise-ping by reusing the existing `findAffectedCharacters(action, impactLevel, dgsm)` helper from `src/engine/shared/impactPropagation.ts` (Phase E kept this file alive). Levels 1–5 already model "targeted / same scene / same macro / neighborhood / global" radii — the same model the legacy impact pipeline used.

Implementation detail (resolved 2026-04-24, F1 Step 6): `FeatureEvent` is extended with intrinsic `impact: 0-5` + `description: string` fields. Each emitter (Applier for synthesized `character.died`, scripted-event runner for `event.emit` effects, future features) sets these. The controller reads `event.impact` directly — no controller-side type→level mapping table needed.

When the renderer ships, this judgment is replaced by perception-threshold filtering — the helper becomes obsolete.

#### Decision 16: `RoleSimContext` adds `reviseTriggers` field (batched per tick)

```ts
RoleSimContext = {
  ...,
  reviseTriggers?: ReadonlyArray<{
    description: string,                            // e.g., "fire spread to your scene"
    sourceEvent?: FeatureEvent | CharacterAction,   // optional structured payload
  }>
}
```

**Batched, not per-event.** Originally drafted as a singular `reviseTrigger` (one event per `decide()` call). Refined 2026-04-24 to a plural array so all events from one tick reach the agent in a single decision pass:
- The controller subscribes only to engine `tickCompleted` (not individual `featureEvent`s).
- For each tick's `TickReport.featureEvents`, controller groups by affected NPC (per `impactPropagation.findAffectedCharacters`).
- Each affected NPC gets ONE `decide()` call per tick with all triggers in `reviseTriggers`.

Why batched:
- Eliminates concurrent `decide()` calls for the same NPC (per-event firing caused races).
- Agent makes one combined-context decision ("fire + scream + Sarah died") rather than reacting to each event in isolation.
- Saves LLM calls (1 instead of N).
- Matches spec §3 — role sim's impact gate processes the full `TickReport` at end of tick.

`reviseTriggers` is absent (or empty) when the tick had no revise events for this NPC.

#### Decision 17: Loop termination = "tool consumes a tick"

The agent is conceptually a continuously-running mind; "loop boundaries" are just the gaps between tools that consume simulated time. Termination is therefore not a tool-by-tool design choice — it falls out of whether a tool advances simulation time.

| Tool | Consumes tick? | Terminal? |
|---|---|---|
| `act` | Yes (action runs over N ticks; auto-cancels in-flight action if any per Decision 14) | ✅ |
| `continue` | Yes (lets 1 tick pass; in-flight action keeps running if any) | ✅ |
| `writeMemory` | No (instant mental write) | ❌ |
| `recallMemory` | No (instant mental query) | ❌ |
| `getMapSnapshot` | No (instant mental query) | ❌ |

Agent's loop continues as long as it keeps calling instant tools (`writeMemory` / `recallMemory` / `getMapSnapshot`); it ends as soon as it calls a tick-consuming tool (`act` / `continue`). This makes the rule mechanical and prompt-friendly.

#### Decision 18: Each `decide()` call is a fresh LLM conversation

Although the agent is **conceptually** "always running" (Decision 17), the implementation does not persist LLM conversation history across `decide()` calls. Every call starts a new LLM conversation seeded by `RoleSimContext` + memory queries.

Rationale:
- All cross-call continuity already lives in `NpcMemory` (long-term intent, plans, beliefs, secrets, learned info, map). The memory layer is the single persistence channel.
- Predictable token budget per call; no unbounded conversation growth.
- No conversation-history persistence needed (NpcMemory already persisted via Prisma).
- Anthropic prompt caching covers the static system-prompt portion — performance benefit of conversation reuse is mostly redundant with prompt caching.

Within one `decide()` call, the agent loop (instant-tool iterations followed by a tick-consuming terminal tool) is naturally a single conversation; once the loop ends, that conversation is discarded.

#### Decision 19: Per-tool call limits within a single `decide()`

Each instant tool has its own per-call budget. This prevents both (a) infinite loops on a single tool and (b) over-broad limits that allow agents to bloat any single category:

| Tool | Max calls per `decide()` |
|---|---|
| `recallMemory` | 10 |
| `writeMemory` | 3 |
| `getMapSnapshot` | 1 |

Implicit total cap = 14 instant calls before the agent is forced to terminate.

**Per-tool cap reached:** the tool call is rejected with an error result fed back to the LLM ("this tool has been used the maximum N times in this decide()"). Other tools remain available; the agent typically responds by trying a different tool or committing to a terminal tool.

**All caps reached + agent still hasn't terminated:** system force-injects `continue` and logs a warning. NPC takes no action this tick; will re-engage at next event.

#### Decision 20: Implicit termination — plain text → `continue`

If the LLM returns text without any `tool_use` block, treat it as an implicit `continue` and end the loop. Log a warning so we can spot prompt-design issues (frequent occurrences indicate the prompt isn't directing the agent clearly enough).

Rationale: Anthropic SDK's tool_use semantics naturally allow text-only responses; rejecting them and retrying wastes a round. "I have nothing to do" is exactly what `continue` means anyway.

#### Decision 21: Write side-effect — immediate visibility within the loop

When the agent calls `writeMemory(...)`, the write is committed to the DB immediately. The next iteration of the same loop can read it via `recallMemory` and sees it via the agent's own subsequent decisions.

Rationale: lets the agent reason coherently — it can chain "write a plan, then act based on the plan I just wrote". No buffered-pending-writes complexity.

Trade-off accepted: no transactional rollback if the loop fails mid-way. Acceptable for Phase F MVP — failures are logged, partial writes are visible to subsequent calls (which may even be useful for debugging).

#### Decision 22: `seedLongTermIntents` — system writes initial intent memory at module load

A small helper function in `src/roleSim/` (no class) loops over module-defined NPCs and writes their initial `long_term_intent` memory entries directly via `NpcMemoryManager.add(...)`. Called from `DynamicGameStateLoader.initializeCompleteDynamicGameState` (or equivalent module-load path) right after NPC profiles are registered.

```ts
// src/roleSim/seedIntents.ts (or similar)
async function seedNpcLongTermIntents(
  npcs: DynamicNPCProfile[],
  sessionId: string,
  moduleId: string,
  memoryManager: NpcMemoryManager,
  gameDay: number,
  gameTime: string,
): Promise<void> {
  for (const npc of npcs) {
    if (!npc.longTermIntent) continue;
    await memoryManager.add({
      npcId: npc.id,
      sessionId, moduleId,
      type: "long_term_intent",
      content: npc.longTermIntent,
      gameDay, gameTime,
    });
  }
}
```

Rationale:
- Module-author-defined NPC intents are narrative design and must be preserved verbatim — agent doesn't get to improvise the starting state.
- Agent still has full autonomy to revise later via `writeMemory({type:"long_term_intent",...})`.
- No LLM call at seed time — fast, deterministic, testable.
- Replaces `NPCPlanningAgent.seedLongTermIntents` and the `NpcLongTermIntent` table writes.

#### Decision 23: `injectCharacter` simplifies; relies on tick-poll for activation

`SimulationRunner.injectCharacter(profile, intent)` shrinks to: validate / inject into DGSM / write a `long_term_intent` memory entry (via the same helper from Decision 22) / save runtime. The legacy call to `generateSingleNpcSchedule` is **deleted** — there is no daily schedule to generate.

Newly-injected NPC's first `decide()` happens naturally on the next tick when `executeTick` polls all alive NPCs. Treats injected NPCs identically to module-defined NPCs (single code path).

```ts
async injectCharacter(profile, intent) {
  // validation + scene resolution unchanged
  injectCharacterIntoState(this.dgsm, profile, entrySceneId);
  await this.memoryManager.add({
    npcId: profile.id,
    sessionId: this.sessionId,
    moduleId: this.config.moduleId,
    type: "long_term_intent",
    content: intent,
    gameDay, gameTime,
  });
  await this.saveRuntime();
  // No generateSingleNpcSchedule; controller's next-tick poll handles first decide.
}
```

`upsertIntent` helper (currently writes to `NpcLongTermIntent` table) is dropped — replaced by direct `memoryManager.add`.

#### Decision 24: `getCurrentNpcActions` queries TickEngine, stays on `SimulationRunner`

The legacy implementation queried `NpcDailyPlan` rows for each NPC's current `PlanNode`. After Phase F, the source of truth is the engine itself — `tickEngine.getActorQueue(npcId)` returns all queued/active `ActionStep`s for that NPC.

Stays as a method on `SimulationRunner` (its current home), reimplemented as a thin engine-query wrapper:

```ts
async getCurrentNpcActions(): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const npc of this.dgsm.getState().npcCharacters) {
    if (!this.dgsm.isNpcAlive(npc.id)) {
      result[npc.id] = null;
      continue;
    }
    const queue = this.tickEngine.getActorQueue(npc.id);
    const active = queue.find(s => s.status === "active");
    result[npc.id] = active?.actionText ?? null;
  }
  return result;
}
```

No LLM, no DB query. Keeps the existing public API contract (callers in `service.ts`, the `npc_position_snapshot` event payload) unchanged.

#### Decision 25: Daily summarization — system-driven, slim output, ISO-dated

`onNewDay`'s legacy two responsibilities split:
- **`generateDailySchedule`** — DELETED (no schedule concept).
- **`summarizeAllNpcDayMemory`** — RETAINED but slimmed down + dated. Lifted out of `NPCPlanningAgent` into a standalone module (e.g. `src/roleSim/dailySummarization.ts`) with its own self-contained prompt builder and formatters.

**Slimmed output (compared to legacy):**

The legacy summarization LLM call produced 4 categories: `memories` (summary type), `newKnowledge`, `updatedKnowledge`, `updatedBeliefs`. Phase F shrinks this to **only `memories`** (the `summary` type). Rationale: the agent now writes `belief` / `information` / `secret` autonomously throughout the day via `writeMemory` — re-doing those at night creates duplicates / conflicts. The "auto knowledge/belief sweep" is intentionally dropped; agents are responsible for recording during the day.

```json
{
  "memories": [
    { "content": "[1923-10-17] Today I went to the library...", "importance": 4 }
  ]
}
```

**Dating: ISO 8601 in content + structured `gameDay` field:**

- New `ModuleSetup.startDate?: string` (ISO format `YYYY-MM-DD`, e.g. `"1923-10-15"`) — module author defines when day 1 occurs in the story world.
- Summarizer computes `currentDate = startDate + (gameDay - 1) days` and passes it to the prompt.
- LLM puts `[YYYY-MM-DD]` prefix at the start of each summary's content (`"[1923-10-17] Today I..."`).
- Existing `NpcMemory.gameDay` field stays as a structured filter key — dual-track (content + field).
- If module doesn't define `startDate`: fall back to `[Day N]` prefix and log a warning encouraging module authors to add the field.
- The dead `NpcInjectionPolicy.moduleStartDate` field is also removed during this cleanup.

**Trigger:** SimulationRunner's day-transition handler (in `executeTick` after detecting `dayBefore !== dayAfter`) calls `summarizeAllNpcDayMemory(dgsm, sessionId, previousDay, ...)` from the new module. No longer routed through `NPCPlanningAgent`.

**Trade-off accepted:** if agent doesn't actively `writeMemory` belief/information updates during the day, those updates are lost. Aligns with the Phase F "agent owns its own mind" philosophy.

#### Decision 26: NPC death — cancel in-flight action + write death event memory

`NPCPlanningAgent.interruptOpenNodesForDeath` is deleted (no `NpcDailyPlan` rows to clean up). Replacement is small and lives in `SimulationRunner.checkDerivedEvents` (existing pattern):

```ts
if (!this.dgsm.isNpcAlive(npc.id)) {
  this.deadNpcIds.add(npc.id);

  // 1. Cancel any in-flight engine action(s) — chain cancellation handles queued siblings.
  const queue = this.tickEngine.getActorQueue(npc.id);
  const active = queue.find(s => s.status === "active" || s.status === "queued");
  if (active) this.tickEngine.cancelAction(active.handle);

  // 2. Write a death event memory (audit + future "others remember this NPC died" use).
  await this.memoryManager.add({
    npcId: npc.id,
    sessionId, moduleId,
    type: "event",
    content: `[${currentDate}] Died at ${gameTime} in ${location}`,
    gameDay, gameTime,
  });

  // 3. Emit npc_death UI event (unchanged).
  this.events.emitSimulationEvent("npc_death", ...);
}
```

`currentDate` follows Decision 25's format (`[YYYY-MM-DD]` if `ModuleSetup.startDate` defined, else `[Day N]`). `location` is `dgsm.resolveLocationId(getCharacterPosition(npcId))`.

After death:
- Controller's existing `decide(npcId)` guard `if (!this.dgsm.isNpcAlive(npcId)) return` ensures dead NPCs are never prompted again.
- The death `event` memory persists for audit, replay, and potential future use (e.g., other NPCs grieving via `recallMemory({ query: "Smith" })`).
- Cleanup is otherwise zero-touch — no plan-node table to maintain.

#### Re-homing summary table (NPCPlanningAgent's responsibilities)

With Decisions 22–26 the legacy `NPCPlanningAgent` is fully decomposed. Final disposition:

| Legacy method | Phase F destination |
|---|---|
| `generateNextAction` | Replaced by agent's `act` tool (Decision 1) |
| `generateSingleNpcSchedule` | Deleted (no daily schedule concept) |
| `seedLongTermIntents` | Standalone helper in `src/roleSim/` (Decision 22) |
| `reviseSchedule`, `runImpactGateForNpc`, `generateImpactObservationForNpc` | Deleted (Decision 13: agent does this via `act` (with auto-cancel of current per Decision 14) + `writeMemory`) |
| `interruptOpenNodesForDeath` | Replaced by `tickEngine.cancelAction` + death memory write in `checkDerivedEvents` (Decision 26) |
| `onNewDay` | Day summarization → standalone module (Decision 25); schedule generation → deleted |
| `getCurrentNpcActions` | Stays on `SimulationRunner`, queries `tickEngine.getActorQueue` (Decision 24) |
| `getInProgressNodes` / `getDueNpcNodes` / `updateNode` / `replaceNodeWithNodes` / `getOpenNodes` | Deleted (no plan-node concept) |
| `getLongTermIntent` | Replaced by reading latest `long_term_intent` memory (Decision 2) |
| `injectCharacter` flow (the `npcPlanningAgent` calls inside `SimulationRunner.injectCharacter`) | Deleted (Decision 23) |
| `getShortTermIntent` / `setShortTermIntent` | TBD — confirm no remaining callers; likely deletable |
| `seedLongTermIntents` formatters (`formatNpcProfile`, etc.) | Move into `src/roleSim/` (used by seedIntents and dailySummarization standalone modules) |

#### Decision 27: F4 storage migration — none

Phase F drops the `NpcDailyPlan` and `NpcLongTermIntent` Prisma tables. **No data-migration script is written.** Rationale:

- Spec §3 "Backwards Compatibility" already declared existing `SimulationRuntime` rows unloadable from Phase E onward. Rows in `NpcDailyPlan` / `NpcLongTermIntent` belong to those already-broken sessions — migrating their content to `NpcMemory` produces data nobody can read.
- Dev-stage software, no real users (per spec).
- Module-defined long-term intents are re-seeded on new session load via Decision 22's helper — no need to preserve old `NpcLongTermIntent` rows for that purpose either.

F4 task collapses to:

1. Delete all code references to `prisma.npcDailyPlan` and `prisma.npcLongTermIntent`.
2. Remove the two `model` blocks from `prisma/schema.prisma`.
3. `pnpm prisma:generate`.
4. `prisma db push` (project convention per CLAUDE.md — not `migrate dev`).

The `npcDailyPlan` / `npcLongTermIntent` related types in `src/planning/types.ts` (`PlanNode`, `PlanNodeStatus`, `PlanNodeExecutionMeta`, `ScheduleEntry`) are deleted as part of this — most are already orphan after the agent rewrite.

#### Decision 28: F3 feature-flag — none; hard cutover

The original plan §F-tasks proposed feature-flagging the old `NpcAgentAdapter` so dev could A/B compare new vs legacy behavior. After Decisions 22–27 all delete the legacy `NPCPlanningAgent` entirely, **there is nothing to A/B against** — keeping both agents in code would force preserving thousands of LOC just for the comparison period.

Phase F does a hard cutover:
- `NPCPlanningAgent` is deleted in F5.
- `NpcAgentAdapter` (Phase E temporary bridge) is deleted in F5.
- New `RoleSimAgent` becomes the only agent code path from Phase F day 1.

Validation strategy:
- Smoke tests + manual dev runs catch obvious regressions.
- If the new agent has issues, `git revert` the Phase F commit returns to Phase E state cleanly.
- Acceptable per spec §3 "no backwards compat / dev-stage software" stance.

**F3 task collapses into F5** (the deletion task). The original F1–F7 sequence becomes effectively F1, F2, F4, F5, F6, F7 — F3 is absorbed.

#### Decision 29: F1 prompt design — deferred to a separate post-Phase-F brainstorm

The agent's actual system prompt + tool schemas + few-shot examples are **not designed during this brainstorm**. Phase F implementation ships with a **minimal placeholder prompt** sufficient to validate the wiring (loop runs, tools dispatch correctly, persistence works). Real prompt design happens in a dedicated follow-on brainstorm + implementation cycle.

Rationale:
- Phase F's primary value is the infrastructure rewrite: new agent loop, tool dispatcher, NpcMemory-only storage, controller wiring, dead-code deletion. Quality of LLM-driven NPC behavior is **orthogonal** to this — a prompt redesign can land later without touching the wiring.
- Prompt design is a deep iterative concern (prompt + few-shot + model choice + failure handling + i18n + behavioral tuning) that benefits from focused attention with the working pipeline already in place to test against.
- Splitting the work prevents Phase F from becoming a 2-month monolith. Each shippable chunk stays smaller and reviewable.

**What Phase F actually ships for the prompt:**
- A minimal system prompt: "You are an NPC in a Call of Cthulhu simulation. Use the provided tools to act and reason."
- Tool schemas auto-generated from the type definitions.
- No few-shot examples.
- Sonnet by default for all calls (model tuning deferred).
- Failure handling = retry once, then `continue` fallback.

**Out of scope for Phase F prompt:**
- Persona-tuned prompts per NPC type (investigator vs civilian vs cultist).
- Behavioral guidance (when to interrupt, when to plan, etc.).
- Few-shot example library.
- Per-tool model selection.
- i18n behavioral tuning (Chinese-language NPC quirks etc.).

These all become the post-Phase-F prompt brainstorm's domain.

---

### Phase F brainstorm summary (29 decisions, 2026-04-24)

The brainstorm produced 29 architecture decisions covering:

| Cluster | Decisions |
|---|---|
| Architecture model | 1 (agent-loop), 17 (tick-consuming = terminal), 18 (fresh conversation per decide) |
| Storage | 2 (long_term_intent → memory), 4 (no plan tool), 5 (5+map types), 6 (map structured-incremental), 7 (polymorphic schema), 27 (no F4 migration) |
| Tool catalog | 3 (plan in memory), 9 (memory read tools), 10 (ctx shape), 11 (perception empty), 12 (no inspectCharacter), 14 (no interrupt — `act` absorbs cancellation; `wait`→`continue`), 19 (per-tool caps), 20 (text → continue), 21 (immediate writes) |
| Revise / Interrupt | 13 (delete A, merge B; controller subscribes to tickCompleted only), 15 (impactPropagation), 16 (reviseTriggers ctx field — batched per tick) |
| Lifecycle | 8 (hybrid context), 22 (seedLongTermIntents helper), 23 (injectCharacter simplified), 24 (getCurrentNpcActions on Runner), 25 (daily summarization slim+dated), 26 (death = cancel + memory) |
| Process | 28 (no A/B feature flag), 29 (prompt design deferred) |

**Implementation plan** (transforming these into F1–F7 tasks) follows below, matching the Phase A–E task format.

---

### Task F1: Schema, types, and module-setup field changes

**Goal:** lay the data-layer foundation for Phase F. Drop the two doomed Prisma tables, introduce the `long_term_intent` memory type, delete planning types nobody reads anymore, and add `ModuleSetup.startDate` for daily-summary dating.

This task contains no behavior changes — it's pure schema + type plumbing — but every later task depends on these definitions being in place.

> **Important:** after F1 ships, the project **will not type-check cleanly until F6 lands**. Every site that still references the deleted types (`PlanNode`, `ScheduleEntry`, etc.) will surface as a TS error. This is expected and intentional — the cost of doing schema/type changes upfront. Don't try to fix individual call-site errors during F1; they self-resolve as F2–F6 replace or delete those call sites.

**Files:**
- Modify: `prisma/schema.prisma` — drop `model NpcDailyPlan`, drop `model NpcLongTermIntent`, add `long_term_intent` to `enum NpcMemoryType`
- Modify: `src/state/types.ts` — add `startDate?: string` to `ModuleSetup`; delete `moduleStartDate` from `NpcInjectionPolicy` (dead field per Decision 25)
- Modify: `src/state/moduleLoader.ts` — same `moduleStartDate` deletion
- Modify: `src/planning/types.ts` — delete `PlanNode`, `PlanNodeStatus`, `PlanNodeExecutionMeta`, `ScheduleEntry`, `PlanNodeType`, `ObjectInteractionPayload` (planning-internal types with no remaining consumers); keep `CharacterAction` re-export and `FailureReason`
- Modify: `src/planning/index.ts` — drop now-orphan exports
- Modify: `src/memory/types.ts` — extend `NpcMemoryType` literal union with `"long_term_intent"`
- Run: `pnpm prisma:generate` then `prisma db push` (per CLAUDE.md convention — not `migrate dev`, due to existing reminder_embeddings drift)

**Per Decisions 2, 25, 27:**
- Decision 2 lives in: schema enum + memory types
- Decision 25 lives in: `ModuleSetup.startDate`
- Decision 27 lives in: schema model deletions

- [x] **Step 1: Update Prisma schema**

```diff
 enum NpcMemoryType {
   event
   witness
   information
   map
   belief
   plan
   secret
   summary
+  long_term_intent
 }

-model NpcDailyPlan {
-  ...
-}
-
-model NpcLongTermIntent {
-  ...
-}
```

- [x] **Step 2: Update `ModuleSetup` interface**

```diff
 export interface ModuleSetup {
   title?: string;
   background?: string;
   storyOutline?: string;
   introduction?: string;
+  /**
+   * In-world calendar date for game day 1 in ISO 8601 (YYYY-MM-DD).
+   * Used by daily summarization to date summary memories
+   * (`[1923-10-17] Today I...`). When omitted, summaries fall back
+   * to `[Day N]` prefix and a console warning suggests adding the field.
+   */
+  startDate?: string;
   initialGameTime?: string;
   tags?: string[];
   ...
 }
```

- [x] **Step 3: Delete dead `moduleStartDate` field**

```diff
 export interface NpcInjectionPolicy {
   moduleId?: string;
-  moduleStartDate?: string;
   description?: string;
   tiers?: NpcInjectionPolicyTiers;
 }
```

Apply the same diff to the duplicate definition in `src/state/moduleLoader.ts:38-50`.

- [x] **Step 4: Update memory types**

```diff
 // src/memory/types.ts
 export type NpcMemoryType =
   | "event"
   | "witness"
   | "information"
   | "map"
   | "belief"
   | "plan"
   | "secret"
-  | "summary";
+  | "summary"
+  | "long_term_intent";
```

(Keep alignment with the Prisma enum from Step 1 — this is the TS-side mirror.)

- [x] **Step 5: Delete orphan planning types (with sweep audit)**

In `src/planning/types.ts`, delete the **PlanNode-era + discoveryPipeline-era types**. The full delete list (verified against the codebase 2026-04-24 — no external consumers outside `NPCPlanningAgent.ts` + planning helpers, all of which F6 deletes):

**PlanNode cluster:**
- `interface PlanNode`
- `interface PlanNodeExecutionMeta`
- `interface MovementExecutionState`  *(only PlanNode.executionMeta references it)*
- `interface ObjectInteractionPayload`
- `interface ScheduleEntry`
- `type PlanNodeType`
- `type PlanNodeStatus`
- `type BuiltinNodeType`  *(only PlanNodeType uses it)*

**Old state-delta cluster** (replaced by Phase A `StateChange`):
- `interface FatigueEffectDelta`
- `interface CharacterStateDelta`
- `interface InteractionStateDelta`
- `interface ItemResult`
- `interface NewItemEntry`
- `interface ObjectStateDelta`
- `interface SceneConnectionEffectResult`
- `interface SceneStateDelta`

**discoveryPipeline-era (deleted in Phase E):**
- `interface DiscoveryEntry`

**Other orphans** (verified zero external consumers):
- `interface ActionResolutionContext`
- `interface ToolCall`

**Keep:**
- `re-export of CharacterAction` from `engine/core/types.js` (still used)
- `re-export of MovementStep` from `engine/core/types.js` (used by codeEngine)
- `type FailureReason` (used by SimulationEvent payload formatting)
- `type SuccessLevel` (still used by resolver outputs)

**Sweep verification (do not skip):** before committing the deletes, for each deleted type name run

```bash
grep -rln "<TypeName>" src/ client/ scripts/ 2>/dev/null | grep -v "src/planning/"
```

Expected: empty output (after `NPCPlanningAgent.ts` and helpers are queued for F6 deletion). If any non-planning file references one of these types, **stop and resolve** — it likely means F2–F6 missed a wiring change or a new dependency snuck in.

Drop orphan re-exports in `src/planning/index.ts` accordingly.

- [x] **Step 6: Extend `FeatureEvent` with intrinsic `impact` + `description`**

`FeatureEvent` becomes self-describing — each emitter sets the event's intrinsic impact level (audibility / visibility radius per spec §3a) and a human-readable description string. Removes the need for the controller to maintain a `eventType → impact` mapping table (Decision 15 implementation: F5 now reads `event.impact` directly).

```diff
 // src/engine/core/types.ts
 export interface FeatureEvent {
   type: string;
+  /**
+   * Intrinsic perceptibility / impact level (0-5). Drives
+   * impactPropagation.findAffectedCharacters: 1=targeted, 2=same scene,
+   * 3=macro location, 4=neighborhood, 5=global. Set by the emitter; matches
+   * spec §E-renderer-layer's "events carry intrinsic impact" model.
+   */
+  impact: 0 | 1 | 2 | 3 | 4 | 5;
+  /**
+   * One-line human-readable description used by NpcActionController to render
+   * the event into the agent's `reviseTriggers` prompt section. Set by the
+   * emitter so each event type is self-describing without controller-side
+   * format tables.
+   */
+  description: string;
   characterId?: string;
   sceneId?: string;
   data?: Record<string, unknown>;
 }
```

Update the only two synthesis sites in the engine:

```diff
 // src/engine/core/applier.ts:243 — death synthesis
-  .map((r) => ({ type: "character.died", characterId: r.characterId }));
+  .map((r) => ({
+    type: "character.died",
+    impact: 4,                                     // major event; neighborhood radius
+    description: `${r.characterId} died`,          // npcName lookup deferred to renderer; ID is fine for MVP
+    characterId: r.characterId,
+  }));
```

Update the scripted-event loader (`src/engine/scriptedEvents/loader.ts`) to require `impact` + `description` on `event.emit` effect events. Currently `data/Mods/**` has zero `event.emit` effects (verified 2026-04-24), so no module data needs migrating.

```diff
 // loader.ts — event.emit validation
 case "event.emit": {
-  // existing structural validation
+  if (typeof effect.event?.impact !== "number" || effect.event.impact < 0 || effect.event.impact > 5) {
+    pushErr(errors, file, path + ".event.impact", "event.emit: 'impact' must be a number 0-5");
+  }
+  if (typeof effect.event?.description !== "string" || !effect.event.description.trim()) {
+    pushErr(errors, file, path + ".event.description", "event.emit: 'description' is required");
+  }
+  // existing structural validation continues
 }
```

`ScriptedEventRunner.ts:417` (forwards `effect.event`) needs no change — it just passes the event through; loader-level validation guarantees the fields are present.

Future feature additions that emit events must set both fields. No controller-side mapping table to maintain.

- [x] **Step 7: Run Prisma codegen + db push**

```bash
pnpm prisma:generate
pnpm prisma db push
```

Expected: codegen succeeds; `db push` drops the two tables.

> **⚠️ Destructive step.** All rows in `NpcDailyPlan` and `NpcLongTermIntent` are deleted along with the tables — no migration script preserves their data. Pre-Phase-F sessions that depended on these tables become unrecoverable on resume (consistent with spec §3 "no backwards compat" + Decision 27).
>
> Prisma may prompt for `--accept-data-loss` confirmation depending on the project setup; confirm by checking the actual prompt output. If a dev DB has test data you want to preserve in any other table, **back it up first** — `db push` schema diffs can sometimes be broader than expected.

> **Verification deferred to F7.** TypeScript will complain about every site that still references the deleted types (`NPCPlanningAgent`, helpers, etc.) — those errors are intentional and resolve themselves as F2–F6 land. Per project preference, no per-task type-check / test runs.

---

### Task F1.5: Drop vestigial `runtime` parameter from the LLM call chain

**Goal:** remove the `runtime: any` parameter from every LLM-call interface in the codebase. Currently `runtime` propagates `service.ts → SimulationRunner → ExecutionContext → engine helpers → generateText`, but it has been an empty `{}` literally everywhere it's set; only one field (`runtime.modelProvider`) is read inside `generateText`, with a fallback to `process.env.MODEL_PROVIDER`. The fallback always wins. The parameter is 100% dead code.

Doing this **before** F2 means F2/F3 are written without the parameter at all — no need for a follow-up cleanup pass.

**Files:**
- Modify: `src/models/generator.ts` — drop `runtime` from `generateText` param type; remove the `runtime.modelProvider ||` fallback (env var becomes the sole source)
- Modify: `src/engine/interpreter/gameInterpreter.ts` — drop `runtime` from `interpretAction`'s signature + body
- Modify: `src/engine/resolver/stateResolver.ts` — drop `runtime` from `resolveState`'s signature + body
- Modify: `src/engine/types.ts` — drop `runtime?: any` from `ExecutionContext`
- Modify: `src/engine/executionContext.ts` — drop `runtime` from `createExecutionContext` opts
- Modify: `src/planning/NPCPlanningAgent.ts` — strip `runtime: this.runtime` from its 6 `generateText` call sites; the file is deleted in F6 anyway, but it must compile until then
- Modify: `src/simulation/SimulationRunner.ts` — drop `this.ctx.runtime = ...` setup line; update internal `interpretAction(...)` and `resolveState(...)` calls to drop the runtime arg

> No `as any` workarounds. The parameter is gone from every signature.

- [x] **Step 1: Update `generateText` signature**

```diff
 // src/models/generator.ts
 export async function generateText(opts: {
-  runtime: any;
   customSystemPrompt: string;
   context: string;
   modelClass?: ModelClass;
   operation?: string;
   provider?: ModelProviderName;
   ...
 }): Promise<string> {
   ...
   const provider =
     providerOverride ||
     envProvider ||
-    runtime.modelProvider ||
     ModelProviderName.OPENAI;
   ...
-  const effectiveModelClass = resolveModelClass(runtime, modelClass);
+  const effectiveModelClass = resolveModelClass(modelClass);
   ...
 }
```

If `resolveModelClass` also reads `runtime`, drop it from there too (small cascade).

- [x] **Step 2: Update `interpretAction` signature**

```diff
 // src/engine/interpreter/gameInterpreter.ts
 export async function interpretAction(
   action: string,
   definitions: ActionDefinition[],
-  runtime: any,
   language: string,
 ): Promise<InterpretedResult> {
   ...
   const text = await generateText({
-    runtime,
     customSystemPrompt: systemPrompt,
     context: ...,
     modelClass: ModelClass.SMALL,
     operation: "game-interpreter",
   });
   ...
 }
```

- [x] **Step 3: Update `resolveState` signature**

```diff
 // src/engine/resolver/stateResolver.ts
 export async function resolveState(
   ctx: ResolverContext,
-  runtime: any,
 ): Promise<Record<string, any>> {
   ...
   const text = await generateText({
-    runtime,
     customSystemPrompt: prompt,
     context: "",
     modelClass: ModelClass.MEDIUM,
     operation: "state-resolver",
   });
   ...
 }
```

- [x] **Step 4: Drop `ExecutionContext.runtime` field**

```diff
 // src/engine/types.ts
 export interface ExecutionContext {
   resolveSkillRoll: ...;
   getScenePenalties: ...;
   ...
-  runtime?: any;
   language?: string;
   memoryManager?: NpcMemoryManager;
   ...
 }
```

```diff
 // src/engine/executionContext.ts
 export function createExecutionContext(opts?: {
-  runtime?: any;
   language?: string;
   memoryManager?: NpcMemoryManager;
 }): ExecutionContext {
   return {
     resolveSkillRoll,
     ...
-    runtime: opts?.runtime,
     language: opts?.language,
     memoryManager: opts?.memoryManager,
   };
 }
```

- [x] **Step 5: Update `NPCPlanningAgent` to compile without `runtime`**

The class itself is being deleted in F6, but it still has to compile between F1.5 and F6 (per the F4-F6 single-session note doesn't apply here — F1.5 ships independently).

In `src/planning/NPCPlanningAgent.ts`:
- Strip the `private runtime: any,` constructor parameter (and the field)
- Strip `getRuntime()` method
- For each of the 6 `await generateText({ runtime: this.runtime, ... })` calls, drop the `runtime: this.runtime` line

The class still works — internally it just calls generateText without runtime, generator.ts uses env vars.

- [x] **Step 6: Update `SimulationRunner`**

```diff
   constructor(params: {
     ...
   }) {
     ...
-    this.ctx.runtime = this.npcPlanningAgent.getRuntime();
     this.ctx.language = this.language;
     ...
   }

   ...
   interpretAction: async (input) => {
     const result = await interpretAction(
       input.actionText,
       definitionList,
-      this.ctx.runtime,
       this.language,
     );
     ...
   },

   resolve: async (step, ctx) => {
     ...
     const resolution = await resolveState(
       { action, definition, ..., language: this.language },
-      this.ctx.runtime,
     );
     ...
   },
```

- [x] **Step 7: Update `client/server/simulation/service.ts`**

```diff
   const npcPlanningAgent = new NPCPlanningAgent(
     params.prisma,
-    {},
     memoryManager,
   );
```

(NPCPlanningAgent's constructor lost the runtime param in Step 5.)

> **Verification deferred to F7.** F1.5 changes are pure API simplifications — no behavior change expected. TS will catch any missed call site immediately.

---

### Task F2: `RoleSimAgent` LLM implementation + tool dispatcher

**Goal:** ship the actual LLM-driven agent that replaces `NpcAgentAdapter`. Implements the agent-loop model from Decisions 1, 17, 18, 21: each `decide(npcId)` opens a fresh Claude conversation, the LLM picks tools, the dispatcher executes them, instant tools loop back, tick-consuming tools terminate. Per-tool call caps from Decision 19 are enforced; cap-rejected tools surface an error to the LLM (Decision 19 option a); plain-text responses fall back to `continue` (Decision 20).

This is the largest task in Phase F by LOC.

**Files:**
- Modify: `src/roleSim/agent.ts` — replace the Phase E stub union with the final 5-tool `RoleSimDecision` union (drop `wait`/`plan`; rename `wait` → `continue`; no separate `interrupt`); extend `RoleSimContext` with `reviseTriggers` (plural — per-tick batched, Decision 16) + `perception` fields
- Create: `src/roleSim/llmAgent.ts` (~200 LOC) — concrete `LLMRoleSimAgent` class implementing `RoleSimAgent.decideNext`; runs the agent loop using existing `generateText` + `parseJsonResponse` (same pattern as `NPCPlanningAgent`); inline system prompt with embedded tool descriptions
- Create: `src/roleSim/toolDispatcher.ts` (~180 LOC) — pure helper that takes a parsed `{tool, ...input}` object + executes it against `NpcMemoryManager` / `DynamicGameStateManager` / `TickEngine`; returns the result string for next LLM round; owns `TOOL_CAPS` + `TERMINAL_TOOLS` constants
- Create: `src/roleSim/__tests__/toolDispatcher.test.ts` — covers tool-routing + cap enforcement + error surfacing (no LLM in tests, mocked tool inputs)
- Modify: `src/roleSim/npcActionController.ts` — minor: rename `wait` → `continue` in the switch; constructor field stays `agent: RoleSimAgent` (accepts any implementation); F5 swaps the per-event subscriptions for `tickCompleted` + `reviseTriggers` plumbing

> **No new model wrapper.** The new agent uses the existing `generateText({ customSystemPrompt, context, modelClass })` from `src/models/` (post-F1.5 — `runtime` parameter is gone). Tool selection is JSON-in-string (LLM emits `{ "tool": "...", ... }`, parsed by `parseJsonResponse`). Native Anthropic `tool_use` API not used in Phase F MVP — keeps the LLM call path identical to existing project conventions.

**Per Decisions 1, 14, 17–21:**
- Decision 1: agent-loop architecture
- Decision 14: 5-tool list `act / continue / writeMemory / recallMemory / getMapSnapshot` (no separate `interrupt` — `act` absorbs cancellation; `wait` renamed to `continue`)
- Decision 17: tick-consuming = terminal
- Decision 18: fresh conversation per decide()
- Decision 19: per-tool caps (recall=10, write=3, getMap=1) + cap error to LLM
- Decision 20: plain text → continue + warning
- Decision 21: writeMemory immediate visibility

- [x] **Step 1: Rewrite `RoleSimAgent` types**

In `src/roleSim/agent.ts`, replace the Phase E stub with the full 5-tool union and updated context shape. **Engine handles never appear in agent-facing types** — the engine is the source of truth for in-flight state; controller queries it on demand instead of mirroring it:

```ts
import type { FeatureEvent, GameTime, CharacterAction } from "../engine/core/types.js";
import type { DynamicNPCProfile } from "../state/types.js";
import type { NpcMemoryType } from "../memory/types.js";

export type RoleSimDecision =
  | {
      tool: "act";
      input: { actionText: string; targetCharacterIds?: string[] };
    }
  | { tool: "continue"; reason?: string }
  | {
      tool: "writeMemory";
      type: NpcMemoryType;
      content?: string;
      mapAdd?: {
        sceneNames?: string[];
        junctionNames?: string[];
        roadNames?: string[];
        revealHiddenConnection?: string;
      };
    }
  | {
      tool: "recallMemory";
      query?: string;
      types?: NpcMemoryType[];
      gameDay?: number;
      limit?: number;
    }
  | { tool: "getMapSnapshot" };

export interface RoleSimContext {
  npcId: string;
  currentTime: GameTime;
  npcProfile: DynamicNPCProfile;
  currentScene: string;
  /** In-flight action, if any. NO handle field — handle is engine-internal.
   *  When agent decides `act` while currentAction is defined, the controller
   *  queries the engine for the active handle and cancels it (Decision 14). */
  currentAction?: { actionText: string };
  recentMemory: ReadonlyArray<{
    type: string;
    content: string;
    gameDay: number;
    gameTime: string;
  }>;
  longTermIntent?: string;
  /** Present iff this tick produced revise-relevant events affecting this NPC
   *  (per impactPropagation). All triggers from one tick are batched here so
   *  the agent makes a single combined-context decision rather than reacting
   *  to each event in isolation. Absent when the tick had no revise events
   *  for this NPC. Decision 16 (revised 2026-04-24). */
  reviseTriggers?: ReadonlyArray<{
    description: string;
    sourceEvent?: FeatureEvent | CharacterAction;
  }>;
  /** Renderer-layer perception output (Decision 10). Empty during Phase F
   *  (Decision 11 — renderer deferred). */
  perception?: {
    narrative: string;
    perceivedFacts?: unknown[];
  };
}

export interface RoleSimAgent {
  decideNext(ctx: RoleSimContext): Promise<RoleSimDecision>;
}
```

Design principle: **agent and controller speak in semantic terms (action text, intent, memory); engine handles stay inside the engine.** Controller queries `engine.getActorQueue(npcId)` whenever it needs to know "is this NPC busy?" or "what handle to cancel?" — no `activeHandles` mirror map.

Notes:
- `tool: "plan"` removed (Decision 4 — plan goes through `writeMemory({ type: "plan", ... })`).
- `tool: "interrupt"` removed (Decision 14 — `act` absorbs cancellation when `currentAction` exists).
- `tool: "wait"` renamed to `continue` (Decision 14).
- `RoleSimDecision.act.input` is a slim shape — no `characterId` (controller adds it from npcId), no `sceneId` (controller adds it from DGSM), and no engine handle.

- [x] **Step 2: Define `TOOL_CAPS` + `TERMINAL_TOOLS` constants in `toolDispatcher.ts`**

Tool "schemas" are not separate JSON files — they're embedded as descriptive text in the system prompt (Step 5). Only the runtime constants live in code:

```ts
// src/roleSim/toolDispatcher.ts (constants)

/** Tools that consume a tick — calling one ends the agent loop. Decision 17. */
export const TERMINAL_TOOLS = new Set(["act", "continue"]);

/** Per-tool call budget within a single decide() call. Decision 19. */
export const TOOL_CAPS: Record<string, number> = {
  recallMemory: 10,
  writeMemory: 3,
  getMapSnapshot: 1,
};

/** Whitelist of valid tool names — used for LLM output validation. */
export const VALID_TOOLS = new Set([
  "act", "continue", "writeMemory", "recallMemory", "getMapSnapshot",
]);
```

The user-facing tool catalog (with shapes, semantics, and JSON output format) is documented inline in the system prompt at Step 5. This is the same convention `NPCPlanningAgent` uses — instructions live in the prompt, parsing logic lives in `parseJsonResponse` + dispatch.

- [x] **Step 3: Implement `toolDispatcher.ts`** (instant tools only)

The dispatcher executes only the **instant tools** (`writeMemory` / `recallMemory` / `getMapSnapshot`) — those touch memory and DGSM but never the engine. **Terminal tools** (`act` / `continue`) do not flow through the dispatcher; the agent loop returns them straight to the controller, which makes the engine call directly. This keeps engine handles strictly inside engine + controller.

```ts
// src/roleSim/toolDispatcher.ts
export interface DispatcherDeps {
  memory: NpcMemoryManager;
  dgsm: DynamicGameStateManager;
  npcId: string;
  sessionId: string;
  moduleId: string;
  gameDay: number;
  gameTime: string;
}

export interface DispatchResult {
  /** Result string fed back to the LLM as the tool_result content. */
  result: string;
}

export async function dispatchInstantTool(
  toolName: string,
  input: unknown,
  caps: Record<string, number>,        // remaining call budget per tool
  deps: DispatcherDeps,
): Promise<DispatchResult> {
  // 1. Cap check (Decision 19 option a):
  if (caps[toolName] !== undefined && caps[toolName] <= 0) {
    return {
      result: `Error: tool "${toolName}" has been used the maximum allowed times in this decision. Try a different tool or commit with act/continue.`,
    };
  }
  if (caps[toolName] !== undefined) caps[toolName] -= 1;

  // 2. Route by tool name (instant tools only — Decision 14 + handle-isolation):
  switch (toolName) {
    case "writeMemory":      return await dispatchWriteMemory(input as WriteMemoryInput, deps);
    case "recallMemory":     return await dispatchRecallMemory(input as RecallMemoryInput, deps);
    case "getMapSnapshot":   return dispatchGetMapSnapshot(deps);
    default:                 return { result: `Unknown instant tool: ${toolName}` };
  }
}

// dispatchWriteMemory / dispatchRecallMemory / dispatchGetMapSnapshot:
//  - call memory.add / memory.query / read map snapshot
//  - return result string with success info or fetched data
```

`act` and `continue` (terminal tools) are **not** in the dispatcher — they're returned by the agent loop as `RoleSimDecision` and handled by the controller's switch in F5 Step 5 (which is where engine submission/cancellation lives).

The `mapAdd` branch of `writeMemory` does name → ID mapping internally (Decision 6 implementation detail) — for Phase F MVP, take a best-effort approach: case-insensitive match on scene/junction/road `name` fields in DGSM; on no match log warning + still write the memory entry with the raw name in content (so it's at least preserved as a textual note).

- [x] **Step 4: Implement `LLMRoleSimAgent.decideNext`**

Uses the existing `generateText` + `parseJsonResponse` pattern (same as `NPCPlanningAgent`'s LLM calls). No new model wrapper. Engine is **not** a dependency — handle-related work happens in the controller.

```ts
// src/roleSim/llmAgent.ts
import { ModelClass, generateText } from "../models/index.js";
import { parseJsonResponse } from "../shared/jsonParse.js";
import { dispatchInstantTool, TOOL_CAPS, TERMINAL_TOOLS, VALID_TOOLS } from "./toolDispatcher.js";
import type { RoleSimAgent, RoleSimContext, RoleSimDecision } from "./agent.js";

const MAX_TOTAL_ITERATIONS = 14; // sum of TOOL_CAPS + a few terminal-call attempts

export class LLMRoleSimAgent implements RoleSimAgent {
  constructor(
    private deps: {
      memory: NpcMemoryManager;
      dgsm: DynamicGameStateManager;
      sessionId: string;
      moduleId: string;
      language: string;
    },
  ) {}

  async decideNext(ctx: RoleSimContext): Promise<RoleSimDecision> {
    const caps = { ...TOOL_CAPS };
    const dispatcherDeps = this.buildDispatcherDeps(ctx);
    const transcript: string[] = [];   // accumulated tool calls + results across iterations

    for (let i = 0; i < MAX_TOTAL_ITERATIONS; i++) {
      const userPrompt = this.buildUserPrompt(ctx, transcript);

      const responseText = await generateText({
        customSystemPrompt: PHASE_F_PLACEHOLDER_SYSTEM_PROMPT,
        context: userPrompt,
        modelClass: ModelClass.MEDIUM,
      });

      let parsed: { tool: string; [k: string]: unknown };
      try {
        parsed = parseJsonResponse<{ tool: string; [k: string]: unknown }>(responseText);
      } catch {
        // LLM returned plain text without parseable JSON — implicit continue (Decision 20)
        console.warn(`[LLMRoleSimAgent] ${ctx.npcId} returned non-JSON — falling back to continue`);
        return { tool: "continue", reason: "implicit (no JSON tool call)" };
      }

      if (!parsed.tool || !VALID_TOOLS.has(parsed.tool)) {
        // LLM made up a tool name — error feedback, loop continues
        transcript.push(this.formatToolError(parsed.tool, "Unknown tool name."));
        continue;
      }

      // Terminal tools (act / continue) — return the decision; controller does the engine call.
      if (TERMINAL_TOOLS.has(parsed.tool)) {
        return this.buildTerminalDecision(parsed);
      }

      // Instant tools (writeMemory / recallMemory / getMapSnapshot) — execute via dispatcher, loop continues.
      const dispatched = await dispatchInstantTool(parsed.tool, parsed, caps, dispatcherDeps);
      transcript.push(this.formatToolCall(parsed));
      transcript.push(this.formatToolResult(dispatched.result));
    }

    console.warn(`[LLMRoleSimAgent] ${ctx.npcId} hit MAX_TOTAL_ITERATIONS without terminating — forcing continue`);
    return { tool: "continue", reason: "iteration cap (forced)" };
  }

  /** Convert LLM-emitted JSON into a typed RoleSimDecision for the controller. */
  private buildTerminalDecision(parsed: { tool: string; [k: string]: unknown }): RoleSimDecision {
    if (parsed.tool === "act") {
      const actionText = String(parsed.actionText ?? "");
      const targetCharacterIds = Array.isArray(parsed.targetCharacterIds)
        ? (parsed.targetCharacterIds as string[])
        : undefined;
      return { tool: "act", input: { actionText, targetCharacterIds } };
    }
    return { tool: "continue", reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
  }

  /** Initial ctx + accumulated transcript so far. Phase F MVP placeholder; F1 brainstorm refines. */
  private buildUserPrompt(ctx: RoleSimContext, transcript: string[]): string {
    const lines: string[] = [];
    lines.push(`# You are ${ctx.npcProfile.name}`);
    lines.push(`Time: Day ${ctx.currentTime.day}, ${ctx.currentTime.tickTime}`);
    lines.push(`Current scene: ${ctx.currentScene}`);
    if (ctx.longTermIntent) {
      lines.push(`\n## Your long-term intent\n${ctx.longTermIntent}`);
    }
    if (ctx.currentAction) {
      lines.push(`\n## Currently doing\n"${ctx.currentAction.actionText}"`);
    }
    if (ctx.reviseTriggers && ctx.reviseTriggers.length > 0) {
      lines.push(`\n## Things that just happened around you (this tick)`);
      for (const t of ctx.reviseTriggers) {
        lines.push(`- ${t.description}`);
      }
    }
    if (ctx.perception?.narrative) {
      lines.push(`\n## What you perceive\n${ctx.perception.narrative}`);
    }
    if (ctx.recentMemory.length > 0) {
      lines.push(`\n## Recent memories`);
      for (const m of ctx.recentMemory) {
        lines.push(`- [${m.gameTime}] (${m.type}) ${m.content}`);
      }
    }
    if (transcript.length > 0) {
      lines.push(`\n## Tool calls so far this decision\n${transcript.join("\n")}`);
    }
    lines.push(`\n## Decide your next action using the tools described in the system prompt. Output a single JSON object.`);
    return lines.join("\n");
  }

  private formatToolCall(parsed: { tool: string; [k: string]: unknown }): string {
    return `→ Called: ${JSON.stringify(parsed)}`;
  }
  private formatToolResult(result: string): string {
    return `← Result: ${result}`;
  }
  private formatToolError(toolName: unknown, msg: string): string {
    return `← Error for "${String(toolName)}": ${msg}`;
  }

  private buildDispatcherDeps(ctx: RoleSimContext): DispatcherDeps {
    return {
      memory: this.deps.memory,
      dgsm: this.deps.dgsm,
      npcId: ctx.npcId,
      sessionId: this.deps.sessionId,
      moduleId: this.deps.moduleId,
      gameDay: ctx.currentTime.day,
      gameTime: ctx.currentTime.tickTime,
    };
  }
}
```

The transcript-string approach (vs. native Anthropic message history) is intentional — same pattern as the rest of the project. Each iteration sends the **full** ctx + transcript-so-far as one user prompt; LLM doesn't need conversation history because we re-render everything. Slightly more tokens per call but mechanically simpler.

- [x] **Step 5: Placeholder system prompt**

```ts
// src/roleSim/llmAgent.ts (constant)
const PHASE_F_PLACEHOLDER_SYSTEM_PROMPT = `
You are an NPC in a Call of Cthulhu tabletop RPG simulation. Each turn you receive your current
context (your profile, time of day, long-term intent, recent memories, current action if any,
and possibly a notification of something that just happened around you) and must choose what to
do next using the provided tools.

Tools that consume a tick (terminate this decision — you must end with exactly one):
- act(actionText, targetCharacterIds?): take a physical action in the world (move, examine, talk,
  attack, etc.). If you currently have an in-flight action, calling act will CANCEL it and start
  the new one — use this when something happens that makes you want to switch focus.
- continue(reason?): do nothing new; if you have an in-flight action let it keep running, otherwise
  let time pass.

Tools that don't consume a tick (loop continues, you can chain multiple before terminating):
- writeMemory(type, content | mapAdd): record a thought/plan/belief/secret/etc. to your memory.
- recallMemory(query?, types?, limit?): query your past memories.
- getMapSnapshot(): view your known map of places.

You must end every decision by calling exactly one of: act, continue.
`.trim();
```

- [x] **Step 6: Tool dispatcher tests** (instant tools only)

`src/roleSim/__tests__/toolDispatcher.test.ts` covers the instant tools the dispatcher actually owns:

- `writeMemory({type:"plan", content:"..."})` calls `memory.add` with correct args; returns confirmation string
- `writeMemory({type:"belief", content:"..."})` ditto
- `writeMemory({type:"long_term_intent", content:"..."})` ditto
- `writeMemory({type:"map", mapAdd:{sceneNames:["library"]}})` resolves "library" via DGSM scene-name match → calls memory.add with structured map update
- `writeMemory({type:"map", mapAdd:{sceneNames:["nonexistent"]}})` logs warning + still writes a textual map memory
- `recallMemory({query:"smith", limit:5})` calls `memory.query` with correct args; formats results
- `recallMemory()` (no query) returns chronological listing
- `getMapSnapshot()` returns the merged KnownMapSnapshot
- Cap enforcement: 11th `recallMemory` call returns cap-exceeded error result string
- Unknown tool name returns error result string

Use mocked DGSM / memory manager. No LLM in tests. **No `act` / `continue` tests here** — those terminal tools don't go through the dispatcher; they're tested via the controller (F5 Step 6).

- [x] **Step 7: Wire `LLMRoleSimAgent` into `NpcActionController`**

Update `npcActionController.ts` constructor signature so it accepts any `RoleSimAgent` (interface unchanged from F2 Step 1). Phase E's `NpcAgentAdapter` and the new `LLMRoleSimAgent` both satisfy it; F4 swaps in the LLM agent.

The controller's switch over `RoleSimDecision` is a 2-arm switch (only terminal tools reach here; instant tools were already executed inside the agent loop). **Engine cancellation + submission both happen here** — the dispatcher does not call the engine, so this is the single source of truth for engine writes:

```ts
switch (decision.tool) {
  case "act": {
    // Decision 14: if NPC has an in-flight action, cancel it before submitting the new one.
    // Engine is the source of truth for in-flight state — query it, do not mirror.
    const queue = this.engine.getActorQueue(npcId);
    const live = queue.find((s) => s.status === "active" || s.status === "queued");
    if (live) this.engine.cancelAction(live.handle);

    await this.engine.submitAction({
      characterId: npcId,
      actionText: decision.input.actionText,
      targetCharacterIds: decision.input.targetCharacterIds,
      sceneId: this.resolveCurrentSceneId(npcId),
    });
    return;
  }
  case "continue":
    return;
  // writeMemory / recallMemory / getMapSnapshot are instant tools — they
  // were dispatched inside agent.decideNext() and never reach here.
}
```

`resolveCurrentSceneId(npcId)` is a tiny helper that calls `dgsm.resolveLocationId(dgsm.getCharacterPosition(npcId))`.

**Phase E `activeHandles` map is removed.** It mirrored what the engine already knows. Replacing it everywhere:
- "Is this NPC busy?" → `engine.getActorQueue(npcId).some(s => s.status === "active" || s.status === "queued")`
- "What's this NPC doing?" → `engine.getActorQueue(npcId).find(s => s.status === "active")?.actionText`

F4 / F5 use the same query pattern.

> **Verification deferred to F7.**

---

### Task F3: `seedNpcLongTermIntents` + `dailySummarization` standalone modules

**Goal:** lift the two surviving NPCPlanningAgent helpers into self-contained modules under `src/roleSim/`. Both are system-driven (not agent-driven) — Phase F treats them as "background processes" that produce memory entries via `NpcMemoryManager.add(...)`. After this task, `NPCPlanningAgent.seedLongTermIntents` and `NPCPlanningAgent.onNewDay` (the summarization half) have replacement homes.

**Files:**
- Create: `src/roleSim/seedIntents.ts` (~40 LOC) — single function `seedNpcLongTermIntents(...)`
- Create: `src/roleSim/dailySummarization.ts` (~250 LOC) — `summarizeAllNpcDayMemory(...)` + `summarizeDayMemory(...)` + slim summary-only prompt builder + ISO date helpers
- Create: `src/roleSim/__tests__/seedIntents.test.ts` — verifies one-memory-per-NPC + skip-when-no-intent
- Create: `src/roleSim/__tests__/dailySummarization.test.ts` — verifies date prefix, only-summary output, mocked LLM
- Modify: nothing else in F3 (wiring happens in F4)

**Per Decisions 22, 25:**
- Decision 22: seedIntents helper (system writes initial long_term_intent memory at module load)
- Decision 25: slim summarization (summary-only, ISO `[YYYY-MM-DD]` prefix, fall back to `[Day N]`)

- [x] **Step 1: `seedNpcLongTermIntents`**

```ts
// src/roleSim/seedIntents.ts
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { DynamicNPCProfile } from "../state/types.js";

/**
 * Module-load helper: write each NPC's module-defined `longTermIntent` as a
 * `long_term_intent` memory entry. Called once per session bootstrap.
 *
 * Per Decision 22 (Phase F brainstorm 2026-04-24): module-author intents are
 * narrative design and must be preserved verbatim into NpcMemory; agent can
 * later self-revise via writeMemory.
 */
export async function seedNpcLongTermIntents(params: {
  npcs: DynamicNPCProfile[];
  sessionId: string;
  moduleId: string;
  memoryManager: NpcMemoryManager;
  gameDay: number;
  gameTime: string;
}): Promise<void> {
  let seeded = 0;
  for (const npc of params.npcs) {
    if (!npc.longTermIntent) continue;
    await params.memoryManager.add({
      npcId: npc.id,
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      type: "long_term_intent",
      content: npc.longTermIntent,
      gameDay: params.gameDay,
      gameTime: params.gameTime,
    });
    seeded += 1;
  }
  console.log(
    `[seedNpcLongTermIntents] seeded ${seeded} long-term intent(s) ` +
    `(${params.npcs.length - seeded} npcs had no module-defined intent)`,
  );
}
```

The console log is part of the contract — F7 Step 4 looks for `[seedNpcLongTermIntents]` in the boot logs to confirm the seeding ran.

- [x] **Step 2: `dailySummarization` — date helper + prompt + driver**

`src/roleSim/dailySummarization.ts` lifts the legacy `summarizeAllNpcDayMemory` + `summarizeDayMemory` from `NPCPlanningAgent.ts`, applies the Decision 25 simplifications:

```ts
// src/roleSim/dailySummarization.ts
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import { ModelClass, generateText } from "../models/index.js";
import { parseJsonResponse } from "../shared/jsonParse.js";
// Inline self-contained formatters (do not import from src/planning/) — F6 deletes that directory's planning code.

/**
 * Resolve in-world calendar date for a given gameDay.
 * Returns "[YYYY-MM-DD]" when ModuleSetup.startDate is a valid ISO 8601 date,
 * "[Day N]" otherwise. Invalid input is logged + falls back gracefully (does
 * not throw — failed dating must not crash the nightly summarization batch).
 *
 * Exported so other system writers (e.g., SimulationRunner's death-memory
 * write in F4) can produce identically-formatted date prefixes without
 * duplicating the validation + fallback logic.
 */
export function formatDayPrefix(gameDay: number, startDate?: string): string {
  if (!startDate) {
    console.warn(
      `[dailySummarization] ModuleSetup.startDate not set; falling back to "[Day ${gameDay}]" prefix. ` +
      `Add a startDate field to enable ISO calendar dating.`,
    );
    return `[Day ${gameDay}]`;
  }
  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) {
    console.warn(
      `[dailySummarization] startDate "${startDate}" is not a valid ISO 8601 date ` +
      `(expected YYYY-MM-DD); falling back to "[Day ${gameDay}]"`,
    );
    return `[Day ${gameDay}]`;
  }
  const result = new Date(start);
  result.setUTCDate(result.getUTCDate() + (gameDay - 1));
  return `[${result.toISOString().slice(0, 10)}]`;
}

interface SummaryItem { content: string; importance: number }

function buildSummaryPrompt(params: {
  npcName: string;
  npcProfile: string;       // simple inline format
  gameDay: number;
  dayPrefix: string;        // "[1923-10-17]" or "[Day 3]"
  eventLog: string;
  language: string;
}): { systemPrompt: string; userPrompt: string } {
  const lang = params.language?.startsWith("zh") ? "Chinese" : "English";

  const systemPrompt = `You are an NPC reflecting on the day at bedtime. Write 1-4 short
diary-style memories in first person summarizing today's significant events and
your reactions to them. Each memory must start with "${params.dayPrefix} " so
future-you can date it. Drop routine actions; focus on important events,
relationship changes, emotional moments. Each memory is 2-3 sentences.

importance: 1=minor, 2=routine, 3=significant, 4=major turning point, 5=critical.

Return JSON only. Write content in ${lang}.

\`\`\`json
{
  "memories": [
    { "content": "${params.dayPrefix} ...", "importance": 3 }
  ]
}
\`\`\``;

  const userPrompt = `## You are ${params.npcName}
${params.npcProfile}

## Today's Events (Day ${params.gameDay})
${params.eventLog}`;

  return { systemPrompt, userPrompt };
}

export async function summarizeDayMemory(params: {
  dgsm: DynamicGameStateManager;
  memoryManager: NpcMemoryManager;
  sessionId: string;
  moduleId: string;
  npcId: string;
  gameDay: number;
  language: string;
  startDate?: string;
}): Promise<void> {
  if (!params.dgsm.isNpcAlive(params.npcId)) return;

  const events = await params.memoryManager.getForDayByTypes(
    params.npcId, params.sessionId, params.gameDay, ["event", "witness"],
  );
  if (events.length === 0) return;

  const npc = params.dgsm.getState().npcCharacters.find((n) => n.id === params.npcId);
  if (!npc) return;

  const dayPrefix = formatDayPrefix(params.gameDay, params.startDate);
  const eventLog = events.map((e) => `- [${e.gameTime}] (${e.type}) ${e.content}`).join("\n");

  // Phase F MVP: minimal profile rendering. F1 prompt brainstorm refines this
  // to include full background / personality / skills.
  const profileBits = [npc.name];
  if (npc.occupation) profileBits.push(npc.occupation);
  if (npc.age != null) profileBits.push(`age ${npc.age}`);

  const { systemPrompt, userPrompt } = buildSummaryPrompt({
    npcName: npc.name,
    npcProfile: profileBits.join(", "),
    gameDay: params.gameDay,
    dayPrefix,
    eventLog,
    language: params.language,
  });

  console.log(`[dailySummarization] 📝 Day ${params.gameDay} for ${npc.name}`);
  const response = await generateText({
    customSystemPrompt: systemPrompt,
    context: userPrompt,
    modelClass: ModelClass.MEDIUM,
  });

  // LLM occasionally returns malformed JSON. Skip this NPC's summary on parse
  // failure rather than crashing the whole nightly batch (running in
  // Promise.all in summarizeAllNpcDayMemory below).
  let parsed: { memories: SummaryItem[] };
  try {
    parsed = parseJsonResponse<{ memories: SummaryItem[] }>(response);
  } catch (err) {
    console.warn(
      `[dailySummarization] ${npc.name}: JSON parse failed, skipping summary:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  await Promise.all(
    parsed.memories.map((m) =>
      params.memoryManager.add({
        npcId: params.npcId,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        type: "summary",
        content: m.content,
        gameDay: params.gameDay,
        gameTime: "23:59",
        metadata: { importance: m.importance },
      }),
    ),
  );
}

export async function summarizeAllNpcDayMemory(params: {
  dgsm: DynamicGameStateManager;
  memoryManager: NpcMemoryManager;
  sessionId: string;
  moduleId: string;
  gameDay: number;
  language: string;
}): Promise<void> {
  const startDate = params.dgsm.getState().moduleSetup?.startDate;
  const npcs = params.dgsm.getSimulatedNpcs();
  // TODO(post-Phase-F): rate-limit when npcs.length is large. Promise.all
  // fires N concurrent LLM calls — risk of hitting Anthropic RPM limits on
  // sessions with many NPCs. Acceptable for MVP (matches legacy behavior in
  // NPCPlanningAgent.summarizeAllNpcDayMemory). Per-NPC failures are
  // already isolated by summarizeDayMemory's try/catch.
  await Promise.all(
    npcs.map((npc) =>
      summarizeDayMemory({
        ...params,
        npcId: npc.id,
        startDate,
      }),
    ),
  );
}
```

Note: prompt formatter uses an inline NPC-profile renderer rather than importing from `src/planning/`. F6 deletes the whole legacy `src/planning/` non-essential surface; this module must not depend on anything that's about to be removed.

- [x] **Step 3: Tests**

Both tests use mocked `NpcMemoryManager` + LLM call to verify outputs without real LLM:

```ts
// src/roleSim/__tests__/seedIntents.test.ts
// - Skips NPCs with empty longTermIntent
// - Writes one memory per NPC with non-empty intent
// - Memory has type: "long_term_intent" + correct content/sessionId/moduleId

// src/roleSim/__tests__/dailySummarization.test.ts
// - When startDate set: prefix is "[1923-10-17]"
// - When startDate omitted: prefix is "[Day 3]" + warning logged
// - Skips NPCs without event memories that day
// - Skips dead NPCs
// - Writes only summary type (no information/belief writes — verify mock not called for those)
// - LLM called exactly once per alive NPC with day-events
```

> **Verification deferred to F7.**

---

### Task F4: `SimulationRunner` integration changes

**Goal:** rewire `SimulationRunner` to consume the new agent + standalone helpers from F2/F3 and to drop the legacy code paths the brainstorm killed. Removes `modifiedCharacterIds`-based revise gate, `npcPlanningAgent.onNewDay` call, schedule generation, and `interruptOpenNodesForDeath`. Adds direct `memoryManager` usage, `tickEngine.getActorQueue` queries, and `summarizeAllNpcDayMemory` invocation.

> **⚠️ F4 + F5 + F6 must be implemented as a single continuous work session — do not commit between them.**
>
> Between any two of these tasks the codebase does not compile cleanly:
> - F4 + F5 introduce calls to `LLMRoleSimAgent` and the new revise-event plumbing, but `NPCPlanningAgent` + `NpcAgentAdapter` are still imported/constructed (they're only deleted in F6)
> - F1.5 dropped `runtime` from the LLM call chain — `npcPlanningAgent.getRuntime()` no longer exists. F4 already passes no runtime arg to `interpretAction` / `resolveState`. Mention here is just for context; this dependency is already gone.
> - The Phase E controller signature still has `planningAgent` until F6 Step 9 strips it
>
> F7 is the **single Phase F commit boundary**. If you must pause mid-implementation, leave the working tree dirty rather than committing a half-state.

**Files:**
- Modify: `src/simulation/SimulationRunner.ts` (substantial — multiple methods)
- Modify: `src/simulation/characterInjection.ts` — drop `upsertIntent` helper (or keep as a thin shim to memory-write only; cleaner to inline at call site and delete the helper)
- Modify: `client/server/simulation/service.ts` — `buildSimulationBundle` now constructs `LLMRoleSimAgent` instead of `NpcAgentAdapter`; pass it into the controller

**Per Decisions 23, 24, 25, 26, 28:**
- Decision 23: injectCharacter simplification
- Decision 24: getCurrentNpcActions reimplementation
- Decision 25: dailySummarization wiring on day_transition
- Decision 26: death handling (cancel + memory)
- Decision 28: hard-cutover to LLM agent (no feature flag)

- [x] **Step 1: `getCurrentNpcActions` — reimplement via engine**

Replace the `npcPlanningAgent.getCurrentNpcActions(...)` delegation with a direct engine query:

```ts
async getCurrentNpcActions(): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const npc of this.dgsm.getState().npcCharacters) {
    if (!this.dgsm.isNpcAlive(npc.id)) {
      result[npc.id] = null;
      continue;
    }
    const queue = this.tickEngine?.getActorQueue(npc.id) ?? [];
    const active = queue.find((s) => s.status === "active");
    result[npc.id] = active?.actionText ?? null;
  }
  return result;
}
```

Note: `this.tickEngine` is constructed lazily in `ensureTickEngine` (Phase E pattern). Until first tick this method may return all-null — acceptable since UI won't display actions for not-yet-started simulations.

- [x] **Step 2: `checkDerivedEvents` — replace `interruptOpenNodesForDeath` with engine cancel + death memory**

```ts
import { formatDayPrefix } from "../roleSim/dailySummarization.js";

private async checkDerivedEvents(): Promise<void> {
  const gameState = this.dgsm.getState();

  for (const npc of gameState.npcCharacters) {
    if (this.deadNpcIds.has(npc.id)) continue;
    if (this.dgsm.isNpcAlive(npc.id)) continue;

    this.deadNpcIds.add(npc.id);

    // (1) cancel in-flight engine action(s) for this NPC
    if (this.tickEngine) {
      const queue = this.tickEngine.getActorQueue(npc.id);
      const live = queue.find((s) => s.status === "active" || s.status === "queued");
      if (live) this.tickEngine.cancelAction(live.handle);
    }

    // (2) write death event memory (Decision 26)
    // Use scene/junction/road *name* in the memory text so it reads naturally
    // ("the manor cellar" not "scene_blackwood_cellar"). UI event below keeps
    // the *ID* in its `location` field for backward compatibility with frontend
    // consumers.
    const position = gameState.characterPositions[npc.id];
    const locationId = position ? this.dgsm.resolveLocationId(position) : "unknown";
    const locationName = (locationId !== "unknown")
      ? (this.dgsm.getScene(locationId)?.name ?? locationId)
      : "unknown";
    const dayPrefix = formatDayPrefix(gameState.gameDay, gameState.moduleSetup?.startDate);
    if (this.memoryManager) {
      await this.memoryManager.add({
        npcId: npc.id,
        sessionId: this.sessionId,
        moduleId: this.config.moduleId,
        type: "event",
        content: `${dayPrefix} Died at ${gameState.timeOfDay} in ${locationName}`,
        gameDay: gameState.gameDay,
        gameTime: gameState.timeOfDay,
      });
    }

    // (3) emit npc_death UI event — keep `location` as ID (existing API contract)
    this.events.emitSimulationEvent("npc_death", npc.id, locationId, gameState.gameDay, gameState.timeOfDay, {
      npcName: npc.name,
      hp: gameState.npcStats[npc.id]?.hp ?? npc.status.hp ?? 0,
    });
  }
}
```

Date prefix uses the same `formatDayPrefix` helper F3 exports — death-memory dating and daily-summary dating share validation, fallback, and warning behavior. No duplicated date logic.

- [x] **Step 3: Day-transition handling — call `summarizeAllNpcDayMemory`, drop `onNewDay`**

In `executeTick`, replace:

```diff
       if (this.dgsm.getGameDay() !== dayBefore) {
         const stateAfter = this.dgsm.getState();
         this.events.emitSimulationEvent(...day_transition...);

-        await this.npcPlanningAgent.onNewDay(
-          this.dgsm,
-          this.sessionId,
-          this.config.moduleId,
-          stateAfter.gameDay,
-          this.language,
-          this.definitions,
-        );
+        // Daily summarization (Decision 25) — system writes [date]-prefixed
+        // summary memories for every alive NPC. Schedule generation (the
+        // legacy second half of onNewDay) is deleted with the planner.
+        if (this.memoryManager) {
+          await summarizeAllNpcDayMemory({
+            dgsm: this.dgsm,
+            memoryManager: this.memoryManager,
+            sessionId: this.sessionId,
+            moduleId: this.config.moduleId,
+            gameDay: dayBefore,                // summarize the day that JUST ended
+            language: this.language,
+          });
+        }
       }
```

Note: `dayBefore` (not `stateAfter.gameDay`) is passed because we're summarizing the day that just ended. No `runtime` parameter — F1.5 dropped the `runtime` field from `summarizeAllNpcDayMemory`'s signature; `generateText` reads provider from env directly.

- [x] **Step 4: `injectCharacter` — simplify**

```ts
async injectCharacter(profile: DynamicNPCProfile, intent: string): Promise<void> {
  if (this.state !== "paused") {
    throw new Error(`Cannot inject character while simulation is ${this.state}. Pause first.`);
  }

  const entrySceneId = profile.residence
    ? resolveEntryScene(this.dgsm, profile.residence)
    : null;
  if (!entrySceneId) {
    throw new Error(`Cannot resolve entry scene for residence "${profile.residence}". Check scenarioOutlines.`);
  }

  injectCharacterIntoState(this.dgsm, profile, entrySceneId);

  // Decision 23: write long_term_intent memory directly. No more upsertIntent
  // (NpcLongTermIntent table is gone). No more generateSingleNpcSchedule (no
  // schedule concept). Newly injected NPC's first decide() happens via
  // executeTick's per-tick poll on next resume.
  const gameState = this.dgsm.getState();
  if (this.memoryManager) {
    await this.memoryManager.add({
      npcId: profile.id,
      sessionId: this.sessionId,
      moduleId: this.config.moduleId,
      type: "long_term_intent",
      content: intent,
      gameDay: gameState.gameDay,
      gameTime: gameState.timeOfDay,
    });
  }

  await this.saveRuntime();
}
```

Drops: `upsertIntent(...)` call; `generateSingleNpcSchedule(...)` call.

- [x] **Step 5: `updateIntent` — strip path A revise trigger**

```ts
async updateIntent(characterId: string, intent: string): Promise<void> {
  if (this.state !== "paused") {
    throw new Error(`Cannot update intent while simulation is ${this.state}. Pause first.`);
  }

  const gameState = this.dgsm.getState();
  const npc = gameState.npcCharacters.find((n) => n.id === characterId);
  if (!npc) {
    throw new Error(`Character "${characterId}" not found in game state.`);
  }

  // Decision 13: path A (player edit triggers reviseSchedule) is deleted.
  // Player edits become pure memory writes; agent picks up the new intent
  // on next natural decide() call.
  if (this.memoryManager) {
    await this.memoryManager.add({
      npcId: characterId,
      sessionId: this.sessionId,
      moduleId: this.config.moduleId,
      type: "long_term_intent",
      content: intent,
      gameDay: gameState.gameDay,
      gameTime: gameState.timeOfDay,
    });
  }

  // No more this.modifiedCharacterIds.add(characterId)
  await this.saveRuntime();
}
```

- [x] **Step 6: Drop `modifiedCharacterIds` field + the `resume`/`step` revise loops**

```diff
   private readonly deadNpcIds: Set<string> = new Set();
-  private readonly modifiedCharacterIds: Set<string> = new Set();

   async resume(): Promise<void> {
     if (this.state !== "paused") return;
-
-    if (this.modifiedCharacterIds.size > 0) {
-      for (const charId of this.modifiedCharacterIds) {
-        if (!this.dgsm.isNpcAlive(charId)) continue;
-        await this.npcPlanningAgent.reviseSchedule(...);
-      }
-      this.modifiedCharacterIds.clear();
-    }
-
     return this.start();
   }

   async step(ticks = 1): Promise<void> {
     if (this.state !== "paused") return;
-
-    if (this.modifiedCharacterIds.size > 0) {
-      for (const charId of this.modifiedCharacterIds) {
-        if (!this.dgsm.isNpcAlive(charId)) continue;
-        await this.npcPlanningAgent.reviseSchedule(...);
-      }
-      this.modifiedCharacterIds.clear();
-    }
-
     for (let i = 0; i < ticks; i++) { ... }
   }
```

- [x] **Step 7: Construct `LLMRoleSimAgent` instead of `NpcAgentAdapter`**

In `ensureTickEngine()` (or wherever the controller is constructed):

```diff
-  const adapter = new NpcAgentAdapter(
-    this.npcPlanningAgent,
-    this.dgsm,
-    this.definitions,
-    this.sessionId,
-    this.language,
-  );
+  // LLMRoleSimAgent has NO engine dep (handle/queue is engine-internal) and
+  // NO runtime dep (F1.5 dropped runtime from the LLM call chain).
+  const agent = new LLMRoleSimAgent({
+    memory: this.memoryManager as NpcMemoryManager,
+    dgsm: this.dgsm,
+    sessionId: this.sessionId,
+    moduleId: this.config.moduleId,
+    language: this.language,
+  });
   const controller = new NpcActionController({
     engine,
-    agent: adapter,
+    agent,
     memory: this.memoryManager as NpcMemoryManager,
     dgsm: this.dgsm,
-    planningAgent: this.npcPlanningAgent,
     sessionId: this.sessionId,
     moduleId: this.config.moduleId,
   });
```

The controller's `planningAgent` constructor field is dropped here — it was Phase E's adapter dependency; the new agent doesn't need it. F6 finishes removing the `npcPlanningAgent` field from `SimulationRunner` once nothing else references it.

- [x] **Step 8: Drop the per-tick NPC polling loop in `executeTick`**

Phase E added (around `SimulationRunner.executeTick` line 718):

```ts
// Poll all alive NPCs without an active engine handle...
for (const npc of this.dgsm.getState().npcCharacters) {
  if (!this.dgsm.isNpcAlive(npc.id)) continue;
  await controller.decide(npc.id);
}
await engine.tick();
```

After F5's controller redesign, this polling is **redundant** — the controller's `tickCompleted` handler does the same job (drives decide() for affected/idle NPCs from the TickReport). Having both means double-decide per NPC per tick.

```diff
   const { engine, controller } = await this.ensureTickEngine();
-
-  // Poll all alive NPCs without an active engine handle...
-  for (const npc of this.dgsm.getState().npcCharacters) {
-    if (!this.dgsm.isNpcAlive(npc.id)) continue;
-    await controller.decide(npc.id);
-  }
-
   await engine.tick();
```

After F5: controller subscribes to `engine.on("tickCompleted", report => ...)` and processes everything from the report. No outside polling needed.

> **One-time bootstrap:** brand-new sessions need at least one decide() pass before the first `engine.tick()` to seed initial actions. Use `await controller.bootstrap()` (Phase E pattern) once at session start. F5 keeps the `bootstrap()` method on the controller for this purpose.

- [x] **Step 9: Replace `npcPlanningAgent.seedLongTermIntents` call in `service.ts`**

`client/server/simulation/service.ts` already has the exact line to replace (currently around line 473 in `createSimulation`):

```diff
   if (config?.weather && config.weather !== "clear") {
     applyGlobalWeather(dgsm, config.weather);
   }

-  await npcPlanningAgent.seedLongTermIntents(dgsm, sessionId, moduleId);
+  // Decision 22 — F3 helper writes long_term_intent memory entries directly.
+  await seedNpcLongTermIntents({
+    npcs: dgsm.getState().npcCharacters,
+    sessionId,
+    moduleId,
+    memoryManager,
+    gameDay: dgsm.getGameDay(),
+    gameTime: dgsm.getTickTime(),
+  });
   if (config?.syncRealTime) {
     runner.enableRealTimeSync(config.realTimeBufferMinutes ?? 0);
   }
```

`dgsm` and `memoryManager` are already in scope at this point (memoryManager from line ~162, dgsm from `buildSimulationBundle` return). Add the import at the top of `service.ts`:

```ts
import { seedNpcLongTermIntents } from "../../../src/roleSim/seedIntents.js";
```

This replaces the exact call site — no scattering "find the right place" ambiguity.

- [x] **Step 10: Document `npcPlanningAgent` field deferral to F6**

After F1.5 + F4, `SimulationRunner.npcPlanningAgent` has only **one** remaining purpose: keeping the field around so its construction in `service.ts` (line ~167) doesn't break before F6 deletes the class. It's no longer used for runtime access (F1.5 dropped that whole chain) — F4 Step 7 already constructs `LLMRoleSimAgent` without runtime.

F6 Step 6 + 7 deletes:
1. The `npcPlanningAgent` constructor param + class field on SimulationRunner
2. The `new NPCPlanningAgent(...)` construction in `service.ts buildSimulationBundle`
3. The `npcPlanningAgent` from `buildSimulationBundle`'s return

**Reminder (per the F4 Goal warning):** F4 + F5 + F6 are a single continuous work session. Don't commit after F4 expecting a clean build — `npcPlanningAgent` is still around but `LLMRoleSimAgent` is also wired in, dual-presence isn't a stable state.

> **Verification deferred to F7.**

---

### Task F5: `NpcActionController` — TickReport-driven decide pipeline

**Goal:** redesign `NpcActionController` around a single `tickCompleted` subscription. Each tick the controller receives a `TickReport` from the engine; from it the controller computes (a) which NPCs received revise-relevant events (per Decision 15 / impactPropagation), (b) which NPCs had an action end this tick, (c) which NPCs are alive and idle. Each affected NPC gets ONE `decide()` call with all triggers from this tick batched into `ctx.reviseTriggers`.

This eliminates concurrency races, ensures one decide per NPC per tick, and gives the agent a complete picture of "what just happened around me".

**Files:**
- Modify: `src/roleSim/npcActionController.ts` — replace Phase E's per-event subscriptions (`actionCompleted` / `actionInterrupted` / `actionCancelled` / `featureEvent`) with a single `tickCompleted` subscription; remove `activeHandles` field; rewrite `decide()` + `buildContext()` to thread `reviseTriggers`
- Modify: `src/engine/shared/impactPropagation.ts` — confirm the `ImpactPropagationAction` interface from Phase E covers what we need; extend if a FeatureEvent's impact-level computation needs different inputs
- Modify: `src/roleSim/agent.ts` — confirm `RoleSimContext.reviseTriggers` field added per F2 Step 1
- Create: `src/roleSim/__tests__/npcActionController.tickReport.test.ts` — verify TickReport → decide-per-affected-NPC; multi-event batching; idle-NPC inclusion

**Per Decisions 13, 15, 16:**
- Decision 13: path B (engine event → revise) merged into agent; deletes legacy reviseSchedule + impactGate
- Decision 15: use `impactPropagation.findAffectedCharacters` for affected-NPC determination
- Decision 16: `RoleSimContext.reviseTriggers` field (revised 2026-04-24 to plural — batched)

- [x] **Step 1: Replace per-event subscriptions with one `tickCompleted` subscription**

The Phase E controller subscribed to four channels (`actionCompleted` / `Interrupted` / `Cancelled` / `featureEvent`) and called `decide()` per event. Phase F collapses to one subscription:

```diff
   constructor(deps: NpcActionControllerDeps) {
     ...
-    this.engine.on("actionCompleted", (a) => { this.activeHandles.delete(a.handleId); void this.decide(a.characterId); });
-    this.engine.on("actionInterrupted", (a) => { this.activeHandles.delete(a.handleId); void this.decide(a.characterId); });
-    this.engine.on("actionCancelled", (a) => { this.activeHandles.delete(a.handleId); void this.decide(a.characterId); });
+    this.engine.on("tickCompleted", (report: TickReport) => this.processTickReport(report));
   }
```

The Phase E `activeHandles: Map<handleId, ActionHandle>` field and `hasActiveHandle` / `findActiveHandle` methods are also **deleted** — the engine is queried directly via `getActorQueue` whenever in-flight state is needed.

`bootstrap()` stays — F4 Step 8 still calls it once at session start to seed the first decide pass before the first `engine.tick()`.

- [x] **Step 2: Implement `processTickReport`**

```ts
private async processTickReport(report: TickReport): Promise<void> {
  // 1. Build per-NPC trigger lists from this tick's FeatureEvents (Decision 15)
  const triggersByNpc = new Map<string, Array<{ description: string; sourceEvent: FeatureEvent | CharacterAction }>>();

  for (const event of report.featureEvents) {
    if (!event.characterId && !event.sceneId) continue;   // unanchored event, skip
    // F1 Step 6 made FeatureEvent self-describing — read impact + description
    // directly off the event. No controller-side type→level mapping table.
    const action: ImpactPropagationAction = {
      characterId: event.characterId ?? "system",
      targetCharacterIds: [],
      location: event.sceneId ?? "",
    };
    const affected = findAffectedCharacters(action, event.impact, this.dgsm);
    for (const [npcId, _level] of affected) {
      const list = triggersByNpc.get(npcId) ?? [];
      list.push({ description: event.description, sourceEvent: event });
      triggersByNpc.set(npcId, list);
    }
  }

  // 2. NPCs whose action ended this tick (need a decide() to choose what's next)
  const npcsWithEndedAction = new Set<string>([
    ...report.commits.map((a) => a.characterId),
    ...report.interruptions.map((i) => i.action.characterId),
    ...report.cancellations.map((a) => a.characterId),
  ]);

  // 3. Alive NPCs currently idle (no in-flight action). They're candidates for
  //    decide() too — replaces the per-tick polling that lived in
  //    SimulationRunner.executeTick (F4 Step 8 deletes it there).
  const idleAlive = this.dgsm
    .getState()
    .npcCharacters.filter((n) => this.dgsm.isNpcAlive(n.id))
    .filter((n) => !this.npcHasActiveStep(n.id))
    .map((n) => n.id);

  // 4. Union of all NPCs that need decide() this tick
  const allTargets = new Set<string>([
    ...triggersByNpc.keys(),
    ...npcsWithEndedAction,
    ...idleAlive,
  ]);

  // 5. Sequential decide() — no concurrency, no race
  for (const npcId of allTargets) {
    if (!this.dgsm.isNpcAlive(npcId)) continue;
    const triggers = triggersByNpc.get(npcId);
    await this.decide(
      npcId,
      triggers && triggers.length > 0 ? { reviseTriggers: triggers } : undefined,
    );
  }
}

private npcHasActiveStep(npcId: string): boolean {
  return this.engine.getActorQueue(npcId).some(
    (s) => s.status === "active" || s.status === "queued",
  );
}
```

**Impact + description come from the event itself.** F1 Step 6 made `FeatureEvent` self-describing (`impact: 0-5` + `description: string`). Each emitter (Applier for synthetic `character.died`, scripted-event runner for `event.emit` effects, future features) sets these fields. The controller doesn't maintain a `eventType → impact` table or a description formatter — it just reads `event.impact` and `event.description`.

This matches spec §E-renderer-layer's "events carry intrinsic impact" model and avoids drift between emitter intent and consumer interpretation.

**On affected-NPC depth (the original review's #6 concern):** for FeatureEvents, the source action passed to `findAffectedCharacters` has `targetCharacterIds: []` — level-1 (targeted) hits no one. Coverage starts at level 2 (same scene). Distant relational depth (e.g., "Smith's mother lives in another town and grieves when he dies") is **out of scope** for Phase F — that's a renderer/perception concern that will be handled when the renderer ships and perception filtering becomes contextual.

- [x] **Step 3: Update `decide` signature to accept batched `reviseTriggers`**

```diff
-  async decide(npcId: string): Promise<void> {
+  async decide(
+    npcId: string,
+    opts?: { reviseTriggers?: ReadonlyArray<{ description: string; sourceEvent?: FeatureEvent | CharacterAction }> },
+  ): Promise<void> {
     if (!this.dgsm.isNpcAlive(npcId)) return;
-    if (this.hasActiveHandle(npcId)) return;
+    // Skip if NPC is busy AND has no triggers — busy idle NPCs without revise
+    // triggers don't need a new decision (their action is already running).
+    // With reviseTriggers, the agent gets a chance to switch action mid-flight.
+    if (this.npcHasActiveStep(npcId) && !(opts?.reviseTriggers && opts.reviseTriggers.length > 0)) return;

-    const ctx = await this.buildContext(npcId);
+    const ctx = await this.buildContext(npcId, opts);
     if (!ctx) return;
     ...
   }
```

- [x] **Step 4: Thread `reviseTriggers` through `buildContext`; derive `currentAction` from engine**

```diff
-  private async buildContext(npcId: string): Promise<RoleSimContext | undefined> {
+  private async buildContext(
+    npcId: string,
+    opts?: { reviseTriggers?: ReadonlyArray<{ description: string; sourceEvent?: FeatureEvent | CharacterAction }> },
+  ): Promise<RoleSimContext | undefined> {
     ...
+
+    // Derive currentAction from engine — no handle in agent-facing ctx.
+    const queue = this.engine.getActorQueue(npcId);
+    const active = queue.find((s) => s.status === "active");
+    const currentAction = active ? { actionText: active.actionText } : undefined;
+
     return {
       npcId,
       currentTime: { day, tickTime },
       npcProfile: profile,
       currentScene,
       recentMemory,
       longTermIntent,
+      reviseTriggers: opts?.reviseTriggers,
+      currentAction,
+      // perception left undefined per Decision 11 (renderer deferred)
     };
   }
```

No `findActiveActionContext` helper; inline `engine.getActorQueue` is the only source for in-flight state.

- [x] **Step 5: Implement the 2-arm controller switch over terminal decisions**

When agent wants to break an in-flight action and switch, it calls `act({ actionText: ... })`. The controller (this method) is the **single place** engine submission and cancellation happen — the dispatcher (F2 Step 3) does not touch the engine.

```ts
switch (decision.tool) {
  case "act": {
    // Decision 14: cancel current action first if any. Engine is the source of
    // truth for in-flight state — query it, do not mirror with activeHandles.
    const queue = this.engine.getActorQueue(npcId);
    const live = queue.find((s) => s.status === "active" || s.status === "queued");
    if (live) this.engine.cancelAction(live.handle);

    await this.engine.submitAction({
      characterId: npcId,
      actionText: decision.input.actionText,
      targetCharacterIds: decision.input.targetCharacterIds,
      sceneId: this.resolveCurrentSceneId(npcId),
    });
    return;
  }
  case "continue":
    return;
  // writeMemory / recallMemory / getMapSnapshot are instant tools — they were
  // dispatched inside agent.decideNext() and never reach this switch.
}
```

`resolveCurrentSceneId(npcId)` is `dgsm.resolveLocationId(dgsm.getCharacterPosition(npcId))`.

This is the single source of engine writes — handle-tracking is implicit (engine maintains its own queue; controller never stores ActionHandle).

- [x] **Step 6: Test — TickReport → batched decide()**

`src/roleSim/__tests__/npcActionController.tickReport.test.ts`:
- Mock TickEngine emits one `tickCompleted` event with a stub `TickReport` containing 2 featureEvents (e.g. a fire spread + a character.died) anchored to scene `S1`
- Mock DGSM: 3 NPCs — `npc1` in `S1`, `npc2` in `S1`, `npc3` elsewhere
- Stub agent's `decideNext` to record the ctx it receives and return `{ tool: "continue" }`
- Verify:
  - `decideNext` is called exactly **once** for `npc1` and once for `npc2` (both same-scene)
  - `decideNext` is **not** called for `npc3` (different scene, no triggers, but has active step → skipped per Step 3 guard); call once if `npc3` is idle (decoupled assertion)
  - The `ctx.reviseTriggers` for `npc1` contains **both** featureEvents (batched) — confirms multi-event batching from one tick
  - `decideNext` is NEVER called twice for the same NPC in the same TickReport processing

Also test the "act + currentAction" cancel-then-submit path (Decision 14):
- Stub agent returns `{ tool: "act", input: { actionText: "flee" } }` when ctx has `currentAction` + `reviseTriggers`
- Mock engine: `getActorQueue(npcId)` returns one `active` step
- Verify the controller switch invokes BOTH `engine.cancelAction(activeHandle)` and `engine.submitAction(...)` in that order

> **Verification deferred to F7.**

---

### Task F6: Delete `NPCPlanningAgent` + adapter + dead helpers

**Goal:** all replacements are now in place (F2 ships the agent, F3 ships the standalone helpers, F4 wires SimulationRunner to use them, F5 routes engine events). F6 deletes everything the brainstorm marked as obsolete.

**Files to delete:**

| Path | LOC | Why |
|---|---|---|
| `src/planning/NPCPlanningAgent.ts` | 1865 | Replaced by `LLMRoleSimAgent` (F2) + standalone helpers (F3) |
| `src/roleSim/npcAgentAdapter.ts` | ~70 | Phase E temp bridge; new agent is the real one |
| `src/planning/npcPlanningTemplates.ts` | 619 | Old planner prompts (impactGate, reviseSchedule, schedule generation) — all retired |
| `src/planning/npcSummaryTemplates.ts` | 102 | F3 lifted what it needed into self-contained dailySummarization |
| `src/planning/autoMovementHelpers.ts` | 63 | Movement is engine subsystem now (Phase E), planner doesn't auto-insert moves |
| `src/planning/revisionHelpers.ts` | ~20 | `interruptNode` was the only thing left; no PlanNode means no need |
| `src/planning/itemFormatHelpers.ts` | 37 | NPCPlanningAgent was sole consumer |
| `src/planning/skillDefaults.ts` | 150 | NPCPlanningAgent was sole consumer (verify with `rg`) |
| `src/planning/__tests__/NPCPlanningAgent.deathGuards.test.ts` | n/a | Testee gone |
| `src/planning/__tests__/NPCPlanningAgent.hiddenIsolation.test.ts` | n/a | Testee gone (already failed in Phase E) |
| `src/planning/__tests__/npcPlanningTemplates.test.ts` | n/a | Testee gone |
| `src/planning/__tests__/autoMovementHelpers.test.ts` | n/a | Testee gone |
| `src/planning/__tests__/timingShift.test.ts` | n/a | Tests planning agent timing logic — gone with planner |

**Files to keep + repurpose:**

| Path | Reason |
|---|---|
| `src/planning/sceneMapFormatter.ts` (541 LOC) | Used by `mapService.ts`, `service.ts`, `npcSceneMap.test.ts` — UI/server consumers. Stays, but consider moving to `src/state/` or `src/memory/` (out of `planning/` namespace) |
| `src/planning/cocSkillList.ts` (187 LOC) | Used by `engine/shared/skillRoll.ts`. Stays. Consider moving to `src/engine/shared/`. |
| `src/planning/types.ts` (post-F1) | Re-exports `CharacterAction`, plus `FailureReason` / `SuccessLevel` still used. Stays slim. |
| `src/planning/index.ts` | Stays, slim re-exports of remaining surface |

**Files to modify (cleanup imports / dead references):**

- `src/engine/types.ts` — delete the `NpcPlanningCapability` interface (was used by the legacy planner; nothing else consumes it)
- `src/engine/types.ts` — `ExecutionContext` may have unused fields after planner is gone; audit and slim
- `src/simulation/SimulationRunner.ts` — drop the `npcPlanningAgent` field from constructor params + class state (no `runtime` replacement needed — F1.5 already eliminated runtime from the LLM call chain)
- `client/server/simulation/service.ts` — drop `npcPlanningAgent` construction in `buildSimulationBundle` and from its return value
- `src/i18n/locales/en.ts`, `src/i18n/locales/zh.ts` — remove i18n keys that only the planner used (`outcome_with_detail_succeeded` etc. referenced from `nodeHelpers.ts` already deleted; `interrupted_death`, `interrupted_replanning_at`, etc.). Audit before removing — some may be used by the engine for action outcomes.

**Per Decisions 13, 22, 23, 25, 26, 27, 28:**
- Decision 13: deletes reviseSchedule + impactGate + revisionHelpers
- Decision 22: deletes seedLongTermIntents (replaced by F3 helper)
- Decision 23: deletes generateSingleNpcSchedule code path
- Decision 25: deletes onNewDay (replaced by F3 + F4 wiring)
- Decision 26: deletes interruptOpenNodesForDeath (replaced by F4 inline)
- Decision 27: deletes the two Prisma tables (already done in F1)
- Decision 28: confirms hard-cutover (no feature flag preservation)

- [x] **Step 1: Verify nothing imports the to-be-deleted helpers (apart from each other and NPCPlanningAgent)**

For each helper file in the deletion table, run:
```bash
grep -rl "from.*planning/<helper>" src/ client/ scripts/ tests/
```

Expected: only hits inside `src/planning/` itself or in NPCPlanningAgent.ts.
If anything else hits, stop and resolve (likely an oversight in F2-F5 wiring).

For `skillDefaults` specifically (no listed external consumers in the brainstorm scan):
```bash
grep -rln "from.*planning/skillDefaults" src/ client/ scripts/
```
If 0 hits outside `src/planning/`, delete it. Otherwise keep + move out of planning/.

- [x] **Step 2: Delete the agent + adapter**

```bash
rm src/planning/NPCPlanningAgent.ts \
   src/roleSim/npcAgentAdapter.ts
```

- [x] **Step 3: Delete dead helpers**

```bash
rm src/planning/npcPlanningTemplates.ts \
   src/planning/npcSummaryTemplates.ts \
   src/planning/autoMovementHelpers.ts \
   src/planning/revisionHelpers.ts \
   src/planning/itemFormatHelpers.ts \
   src/planning/skillDefaults.ts   # only if Step 1 verified no external consumers
```

- [x] **Step 4: Delete planning tests for deleted code**

```bash
rm src/planning/__tests__/NPCPlanningAgent.deathGuards.test.ts \
   src/planning/__tests__/NPCPlanningAgent.hiddenIsolation.test.ts \
   src/planning/__tests__/npcPlanningTemplates.test.ts \
   src/planning/__tests__/autoMovementHelpers.test.ts \
   src/planning/__tests__/timingShift.test.ts
```

(Keep `sceneMapFormatter.test.ts` and `npcSceneMap.test.ts` since their testees survive.)

- [x] **Step 5: Strip `NpcPlanningCapability` interface and **delete `ExecutionContext` entirely**

In `src/engine/types.ts`, delete:
- `interface NpcPlanningCapability { ... }` (the whole interface)
- `interface ExecutionContext { ... }` (whole interface — see below)
- Any imports / re-exports referencing them

**Why ExecutionContext is fully dead** (verified 2026-04-24):

Every field on `ExecutionContext` is unused after F1.5 + F2-F5 land:

| Field | Reader count | Status |
|---|---|---|
| `resolveSkillRoll` | 0 | dead — uses `PlanNode` (deleted in F1) |
| `getScenePenalties` | 0 | dead |
| `applyPenalties` | 0 | dead |
| `getCharacterPenalties` | 0 | dead |
| `getNodeDifficulty` | 0 | dead — uses `PlanNode` |
| `currentTime?: string` | 0 | dead |
| `simulationEmitter?` | 0 readers (only `SimulationRunner.ts:137` sets it) | dead |
| `runtime?: any` | 0 (F1.5 deletes) | dead |
| `language?: string` | 0 readers (`SimulationRunner.ts:139` sets, nobody reads — `stateResolver` reads its own `ResolverContext.language`, different type) | dead |
| `memoryManager?` | 0 readers (`SimulationRunner.ts:140` sets, nobody reads — `LLMRoleSimAgent` and `dailySummarization` get memory directly) | dead |

So:
- Delete `interface ExecutionContext` from `src/engine/types.ts`
- Delete `src/engine/executionContext.ts` entirely (the `createExecutionContext` factory)
- Drop `src/engine/index.ts` export of `createExecutionContext`
- Drop `src/planning/index.ts` re-export of `createExecutionContext` + `ExecutionContext`

In `SimulationRunner`:
```diff
   constructor(params: {
     config: SimulationConfig;
     dgsm: DynamicGameStateManager;
     definitions: ActionDefinitionRegistry;
-    ctx: ExecutionContext;
     language: string;
     memoryManager?: NpcMemoryManager;
     prisma: PrismaClient;
   }) {
     ...
-    this.ctx = params.ctx;
     this.language = params.language;
     this.memoryManager = params.memoryManager;
     ...
-    this.ctx.simulationEmitter = this.events;
-    this.ctx.language = this.language;
-    this.ctx.memoryManager = this.memoryManager;
   }
-
-  private readonly ctx: ExecutionContext;
```

In `service.ts buildSimulationBundle`:
```diff
-  const ctx = createExecutionContext();
   const runner = new SimulationRunner({
     ...,
-    ctx,
     ...,
   });
```

Net: ~50 LOC dead code deleted (interface + factory + setup) on top of the F6 deletion list.

- [x] **Step 6: SimulationRunner cleanup**

Drop the `npcPlanningAgent` field entirely — F1.5 already removed the only thing it was used for (runtime access via `getRuntime()`).

```diff
   constructor(params: {
     config: SimulationConfig;
     dgsm: DynamicGameStateManager;
-    npcPlanningAgent: NPCPlanningAgent;
     definitions: ActionDefinitionRegistry;
     ctx: ExecutionContext;
     language: string;
     memoryManager?: NpcMemoryManager;
     prisma: PrismaClient;
   }) {
     ...
-    this.ctx.runtime = this.npcPlanningAgent.getRuntime();
     this.ctx.language = this.language;
   }
```

`reconcileDeadNpcPlans` is also deleted — its only caller (`reviseSchedule`-era cleanup) is gone.

- [x] **Step 7: `service.ts` cleanup**

Both call sites of `buildSimulationBundle` (`createSimulation` ~line 405 + `getRunner` ~line 200) need updating. Inside `buildSimulationBundle`:

```diff
-  const npcPlanningAgent = new NPCPlanningAgent(
-    params.prisma,
-    memoryManager,                          // post-F1.5 — runtime arg already gone
-  );

   const runner = new SimulationRunner({
     config: params.config,
     dgsm,
-    npcPlanningAgent,
     definitions,
     ctx,
     language: params.language,
     memoryManager,
     prisma: params.prisma,
   });

-  return { runner, dgsm, npcPlanningAgent };
+  return { runner, dgsm };
```

Update both call sites of `buildSimulationBundle`:
- `createSimulation` (the destructure currently is `const { runner, dgsm, npcPlanningAgent } = buildSimulationBundle(...)` — drop `npcPlanningAgent`)
- `getRunner` (same destructure, same fix)

Also update the `await npcPlanningAgent.seedLongTermIntents(...)` call in `createSimulation` — F4 Step 9 already replaced it with `await seedNpcLongTermIntents({...})`. Confirm this swap is still in place.

- [x] **Step 8: i18n key audit**

```bash
grep -rln "interrupted_death\|interrupted_replanning\|outcome_with_detail" src/ client/
```

For each i18n key with no remaining references after F2-F6, remove from `src/i18n/locales/en.ts` + `zh.ts`. Skip ones still used by the engine (action outcome formatting in resolver).

- [x] **Step 9: Add `loadLongTermIntent` helper to controller (and expose `findLatestByType` from NpcMemoryManager)**

F4 Step 7 already removed `planningAgent` from `NpcActionController` construction; F5 Step 1 already removed `planningAgent` from the deps interface. What remains: the controller's `buildContext` (F5 Step 4) reads `longTermIntent` from somewhere — Phase E was `this.planningAgent.getLongTermIntent(...)`. Per Decision 2, the latest `long_term_intent` memory entry is the current intent.

`NpcMemoryManager.getAllByTypes` orders by `importance desc`, which is wrong for "latest". `MemoryStore` already has `findLatestByType` (orders by `updatedAt desc, createdAt desc`) — expose it through the manager:

```diff
 // src/memory/NpcMemoryManager.ts (add public method)
+  async findLatestByType(
+    sessionId: string,
+    npcId: string,
+    type: NpcMemoryType,
+  ): Promise<NpcMemory | null> {
+    return this.store.findLatestByType(sessionId, npcId, type);
+  }
```

Then in `NpcActionController`:

```ts
private async loadLongTermIntent(npcId: string): Promise<string> {
  const entry = await this.memory.findLatestByType(this.sessionId, npcId, "long_term_intent");
  return entry?.content ?? "";
}
```

Update `buildContext`:

```diff
-    const longTermIntent = await this.planningAgent
-      .getLongTermIntent(this.sessionId, npcId)
-      .catch(() => "");
+    const longTermIntent = await this.loadLongTermIntent(npcId);
```

This is the last `npcPlanningAgent`-coupled call in the controller. After this, the controller has zero references to the deleted class.

> **Verification deferred to F7.**

---

### Task F7: End-to-end verification + Phase F commit

**Goal:** consolidated verification of all F1–F6 changes (per project preference: skip per-task tests, batch at end). Then a single Phase F commit.

**Files:** none new; runs the full verification stack.

- [x] **Step 1: Full test suite**

```bash
pnpm vitest run --reporter=basic
```

Expected: all green. Likely failures to expect + how to handle:

- **F2/F3 unit tests** (toolDispatcher, seedIntents, dailySummarization): should pass on first run if F2/F3 followed the spec
- **Pre-existing failures from Phase E**: `NPCPlanningAgent.hiddenIsolation.test.ts` etc. — these are removed in F6 Step 4, so they're gone from the run
- **Resolver / interpreter / engine tests**: should be unaffected by Phase F
- **Frontend tests** (if any): should be unaffected

If a test fails, fix at site. Common categories likely to surface:
- Stale imports referencing deleted files (fix or delete the test)
- Missing tool dispatcher behavior (fix in F2 implementation)
- Type-shape mismatch on `RoleSimContext` (fix in F2 Step 1)

**Disambiguating "is this a Phase F regression or pre-existing?"** —
when uncertain, stash the working tree and re-run the same test against
Phase E baseline:

```bash
git stash --include-untracked
pnpm vitest run <suspect-file>          # baseline behavior on Phase E
git stash pop
pnpm vitest run <suspect-file>          # post-Phase-F behavior
```

If both fail identically → pre-existing, skip. If only post-F fails → Phase F regression, fix.

If you can't figure out a test failure within ~15 min, **stop and ask for help** instead of guessing — partial fixes risk breaking the bigger picture.

- [x] **Step 2: Type check**

```bash
pnpm build:tsc 2>&1 | grep -E "error TS" | head -50
```

Expected: 0 errors from Phase F surface (`src/roleSim/`, `src/simulation/SimulationRunner.ts`, `client/server/simulation/service.ts`, `src/planning/types.ts`, `src/engine/types.ts`).

Pre-existing Phase D errors (`worldStateBlock.ts getFeatureState`, `fireFeature`, `eventBus overload`) may persist; they're unrelated to Phase F and don't need to be fixed here.

If a Phase-F-introduced error surfaces, fix at site — most commonly:
- Missing field on `RoleSimContext` (add to type, F2 Step 1)
- Tool schema input type mismatch (refine F2 Step 3)
- Stale `NPCPlanningAgent` reference somewhere F6 missed (delete the reference)

- [x] **Step 3: Biome check**

```bash
pnpm check 2>&1 | tail -20
```

If biome auto-applies fixes, accept them (style cleanup; safe).

If biome errors persist on Phase F files, fix at site.

- [x] **Step 4a: Boot smoke (server + first tick)**

```bash
pnpm chat:dev
```

Bare minimum confirmation that wiring is correct:

1. Server starts without throwing (most common failure mode here: `LLMRoleSimAgent` constructor or `toolDispatcher` import errors — fix at site, re-run)
2. Frontend at `http://localhost:5173` loads
3. Create a new simulation from any available test module (check `data/Mods/` for what's actually present — `simple-town`, `blackwood-manor`, etc.)
4. Click Start
5. Confirm via server logs:
   - `[seedNpcLongTermIntents] seeded N long-term intent(s)` — F3 helper ran (Decision 22)
   - First tick completes without throwing
   - At least one NPC's `decide()` produced a `tool_use` block in the agent logs
   - `engine.submitAction(...)` returned a handle, action was processed

If 4a passes, the new agent + dispatcher + memory writes are wired correctly. If anything throws, **stop here and fix**; don't proceed to 4b.

- [x] **Step 4b: Feature smoke (behavior walkthrough — best-effort)**

These confirm individual Decisions land correctly. Some require functionality the project doesn't have a UI / scripted test path for — mark those as "not testable without renderer / dev script" rather than failing the task.

| # | Scenario | How to verify | Decision |
|---|---|---|---|
| 1 | Day-transition triggers summarization | Use `step ticks=N` in dev API to advance to day boundary fast (e.g., N = ticksPerDay). Confirm `[dailySummarization]` log + new `summary` memory rows in DB | 25 |
| 2 | Player intent edit takes effect on next decide() | Pause sim → use UI (or POST `/api/simulation/:id/intent`) to update an NPC's intent → resume → next decide() ctx contains the new long-term intent (visible in agent logs) | 13 path A |
| 3 | Inject a new NPC | Pause → inject via UI → resume → new NPC starts acting (visible in event stream) | 23 |
| 4 | Engine event triggers revise | **Untestable in Phase F without a dev trigger script** — note as "verify post-renderer when perception path lights up". Optional pre-renderer check: programmatically push a `featureEvent` via Node REPL into the engine and confirm controller logs `decide()` called with `reviseTriggers` populated (look in transcript for "Things that just happened around you") | 13 path B / 15 / 16 |
| 5 | NPC death cleanup | **Untestable in Phase F without a dev trigger** for HP-to-0. If a real CoC scenario exists where NPCs can plausibly die during a smoke run (e.g., a combat module), use it. Otherwise mark as "verified by code review of `checkDerivedEvents`" | 26 |

If items 4 + 5 are untestable in this environment, that's accepted — they're code-reviewed in F4/F5 and exercised properly when the renderer or a dev trigger script ships.

> **Time budget hint:** if a default tick interval is high (e.g. 1 tick / minute realtime), use `pnpm chat:debug` or set `tickIntervalMs=100` via the simulation config to make day boundaries reachable in a smoke session.

- [x] **Step 5: Confirm legacy `SimulationRuntime` rows are unloadable** (per Phase E E9 Step 5 — same expectation carries forward)

Boot the server, attempt to resume any pre-Phase-F session: expect a load-time type/shape error mentioning the missing `NpcDailyPlan` / `NpcLongTermIntent` table or planning types. **Not silent corruption.** This confirms the "no backwards compat" stance from spec §3 + Decision 27.

- [x] **Step 5.5: Failure-recovery decision point**

If Step 1–5 surfaces a critical problem you can't fix within ~30 minutes:

- **Fix forward**: re-run the relevant F1–F6 task fix-up + re-run F7 from Step 1. Acceptable when the issue is localized (one wiring miss, a typed error).
- **Roll back to Phase E**: per Decision 28, Phase F is a hard cutover with no feature flag — fallback path is `git revert` of the Phase F commits.
  ```bash
  git log --oneline                    # find F1-F7 commit hash(es)
  git revert <hash>                    # if single squashed commit
  # or:
  git reset --hard cabfbb3             # back to Phase E HEAD (cabfbb3 = Phase E commit per repo log)
  ```
  Then raise an issue documenting what failed; re-brainstorm if the failure surface is architectural (not just an impl bug).

Choose based on issue severity. **Don't ship a half-working Phase F.**

- [x] **Step 6: Verify file inventory**

```bash
git status
git diff --stat HEAD
```

Expected file set (final delete list depends on F6 Step 1 grep results — `skillDefaults.ts` only deleted if F6 verified zero external consumers; otherwise it stays + may be moved out of `src/planning/`):

- **New:** `src/roleSim/llmAgent.ts`, `src/roleSim/toolDispatcher.ts`, `src/roleSim/toolSchemas.ts`, `src/roleSim/seedIntents.ts`, `src/roleSim/dailySummarization.ts`, plus tests
- **Deleted:** `src/planning/NPCPlanningAgent.ts`, `npcPlanningTemplates.ts`, `npcSummaryTemplates.ts`, `autoMovementHelpers.ts`, `revisionHelpers.ts`, `itemFormatHelpers.ts`, `src/roleSim/npcAgentAdapter.ts`, plus their tests (`+ skillDefaults.ts` per F6 Step 1)
- **Modified:** `prisma/schema.prisma`, `src/state/types.ts`, `src/state/moduleLoader.ts`, `src/planning/types.ts`, `src/planning/index.ts`, `src/memory/types.ts`, `src/engine/types.ts`, `src/simulation/SimulationRunner.ts`, `client/server/simulation/service.ts`, `src/roleSim/agent.ts`, `src/roleSim/npcActionController.ts`
- Net LOC: ~2200 deleted, ~700 added (matches the brainstorm projection of ~2100 / ~400, slightly higher add due to thorough toolDispatcher implementation)

If `git status` shows files **not** in the above lists (typical culprit: biome auto-fixes from Step 3 touching unrelated files, like Phase E hit), see Step 7 for how to handle.

- [x] **Step 7: Stage + Phase F commit (single commit, narrow `git add`)**

Per user preference (`feedback_commit_all_at_once.md`): one commit for all of F1–F7.

**Important: do NOT use `git add src/` blanket** — `pnpm check` (Step 3) often auto-formats unrelated files (Phase E hit this exact issue, ~50 unrelated files got biome fixes mixed in). Two clean approaches:

**Option (i) — Stash unrelated biome fixes, commit Phase F only:**

```bash
# 1. Identify which files Phase F actually touched (compare against the list in Step 6)
git status --short

# 2. Add ONLY the Phase F files explicitly:
git add prisma/schema.prisma \
        src/state/types.ts src/state/moduleLoader.ts \
        src/planning/types.ts src/planning/index.ts \
        src/memory/types.ts \
        src/engine/types.ts \
        src/simulation/SimulationRunner.ts \
        client/server/simulation/service.ts \
        src/roleSim/                                # all of roleSim/
git add docs/superpowers/plans/2026-04-21-engine-architecture-refactor-plan.md

# 3. Stage deletions explicitly
git add -u src/planning/                            # picks up rm'd planning files
git add -u src/roleSim/npcAgentAdapter.ts           # explicit rm

# 4. Verify nothing extra is staged
git diff --cached --stat
# Should match Step 6 inventory. If extra files appear, unstage them:
# git restore --staged <unrelated-file>

# 5. Stash anything left in the working tree (the biome auto-fixes)
git stash --include-untracked --message "biome auto-fixes from F7 pnpm check"
```

**Option (ii) — Commit everything together (Phase F + biome fixes), like Phase E did:**

If you decide the biome fixes are pure formatting and you don't mind them riding along (Phase E user chose this option), use a broader `git add` and acknowledge it in the commit message body.

```bash
git add -A
```

Then in the commit message body add: `Bundled with this commit: cosmetic biome auto-fix sweep applied to N unrelated files.`

Pick one approach. Phase E used Option (ii); Phase F can do the same or be tighter.

```bash
git commit -m "$(cat <<'EOF'
refactor(engine): Phase F — RoleSimAgent + memory-only storage + dead-code purge

Replaces the 1865-LOC NPCPlanningAgent with a tool-driven LLMRoleSimAgent
following the agent-loop architecture from the 29 brainstorm decisions.
All NPC mental state collapses into NpcMemory: drops the NpcDailyPlan
and NpcLongTermIntent Prisma tables, dissolves PlanNode / ScheduleEntry
types, folds long-term intent into a long_term_intent memory type.

Key changes:
- New LLMRoleSimAgent with 5-tool dispatcher (act, continue,
  writeMemory, recallMemory, getMapSnapshot — no separate interrupt;
  `act` absorbs cancellation). Per-tool call caps; immediate
  write visibility within a loop; tick-consuming tools = terminal.
- Engine TickReport → controller batches that tick's events into
  ctx.reviseTriggers (plural), calls decide() once per affected NPC.
  Affected NPCs computed via impactPropagation.findAffectedCharacters.
  Replaces the legacy reviseSchedule + impactGate two-stage LLM call.
- Standalone seedNpcLongTermIntents and dailySummarization modules in
  src/roleSim/. Summarization slimmed to summary-only output with ISO
  YYYY-MM-DD prefix (ModuleSetup.startDate added).
- SimulationRunner integrates: simplified injectCharacter / updateIntent
  (drop reviseSchedule trigger), checkDerivedEvents handles death (cancel
  in-flight + write death memory), day-transition triggers summarization.
- Phase F ships with placeholder system prompt (Decision 29); proper
  prompt design is a separate post-Phase-F brainstorm.

Net: ~2200 LOC removed (NPCPlanningAgent + helpers + 2 Prisma tables +
related templates / tests), ~700 LOC added. No backwards compatibility
for existing SimulationRuntime rows (consistent with spec §3 stance).

See docs/superpowers/plans/2026-04-21-engine-architecture-refactor-plan.md
§F-brainstorm-2026-04-24 for the 29 architecture decisions and
Tasks F1-F7 for the implementation plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [x] **Step 8: Verify commit landed**

```bash
git log --oneline -1
```

Expected: one new commit with the Phase F message.

---

#### Open questions (still being discussed)

- Re-homing of `NPCPlanningAgent`'s remaining responsibilities (seed long-term intents on module load, onNewDay hook, getCurrentNpcActions UI query, injectCharacter pathway).
- `recentMemory` size + selection strategy in default ctx (10? 20? latest-by-time vs prioritized sample).
- Plan-storage migration approach (F4): one-shot script vs lazy migration; rollback / backup strategy.
- Feature-flag mechanism for F3 A/B comparison (env var? config flag? per-session?).
- Name → ID mapping policy for `map` memory writes (Decision 6 implementation detail — F1/F2).
- ~~Impact-level computation for engine events in Decision 15 implementation~~ — resolved by F1 Step 6 (intrinsic `impact` + `description` fields on `FeatureEvent`).
- Agent prompt design (F1).

### §F-out-of-scope

- The 3 future tools (`recallMemory`, `observe`, `reviseLongTermIntent`).
- `chooseToIgnore` field on renderer output (still deferred per §E-renderer-layer).
- Player-controlled character (would be a parallel `playerActionController.ts` with player input replacing the LLM call; out of scope).
- LLM-side caching / batching optimizations (correctness first; perf separate phase).

---

## Phase G — Renderer Layer (perception rendering for NPCs)

> **Phase G intent (2026-05-07):** The renderer was deferred from Phase E (Task E4) and Phase F (§F-out-of-scope). Phase G fills it in. Currently, `NpcActionController` already does impact propagation via `findAffectedCharacters` and uses raw `event.description` (god-eye text) as the trigger for `decideNext`. Phase G inserts a true rendering step that converts FeatureEvents + DGSM state into a per-NPC, first-person, citation-annotated narrative — and threads it into the agent's prompt context.

### §G-decisions (in progress, brainstorm 2026-05-07)

The decisions below are confirmed in discussion; remaining open questions sit in §G-open-questions.

#### Decision G1: Renderer lives in the roleSim layer, controller-driven

`NpcActionController.processTickReport` is the single integration point. The TickEngine stays ignorant of NPC AI (per Phase B / §3 Decisions). Flow:

```
TickEngine → TickReport
  ↓
controller.processTickReport:
  ├─ affectedNpcs = ⋃(per FeatureEvent e: findAffectedCharacters(synthAction, e.impact, dgsm))
  ├─ endedNpcs    = commits ∪ interruptions ∪ cancellations
  ├─ targets      = affectedNpcs ∪ endedNpcs ∪ idleAlive
  └─ for each npc in targets:
       perceived  = buildPerceivedBundle(npc, report, dgsm)
       narrative  = await renderer.render(npc, perceived, dgsm)   ← new
       agent.decideNext({ ...ctx, perception: narrative })
```

The full `perceived` bundle composition is defined in G10. Renderer is invoked **only for NPCs the controller already decided need a `decide()` pass**. No global render-everyone-every-tick. The synthetic-action shape passed into `findAffectedCharacters` matches the current `processTickReport` implementation (`{ characterId, targetCharacterIds: [], location }`).

#### Decision G2: Renderer output is annotated narrative text (paper-citation style)

The renderer returns a single string with two sections:

```
[narrative]
I'm in the kitchen [1] when Alex Brown [2] bursts in, swinging a rusty
kitchen knife [3] at Tom Reed [4]. Smoke pours from the east wall;
Alex Brown's [2] coat catches an ember.

[references]
[1] kitchen: warm, low-ceilinged, copper pots on the wall
[2] Alex Brown: gaunt man, mid-40s, frayed coat
[3] rusty kitchen knife: jagged blade, dried blood on the hilt
[4] Tom Reed: younger, terrified, hands raised
```

Rules:

- Narrative reads standalone — names appear inline, `[N]` is a citation marker not a substitute.
- Same entity reused within one render → same number (renderer dedups).
- Reference block sorted by appearance order, one entry per cited entity.
- Sub-locations (`east wall`), `SceneCondition` effects (`burning`, `smoke`), weather, and generic environmental prose appear in the narrative **without** `[N]` markers — they are scene attributes / atmosphere, not citation targets. See G5 for the full inclusion rule.
- No structured `PerceivedFact[]` external API in MVP — the controller does not introspect the rendered text. Cost / attention short-circuit lives in event propagation (G9), not in narrative parsing.

#### Decision G3: Citation numbering is per-render-call local

`[N]` numbering is a one-shot reading aid for that single LLM call. Not stable across ticks, not stable across NPCs.

- NPC A's `[1]` at tick 100 may be Alex; at tick 101 may be Tom Reed (whoever is mentioned first).
- NPC B's `[1]` in the same tick is independent of NPC A's.
- Identity tracking lives in memory (canonical names) and relationship tables (IDs); citation numbers do not participate.

#### Decision G4: Two bracket dialects, half-width `[]` both directions, disambiguated by content

| Direction | Form | Example | Parser |
|---|---|---|---|
| Renderer → LLM (prompt) | `[N]` numeric anchor after canonical name | `Alex Brown [2]` | n/a (LLM reads it) |
| LLM → engine (`actionText`) | `[Name]` canonical-name tag | `I attack [Alex Brown] with the [rusty kitchen knife]` | `/\[([^\]]+)\]/g`, then filter `^\d+$` to skip echoed numbers |

Same `[]` both directions; content type (pure digits vs. text) disambiguates. Numeric brackets in LLM output are illegal — they are stripped / warned, with fallback to the existing fuzzy name → entity matcher.

#### Decision G5: Annotation scope (what gets `[N]` / `[Name]`)

**Citation principle:** an entity is cited iff DGSM models it as a **first-class entity with an `id` and a `name`**. Such entities have intrinsic attributes — stats, conditions, descriptions, identity — that warrant a reference-block entry. Scene attributes (conditions, weather) and prose-only descriptors (sub-locations buried inside `scene.description`) are not first-class entities and stay inline as plain prose.

**In scope (cite with `[N]` in prompt narrative; tag with `[Name]` in `actionText`):**

- **People** — `DynamicNPCProfile` (NPC) and PC. By canonical full name (or description-based identifier per G8 if unknown).
- **Named items / objects** — entries in DGSM's `items` map with `id + name + description`.
- **Scenes** — `DynamicScene` (`id + name + description`).
- **Topology nodes** — `JunctionNode`, `RoadNode` (`id + name`) when narrative mentions them by name (e.g. "I head out onto Main Street [3]").

**Out of scope (write inline as plain prose, no `[N]` / `[Name]`):**

- **Sub-locations buried in `scene.description`** (`east wall`, `the desk`, `the fireplace`) — not first-class DGSM entities; they are part of the scene's prose description.
- **`SceneCondition` effects** (`burning`, `flooded`, `dim`) — these are state attached to a scene, not entities themselves. Express via prose ("flames climb the east wall", "the room is half-flooded").
- **`CharacterCondition` effects on others** — same logic; render via the carrier's prose ("Alex's hands are trembling").
- **Weather, time-of-day, ambient mood** — atmosphere, not entities.
- **Generic nouns** (`door`, `window`, `floor`, `ceiling`).
- **Numbers, times, action verbs, abstract emotions.**
- **LLM-improvised flourishes** that have no DGSM origin.

The same scope applies in both directions: prompt citation block and `actionText` `[Name]` tags use identical inclusion rules so the parser surface stays uniform. The agent's `targetCharacterIds` / scene-id channels remain authoritative for ID resolution; `[Name]` tags are an additional human-readable / parser-anchor layer.

#### Decision G6: Renderer is an LLM layer, lower-tier model, uniform pipeline

The renderer makes a real LLM call (not a code template). Two reasons:

1. **Player-facing reuse.** The same renderer feeds the future player UI. A code-templated narrative would be too robotic for player consumption and would have to be rewritten as an LLM layer later — the code path is throwaway work.
2. **Multi-event prose merging.** Several events in one tick read as a single coherent paragraph from the LLM, not a bullet-list stitch from templates.

Cost mitigation: **use a lower-tier model** (Haiku class) for the renderer call. The renderer's job is "facts → first-person prose with citations" — translation, not reasoning. Decision-making (`agent.decideNext`) keeps Sonnet; rendering does not need it.

No trivial-case short-circuit (e.g. "if the only event is the NPC's own action completing, skip LLM"). The pipeline stays uniform — every NPC in `targets` goes through one renderer call. Lower-tier model cost makes this affordable.

Pipeline:

```
controller.processTickReport
  └─ for each npc in targets:
       perceived = buildPerceivedBundle(npc, report, dgsm)              // see G10
       narrative: string = await renderer.render(npc, perceived, dgsm)  // 1 LLM call (Haiku-tier)
       ctx.perception = narrative
       await agent.decideNext(ctx)                                       // separate LLM loop (Sonnet)
```

Renderer output is the annotated narrative + reference block from G2. Citation discipline is enforced by prompt design only — there is no post-parse validator that re-checks `[N]` numbering or reference-block well-formedness in MVP. If the renderer's output is malformed (missing reference block, mismatched numbers), it is still passed verbatim to `agent.decideNext`; agents are robust to imperfect prompts. A validator may be added once we have failure data, but is out of scope for Phase G.

#### Decision G7: Renderer is sensory-only — first-principles input scope

The renderer renders only what the viewpoint NPC perceives **right now**: external sights / sounds / smells / touches plus the viewpoint NPC's own proprioception. Memory / relationship history / learned knowledge / long-term intent stay out of the renderer (they live in `agent.decideNext`'s ctx via `recentMemory` / `longTermIntent` / `recallMemory` tool).

**Renderer prompt input:**

1. **Viewpoint NPC**: `name`, `appearance` (baseline), **all** active conditions (proprioceptive — own internal state is self-knowable). Always rendered as first-person ("I"), never cited with `[N]`.
2. **Current scene** (citable per G5): `name`, `description`, plus `activeConditions[]` (scene-level state, e.g. burning / flooded — non-citable, narrative renders as prose attributes of the scene). The scene itself is cited; its attributes are not.
3. **Other citable entities mentioned in events** (people + items + adjacent scenes + topology nodes per G5): `name`, `description` / `appearance`, **all** active conditions. These become `[N]` citations. Filtering of which conditions show up is delegated to the renderer LLM via prompt instruction (`only render externally perceivable conditions for non-self entities; do not leak plot secrets or hidden allegiances`). The phrases "plot secrets" and "hidden allegiances" are prose hints to the LLM, not first-class data — no condition schema field tags them. Single-layer prompt control: no code-level `internal: boolean` / `sensoryManifestation` schema flag, no code-level `plot_secret` allowlist.
4. **Events**: `kind`, `description`, `impact`, involved entity ids.
5. **Relationship presence check** (identity gate, see G8). A boolean per cited person, nothing else.

**Excluded from renderer prompt** (this stays in `agent.decideNext`):

- `NpcMemory` of any type (event / witness / belief / secret / information / summary / long_term_intent / map)
- relationship score / history / interaction count
- Any reasoning / planning / knowledge state

#### Decision G8: Identity gate — name vs description by relationship-graph presence

For each person cited in events, the renderer queries `viewpoint.relationships.has(otherCharId)` (boolean presence — not score, not history).

- **Known**: render canonical name in narrative and references — `[2] Alex Brown: gaunt man, mid-40s, frayed coat`.
- **Unknown**: render description-based identifier — `[2] the gaunt man: mid-40s, frayed coat, breathing hard`. Disambiguate multiple unknowns by leaning on `appearance` differences (`the gaunt man in frayed coat` vs `the heavy-set woman in red shawl`).

Repeat sightings of the same unknown person **do not auto-promote** to known — identity knowledge only changes when the relationship graph itself changes (formal introduction, name leaked in dialogue, etc.). NPCs that want to track "I've seen this person before" do so via their own `writeMemory` calls; the renderer is stateless on this axis.

The viewpoint NPC's own ID is always rendered as canonical `I` / first-person; the identity gate applies only to **other people**, not to items, scenes, or sub-locations. Items and locations have no relationship-graph concept — they always render with their canonical name + DGSM description. (An NPC walking into an unfamiliar room still sees `the parlor` if that's the canonical name; "unfamiliarity" is something the agent can write into its own memory after the fact, not something the renderer obscures.)

This is the only place where the renderer reads relationship data — and only the boolean presence, never the score or history. It is the minimum-information identity resolution and does not violate G7's exclusion of memory/relationship content.

#### Decision G9: No `attentionThreshold`, no `chooseToIgnore` — propagation + `continue` already cover it

The two `§G-open-questions` originally tracked here (per-action `attentionThreshold` short-circuit, new `chooseToIgnore` tool) are dropped — the existing pipeline already covers their semantics:

- **Cost short-circuit lives in event propagation, not in the controller.** `findAffectedCharacters(action, event.impact, dgsm)` already filters by scene topology + event impact; an event that doesn't propagate to a given NPC's scene never enters their `targets` set, so renderer + `decideNext` are never invoked. There is no need for an additional per-`ActionDefinition.attentionThreshold` field — the propagation layer is the threshold layer.
- **"Acknowledge but don't act" is `continue`.** The Phase F `continue` terminal tool returns from the controller without canceling or submitting any action; the in-flight action keeps running. This is exactly `chooseToIgnore` semantics. No new tool.

Phase G's behavioral change is therefore narrow: replace the raw `event.description` (god-eye text) currently fed into `reviseTriggers[].description` with the rendered first-person citation-annotated narrative. Everything else (propagation, targets union, `continue` handling) is unchanged.

#### Decision G10: Renderer always emits scene baseline + action state + events overlay

The `perceived` bundle is **always** populated with three parts, even when the NPC entered `targets` solely because they were idle (no events, no ended action). Renderer always runs; output always includes a scene baseline.

```ts
interface PerceivedBundle {
  // Always present — the scene the NPC currently inhabits.
  scene: {
    id: string;
    name: string;
    description: string;
    activeConditions: SceneCondition[];     // perceivable scene-level conditions
  };

  // The NPC's own action posture this tick.
  ownAction:
    | { kind: "ongoing"; actionText: string }
    | { kind: "ended"; actionText: string; status: "committed" | "interrupted" | "cancelled" }
    | { kind: "idle" };

  // Subset of TickReport.featureEvents that propagated to this NPC. May be empty.
  events: FeatureEvent[];
}
```

Composition rules:

- **Scene baseline always**. The renderer always describes "where I am" — ground truth from DGSM. Even idle NPCs get a paragraph about their surroundings.
- **`ownAction.kind = "ongoing"`** when the NPC has an active step in the engine queue and that step did **not** end this tick. Renderer mentions "I'm reading the journal when…" as the lead-in.
- **`ownAction.kind = "ended"`** when the NPC's action commit / interrupt / cancel landed in this tick's `TickReport`. Status carries the engine's resolution. Renderer mentions "I just finished reading the journal" or "My grip slips on the rope — I lose hold" depending on status.
- **`ownAction.kind = "idle"`** when neither ongoing nor ended applies (most common at session bootstrap). Renderer renders only scene baseline + any events.
- **`events`** is always the propagated subset, possibly empty. When non-empty, renderer weaves them into a single coherent paragraph alongside scene baseline and own-action — no bullet list, no two-section split between own-action and external events. Single unified narrative per G2.

The `agent.decideNext` ctx still receives separate `currentAction` / `currentScene` fields as it does today (Phase F); the renderer-rendered `narrative` is an additional, prose-form perception. Agents do not lose access to structured action / scene data.

#### Decision G11: Renderer LLM failure → retry once, then fall back to god-eye concat

The renderer LLM call is wrapped in a single retry. If both attempts fail (timeout, rate-limit, malformed output, network), the controller falls back to a deterministic code-built god-eye narrative built from the same `PerceivedBundle`: a one-line scene baseline (`"You are in <scene.name>: <scene.description>"`), one line for `ownAction` if non-idle, and `event.description` concatenated for each event. No citation block. This fallback is uglier prose but contains the same information; agents tolerate it.

```ts
async function renderWithFallback(npc, perceived, dgsm): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await renderer.renderViaLLM(npc, perceived, dgsm);
    } catch (err) {
      console.warn(`[renderer] attempt ${attempt + 1} failed:`, err);
    }
  }
  return buildGodEyeFallback(npc, perceived, dgsm);  // deterministic, no LLM
}
```

Tick pipeline never blocks on a renderer failure: simulation continues, the affected NPC just receives a less-polished prompt. Failures are logged at `warn` level for observability; if they become frequent we revisit retry budget / model fallback.

### §G-open-questions

- **`[narrative]` / `[references]` literal section markers vs. structured separator** — MVP literal text headings. Format may evolve once we see prompt behavior.
- **Renderer model tier configuration** — which exact model satisfies G6's "lower-tier" (e.g. `claude-haiku-4-5`)? Pinned at implementation time.

### §G-out-of-scope (not in Phase G)

- Player-character renderer (would be a separate `playerPerceptionRenderer` writing to UI, not LLM)
- Cross-tick narrative continuity / "you remember…" splicing — that's memory's job
- Sound / smell / off-screen rumor channels — only direct line-of-sight + same-scene + connected-scene impact for MVP

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
