# World Action Engine Staged Output Refactor Plan

> **For agentic workers:** Implement the tasks in order. Do not commit per task; preserve unrelated working-tree changes and commit only after the complete branch has passed review.

**Goal:** Replace the oversized, non-strict `submit_resolution` contract with six small, sequential, phase-specific submission tools. Every phase validates before its output becomes input to the next phase; the complete draft is still globally validated and atomically finalized before any world state is applied.

**Why:** The current six-array schema is valid application JSON Schema but Claude Sonnet 5 rejects `strict: true` before generation because the compiled grammar is too large. With `strict: false`, a live Grayhaven run also showed the model serializing the entire resolution into the `starting` field, after which normalization could recover only one domain. Smaller phase schemas restore strict tool use, give each phase narrower instructions, and make correction prompts local and actionable.

**Architecture:** Run one ordered World Action Engine pipeline:

```text
endings -> starts -> character changes -> item changes -> scene changes
        -> occurrences -> global validation -> atomic finalization/application
```

Each phase is a separate model session/request surface with only its own submit tool and relevant English rule modules. Accepted upstream outputs are injected into downstream context as read-only facts. Phase-local validation can retry only that phase. A final cross-domain error rewinds to the earliest implicated phase and reruns that phase plus every downstream phase. No partial draft reaches the Applier.

**Tech Stack:** TypeScript, Vitest, the existing `generateToolCalls` provider abstraction, JSON Schema tool definitions, Biome, pnpm.

---

## Fixed Design Decisions

1. **Quality-first, sequential execution.** Phases are not parallelized because later judgments depend on accepted earlier facts.
2. **Six submit tools.** The public wire tools are `submit_endings`, `submit_starts`, `submit_character_changes`, `submit_item_changes`, `submit_scene_changes`, and `submit_occurrences`.
3. **Strict by default.** Every phase schema has one required top-level array, requires all structurally necessary fields, uses `additionalProperties: false`, and sets `strict: true`. An empty domain is submitted as `[]`.
4. **Independent phase validation.** A phase result is retained only after its own validator accepts it. Rejected output never enters downstream prompts.
5. **One final global gate.** The assembled `RawTickResolution` must still pass `validateRawResolution`, then `finalizeResolution`; the existing atomic application boundary remains unchanged.
6. **Targeted rewind.** A final global error rewinds the earliest phase capable of fixing it and discards all accepted downstream results. At most one global rewind is allowed.
7. **Shared call budget.** The whole resolution has a hard ceiling of 12 provider calls, including tool lookup turns, strict-schema failures, local correction turns, and global-rewind reruns. Each phase allows at most three submission attempts. Budget exhaustion rejects the whole tick without application.
8. **Strict-schema fallback.** For a deterministic provider-side grammar/schema compilation rejection only, retry that phase once with an otherwise identical non-strict submit tool, emit a warning, and remember the downgrade in process by provider/model/schema fingerprint. Do not downgrade on transport errors, rate limits, malformed model output, or semantic validation failures.
9. **English prompt material.** All text injected into any engine prompt must be English. Operational documentation that is not prompt input may remain Chinese, but the loader/import graph must prove that separation.
10. **Compatibility.** Keep `resolveTick`, `WorldActionEngineResult`, the final `RawTickResolution`, `TickResolution`, and Applier interfaces stable. No persisted-state or database migration is introduced.

---

## Phase Contracts

### 1. Endings

Tool payload:

```ts
interface SubmitEndingsInput {
  endings: Array<
    | { actionId: string; mode: "outcome"; outcome: string }
    | { actionId: string; mode: "pure_speech" }
  >;
}
```

This intermediate contract deliberately requires one decision for every action in the ending worklist. `mode: "outcome"` becomes a final `RawActionEnd`; `mode: "pure_speech"` produces no final ending row but is retained as an upstream fact for the occurrence phase. The phase may use deterministic `damageRoll` before submitting. No model-authored damage roll is accepted.

Local validation:

- Every ending worklist id appears exactly once; no starting-only or unknown id appears.
- `outcome` is non-empty only for `mode: "outcome"`.
- `pure_speech` is legal only for an action whose command actually carries an utterance and whose resolution is only that speech.
- Action status, resolved check results, clock ownership, and damage-tool provenance remain code-owned.

### 2. Starts

Tool payload:

```ts
interface SubmitStartsInput {
  starting: RawActionStart[];
}
```

Local validation covers exact starting-worklist membership, uniqueness, duration rules, check legality, opposed checks, routes, vehicles, and `passBlockedConnectionId`. It receives accepted ending decisions so it cannot contradict actions resolved in the same tick.

