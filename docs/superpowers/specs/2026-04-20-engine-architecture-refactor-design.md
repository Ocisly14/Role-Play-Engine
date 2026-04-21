# TickEngine Architecture Refactor — Design

**Status:** Design complete (§9 open questions resolved 2026-04-20). Ready for implementation plan.
**Date:** 2026-04-20
**Goal:** Separate the 805-line `tickProcessor.ts` god function into focused components, introduce a queue-based execution model, and make the feature system properly modular.

---

## 1. Motivation

Current `tickProcessor.executeSingleTick()` is a single 600+ line function mixing:

- Clock / time progression
- NPC schedule fetching (in-progress + due nodes, carry-over, sort)
- Per-node execution (interpreter + skill check + resolver + apply + shift)
- Feature lifecycle (`onNodeStart` / `activate` / `tick` / `propagate`)
- Emergent event scanning + impact gate LLM calls (encounter detection, impactPipeline, world events)

Problems:

- Can't test layers in isolation
- Features directly mutate DGSM via `dgsm.setFeatureSceneState(...)` — tight coupling
- SceneCondition lacks an `owner` field, so features can't reliably "replace just my own" — current code does prefix matching on `description` text
- `setFeatureSceneState(key, ...)` is named for scenes but features pass arbitrary keys: weather passes `regionId`, stamina/sanity pass `characterId`, eventTrigger passes its own ID. Type / API doesn't acknowledge the multi-scope reality
- WorldFeature is mostly behavior hooks with little declarative metadata — engine / planning LLM / UI can't introspect "what state does this feature touch, how big is its impact" without reading code
- `eventTriggerFeature` is forced through the WorldFeature interface, but it's a fundamentally different kind of thing: module-authored scripted story beats (daily/cumulative/prerequisite conditions), not a procedural physics-style simulation. This is what drives the `stateScope: "custom"` hack. This refactor extracts it into a dedicated `ScriptedEventRunner` subsystem (see §3 "Scripted Events")
- Feature tick order = registration order (no explicit dependency)
- Planning layer's time-window model (PlanNode.startTime/endTime) fights with runtime's 1-tick-executes-everything behavior and needs schedule-shift fixup after the fact
- Multi-step interpreter output is unused by runtime (takes only first non-movement step)

---

## 2. Architecture

### Three-Layer Separation

```
┌──────────────────────────────────────────────────────────────┐
│ ① Role Simulation Layer (per-NPC)                              │
│   NPC AI decides "next action"; manages intents, multi-step   │
│   chains, re-planning, daily schedule.                         │
│                                                                │
│   submitAction(input)   ─┐    ┌─ onActionCompleted             │
│   cancelAction(handle)   │    ├─ onActionInterrupted           │
│   interruptAction(h, r) ─┤    ├─ onFeatureEvent                │
│                          ▼    └─ onTickCompleted (batch)       │
├──────────────────────────────────────────────────────────────┤
│ ② TickEngine (pure execution)                                  │
│   ActionIntake → GameInterpreter → Queue (DEX-sorted) →        │
│     activation (lazy Resolver) → commit → Applier → DGSM       │
│   Two sibling subsystems each tick (both produce StateChange): │
│     • FeatureRunner   (physics: fire/weather/lighting/         │
│                        stamina/sanity — TS code)                │
│     • ScriptedEventRunner (story beats: daily/cumulative/      │
│                            prerequisite — declarative data)    │
│   Output: CharacterAction / StateChange / FeatureEvent         │
├──────────────────────────────────────────────────────────────┤
│ ③ DGSM (world state; single mutator = Applier)                 │
└──────────────────────────────────────────────────────────────┘
```

### Control Flow

