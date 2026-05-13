# Engine Unified Subsystem Design

**Date:** 2026-05-12
**Status:** Spec — pending review
**Branch target:** Phase I (after `engine-phase-h-citation-contract` merges)
**Brainstorm session:** 2026-05-12 (this doc)

## Context

After Phase A–H the engine has **two** parallel "deterministic, per-tick" subsystem mechanisms:

| Mechanism | File | Trigger | Lifetime | Hook signatures |
|---|---|---|---|---|
| `WorldFeature` | `src/engine/core/worldFeature.ts` | Engine-owned, always | Engine lifetime | `init / onTick / onActionCommit / onPropagate` |
| `CodeEngineSubsystem` | `src/engine/codeEngine/types.ts` | `ActionStep` with `engine: "code"` | Step lifetime | `onActivate / onTick / onInterrupt` |

Both run per-tick, both emit `StateChange[]`, both have spawn / tick / teardown semantics. They differ only in **what binds the instance**: an environment anchor (scene / character / global) vs. an active ActionStep. Beyond that, the abstractions are duplicates.

Phase G's snapshot doc (`reports/2026-05-07-architecture-snapshot-vs-spec.md` §6) flagged "WorldFeature / CodeEngine duality" as an open consolidation question. Phase I closes it.

## Goal

Replace `WorldFeature` and `CodeEngineSubsystem` with a unified **Subsystem** abstraction. Collapse `TickOrchestrator` Phase 0 / 3.5 / 5 / 6 / 8 / 9.5 into a single per-tick `onTick` pass over all active instances.

## Non-goals

- `ScriptedEventRunner` migration. It has its own DSL semantics (Predicate, Tracker, status state machine, fireDelay / duration) that deserve their own discussion. Stays in Phase 7 untouched. Tagged for Phase J.
- Any change to: action queue, DEX ordering at commit, resolver pipeline, role-sim layer, renderer, persistence schema *beyond* what state migration forces.
- Adding new features. Phase I is migration only; feature behavior is preserved.

## Decisions

Each `D#` corresponds to one brainstorm question. Decision body leads with the rule; *Rationale* explains why; *Implication* lists the concrete code shape.

---

### D1: Subsystem registry is the single source of truth (Q1 = C)

A subsystem is **registered**; once registered, lifecycle is owned by the engine — no "world actor" submitting permanent steps, no `engine.registerWorldStep` side door. The registry alone determines what subsystems exist; `TickOrchestrator` reads the registry at bootstrap and again per tick to manage instances.

**Rationale.** The two rejected alternatives are uglier: borrowing `submitAction` to create "permanent steps" twists the ActionStep abstraction (DEX, interrupt, status all become awkward special-cases); a separate `registerWorldStep` keeps two registration code paths. A single registry with subsystem-declared lifecycle is the cleanest abstraction.

**Implication.** New file: `src/engine/subsystem/registry.ts`. `TickEngine` constructor takes a `SubsystemRegistry` (or builds the default one) — the existing `features: WorldFeature[]` and `codeEngineRegistry: CodeEngineRegistry` options collapse into one.

---

### D2: Instances are dynamic, multi-cardinality, anchor-bound (Q2 = B)

Each subsystem declares an **anchor kind**. The engine maintains a dynamic set of active instances per subsystem, keyed by `(subsystemId, anchorId)`. Fire-in-scene-X and fire-in-scene-Y are two distinct instances of the `fire` subsystem.