### 3. Character changes

Tool payload:

```ts
interface SubmitCharacterChangesInput {
  characterChanges: RawCharacterChange[];
}
```

The existing seven character operations remain unchanged: `hp`, `fatigue`, `position`, `spot`, `setAppearance`, `addCondition`, and `removeCondition`. Validation covers source action ids, character/place references, operation-specific fields, and consistency with accepted endings and starts.

### 4. Item changes

Tool payload:

```ts
interface SubmitItemChangesInput {
  itemChanges: RawItemChange[];
}
```

The existing four item operations remain unchanged: `create`, `move`, `destroy`, and `set`. Validation covers source actions, holder/reference integrity, ownership and locality, same-tick id uniqueness, and conservation rules. Accepted item output becomes visible to the scene and occurrence phases.

### 5. Scene changes

Tool payload:

```ts
interface SubmitSceneChangesInput {
  sceneChanges: RawSceneChange[];
}
```

The existing eight scene operations remain unchanged: `addCondition`, `removeCondition`, `setDescription`, `connectionBlock`, `connectionDiscovered`, `connectionHidden`, `environmentContribute`, and `environmentHazard`.

Local validation also owns the earliest practical cross-domain checks:

- A `passBlockedConnectionId` means only this movement passes; it must not be paired with `connectionBlock: false` for the same passage unless the action actually removes the obstacle.
- Moving or destroying a cited item must include any required `setDescription` update that removes the stale citation.
- Connection and scene ids must resolve against the same graph shown to the model.

### 6. Occurrences

Tool payload:

```ts
interface SubmitOccurrencesInput {
  occurrences: RawOccurrence[];
}
```

This phase receives the complete accepted draft from all earlier phases. Validation covers ending traceability, pure-speech coverage, non-speech occurrence requirements, exact utterance handling, perceivers, targets, objective content, same-tick created-item references, and one sanity check per character across all occurrences.

---

## Error Ownership and Rewind Rules

Phase-local errors are returned only to that phase as addressed messages. A correction must resubmit the complete array for that phase; it is never a patch and never mutates the previous accepted draft.

After all six phases, assemble the existing shape:

```ts
interface RawTickResolution {
  starting: RawActionStart[];
  ending: RawActionEnd[];
  characterChanges: RawCharacterChange[];
  itemChanges: RawItemChange[];
  sceneChanges: RawSceneChange[];
  occurrences: RawOccurrence[];
}
```

Map global validation errors to the earliest rerun point:

| Error target/domain | Rewind phase |
|---|---|
| Whole resolution, ending action, damage provenance | Endings |
| Starting action, timing, check, movement | Starts |
| Character change | Character changes |
| Item change or item lifecycle | Item changes |
| Scene/connection/environment change | Scene changes |
| Occurrence, speech, perception, sanity | Occurrences |

When rewinding, clear the selected phase and every downstream phase, preserve only earlier accepted outputs, add the global errors to the selected phase prompt, and rerun forward. If the rebuilt draft still fails global validation, or the one-rewind/call budget is exhausted, return the existing unusable result and apply nothing.

---

## Prompt and Context Boundaries

Each phase builds a fresh, narrow system prompt from English-only rule modules:

- Endings: root causality/action adjudication, applicable skill guidance, resolved dice, and deterministic damage-tool instructions.
- Starts: action adjudication, movement and position, declared-skill guidance, and engine-owned clock/check rules.
- Character changes: character-change rules plus accepted action facts.
- Item changes: item-change and conservation rules plus accepted action/character facts.
- Scene changes: scene/connection rules plus accepted starts and item changes.
- Occurrences: perception, dialogue, occurrence, and sanity rules plus the complete accepted upstream draft.

The stable world context may initially be reused in every phase for output quality and prompt-cache compatibility. Context pruning is a later optimization and must not be mixed into this correctness refactor.

Audit every `readFileSync`, rule-module list, prompt concatenation, and rendered instruction source reachable from the six phase prompts. Convert any reachable Chinese instruction text to English. Correct stale comments or tests that still claim the unified `submit_resolution` schema is strict.

---

## File Structure

### Create

- `src/engine/resolution/worldResolutionStageSchemas.ts` — six strict tool schemas, ending-decision type, schema fingerprints, and non-strict fallback copies.
- `src/engine/resolution/worldResolutionStageValidator.ts` — phase-local validators, accepted-draft type, phase/error ownership mapping, and final assembly.
- `src/engine/resolution/worldResolutionStagePrompts.ts` — phase rule selection and English prompt/context rendering.
- `src/engine/resolution/__tests__/worldResolutionStageSchemas.test.ts`
- `src/engine/resolution/__tests__/worldResolutionStageValidator.test.ts`
- `src/engine/resolution/__tests__/worldResolutionStagePrompts.test.ts`