1. Role sim decides an NPC's next action → `tickEngine.submitAction(input)`
2. TickEngine calls **GameInterpreter** on the action text → produces `steps[]` (multi-step allowed)
3. TickEngine inserts one `ActionStep` per step into the Queue, chained by `stepGroupId`, sorted by actor's DEX
4. Each tick (StateChanges accumulate into the tick's buffer through every phase; only the final Apply phase writes DGSM):
   - **Interrupt apply phase:** drain pending `interruptAction` / `cancelAction` requests submitted by role sim since previous tick (active step → C compromise; queued steps → discard)
   - **Activate phase:** for each idle actor, take the next eligible step (next step in active chain OR chain head if no active), call **Resolver** to compute duration + outcome → mark `active` with `completionTime = now + plannedDuration`
   - **Commit phase:** for steps with `completionTime <= now`, in DEX order, apply pre-computed outcome → `FeatureRunner.onActionCommit` → StateChanges accumulated into the buffer (no DGSM write yet)
   - **Feature phase:** `FeatureRunner.onTick` (by priority) + propagation (on schedule) → StateChanges accumulated
   - **Scripted event phase:** `ScriptedEventRunner.run` — module-defined event triggers evaluate their conditions against committed actions + accumulated state, fire `onComplete` / `onFail` effects → StateChanges accumulated
   - **Scan phase:** `EmergentEventEmitter` (encounter detection + world-event detection — **no LLM, no impact gate**)
   - **Apply phase:** `Applier.flush()` — group + sum + clamp all accumulated StateChanges, single batch write to DGSM, append `DamageReport`s into `TickReport`
   - **Emit phase:** streaming events as they happen (already partly emitted earlier) + a single `tickCompleted(TickReport)` at end-of-tick

### Key Invariants

- **Actor slot mutex:** each actor has at most one `active` step at a time
- **Single interpreter call per submission:** interpreter runs at submit; resolver runs lazily at activation
- **Per-step resolver:** each step in a chain gets its own resolver call when it activates (step 2's context sees step 1's result)
- **Feature no-mutate:** features never touch DGSM; they return `StateChange[]`
- **Single mutator:** all DGSM writes go through `Applier`
- **TickEngine ignorant of NPC AI:** the impact gate (LLM-driven "should NPC X interrupt their current action?") lives in role sim. TickEngine only reports events and accepts `interruptAction(handle, reason)` callbacks
- **Chain immutability:** once submitted, a chain can only be cancelled (whole) or interrupted (active step + cancel rest). No mid-chain insert/swap/skip
- **Per-tick delta merge:** within one tick, all `character.hp/san/fatigue` deltas for the same character are summed by Applier; clamping to `[0, max]` happens once after summing; a `DamageReport` is added to the tick's `TickReport.damageReports` retaining per-source contributions

---

## 3. Decisions Made (with rationale)

### Resolver Timing → Lazy per-step
- Chose B (lazy per-step) over eager-all-at-once or per-tick
- Multi-step is sequential; step 2's state depends on step 1's outcome
- Resolver seeing fresh state is worth the extra LLM call per step
- Interpreter still runs once upfront (cheap classification)

### Interruption Policy → C 妥协版
- `elapsedRatio = (currentTickTime - activatedAt) / plannedDuration`, computed at the start of the next tick's interrupt-apply phase
- `elapsedRatio < 50%` → discard the planned outcome; no StateChanges applied; remaining chain steps cancelled
- `elapsedRatio >= 50%` → re-call resolver with interrupt context → feed the resulting `partialOutcome` through `FeatureRunner.runActionCommit(step, partialOutcome, ctx, { interrupted: true })` so features see it as a (flagged) commit and can add their own reactive StateChanges; remaining chain steps cancelled
- In both cases, the standard `actionInterrupted(action, reason)` streaming event fires and `TickReport.interruptions[]` records the entry — role sim's memory layer writes NPC memory by subscribing to these, no dedicated notification channel needed
- Cancelled chain steps: **discarded** (not re-queued). Role sim decides whether to re-plan.

**Edge cases:**
- Calling `interruptAction` on a queued (not-yet-active) handle: behaves like `cancelAction` (no elapsed, no partial outcome). Caller does not need to distinguish.
- Calling `interruptAction` twice on the same handle: idempotent, first wins, subsequent calls return `{ applied: false }`.
- Calling `interruptAction` / `cancelAction` on a handle already in `completed` / `cancelled` / `interrupted` state: returns `{ applied: false }`, no side effects.
- `currentTickTime < activatedAt`: throws Error (queue state corruption).

### Queue Structure → Global session queue
- One global queue per session, not per-NPC
- Entries sorted by `(actor.DEX desc, submittedAt asc)`
- Not a central scheduler — role sim still drives decisions; queue is just a buffer
- Complies with earlier `feedback_no_scheduler.md` (NPC AI → Translation → Queue → TickEngine)

### Multi-Step → Preserved, chained
- Interpreter returns `InterpretedStep[]` (existing API kept)
- TickEngine expands into N `ActionStep` objects with `stepGroupId` + `stepIndex`
- Actor slot model: only step N is active; steps N+1..N+K wait for slot
- On commit of step N: activate step N+1 (lazy resolver)
- On interrupt of any step: cancel remaining chain
- "Is this the last step?" is **derived** from the queue (no entry with same `stepGroupId` and higher `stepIndex`), not stored on the step

### Feature Interface → Option 2 (declarative)
- Features implement `WorldFeature` interface with hook methods
- Hooks return `StateChange[]`; they never mutate DGSM
- Features query via narrow `FeatureReadContext` (no direct DGSM access)
- Scene.condition gains owner-tagging: `{ featureId, data, mechanicalEffect, description }` (see §6 SceneCondition for final shape)

### Feature Ordering → Priority number
- `readonly priority?: number` — lower runs earlier
- Convention: 100-199 environment, 200-299 world dynamics, 300-399 character state, 400+ reactive
- Unset defaults to 999 (runs last)
- Applies to: `onTick`, `onActionEnqueue`, `onActionCommit`, `onPropagate`, `getCharacterSkillModifiers` (multi-feature skill modifiers compose in priority order)
- Stable sort on tie (by registration order)

### TickEngine/Role Separation → TickEngine is pure executor
- TickEngine knows NOTHING about NPC decision-making, multi-step planning intent, or LLM gates
- Multi-step chains exist in TickEngine only as opaque ActionStep sequences with `stepGroupId`
- Role sim manages all decision-making
- Two interact only via `submitAction` / `cancelAction` / `interruptAction` (role sim → TickEngine) and the event subscriptions (TickEngine → role sim)

### Interpreter Location → TickEngine side
- Role sim submits raw action text
- TickEngine runs interpreter at `submitAction`
- Interpreter is shared infrastructure, not role sim logic

### StateChange Conflict Resolution → Sum + clamp + damageReport
- Multiple `character.hp/san/fatigue` deltas in the same tick are **summed** by Applier (order-independent)
- Result is clamped to `[0, max]` once after summing
- Death judgement runs once after clamp: when hp drops from positive to 0, Applier appends a synthetic `FeatureEvent { type: "character.died"; characterId }` to `TickReport.featureEvents` (also flowing through the streaming `featureEvent` channel) — death is not a separate StateChange kind
- Applier additionally records a `DamageReport` (per-source contributors) into `TickReport.damageReports` so role sim / UI / future Major Wound logic can attribute damage without needing serial application

### Connection Blocking → Dedicated StateChange + reference counting
- New `StateChange` kind: `connection.setBlock { connectionId, blocked, sourceFeatureId, reason }`
- Applier maintains per-connection refcount keyed by `(sourceFeatureId, reason)` —connection is blocked if any vote is outstanding
- Multiple features blocking the same connection compose naturally (no policy needed); when one feature withdraws its vote (`blocked: false`), other votes still hold

### Cross-feature events → Removed (`onEvent` hook deleted)
- The original spec had a `WorldFeature.onEvent` hook so features could react to other features' `event.emit`
- After abstracting `eventTriggerFeature` into a separate ScriptedEventRunner subsystem (see "Scripted Events" decision below), no remaining feature actually needs to listen to other features' events — physical features (fire/weather/lighting/stamina/sanity) interact through DGSM state, not events
- Drop `onEvent` from `WorldFeature` entirely
- `event.emit` StateChange remains valid as an outward broadcast: emitted events flow into `TickReport.featureEvents` and the streaming `featureEvent` channel (consumed by role sim impact gate, UI, persistence)
- Q2's `maxDepth = 3` cascade cap and `eventCascadeOverflow` system event are obsolete — without `onEvent`, no cross-feature cascade is possible

### SceneCondition Schema → Owner + free-form data, no kind
- Drops the `kind` discriminator
- Adds: `featureId?` (owner), `data?` (feature-private metadata), `mechanicalEffect.blockConnections` (renamed from `blocked`)
- `ConditionPredicate` collapses to `{ featureId }` only — features remove their own conditions wholesale, then re-add fresh ones (replaces current `replaceSceneConditions` pattern)
- No backwards compatibility (Q5 below)

### Mid-Chain Modification → Not supported
- Once submitted, a chain is immutable
- Only two mutations allowed: `cancelAction(handle)` (drop whole chain) or `interruptAction(handle, reason)` (C-compromise on active step + drop remaining)
- Want to "swap step 2"? Cancel the chain and submit a new one
- TickEngine API surface stays minimal; TickEngine never reorders chains

### Backwards Compatibility → None
- Refactor ships with breaking changes to `gameState` JSON shape
- Existing `SimulationRuntime` rows become unloadable; loading throws
- No migration script, no schemaVersion gate, no friendly UI message in this iteration
- Acceptable because this is dev-stage software with no real users

### Impact Gate Location → Role sim, not TickEngine
- TickEngine never calls LLM for "should NPC X interrupt?" decisions
- TickEngine emits events; role sim's per-NPC handler runs the impact gate (LLM); role sim calls `tickEngine.interruptAction(handle, reason)` for affected NPCs
- Resolves the §3 contradiction "engine knows nothing about NPC AI" vs "EmergentEventScanner wraps impactPipeline"
- `EmergentEventScanner` is renamed `EmergentEventEmitter` and only does encounter / world-event detection (no LLM)
- Trade-off: interrupt has a 1-tick latency (event observed in T → interrupt applied at start of T+1). Acceptable in 1-minute ticks, and physically realistic ("I noticed and reacted")

### Event Emission → Streaming + batch
- TickEngine streams fine-grained events as they happen: `actionCompleted`, `actionInterrupted`, `featureEvent` (for UI / persistence subscribers)
- Aggregate-only signals (`StateChange[]`, `DamageReport[]`) are not streamed — they live exclusively in the `TickReport`. Sub-tick streaming for these would be redundant: TickEngine is single-threaded within a tick, and consumers want the post-Applier consolidated view, not raw mid-tick deltas
- TickEngine **also** emits one `tickCompleted(report: TickReport)` at end-of-tick containing the full set of events from this tick (for role sim's impact gate, which needs the full picture to make ≤1 LLM call per affected NPC per tick)
- SimulationRunner awaits role sim's `onTickReport` handler before scheduling next tick (backpressure via `await`)

### Cancel vs Interrupt → Two distinct APIs
- `cancelAction(handle)`: voluntary self-abandonment by role sim (re-planning, player override). Active step is discarded with no resolver call, no partial outcome. Fires the `actionCancelled` streaming event and appends to `TickReport.cancellations[]` so UI / persistence / logs can observe
- `interruptAction(handle, reason)`: forced interruption from impact gate. Active step runs C-compromise (`elapsedRatio < 50%` → discard outcome; `≥ 50%` → re-call resolver with interrupt context, apply partial outcome). Both cancel remaining chain steps and fire the `actionInterrupted` streaming event
- Type-level distinction prevents TickEngine from guessing semantics from a string reason
- **Application timing:** both calls record their request synchronously and return `*Result` immediately, but the actual queue mutation happens at the start of the next tick's "Interrupt apply phase". This guarantees ticks remain atomic even if role sim races multiple cancels/interrupts. The returned `applied` flag reflects the request acceptance, not the post-tick state — query `getActionStatus(handle)` after next tick if you need confirmation

### Naming → ActionStep replaces IntentEntry
- "Intent" overloads with role sim's intent concept and conflicts with §3's "engine knows nothing about intents"
- ActionStep = "one executable step" — single-step submission has 1 ActionStep, multi-step has N (sharing `stepGroupId`)
- Distinct from `CharacterAction` which is the outward "this happened" event type
- `ActionIntake` keeps its name (intake = entry point, not intent-related)

### Feature State Scope → Self-declared, opaque key
- WorldFeature declares `stateScope: "scene" | "region" | "character" | "global"`
- FeatureReadContext / StateChange use opaque `key: string` (not `sceneId`); meaning of `key` depends on the feature's declared scope
- Applier maintains a separate state bucket per `(featureId, scope)` so different scopes never collide
- Resolves the current hack where weather / stamina / sanity all call `setFeatureSceneState(...)` with non-scene keys
- "global" scope: key is ignored by convention (pass empty string)
- ~~"custom" scope~~ removed: the only feature that needed it was eventTrigger, which is now ScriptedEventRunner (separate subsystem with its own keying)
- Note: SceneCondition output is still per-scene regardless of feature scope — weather's region-level state may produce N per-scene SceneConditions across the region

### Feature Declaration → Skill-style metadata, behavior in TS
- Continues the existing pattern (`id`, `description`, `priority`, `propagation`, `planningPrompt`, `planNodeSchema` are already declarative); fills the gaps:
  - `affectedKinds: StateChangeKind[]` — explicit list of `StateChange` kinds the feature can produce
  - `effectSummary: string` — natural-language summary for planning LLM / UI ("fire burns characters in the scene proportional to intensity; spreads to adjacent scenes when intensity high")
  - `impactRange?: Partial<Record<StateChangeKind, [number, number]>>` — optional quantitative envelope per kind (`{ "character.hp": [-10, 0] }`) for impact-prediction UI / planning
- Behavior hooks stay TS code — fire propagation algorithms etc. are not expressible in DSL without significant cost
- This makes WorldFeature shape-equivalent to Claude Code skills: declarative frontmatter (metadata) + body (code), letting engine / planning / UI introspect a feature without reading its hooks
- Rejected DSL alternatives: pure-YAML rule engine (program-B from brainstorming) — large independent project, out of scope for this refactor; pure-LLM rule interpretation — incompatible with sub-second tick budget

### Scripted Events → Separate ScriptedEventRunner subsystem
- Module-authored story beats (currently `eventTriggerFeature`) are extracted into a sibling subsystem `ScriptedEventRunner`, peer to `FeatureRunner` inside TickEngine
- ScriptedEvents are **declarative data** loaded from module definitions (YAML/JSON), not TS code — module authors don't write classes, they write event configurations
- Each ScriptedEvent has:
  - `conditions[]` — daily / cumulative / prerequisite (declarative)
  - `onComplete` / `onFail` effects — high-level (e.g., `{ kind: "character.san"; predicate: "witnesses"; delta: -10 }`); Runner translates to concrete StateChange[] at fire time
- Runs as its own tick phase between Feature phase and Scan phase
- Resolves several current pain points:
  - Removes `stateScope: "custom"` from WorldFeature (no remaining feature needs it)
  - Cleanly separates "physical world simulation" (FeatureRunner) from "story scripting" (ScriptedEventRunner)
  - Removes the `WorldFeature.onEvent` cross-feature listener (no remaining feature consumes other features' events — see "Cross-feature events" decision above)
  - Module authors get a real DSL instead of having to write WorldFeature classes
- Cascade safety: a ScriptedEvent's effect may include `{ kind: "trigger"; otherEventId }` to fire another scripted event. Runner enforces a per-tick cap (`maxCascade = 8`) on chained triggers; overflow logs warning and drops further triggers

---

## 4. TickEngine API

```ts
interface TickEngine {
  // ===== Commands =====
  submitAction(input: ActionInput): ActionHandle;
  cancelAction(handle: ActionHandle): CancelResult;
  interruptAction(handle: ActionHandle, reason: InterruptReason): InterruptResult;

  // ===== Main loop =====
  tick(): Promise<void>;   // advances by TICK_DURATION_MINUTES (= 1 min); awaited because Resolver runs LLM calls

  // ===== Event subscription (streaming, fine-grained) =====
  on(ev: "actionCompleted",       cb: (a: CharacterAction) => void): Unsubscribe;
  on(ev: "actionInterrupted",     cb: (a: CharacterAction, reason: InterruptReason) => void): Unsubscribe;
  on(ev: "actionCancelled",       cb: (a: CharacterAction) => void): Unsubscribe;
  on(ev: "featureEvent",          cb: (e: FeatureEvent) => void): Unsubscribe;

  // ===== Event subscription (batch, end-of-tick) =====
  on(ev: "tickCompleted",         cb: (report: TickReport) => Promise<void> | void): Unsubscribe;

  // ===== Queries =====
  getActionStatus(handle: ActionHandle): ActionStatus;
  getActorQueue(characterId: string): ReadonlyArray<ActionStep>;
}

interface ActionInput {
  characterId: string;
  actionText: string;              // natural language
  targetCharacterIds?: string[];
  sceneId: string;
  overlayFields?: Record<string, unknown>;   // feature overlays (fireIntensity etc.)
}

interface ActionHandle {
  readonly id: string;
  readonly characterId: string;
  readonly submittedAt: GameTime;
}

type ActionStatus = "queued" | "active" | "completed" | "interrupted" | "cancelled";

interface CancelResult {
  applied: boolean;                // false if handle already terminal
  remainingChainCancelled: number;
}

interface InterruptReason {
  triggerKind: "encounter" | "featureEvent" | "stateChange" | "other";
  description: string;             // human-readable, used by memory + UI
}

interface InterruptResult {
  applied: boolean;                // false if handle already terminal
  remainingChainCancelled: number;
  partialOutcome?: StateResolution; // presence ⇔ elapsed ≥ 50% case (re-resolver was called)
}

interface TickReport {
  tickTime: GameTime;
  commits: CharacterAction[];
  interruptions: Array<{ action: CharacterAction; reason: InterruptReason }>;
  cancellations: CharacterAction[];
  featureEvents: FeatureEvent[];
  encounters: EncounterDetection[];
  stateChanges: StateChange[];
  damageReports: DamageReport[];
}

interface DamageReport {
  characterId: string;
  field: "hp" | "san" | "fatigue";
  contributors: Array<{ featureId: string; delta: number; reason: string }>;
  finalValueAfter: number;         // post-clamp
  died: boolean;                   // true iff this report drove hp to 0 from positive
}
```

---

## 5. Internal Components

### ActionIntake
- Entry point for `submitAction`
- Runs GameInterpreter synchronously
- Produces one ActionStep per interpreter step, sets `stepGroupId` + `stepIndex`
- Inserts into Queue by DEX
- Returns single ActionHandle representing the whole chain

### GameInterpreter (existing)
- `src/engine/interpreter/gameInterpreter.ts`
- Returns `InterpretedStep[]` (multi-step)
- No behavior change; just used earlier (at submit) instead of inline in tickProcessor

### Queue
- Global session queue
- Sort: `(actor.DEX desc, submittedAt asc)`
- Per-step status: `queued | active | committed | interrupted | cancelled`
- Per-actor slot mutex enforced
- Indexed lookups: by actor, by handle, by stepGroupId
- "Is last step in chain?" derived: `!queue.entriesByGroup(stepGroupId).some(e => e.stepIndex > self.stepIndex)`

### ActionStep
```ts
interface ActionStep {
  id: string;
  handle: ActionHandle;            // points to owning submission
  stepGroupId: string;             // same for all steps from one submission
  stepIndex: number;               // 0-based; last-step is derived from queue, not stored

  characterId: string;
  targetCharacterIds: string[];
  actionText: string;              // original submission text
  definitionId: string;            // from interpreter
  executionSceneId: string;
  overlayFields?: Record<string, unknown>;

  submittedAt: GameTime;

  // Set at activation (lazy)
  activatedAt?: GameTime;
  plannedDuration?: number;        // minutes
  plannedOutcome?: StateResolution;
  completionTime?: GameTime;

  status: ActionStatus;
}
```

### Resolver (existing)
- `src/engine/resolver/stateResolver.ts`
- Called at activation only
- Produces StateResolution with `elapsedMinutes` determining `completionTime`
- Already refactored in previous work (static system prompt, elapsedMinutes priority rules, etc.)

### TickOrchestrator
Runs phases per tick, no game logic of its own. StateChanges accumulate into the tick's buffer through every phase; only `applier.flush()` writes DGSM:
1. `clock.advance(TICK_DURATION_MINUTES)`
2. `queue.applyPendingInterrupts()` — drain `interruptAction` / `cancelAction` requests submitted by role sim since last tick; apply C-compromise to active steps (≥ 50% case re-runs Resolver and feeds `partialOutcome` through `featureRunner.runActionCommit(..., { interrupted: true })` so features can react); cancel queued chain remainders; fire `actionInterrupted` / `actionCancelled` events accordingly
3. `queue.activate(idleActors)` — calls Resolver for next queue head of each idle actor
4. `queue.commitDue(now)` — commit steps with `completionTime <= now`, by DEX → `featureRunner.runActionCommit` → StateChanges accumulated
5. `featureRunner.runTick()` — all features' onTick in priority order → StateChanges accumulated
6. `featureRunner.runPropagation()` — features with propagation due this tick → StateChanges accumulated
7. `scriptedEventRunner.run()` — module-defined event triggers evaluate conditions against committed actions + accumulated StateChanges (read-through view); fire effects → StateChanges accumulated
8. `eventEmitter.scan()` — encounter detection + world-event detection (no LLM, no impact gate)
9. `applier.flush()` — group + sum + clamp all accumulated StateChanges, single batch write to DGSM, append `DamageReport`s into tick's report buffer
10. Emit streaming events as they happen + `tickCompleted(TickReport)` at the end

### FeatureRunner
- Holds physics features in priority-sorted order
- Methods:
  - `runTick(ctx) → StateChange[]`
  - `runActionCommit(step, outcome, ctx, opts?: { interrupted?: boolean }) → StateChange[]` — invoked both for normal completion and for ≥ 50% interrupt partial outcomes; `opts.interrupted` lets features distinguish if they care (most won't)
  - `runActionEnqueue(step, ctx) → { blocked?, changes? }`
  - `runPropagation(ctx) → StateChange[]`
  - `getCharacterSkillModifiers(charId, ctx) → CharacterSkillModifier[]` — aggregates per-feature `getCharacterSkillModifiers` results
- Returns StateChanges; never mutates
- No event-dispatch responsibility — features no longer expose `onEvent`. Cross-feature reactions are handled by ScriptedEventRunner (data-driven) or via DGSM state observation in `onTick`

### Applier
- Single DGSM mutator (formerly named `FeatureStateApplier`)
- Input: `StateChange[]` accumulated over the tick (from features, action commits, propagation, event cascades)
- Two-pass apply:
  - **Pass 1 — group:** bucket all `character.hp/san/fatigue` changes by `(characterId, field)`; collect `connection.setBlock` votes; collect condition / feature-state changes
  - **Pass 2 — flush:**
    - sum each `(characterId, field)` bucket → clamp to `[0, max]` → write DGSM → accumulate `DamageReport` (with per-source contributors + `died` flag) into the tick's report buffer
    - update connection refcount table from `setBlock` votes; write `blocked` to topology
    - apply scene/character condition changes in order
    - apply feature-state writes in order
    - collect `event.emit` items: append each to `TickReport.featureEvents` and fire the streaming `featureEvent` channel (no cross-feature dispatch — `onEvent` hook was removed)
- All other dispatches:
  - `character.addCondition`, `character.removeCondition`
  - `scene.addCondition`, `scene.removeCondition`
  - `feature.setState`, `feature.removeState` — Applier looks up the feature's declared `stateScope` and writes to the corresponding bucket (`sceneStates[featureId][key]` for scope=scene, `regionStates[featureId][key]` for region, etc.) so different scopes never collide
- Testable with mock DGSM

### ScriptedEventRunner
- Sibling of FeatureRunner inside TickEngine — runs in its own tick phase
- Loads `ScriptedEvent[]` from module definitions (declarative data, see §6)
- Per tick: receives a `ScriptedEventReadContext` (see §6) and iterates enabled events, evaluating conditions (daily / cumulative / prerequisite) against committed actions from `ctx.getCommittedActionsThisTick()` + accumulated changes from `ctx.getAccumulatedStateChanges()` + its own progress namespace via `ctx.getEventProgress()`
- When a condition is met: fires `onComplete` effects → translates each declarative effect into concrete `StateChange[]` (e.g., `{ kind: "character.san"; predicate: "witnesses"; delta: -10 }` expands into one `StateChange` per witness NPC) → accumulates into the tick's StateChange buffer
- When a condition fails (e.g., daily missed too many times): fires `onFail` effects similarly
- Cascade safety: a `{ kind: "trigger"; otherEventId }` effect can chain to another scripted event in the same tick. Runner enforces `maxCascade = 8` per tick; overflow logs warning + drops further triggers
- Owns its own state namespace (per-event progress: `dailyFulfilledToday`, `cumulativeCount`, etc.) — completely separate from `feature.setState` buckets
- Replaces the current `eventTriggerFeature.ts` entirely; that file is deleted

### EmergentEventEmitter
- Renamed from `EmergentEventScanner`
- Wraps existing `encounterScanner.ts` only (impactPipeline is moved out of TickEngine)
- Detects encounters + world-event triggers (purely deterministic — no LLM)
- Outputs:
  - `EncounterDetection[]` → appended to `TickReport.encounters[]`
  - synthetic `FeatureEvent[]` → appended to `TickReport.featureEvents[]` and fired on the streaming `featureEvent` channel (same path as `event.emit` StateChanges from features)
- Single call from TickOrchestrator
- impact gate (LLM-driven "should NPC X interrupt?") now lives in role sim's `onTickReport(report)` handler

---

## 6. Feature Interface

```ts
type FeatureStateScope = "scene" | "region" | "character" | "global";

interface WorldFeature {
  // ===== Identity =====
  readonly id: string;
  readonly description: string;

  // ===== State scope (engine routes state by this) =====
  readonly stateScope: FeatureStateScope;
  // key semantics by scope:
  //   scene     → key is sceneId
  //   region    → key is regionId
  //   character → key is characterId
  //   global    → key is ignored (pass empty string)

  // ===== Declarative impact (engine / planning / UI introspect this) =====
  readonly affectedKinds: ReadonlyArray<StateChange["kind"]>;
  readonly effectSummary: string;             // natural-language summary for planning LLM / UI
  readonly impactRange?: Partial<Record<StateChange["kind"], readonly [number, number]>>;
                                              // e.g., { "character.hp": [-10, 0] } — optional, only meaningful for delta kinds

  // ===== Execution metadata =====
  readonly priority?: number;                 // tick order; lower runs earlier

  // Propagation is spatial (scene-to-scene through the world graph), independent of stateScope.
  // Any feature can opt in by defining this config + implementing onPropagate.
  // Typical pattern: scene-scope features (fire) propagate naturally; region-scope features
  // (weather) may still propagate scene-to-scene to simulate localized fronts moving across the map.
  readonly propagation?: {
    tickInterval: number;
    maxHops: number;
  };

  // ===== Planning integration =====
  readonly planningPrompt?: string;
  readonly planNodeSchema?: FeatureNodeSchema;

  // ===== Behavior hooks (TS code) =====
  stateDescription?(ctx: FeatureReadContext): string;

  onTick?(ctx: FeatureReadContext): StateChange[];

  onActionEnqueue?(
    step: ActionStep,
    ctx: FeatureReadContext
  ): { blocked: { reason: string } } | { changes: StateChange[] };

  onActionCommit?(
    step: ActionStep,
    outcome: StateResolution,
    ctx: FeatureReadContext
  ): StateChange[];

  // Called only if `propagation` is defined. source.sceneId / spreadToSceneIds are
  // world-graph nodes (scenes), NOT the feature's own state keys (which depend on stateScope).
  onPropagate?(
    source: { sceneId: string; hop: number },
    ctx: FeatureReadContext
  ): { spreadToSceneIds: string[]; changes: StateChange[] };

  getCharacterSkillModifiers?(
    characterId: string,
    ctx: FeatureReadContext
  ): CharacterSkillModifier[];
}

interface CharacterSkillModifier {
  skill: string;
  delta: number;
  source: string;            // human-readable attribution (e.g., "fire: smoke")
}

interface FeatureReadContext {
  readonly gameDay: number;
  readonly tickTime: string;
  readonly tickDurationMinutes: number;

  // World queries (always scene-keyed — scenes are the universal world unit)
  getSceneIds(): string[];
  getScene(sceneId: string): SceneView | undefined;
  getCharacter(charId: string): CharacterView | undefined;
  getCharactersInScene(sceneId: string): CharacterView[];
  getRegionId(sceneId: string): string | undefined;            // for region-scope features mapping scenes → regions

  // Feature state queries (key meaning depends on the calling feature's `stateScope`)
  getFeatureState<T>(key: string): T | undefined;
  getAllFeatureStates<T>(): Array<{ key: string; state: T }>;

  // Cross-feature read: caller must know the other feature's scope to pass the right key
  getOtherFeatureState<T>(featureId: string, key: string): T | undefined;
}

// Owner-tagged structured condition. No `kind` discriminator — features either keep one
// condition per scene and carry differentiation in `data`, or add multiple and replace
// them as a group via `removeCondition({ featureId })`.
interface SceneCondition {
  featureId?: string;                          // owner; required for removal-by-owner
  data?: Record<string, unknown>;              // feature-private metadata (intensity, etc.)
  mechanicalEffect?: {
    skillPenalty?: Record<string, number>;
    blockConnections?: boolean;                // scene-level shorthand; for connection-level use connection.setBlock
  };
  description: string;                         // human/LLM-readable
}

type StateChange =
  | { kind: "scene.addCondition"; sceneId: string; condition: SceneCondition }
  | { kind: "scene.removeCondition"; sceneId: string; predicate: ConditionPredicate }
  | { kind: "character.hp"; characterId: string; delta: number; sourceFeatureId: string; reason: string }
  | { kind: "character.san"; characterId: string; delta: number; sourceFeatureId: string; reason: string }
  | { kind: "character.fatigue"; characterId: string; delta: number; sourceFeatureId: string; reason: string }
  | { kind: "character.addCondition"; characterId: string; condition: CharacterCondition }
  | { kind: "character.removeCondition"; characterId: string; conditionId: string }
  | { kind: "connection.setBlock"; connectionId: string; blocked: boolean; sourceFeatureId: string; reason: string }
  | { kind: "feature.setState"; featureId: string; key: string; state: unknown }      // key per feature's stateScope
  | { kind: "feature.removeState"; featureId: string; key: string }                   // key per feature's stateScope
  | { kind: "event.emit"; event: FeatureEvent };

// Owner-only — features remove their own conditions wholesale, then re-add fresh ones
type ConditionPredicate = { featureId: string };
```

### ScriptedEvent (module-defined story beats)

Loaded from module data (YAML/JSON) — not TS code. ScriptedEventRunner consumes these.

```ts
interface ScriptedEvent {
  id: string;                            // unique per session
  label: string;                         // human-readable title
  enabled: boolean;                      // module can disable without removing
  conductorNpcId?: string;               // primary NPC tied to this beat (for memory attribution)
  siteSceneId?: string;                  // primary scene (for "witnesses" predicate scoping)

  conditions: ScriptedEventCondition[];  // ALL must hold for onComplete; failure modes per condition
  onComplete: ScriptedEventEffect[];
  onFail?: ScriptedEventEffect[];
}

type ScriptedEventCondition =
  | { type: "daily"; triggerDefinitionId: string; failAfterMissed: number }
  | { type: "cumulative"; triggerDefinitionId: string; requiredCount: number }
  | { type: "prerequisite"; locationId?: string; itemId?: string; mode: "manual" | "passive" };

// `triggerDefinitionId` matches `ActionStep.definitionId` (produced by GameInterpreter).
// Module authors reference the defined action category IDs from the interpreter's
// vocabulary (e.g., "cook", "pray", "inspect"). For finer-grained matching
// ("prayed at THIS altar"), add a `prerequisite` condition checking sceneId / itemId.

// Declarative effects — Runner expands into concrete StateChange[] at fire time.
// Shape asymmetry (sceneId is a plain string, target is a predicate) is intentional:
// scene targets are static (module authors know the sceneId when writing the event),
// but character targets are dynamic ("witnesses" = whoever happens to be in the site at
// fire time), so they must be resolved at runtime.
type ScriptedEventEffect =
  // sceneId optional: omitting it defaults to ScriptedEvent.siteSceneId (common case)
  | { kind: "scene.addCondition"; sceneId?: string; condition: SceneCondition }
  | { kind: "character.san"; predicate: "witnesses" | "global" | { characterIds: string[] }; delta: number }
  | { kind: "character.hp"; predicate: "witnesses" | "global" | { characterIds: string[] }; delta: number }
  | { kind: "trigger"; otherEventId: string };
```

ScriptedEventRunner maintains its own per-event progress state, separate from `feature.setState`:

```ts
type ScriptedEventProgress =
  | { type: "daily"; fulfilledToday: boolean; lastFulfilledDay: number; consecutiveMissed: number }
  | { type: "cumulative"; currentCount: number }
  | { type: "prerequisite"; fulfilled: boolean };
```

Read context specific to ScriptedEventRunner — extends `FeatureReadContext` with access to this tick's committed actions and accumulated changes, plus its own progress namespace:

```ts
interface ScriptedEventReadContext extends FeatureReadContext {
  // Actions committed in this tick (phase 4 output, before Apply phase writes DGSM)
  getCommittedActionsThisTick(): ReadonlyArray<CharacterAction>;
  getCommittedActionsByCharacter(characterId: string): ReadonlyArray<CharacterAction>;

  // StateChanges accumulated so far in this tick (phase 4/5/6 output, before Apply phase flushes)
  getAccumulatedStateChanges(): ReadonlyArray<StateChange>;

  // Per-event progress (separate namespace from feature.setState)
  getEventProgress(eventId: string): ScriptedEventProgress | undefined;
}
```

> **Mockability note (replaces former §9 Q7):** `FeatureReadContext` is intentionally a pure interface with no side effects. Implementation choice for unit tests (hand-written builder, plain-object stub, in-memory DGSM stub) is left to the implementation plan — the contract here doesn't constrain it.

---

## 7. What Gets Deleted / Replaced

| Current | Replaced By |
|---|---|
| `PlanNode.startTime` / `PlanNode.endTime` | ActionStep's `completionTime` (lazy) |
| `shiftPendingNodesByDelta` | Not needed — no time-window model |
| `executionMeta.remainingMinutes` (for non-movement) | ActionStep's `completionTime - now` |
| tickProcessor `executeSingleTick` 600+ line | TickOrchestrator + Queue + Resolver + FeatureRunner + Applier |
| feature's direct `dgsm.setFeatureSceneState` / `appendSceneCondition` / `setConnectionBlocked` | `StateChange` return values |
| `replaceSceneConditions` description-prefix matching | `removeCondition({ featureId })` then `addCondition` |
| `setConnectionBlocked` direct call | `connection.setBlock` StateChange + Applier-managed refcount |
| `InterpretedResult.steps` consumed only [0] in runtime | Expanded into multi-step chain in queue |
| `impactPipeline` inside TickEngine | Moved to role sim's `onTickReport(report)` handler |
| `eventTriggerFeature.ts` (squeezed scripted events through WorldFeature) | Replaced by `ScriptedEventRunner` subsystem + declarative `ScriptedEvent` data |
| `WorldFeature.onEvent` hook | Removed — no remaining feature consumes other features' events; cross-feature reactions live in ScriptedEventRunner |
| Cross-feature event cascade + `maxDepth = 3` cap + `eventCascadeOverflow` event | Removed — onEvent removed, no cascade possible. ScriptedEvent `trigger` chain has its own internal `maxCascade = 8` |
| `stateScope: "custom"` | Removed — only eventTrigger needed it; ScriptedEventRunner has its own state namespace |

## 7b. External Type References

This spec references several types without defining them inline. Categorized:

**Already exists in codebase (use as-is):**
| Type | Location |
|---|---|
| `CharacterAction` | `src/state/types.ts` (existing CharacterAction shape used for emitted action records) |
| `CharacterCondition` | `src/state/types.ts` |
| `StateResolution` | `src/engine/resolver/stateResolver.ts` (output schema) |
| `GameTime` | `src/state/types.ts` (existing tickTime / gameDay container) |
| `InterpretedStep` | `src/engine/interpreter/gameInterpreter.ts` |
| `FeatureNodeSchema` | `src/engine/types.ts` (existing planning extension type) |
| `SceneView` / `CharacterView` | currently DGSM read-helper return types in `src/state/DynamicGameState.ts`; kept as-is for FeatureReadContext |

**New types this refactor introduces (defined in §4 / §6):**
| Type | Defined in |
|---|---|
| `ActionStep` | §5 |
| `ActionHandle` / `ActionInput` / `ActionStatus` / `CancelResult` / `InterruptReason` / `InterruptResult` / `TickReport` / `DamageReport` | §4 |
| `StateChange` (union) / `SceneCondition` / `ConditionPredicate` / `FeatureStateScope` / `WorldFeature` / `FeatureReadContext` / `CharacterSkillModifier` | §6 |
| `ScriptedEvent` / `ScriptedEventCondition` / `ScriptedEventEffect` / `ScriptedEventProgress` / `ScriptedEventReadContext` | §6 |
| `EncounterDetection` | TBD in plan phase — wraps current `encounterScanner.ts` output |
| `FeatureEvent` | TBD in plan phase — minimal shape: `{ type: string; characterId?: string; sceneId?: string; data?: Record<string, unknown> }` (used for `character.died` and any feature-emitted broadcast via `event.emit`) |

**Standard TS pattern (no definition needed):**
- `Unsubscribe` = `() => void`

---

## 8. What Stays

- DGSM as the state store
- Feature state namespace (`getFeatureState(key)` / `getOtherFeatureState(featureId, key)` — generalized from sceneId-only to scope-aware)
- Planning layer (NPCPlanningAgent) — but its output format simplifies (see role sim section)
- Movement tool's cross-tick semantics (independent of this refactor)
- Skill check tool
- Memory manager + NpcMemory

---

## 9. Open Questions — Resolved (2026-04-20)

All seven open questions from the original draft were resolved in the 2026-04-20 brainstorming session. Decisions are folded into §3 (rationale) and §4–§6 (interface shape). Summary table:

| # | Topic | Resolution | Where |
|---|---|---|---|
| 1 | StateChange conflict (hp/san/fatigue) | Sum deltas → clamp to `[0, max]` → record `DamageReport` in `TickReport` for attribution | §3 "StateChange Conflict Resolution", §5 Applier, §6 StateChange |
| 1b | Connection blocking conflict | Dedicated `connection.setBlock` StateChange + Applier-managed refcount per `(sourceFeatureId, reason)` | §3 "Connection Blocking", §6 StateChange |
| 2 | Event cascade depth cap | Originally chose `maxDepth = 3`. Subsequently obsolete after `WorldFeature.onEvent` was removed (cascade impossible). ScriptedEvent chain has its own `maxCascade = 8` | §3 "Cross-feature events", §3 "Scripted Events" |
| 3 | SceneCondition DB migration | Drop `kind`; add `featureId`/`data`/`blockConnections`; predicate is owner-only; no Prisma migration (gameState is Json blob) | §3 "SceneCondition Schema", §6 SceneCondition |
| 4 | Mid-chain cancel protocol | No mid-chain edits. Only `cancelAction(handle)` (whole chain) or `interruptAction(handle, reason)` (active step + cancel rest) | §3 "Mid-Chain Modification", §4 API |
| 5 | Backwards compatibility | None — old `SimulationRuntime` rows become unloadable; no migration, no schemaVersion gate | §3 "Backwards Compatibility" |
| 6 | Interruption detection contract | Impact gate moves to role sim. TickEngine streams events + emits `tickCompleted(TickReport)` batch; role sim's handler decides + calls `interruptAction`. 1-tick latency accepted | §3 "Impact Gate Location" / "Event Emission" / "Cancel vs Interrupt", §4 API |
| 7 | FeatureReadContext mock | Not a spec-level decision. Interface is pure; implementation choice deferred to plan | §6 mockability note |

---

## 10. Unresolved (not yet discussed)

- tickProcessor module file layout (which files under `src/engine/runtime/` vs new paths)
- Migration plan (step-by-step replacement strategy)
- Per-feature migration cost
- ActionStep persistence strategy: persist as a separate Prisma table, or live inside `SimulationRuntime.gameState` JSON blob? (Independent of Q5 — this is about *new* data persistence, not old-data compatibility)
- Session resume behavior: on process restart with an active session, is the queue rebuilt from `NpcDailyPlan` rows, or restored from its persisted form?
- Relationship with current handlers (`src/engine/handlers/`) — do they survive or dissolve into the generic commit flow?

---

## 11. Brainstorming Decisions Log

| Decision | Chosen | Rejected |
|---|---|---|
| Resolver timing | B (lazy per-step) | A (eager all-at-once), C (per-tick) |
| Interruption | C 妥协版 (<50% discard, ≥50% re-resolve) | A (always discard), B (linear scale) |
| Queue scope | Global session | Per-NPC, priority heap |
| Multi-step handling | Sequential chained entries | Single entry with steps, fan-out all resolved upfront |
| Feature interface | Option 2 (declarative StateChange) | Option 1 (DSL rules), Option 3 (actor model) |
| Feature ordering | `priority: number` | `dependsOn: string[]` |
| Interpreter location | TickEngine side | Role sim side |
| NPC intent management | Role sim | TickEngine |
| hp/san/fatigue delta merge | A (sum + clamp + damageReport) | B (priority-ordered serial), C (highest-priority wins) |
| Connection blocking model | B (dedicated StateChange + refcount) | A (via SceneCondition.blockConnections), C (hybrid) |
| Death semantics | C (clamp [0,max] + emit damageReport) | A (clamp only), B (allow negative hp) |
| Event cascade cap | A (maxDepth=3, log + synthetic event on overflow) — **later superseded; see "Cross-feature event cascade cap" row below** | B (5), C (per-type counter), D (no cascade) |
| Event emission shape | C (streaming + batch tickCompleted) | A (streaming only), B (batch only) |
| Cancel vs Interrupt API | B (two distinct APIs) | A (one API + reason string), C (one API + enum) |
| Mid-chain modification | A (not supported) | B (cancelStep), C (truncateChain) |
| Impact gate location | B (role sim) | A (TickEngine), C (TickEngine + injected decider) |
| Backwards compat | A (none, old sessions break) | B (schemaVersion gate + UI message) |
| SceneCondition schema | Owner-only predicate, no `kind` | `kind` discriminator |
| ActionStep naming | `ActionStep` | `IntentEntry` (rejected: "intent" overloads role-sim concept) |
| `isLastStep` field | Derived from queue | Stored on step |
| Q7 mock impl | Defer to plan phase | Decide in spec |
| Feature state scope | C (feature self-declares `stateScope`, opaque key API) | A (opaque key only), B (multiple explicit per-scope APIs) |
| Feature declarative metadata | A (extend WorldFeature with `stateScope` / `affectedKinds` / `effectSummary` / `impactRange`) | B (YAML-rule DSL — out of scope), C (LLM-interpreted markdown — incompatible with sub-second tick) |
| Streaming `stateChanged` / `damageReport` events | Drop streaming, keep in TickReport | Stream + batch (redundant) |
| `getWorldStateView()` query | Drop — consumers read DGSM directly | Keep as proxy |
| `InterruptResult.outcomeApplied` | Drop — derive from `partialOutcome` presence | Keep as separate flag |
| `InterruptReason.triggerEventId` | Drop — no event-id system in place | Keep with caveats |
| `tick()` return type | `Promise<void>` | Undefined `TickResult` (was a spec bug) |
| Scripted event subsystem | Separate `ScriptedEventRunner` (sibling of FeatureRunner) | Stay as a WorldFeature with `stateScope: "custom"` |
| `WorldFeature.onEvent` hook | Removed | Keep with cascade-bounded dispatch |
| Cross-feature event cascade cap | Removed (cascade no longer possible) | Originally `maxDepth = 3` |
| `FeatureStateScope` "custom" | Removed | Keep for non-standard keying |
| Applier name | `Applier` | `FeatureStateApplier` (verbose, redundant prefix) |
| Death signal channel | Synthetic `FeatureEvent { type: "character.died" }` in TickReport | New StateChange kind |
| Interrupt memory notification | Piggyback on existing `actionInterrupted` event + `TickReport.interruptions[]` | Dedicated `memory.event` FeatureEvent (redundant payload) |
| Cancel visibility | A (dedicated `actionCancelled` event + `TickReport.cancellations[]`) | B (silent, track via CancelResult), C (reuse `actionInterrupted` with voluntaryCancel triggerKind) |
| ScriptedEventRunner read context | A (dedicated `ScriptedEventReadContext` extending FeatureReadContext) | B (add action-history methods to FeatureReadContext itself) |
| `triggerActionType` semantics | A (rename to `triggerDefinitionId`, matches `ActionStep.definitionId`) | B (LLM-matched free text — violates sub-second tick), C (free text + string match — fragile) |
| ≥ 50% interrupt apply path | A (go through `FeatureRunner.runActionCommit` with `{interrupted: true}` flag so features react) | B (raw apply partialOutcome — features lose visibility into mid-action events) |
| ScriptedEventEffect shape asymmetry | C (keep sceneId-vs-predicate asymmetry, make sceneId optional defaulting to siteSceneId, document rationale) | A (force `sceneTarget` predicate for consistency — redundant wrapping), B (remove predicates, force explicit IDs — can't express "witnesses") |
