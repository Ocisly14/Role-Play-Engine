# Resolver → StateChange → Memory Bridge Design

**Date:** 2026-05-15
**Status:** Draft (post-Phase I gap fix)
**Scope:** Engine resolver wiring + scene perception dynamization

## Context

After Phase I's unified Subsystem refactor, three layers between the resolver
and downstream consumers are silently broken. The first 10-tick e2e run with
two LLM-driven NPCs in a static study scene exposed it: every commit's
`outcome.narrative` was `null`, agents looped on the same action ("examine
unopened letter") because the world never updated, and resolver-emitted
memories never reached the memory store.

**Three concrete breaks**:

1. **Bridge bug** — `SimulationRunner` and the test script's resolve closures
   read `resolution.stateChanges`, but `resolveState()` returns the LLM's
   raw flat dict like `{"memory.event": [...], "item.modify": [...],
   "elapsedMinutes": 1}`. There is no `stateChanges` key. The fallback is
   `[]`, so **every state change the resolver emits is dropped on the floor**.

2. **Memory applier no-op** — `stateChangeAppliers.ts:235-241` for
   `memory.event` and `memory.witness` are placeholders with the comment
   "handled by tickProcessor via memoryManager". `tickProcessor` was the
   pre-Phase-I name; the new TickOrchestrator does not consume them. Even
   when (1) is fixed, memory writes would still vanish.

3. **Scene description static** — `scene.description` and `scene.items[i]`
   are loaded from JSON once and never mutated. Even if `item.modify` reaches
   the applier, there is no `dgsm.modifyItem(...)` to apply the change. The
   renderer keeps describing "an unopened letter on the desk" forever.

The combination produces the observed symptom: NPCs perceive an unchanged
world, generate identical actions, commit them, and never form memory of
having done so.

**Outcome of this design**: a single end-to-end path where the resolver's
JSON output flows through a centralized typed conversion, lands as real
state changes (item rename + memory rows), and the perception layer reflects
those changes the next tick. Engine stays memory-agnostic; the controller
remains the only writer to the memory store.

---

## Architecture

```
Resolver LLM
  │ flat JSON  {"memory.event":[...], "item.modify":[...], "elapsedMinutes":N}
  ↓
resolveState()  ──── flattenToStateChanges ────→  {stateChanges, elapsedMinutes}
  │                                                        ↑ typed
  ↓                                                        StateChange[]
SimulationRunner / test resolve closure
  (thin wrapper; passes through, applies cancel-prompt wrap when needed)
  ↓
PlannedOutcome { stateChanges, elapsedMinutes }      ← narrative? field DELETED
  ↓
TickOrchestrator.buffer.push(...stateChanges)
  ↓
Applier.flush
  ├── item.modify         → dgsm.modifyItem(itemId, {name?, description?}, from?)
  ├── scene.condition     → existing dgsm.appendSceneCondition / removeSceneCondition
  ├── character.hp/san    → existing dgsm.updateNpcHp / updateNpcSan
  └── memory.event/witness → no-op (intentional; controller consumes)
  ↓
TickReport { activations, commits, cancellations, stateChanges, ... }
  ↓
NpcActionController.processTickReport
  ├── writeAutoMemories[begin]      (handcoded; activations → "[begin] <actionText>")
  ├── routeResolverMemories(report) (NEW: scan stateChanges for memory.event/witness, route to memoryManager)
  └── decide() pass for affected NPCs
```

**Invariants**:
- Engine layer never touches `NpcMemoryManager`. Controller is the sole writer.
- Resolver memory.event content is the canonical "what happened" text (no
  separate `narrative` field).
- `[begin]` event memory is handcoded by controller at activation time;
  `[result]`-style content is whatever resolver produces.

---

## Components

### Engine

**`src/engine/resolver/stateResolver.ts`**
- `resolveState()` return type: `Record<string, any>` → `{ stateChanges: StateChange[]; elapsedMinutes: number }`
- New private `flattenToStateChanges(resolution: Record<string, any>): StateChange[]`:
  walk top-level keys, skip `elapsedMinutes`, for each typeId-array spread
  each object as `{ kind: typeId, ...obj }`. Drops empty arrays. Returns
  typed StateChange[].
- Validation pass continues to drop unknown keys before flattening.

**`src/engine/resolver/stateChangeAppliers.ts`**
- `item.modify` applier: call `dgsm.modifyItem(c.itemId, { name?: c.name, description?: c.description }, c.from)`. The `from` field is optional and matches the existing `item.destroy` convention ("scene:<sceneId>" or "<npcId>"); when absent, modifyItem searches scenes then inventories for the matching id.
- `memory.event` / `memory.witness` appliers: keep no-op. Add a comment noting controller-side consumer in `npcActionController.routeResolverMemories`.

**`src/engine/resolver/stateChangeTypes.ts`**
- Extend `item.modify` schema: drop the old required `properties` object; add optional `name: string`, `description: string`, and `from: string` (matches `item.destroy` convention). `itemId` is the only required field. Item state changes are surfaced via `name` / `description` swaps so they show up in the renderer's prompt automatically; opaque blobs are deliberately out of scope.
- Update the `description` text to mention the new editable fields so the resolver LLM knows it can rename / re-describe items.

**`src/engine/core/types.ts`**
- Delete `PlannedOutcome.narrative?: string`. Search for residual readers and clean.

**`src/engine/core/tickOrchestrator.ts`**
- `ResolveCancelContext.plannedNarrative` repurposed: no longer comes from a deleted `narrative` field; instead `applyPendingCancellation` extracts it from `step.plannedOutcome.stateChanges.find(s => s.kind === "memory.event")?.content` (the resolver's original event memory text). When no such entry exists, omit the field.
- `applyPendingCancellation` keeps current shape; only the source of `plannedNarrative` changes.

### State

**`src/state/DynamicGameState.ts`**
- Add `modifyItem(itemId: string, patch: { name?: string; description?: string }, from?: string): boolean`.
  - When `from` is given (`"scene:<sceneId>"` or `"<npcId>"`), look only in that location.
  - When `from` is absent, scan `state.scenes` first, then `state.npcInventories`. Apply patch to the first match.
  - Merges `patch` into the matched Item entry (mutates in place — DGSM is mutable). Returns true on success, false (with warn) on no match.

### RoleSim

**`src/roleSim/npcActionController.ts`**
- Keep `[begin]` write block (Q5 decision: dual entries).
- Delete the existing commits/cancellations `[result]` write blocks (resolver now provides content via memory.event).
- Add `routeResolverMemories(report: TickReport)`:
  - Iterate `report.stateChanges`.
  - For `kind === "memory.event"`: look up actor's scene from commits/cancellations of same characterId for the location field, fall back to current position. Call `memory.add({type: "event", content, characterId, ...})`.
  - For `kind === "memory.witness"`: same routing.
  - Wrap each in try/catch (per existing `writeMemoryEntry` helper).
- Witness memories from `eventsByNpc` (current writeAutoMemories block) — keep, since FeatureEvents are subsystem-emitted, not resolver-emitted. Resolver `memory.witness` is a separate channel for action-driven witnessing (e.g., "Marsh saw Hollins react in disgust").

### Resolver callers

**`src/simulation/SimulationRunner.ts`**
- Resolve closure becomes thin: just call `resolveState`, pass through the typed `{stateChanges, elapsedMinutes}` as `outcome` (PlannedOutcome no longer has narrative). Keep cancel-prompt-wrapping logic.
- Override `elapsedMinutes` for cancel: `cancel ? cancel.elapsedMinutes : result.elapsedMinutes`. (Same logic, narrowed return type. Param name matches the renamed `cancel?: ResolveCancelContext`.)

**`scripts/test-role-agent.ts`**
- Mirror SimulationRunner changes.
- Bonus: include `report.stateChanges` in the JSON record so e2e verification can inspect what the resolver actually emitted (currently absent from the JSON shape).

### Cleanup

- Search for `PlannedOutcome.narrative` / `outcome?.narrative` / `resolution.narrative` references. Remove all.
- `src/engine/types.ts`'s deprecated `StateResolution` interface: confirm no remaining callers; consider removing.
- Renderer doesn't change directly — it already reads `dgsm.getScene(sceneId).items[i].name + .description`. Once `dgsm.modifyItem` mutates those, perception updates automatically.

---

## Key data-flow scenarios

### Scenario A — Marsh opens the letter (natural completion)

1. T0 agent submits `act` with intent "examine and open the letter".
2. T0 same tick: `engine.submitAction` → interpretAction → step queued.
3. T1 Phase 3 activate → resolveState LLM call:
   ```json
   {
     "memory.event": [{"characterId":"npc_marsh",
                       "content":"I broke the wax seal and slid the letter free."}],
     "item.modify": [{"itemId":"item_letter",
                      "from":"scene:scene_study",
                      "name":"opened letter",
                      "description":"Cream envelope, broken-sealed; folded sheet protrudes."}],
     "elapsedMinutes": 1
   }
   ```
4. flattenToStateChanges produces 2 typed `StateChange` entries; `step.plannedOutcome = {stateChanges, elapsedMinutes:1}`.
5. T1 Phase 4 commit; outcome surfaces in TickReport.commits.
6. Applier: `item.modify` mutates `dgsm.scene_study.items.item_letter` → name + description swapped; `memory.event` no-op.
7. Controller: `routeResolverMemories` finds the memory.event entry → memoryManager.add (event row with location=scene_study).
8. T2 perception: renderer shows `Items in scene: opened letter (id: item_letter): broken-sealed; folded sheet`. Marsh sees this, doesn't loop, decides next action (e.g., read the contents).

### Scenario B — Marsh switches mid-flight (cancel-on-act with partial narrative)

1. T0: Marsh reading a long document (5-min `act`); resolver pre-computed plannedOutcome with `memory.event "I begin reading..."`.
2. T0: controller writes `[begin] I begin reading...` event memory.
3. T1: a perception event reaches Marsh; he picks new `act` "rise and check the door".
4. T1: controller calls `engine.cancelAction(handle, "switching to: rise and check the door")` → orchestrator queues pending cancellation.
5. T2 Phase 2 processes cancellation: re-runs resolver with cancel context. Resolver outputs:
   ```json
   {
     "memory.event": [{"characterId":"npc_marsh",
                       "content":"I had read about three lines when the latch clicked, so I rose."}],
     "elapsedMinutes": 2
   }
   ```
6. flatten + step.plannedOutcome replaced; cancellations.push(action).
7. Controller `routeResolverMemories` writes the partial event memory.
8. T3 Marsh sees both `[begin] I begin reading...` (T0) and the partial result (T2) in today's memories.

### Scenario C — Resolver fails or emits no memory.event

- LLM returns `{}`: validation drops unknown keys (none in this case), flatten produces `[]`, plannedOutcome is `{stateChanges:[], elapsedMinutes:0}`. Action commits with no observable effect. Controller writes `[begin]` only; no result memory. Acceptable degradation.
- LLM throws: existing catch in `resolveState` returns empty resolution, same path as above.

---

## Error handling

| Case | Behavior |
|------|---------|
| Resolver omits required `memory.event` | Action still commits; no result memory written; warn. |
| Resolver emits unknown typeId | `validateResolution` drops it pre-flatten; safe. |
| Resolver returns non-JSON | `parseStateResolution` catch returns `{}`; action commits empty. |
| `dgsm.modifyItem` references missing scene/item | Returns false + warn; doesn't throw. Action still commits. |
| `routeResolverMemories` references dead NPC | `dgsm.isNpcAlive(charId) === false` → skip + warn. |
| `memoryManager.add` throws | Wrapped in try/catch (existing `writeMemoryEntry` helper). |
| Cancel re-resolve fails | Existing fallback: keep prior `step.plannedOutcome`. |

---

## Testing & verification

No new unit tests (per project convention). End-to-end via the existing
`scripts/test-role-agent.ts`.

**Static**:
1. `pnpm exec tsc --noEmit -p tsconfig.json` passes (zero errors).
2. grep for `PlannedOutcome.narrative` / `resolution.narrative` / `outcome?.narrative` / `ResolveCancelContext.plannedNarrative` returns nothing in src/ or scripts/.

**Dynamic — 10-tick e2e**:
- Run when user explicitly says so.
- Inspect `logs/role-agent-test-<ts>.json`:
  - Each `commits[i]` has a non-empty `stateChanges` array (currently always empty).
  - At least one entry has `kind: "memory.event"`.
  - `memoryWrites[]` contains entries whose `content` matches resolver-LLM phrasing (not the handcoded `[result] <actionText>` template).
  - Marsh's commit sequence does NOT include the same actionText 3 times in a row (current bug).
- Look for `Items in scene` line in any later renderer log: confirm name/description differs from initial JSON after item.modify.

**Manual cancel verification**:
- 10 ticks naturally produce 0 cancellations. To exercise cancel re-resolve,
  either (a) inject a synthetic high-impact FeatureEvent at tick 1 to force
  one NPC to switch, or (b) write a 5-line standalone test that submits a
  long action then `cancelAction`s it next tick.

**Implementation order** (suggested):
1. `dgsm.modifyItem` + `item.modify` schema extension + applier.
2. `flattenToStateChanges` + `resolveState` return type.
3. Resolver-caller closures simplified.
4. Controller `routeResolverMemories` + delete old `[result]` writes.
5. Drop `PlannedOutcome.narrative` everywhere.
6. JSON output enriched with `report.stateChanges`.
7. tsc + manual e2e + verification.