**Rationale.** The "singleton + internal iteration" alternative (current `fireFeature` pattern) is a singleton subsystem with an internal map keyed by sceneId — *de facto* multi-cardinality, just hidden inside the subsystem body. Making the engine aware of per-instance identity unlocks: (a) clean lifecycle (instance dies when scene's fire goes out, state goes with it); (b) symmetry with ActionStep-bound instances; (c) future per-instance debugging / telemetry.

**Implication.** Anchor kinds: `"scene" | "region" | "character" | "global"` — same enum as `FeatureStateScope` in `src/engine/core/types.ts:7`. The single `"global"` anchor produces exactly one instance per subsystem (used for e.g. sun). `"region"` is per-region (current weather scope). Per-character / per-scene cardinality is whatever DGSM currently has.

---

### D3: Lifecycle is predicate-driven, automatic spawn/destroy (Q3 = A)

Each `AnchorSubsystem` implements `shouldExist(anchorId, ctx): boolean`. Each tick, `TickOrchestrator` evaluates the predicate across the anchor set, diffs against the current instance set, and:

- `false → true`: spawn the instance, call `initialState(anchorId, ctx)`, apply its `StateChange[]` (seeds the DGSM bucket).
- `true → false`: destroy the instance, emit a synthetic `feature.removeState { featureId, anchorId }` StateChange that clears the entire scoped bucket.

**Rationale.** Explicit `subsystem.spawn` / `subsystem.destroy` StateChanges would distribute trigger logic across every external caller (every action that lights a fire, every action that puts a fire out, every place where conditions can change). A predicate centralizes the "when does fire exist" rule in `fireSubsystem.shouldExist` — the subsystem owns its own existence condition.

**Implication.** Predicate runs every tick on every anchor of its kind. Anchor sets are small (`<200` typical for scenes / characters); predicate is a pure function over already-applied DGSM state. Cost is negligible. No caching needed in MVP.

---

### D4: All state in DGSM; TickOrchestrator owns its lifecycle (Q4 = C')

Instance state lives in `dgsm.scopedFeatureState[subsystemId][anchorId]`. There is **no** instance-side in-memory state — not even for "internal" bookkeeping like propagation countdowns. The subsystem doesn't manually create or clean up state; `TickOrchestrator` does:

- Spawn → `initialState(anchorId, ctx)` returns `StateChange[]` that include the initial `feature.setState`.
- Destroy → engine-issued `feature.removeState { featureId, anchorId }` clears the bucket.

**Rationale.** The role-sim renderer reads world state via `FeatureReadContext`, which routes to DGSM. Any state hidden in instance objects would be invisible to the LLM pipeline, breaking perception. Forcing all state through DGSM also eliminates the "double-write consistency" problem of A hybrid model and the "state leak after destroy" problem of the current WorldFeature pattern. "Internal" fields (countdowns, accumulators) live in DGSM too — narrative can use them, and even if it can't, the storage cost is irrelevant.

**Implication.** `FeatureReadContext` API for subsystems is unchanged (`getFeatureState` / `getAllFeatureStates`). The engine's `feature.removeState` StateChange must support "clear entire bucket for this featureId+anchorId" semantics — current shape (`{ kind: "feature.removeState", featureId, key }`) already does this.

---

### D5: Two Subsystem flavors with shared base interface (Q5 = A)

```ts
// src/engine/subsystem/types.ts
export interface SubsystemBase {
  readonly id: string;
  readonly priority?: number;          // default 999; lower runs first
  readonly description: string;
  readonly effectSummary: string;
  readonly affectedKinds: ReadonlyArray<StateChange["kind"]>;
}

export interface AnchorSubsystem extends SubsystemBase {
  readonly kind: "anchor";
  readonly anchorKind: "scene" | "region" | "character" | "global";

  /** Per-tick existence predicate. Must be a pure function over DGSM. */
  shouldExist(anchorId: string, ctx: FeatureReadContext): boolean;

  /** Called once when shouldExist transitions false→true. */
  initialState(anchorId: string, ctx: FeatureReadContext): StateChange[];

  /** Called every tick while alive. */
  onTick(anchorId: string, ctx: FeatureReadContext): StateChange[];
}

export interface ActionSubsystem extends SubsystemBase {
  readonly kind: "action";

  onActivate?(step: ActionStep, ctx: FeatureReadContext): SubsystemStepResult;
  onTick(step: ActionStep, ctx: FeatureReadContext): SubsystemStepResult;
  onInterrupt?(step: ActionStep, ctx: FeatureReadContext): { stateChanges: StateChange[] };
}

export interface SubsystemStepResult {
  stateChanges: StateChange[];
  completed: boolean;
  failed?: { reason: string };
}

export type Subsystem = AnchorSubsystem | ActionSubsystem;
```

**Rationale.** A single polymorphic `Subsystem` interface with `handle: AnchorHandle | ActionHandle` was rejected: every concrete implementation would branch on `handle.kind`, contributing nothing but noise. The two flavors have genuinely different lifecycle models (predicate vs. step-completion) and benefit from distinct types. The shared `SubsystemBase` carries metadata that both need (id, priority, description, affectedKinds).

**Implication.** TypeScript discriminated union via `kind`. Registry stores both in one collection; `TickOrchestrator` dispatches by `kind`. No common `onTick` signature — anchor's is `(anchorId, ctx)`, action's is `(step, ctx)` — but execution loop is one block.

---

### D6: No event hooks; actions emit domain StateChanges, subsystems bridge via predicate + initialState (Q6 = B)

`WorldFeature.onActionCommit` is **removed**. There is no per-action event hook on any Subsystem. Actions affect subsystem state through **domain-appropriate StateChanges** — scene conditions, character conditions, raw field deltas — that the subsystem's `shouldExist` predicate (D3) and `initialState` (D4) translate into subsystem-internal state.

**The pattern**

```
LLM action intent
  → resolver produces domain StateChanges in planned outcome
     (e.g. scene.addCondition: burning, scene.removeCondition: burning,
            character.fatigue: +5, character.addCondition: bleeding)
  → Phase 4 commit aggregates StateChanges into buffer
  → Phase 8 flush writes them into DGSM
  → Next tick Phase 5: subsystem.shouldExist re-evaluates against new DGSM:
       - scene gained "burning" → fireSubsystem.shouldExist returns true → spawn
       - fire.initialState seeds full state {intensity, smokeLevel, propagationCountdown, …}
       - scene lost "burning" → fireSubsystem.shouldExist returns false → destroy
```

The LLM emits *what changed in the world* (a scene caught fire, a character grew tired), not *the internal bookkeeping of a subsystem* (intensity values, propagation counters). The subsystem owns its own schema; the world emits triggers; the predicate bridges.

**Invariant.** `shouldExist` MUST NOT read the subsystem's own state bucket. It reads external DGSM state (scene conditions, character conditions, position, etc.). The subsystem's own bucket is seeded by `initialState` and mutated by `onTick` — using it as a predicate input would create cyclic spawn-destroy oscillations and break D9's rehydration logic.

**Current vs. new pattern, concretely**

Phase H (current):
```
LLM extinguishFire action
  → resolver plants step.overlayFields.fireExtinguish: true
  → fireFeature.onActionCommit reads overlay, emits feature.setState { fire, intensity -= 2 }
```

Phase I (new):
```
LLM extinguishFire action
  → resolver emits StateChange directly: scene.removeCondition { fromFeature: "fire" }
    (or: character.fatigue: +5 if dousing costs stamina, etc.)
  → applier flushes to DGSM
  → next tick: fireSubsystem.shouldExist sees no burning condition → instance destroyed
  → engine emits feature.removeState clearing the fire bucket
```

The "intensity goes down by 2" semantics disappear from the action; either `shouldExist` returns false when scene loses `burning`, or `fireSubsystem.onTick` chooses a damping function based on its own state + external dampening conditions (rain, wet scene condition, etc.).

**Rationale.** Three benefits over keeping `onActionCommit`:

1. *Per-tick 彻底统一*: only one execution channel (Phase 5/6), no event hooks.
2. *Decoupling*: LLM doesn't memorize subsystem schemas; the world model stays in terms of conditions and entity fields.
3. *Reversibility for free*: every spawn has a destroy because predicate is bidirectional — no "remember to remove" bug class.

**Cost.** Actions can no longer perform fine-grained subsystem mutations (e.g. "set intensity to exactly 3.7"). For most cases this is fine — the natural game vocabulary is "lit / put out / boost / spread", which maps cleanly to conditions. If a future action truly needs precise control over a subsystem's internal value, two escape hatches remain:

- *(escape hatch a)* Action emits a domain field that the subsystem's `onTick` reads — e.g. a `SceneCondition: doused { strength: 0.5 }` that fire's onTick interprets as a damping coefficient.
- *(escape hatch b)* `ActionDefinition.commitHandler(step, outcome, ctx) → StateChange[]` — a code-side adapter that produces a `feature.setState` directly. This is a last-resort coupling; flagged with a comment so reviewers can question it. Not the default.

The default for migration is: *map every Phase H `onActionCommit` branch to a domain-StateChange emission from the action*. Resort to (b) only when (a) doesn't fit.

---

### D7: Scope = features + CodeEngine + condition-expiry + delete empty emitter (Q7 = B + delete EmergentEventEmitter)

In scope for Phase I migration:

| Source | Target |
|---|---|
| `weatherFeature` | `weatherSubsystem` (AnchorSubsystem, `anchorKind: "region"`, `shouldExist: always true`) |
| `sunFeature` | `sunSubsystem` (anchor=global) |
| `staminaFeature` | `staminaSubsystem` (anchor=character) |
| `itemDamageFeature` | `itemDamageSubsystem` (anchor=scene) |
| `fireFeature` | `fireSubsystem` (anchor=scene, `shouldExist`: scene has fire intensity > 0 / `burning` condition) |
| `MovementSubsystem` | `movementSubsystem` (ActionSubsystem; signature change only) |
| Phase 9.5 `condition-expiry sweep` (char) | `characterConditionExpirySubsystem` (anchor=character) |
| Phase 9.5 `condition-expiry sweep` (scene) | `sceneConditionExpirySubsystem` (anchor=scene) |
| `EmergentEventEmitter` (Phase 8, empty scanner array) | **deleted** |
| `ScriptedEventRunner` (Phase 7) | **unchanged** (Phase J) |

**Rationale.** ScriptedEventRunner has its own DSL — Predicate operators, Tracker state machines, fireDelay/duration timing, four-status state. Migrating it well is its own brainstorm; doing it in Phase I would balloon scope. The empty `EmergentEventEmitter` has zero migration cost (literally delete the file + its single call site); no reason to keep an empty slot when re-adding any future scanner is just "write an AnchorSubsystem with anchorKind=global".

---

### D7.5: Timing — predicate sees end-of-last-tick DGSM, 1-tick spawn lag

`applier.flush` runs once at Phase 8 (end of tick); all in-tick StateChanges are buffered until then. Consequence:

- Phase 5 `shouldExist` always reads the **post-flush state from the previous tick** — i.e., end-of-last-tick DGSM. This-tick commits (Phase 4) and this-tick onTick outputs (Phase 6) are still in the buffer and **not visible** to Phase 5.
- Therefore: an action that adds a condition in tick N spawns the subsystem instance in tick N+1, not tick N. **One-tick lag from commit to instance-alive.**

This is intentional and matches current `WorldFeature` semantics (which also see post-flush DGSM in their `onTick`). For a minute-resolution simulation, 1 tick = 1 in-game minute; this lag is invisible to narrative.

Same lag applies to propagation: fire's `onTick` in tick N emits `scene.addCondition: burning` on the adjacent scene → flushed at Phase 8 → tick N+1's Phase 5 sees the condition → adjacent fire instance spawns. Propagation cadence (current `propagation.tickInterval = 10`) is encoded as `propagationCountdown` inside fire's per-scene state, decremented in `onTick`; when it hits 0, fire emits the propagation condition and resets the countdown.

### D8: TickOrchestrator phase structure after Phase I

```
Phase 1   clock.advance
Phase 2   applyPendingInterrupts
Phase 3   action step activate
            ├─ resolver pipeline (LLM, unchanged)
            └─ ActionSubsystem.onActivate (for engine:"code" steps)
Phase 4   commitDue
Phase 5   anchor lifecycle pass
            for each AnchorSubsystem s, priority-ordered:
              for each anchorId in dgsm.anchorIdsOf(s.anchorKind):
                shouldBe = s.shouldExist(anchorId, ctx)
                isActive = activeSet.has(s.id, anchorId)
                if shouldBe && !isActive:
                  activeSet.add(s.id, anchorId)
                  buffer.push(...s.initialState(anchorId, ctx))
                if !shouldBe && isActive:
                  activeSet.remove(s.id, anchorId)
                  buffer.push({ kind: "feature.removeState", featureId: s.id, key: anchorId })
Phase 6   instance onTick pass
            for each active anchor instance (priority order):
              buffer.push(...subsystem.onTick(anchorId, ctx))
            for each active action instance:
              result = subsystem.onTick(step, ctx)
              buffer.push(...result.stateChanges)
              if result.completed: mark step for commit/cleanup
Phase 7   scriptedEventRunner.run  ← unchanged, left for Phase J
Phase 8   applier.flush(buffer, gameDateTime)
Phase 9   streaming events + tickCompleted(TickReport)
```

Phase numbers compressed from the current 10+ to 9. Eliminated:

- Phase 0 `WorldFeature.init` — bootstrap is "tick 1 of session" where `activeSet` is empty, so the Phase 5 anchor lifecycle pass naturally spawns every anchor instance whose `shouldExist` returns true on the seeded DGSM. The "fresh vs. rehydrated" branch lives entirely in DGSM (rehydrated DGSM already has the scoped state buckets, so re-running `initialState` would clobber — see D10).
- Phase 6 `runPropagation` — propagation becomes a direct `onTick` emission. Fire spreading to an adjacent scene means `fireSubsystem.onTick` returns `scene.addCondition { burning, target: adjacentSceneId }`; next tick the adjacent scene's predicate sees the condition and spawns its own fire instance. Propagation cadence (every N ticks) becomes an internal countdown stored in DGSM `scopedFeatureState[fire][sceneId].propagationCountdown`.
- Phase 8 `EmergentEventEmitter` — deleted.
- Phase 9.5 `condition-expiry sweep` — folded into the two expiry subsystems' `onTick`.

---

### D9: Bootstrap = "tick 1 with empty active set" (no separate init phase)

On fresh-session engine creation, `activeSet` starts empty. The first `tick()` runs Phase 5 (anchor lifecycle); every AnchorSubsystem whose `shouldExist(anchorId, …)` returns true on the freshly-seeded DGSM gets spawned. For always-on subsystems (weather, sun, stamina-per-character), this is N instances spawned in one pass.

On rehydrated sessions, `activeSet` is **reconstructed from DGSM**, not from persisted state: at engine creation, `TickOrchestrator` scans `dgsm.scopedFeatureState` and adds `(subsystemId, anchorId)` to `activeSet` for every present bucket. **No separate persisted instance-set.** DGSM is the source of truth for "what's alive."

**Rationale.** Storing `activeSet` separately from DGSM would create a 2nd persisted truth that could drift. Reconstructing from DGSM scoped state means there's exactly one fact: "instance exists iff DGSM has its bucket." Predicate evaluation on first tick of a rehydrated session re-verifies — if some hand edit removed a bucket while the predicate still says true, the instance gets re-spawned with `initialState` (harmless idempotency).

**Implication.** `initialState` must be safely callable on already-present state without breaking — i.e., if the bucket exists, `initialState` should be a no-op (or the engine's Phase 5 path should skip `initialState` when the bucket already exists in DGSM). Easiest: Phase 5 explicitly checks `dgsm.getScopedFeatureState(subsystemId, anchorId)` before calling `initialState`; if a bucket exists, the instance is "already born", just add to activeSet without seeding.

---

### D10: `priority` ordering, tie-break by registration order

`onTick` execution order within Phase 6 is determined by `priority` (ascending; lower = earlier). When two subsystems share a priority, registration order breaks the tie (deterministic given the same registry build).

For instances of the **same** subsystem (e.g., 5 fire instances in 5 burning scenes), order among them is **anchor-id sort order** (string compare). This matters only when two instances of the same subsystem could write to overlapping state — rare in practice — and the deterministic order avoids flaky tests.

Anchor instances and action instances are ordered together by `priority`; no anchor-first / action-first rule. If a feature needs to run before action ticks, give it a lower priority.

---

### D11: TickReport / EventBus / persistence shape — minimal change

`TickReport` keeps its current shape (`commits`, `interruptions`, `cancellations`, `featureEvents`, `stateChanges`, `damageReports`, etc.). The phase 5 anchor lifecycle StateChanges (initialState seeding + removeState destruction) flow through the buffer like any other StateChange — Applier handles them; TickReport reports them under `stateChanges`.

`engine.serialize()` and `persistedState`: no schema change. `activeSet` is not serialized (D9). The existing `{ queue, dexByActor, connectionVotes }` schema is unchanged. DGSM persistence (which already includes scoped feature state) carries everything.

The `PropagationTickCounter` map on `FeatureRunner` is **deleted**. Its semantics move into DGSM-stored `propagationCountdown` fields on per-instance state (D8 paragraph).

---

## Architecture overview

```
┌────────────────────────────────────────────────────────────────────┐
│ SubsystemRegistry                                                   │
│   register(s: Subsystem) / get(id) / getAll()                       │
│                                                                     │
│   Default = [                                                       │
│     weatherSubsystem, sunSubsystem, staminaSubsystem,               │
│     itemDamageSubsystem, fireSubsystem,                             │
│     characterConditionExpirySubsystem, sceneConditionExpirySubsystem,│
│     movementSubsystem,                                              │
│   ]                                                                 │
└────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────────────────────────────────┐
│ TickOrchestrator (one orchestrator, one tick loop)                  │
│                                                                     │
│   activeSet: Set<{ subsystemId, anchorId }>                         │
│     - anchor instances: managed by Phase 5 predicate                │
│     - action instances: managed by Phase 3 onActivate +             │
│       Phase 6 onTick.completed                                      │
│                                                                     │
│   Per tick:                                                         │
│     1  clock                                                        │
│     2  interrupts                                                   │
│     3  action activate                                              │
│     4  commit due                                                   │
│     5  anchor lifecycle (spawn/destroy diff via shouldExist)        │
│     6  instance onTick (all kinds, priority order)                  │
│     7  scriptedEventRunner (unchanged)                              │
│     8  applier.flush                                                │
│     9  emit tickCompleted(TickReport)                               │
└────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────────────────────────────────┐
│ DGSM                                                                │
│   single source of truth for instance state                         │
│   scopedFeatureState[subsystemId][anchorId] = { ... }               │
│                                                                     │
│   "instance exists" ⇔ "bucket exists in scopedFeatureState"         │
└────────────────────────────────────────────────────────────────────┘
```

---

## Migration plan (sketch — will be tasks in the Phase I plan)

1. **Add new Subsystem types + registry** in `src/engine/subsystem/`. Don't touch existing features. (Both `WorldFeature` and `CodeEngineSubsystem` continue to work.)
2. **Wire new Phase 5/6 into TickOrchestrator** in parallel with old phases. New phases run on an empty registry; old phases still drive everything. This is the dual-execution checkpoint.
3. **Migrate one feature at a time**, in order of complexity:
   - `weather` (anchor=global, init only, simplest)
   - `sun` (anchor=global)
   - `stamina` (anchor=character)
   - `itemDamage` (anchor=scene)
   - `fire` (anchor=scene, with propagation + action-coupled commit logic) — most complex; pulls in D6 action redesign
4. **Migrate `MovementSubsystem`** to new `ActionSubsystem` interface (signature change only — `onActivate(step, ctx) / onTick(step, ctx)`).
5. **Migrate condition-expiry sweep** into the two expiry subsystems.
6. **Delete `EmergentEventEmitter`** + its scan call in TickOrchestrator.
7. **Delete legacy code**: `WorldFeature`, `FeatureRunner`, `CodeEngineSubsystem`, `CodeEngineRegistry`, Phase 0 / 5 / 6 / 8 / 9.5 wiring, `propagationTickCounter`.
8. **Final type-check + batch test pass.**

Each migration step ships a working engine (old + new run in parallel until step 7).

---

## Open questions (to resolve in plan)

- **`feature.removeState` semantics on full bucket clear.** Confirm the current Applier behavior when `key: anchorId` is passed but no specific sub-key — does it delete the whole bucket or no-op? Read code in plan-writing pass; adjust if it doesn't already support bucket-clear.
- **ActionDefinition schema for D6.** Each fire-coupled action (extinguishFire, ignite, addFuel, etc.) needs a one-line decision in its plan task: (a) LLM produces StateChange directly, or (b) commitHandler wraps a small payload. Decided per-action during migration step 3.
- **Anchor instance ordering when same priority.** Confirmed in D10 as anchor-id string sort, but `dgsm.anchorIdsOf("character")` may not currently return sorted output — plan task ensures it does.

## Out of scope

- ScriptedEventRunner migration (Phase J)
- New subsystems / behaviors (Phase I is migration only)
- Player-facing UI changes
- Memory / role-sim / renderer layer changes
- Persistence schema changes beyond what subsystem state migration forces