### Modify

- `src/engine/resolution/worldActionEngine.ts` — replace the monolithic agent loop with the ordered phase runner, shared budget, local corrections, strict fallback, global rewind, and unchanged final return contract.
- `src/engine/resolution/worldDeltaSchema.ts` — keep final raw domain schemas/types reusable by the phase schemas; remove the runtime `submit_resolution` tool export after callers/tests migrate.
- `src/engine/resolution/worldDeltaValidator.ts` — expose/reuse domain validation helpers where appropriate; retain `validateRawResolution` and `finalizeResolution` as the final authority; repair stale strict-mode comments.
- `src/engine/resolution/types.ts` — add internal phase/draft/result types only if they are shared; do not change public result semantics.
- `src/engine/resolution/__tests__/worldActionEngine.test.ts` — replace unified submission/correction tests with staged execution, correction, budget, rewind, and atomic-failure tests.
- `src/engine/resolution/__tests__/schemaAgreement.test.ts` — assert phase schemas agree with domain types and remain strict-compatible.
- `src/engine/resolution/__tests__/worldDeltaValidator.test.ts` — retain final cross-domain coverage and fix stale assumptions about unified strictness.
- `src/models/providers/__tests__/toolSchemas.test.ts` — assert strict is forwarded for each phase and disabled only by the narrow fallback path.
- `src/engine/rules/session-protocol.md` and relevant `src/engine/rules/world/*.md` — replace unified-submit instructions with phase-specific English contracts without duplicating validator logic.
- `docs/engine-operations.md`, `CLAUDE.md`, and `README.md` — document the six-phase flow, validation boundary, call budget, fallback warning, and atomic failure behavior.

Do not remove the final domain types merely because their fields are submitted separately; they are still the internal assembly and validation boundary.

---

## Implementation Tasks

### Task 1: Extract reusable schemas and define the six tools

- [ ] Extract each domain array schema from `submitResolutionTool` without changing its accepted element shape.
- [ ] Add the explicit ending-decision schema with discriminated `mode` branches.
- [ ] Define six required-array, `additionalProperties: false`, `strict: true` tools.
- [ ] Generate stable schema fingerprints from provider name, model id, tool name, and canonical schema content; do not use process-random hashes.
- [ ] Delete the production dependency on `submit_resolution` only after all phase callers are wired.
- [ ] Add schema-agreement tests for required fields, optional-count limits, operation unions, and strict flags.

### Task 2: Split validation without weakening the global validator

- [ ] Introduce an in-memory `AcceptedResolutionDraft` that distinguishes ending decisions from final ending rows.
- [ ] Extract or wrap domain-specific checks so every phase validates immediately.
- [ ] Ensure local validators receive only the world context and accepted upstream facts they need.
- [ ] Assemble the exact existing `RawTickResolution`; convert `pure_speech` decisions to occurrence obligations rather than final ending rows.
- [ ] Keep all cross-domain checks in `validateRawResolution`, even when an earlier phase also checks them for faster feedback.
- [ ] Add deterministic mapping from every `ResolutionError.target` variant to a rewind phase.

### Task 3: Build phase-specific English prompts

- [ ] Split the current monolithic `SYSTEM_PROMPT` and opening instruction into phase renderers.
- [ ] Supply only the current submit tool; the endings phase may additionally receive `damageRoll`.
- [ ] Render accepted upstream arrays as read-only JSON and explicitly forbid revising them in a downstream phase.
- [ ] Make correction text demand a complete replacement for the current phase array.
- [ ] Audit all injected Markdown and fallback strings for English-only content.
- [ ] Add prompt snapshot/substring tests that detect obsolete `submit_resolution` and `repair_resolution` instructions.

### Task 4: Replace the monolithic loop with a staged runner

- [ ] Implement the fixed phase order and retain accepted output only after local validation succeeds.
- [ ] Count every `generateToolCalls` invocation against the shared ceiling of 12.
- [ ] Permit at most three complete submission attempts per phase.
- [ ] Keep deterministic damage invocations tied to the ending phase and preserve invocation records across correction turns.
- [ ] Reject unexpected, duplicate, mixed, empty, or unreadable tool submissions with addressed phase-local feedback when budget remains.
- [ ] After six accepted phases, run global validation and finalization exactly once for the current draft.
- [ ] On the first global failure, rewind to the earliest implicated phase and rerun downstream; on a second failure, reject atomically.
- [ ] Preserve the current `resolveTick` success and `unusable(...)` return shapes.

### Task 5: Add deterministic strict-schema fallback

- [ ] Classify only known provider grammar/schema compilation errors, preserving the original error text for logs.
- [ ] On the first classified error for a fingerprint, warn and make one non-strict retry for that same phase.
- [ ] Cache that downgrade for the rest of the process so later ticks do not repeat a request known to be un-compilable.
- [ ] Continue to run normal local validation on non-strict output; fallback changes structure enforcement, never semantics.
- [ ] Do not retry/downgrade generic HTTP 400s, authentication failures, rate limits, timeouts, or provider outages.
- [ ] Unit-test strict success, classified downgrade, cached downgrade, fallback validation failure, and unrelated-error rejection.

### Task 6: Update documentation and remove stale contracts

- [ ] Document the six phases, their exact order, correction scope, 12-call ceiling, and one-rewind rule.
- [ ] State clearly that no phase mutates DGSM and that only the globally valid finalized result reaches the Applier.
- [ ] Remove references to the deleted repair protocol and unified terminal tool.
- [ ] Fix comments/tests claiming `submit_resolution` is strict or can safely be made strict as-is.
- [ ] Verify that `docs/engine-operations.md` is not prompt-injected; if any portion is injected, translate that portion to English or move it into an English rule module.

### Task 7: Verification and final review

- [ ] Run targeted schema, validator, provider, and World Action Engine tests.
- [ ] Run `pnpm build:tsc`.
- [ ] Run `pnpm check` and inspect any formatter changes so unrelated files are not rewritten accidentally.
- [ ] Run the complete Vitest suite.
- [ ] Run a 10-tick Grayhaven simulation with Claude using the same fixture/model configuration as the failed strict-schema trial.
- [ ] Confirm no compiled-grammar rejection occurs for the six strict phase tools; if fallback fires, record the exact phase, provider/model, fingerprint, and warning.
- [ ] Inspect all 10 tick traces for phase coverage, correction count, malformed argument recovery, cross-phase contradictions, global rewinds, and atomic failure.
- [ ] Compare call count, latency, token use, accepted ticks, and validator errors against the saved unified-schema run.
- [ ] Perform a final whole-branch review focused on contract drift among schemas, prompts, validators, finalization, and provider adapters.

---

## Required Test Matrix

1. **Happy path:** all six phases accept on the first submission and assemble the same final resolution shape as today.
2. **Empty domains:** every phase submits its required empty array successfully.
3. **Pure speech:** endings records `pure_speech`; occurrences supplies the exact speech row; final `ending` omits that action.
4. **Physical ending:** ending outcome requires a non-speech occurrence and fails globally if absent.
5. **Local correction:** one malformed item operation reruns only the item phase, then continues with scene and occurrences.
6. **Downstream visibility:** scene validation sees accepted item changes; occurrence validation sees all accepted upstream changes.
7. **Pass versus unblock:** `passBlockedConnectionId` permits one traversal without opening the edge; actual obstacle removal uses `connectionBlock: false`.
8. **Global rewind:** a cross-domain stale item citation rewinds item changes and reruns item, scene, and occurrences only.
9. **Second global failure:** returns unusable and applies no changes.
10. **Per-phase cap:** the fourth attempted submission is never requested.
11. **Shared cap:** the thirteenth provider call is never made, including damage-tool and fallback calls.
12. **Strict fallback:** only a recognized compiled-grammar/schema error triggers one warned non-strict retry and fingerprint cache.
13. **Provider outage:** no strict downgrade; the whole tick fails through the existing model-error path.
14. **Atomicity:** neither locally accepted phases nor a globally rejected assembled draft changes DGSM, movement runtime, action state, or persisted state.
15. **Prompt language:** every injected instruction source is English and names only the current phase tool.

---

## Definition of Done

- Claude accepts each phase's strict schema in the Grayhaven run, or the narrow fallback activates once with an explicit diagnostic and validated non-strict output.
- The final resolution and all downstream public/runtime contracts remain compatible.
- Every phase has immediate independent validation, while the final validator still enforces the complete cross-domain contract.
- No invalid or partial phase output can reach world state.
- All injected engine instructions are English and agree with the schemas and validators.
- Targeted tests, TypeScript build, Biome, full test suite, 10-tick Grayhaven run, and final branch review all pass.
