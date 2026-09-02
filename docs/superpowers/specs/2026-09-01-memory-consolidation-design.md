# Memory consolidation — the character condenses their own memories

Date: 2026-09-01
Status: implemented (uncommitted)

## Problem

`## What you remember` is injected whole on every decision and has no ceiling.
`writeMemory` is capped at 3 calls per decision, `DecayEngine` only scores and
never deletes, and the only deletions are the character's own `op: "delete"`
and the rollback path. The one guard is `loadAllMemories`'s `take: 2000`,
which silently drops the OLDEST rows once it bites — the character loses their
earliest map and relationship memories without ever being told.

A long-running character who mostly `add`s therefore grows a memory block
without bound, until the 2000-row cut or the context window, with nothing in
between.

## Principle

Same as `perceptionCompactor`: what is worth keeping is a judgement, and the
codebase gives that judgement to the person whose memories they are. No
curator, no importance-sorted pruning. The character is handed their own
prompt and asked to bring their memories down to something they can carry.

Unlike the perception stream, memories cannot be replaced by one paragraph:
each row has a handle the character cites, a type, and (for `relationship`)
a side effect on `npcRelationshipGraph`. So the consolidation's output is a
batch of `writeMemory` operations, applied through the existing dispatcher,
not free text.

## Design

### New module: `src/roleSim/memoryConsolidator.ts`

Mirrors `perceptionCompactor.ts` in shape and constants.

| Constant | Value | Mirrors |
|---|---|---|
| `MEMORY_BUDGET_TOKENS` | 80_000 | `PERCEPTION_BUDGET_TOKENS` |
| `MEMORY_TARGET_TOKENS` | 50_000 — asked for in the prompt, not enforced | `SUMMARY_TARGET_TOKENS` |
| `KEEP_RECENT_MEMORIES` | 20 — newest rows by `gameDateTime`, not offered for folding | `KEEP_RECENT` |
| `CONSOLIDATION_WRITE_CAP` | 80 — `writeMemory` cap for this one call | `TOOL_CAPS.writeMemory` (3) |

Exports:

- `memoryBlockTokens(rows)` — `estimateTokens` over the block exactly as
  `formatMemories` renders it (render, then measure; the formatter is cheap).
- `needsConsolidation(rows)` — `rows.length > KEEP_RECENT_MEMORIES && memoryBlockTokens(rows) > MEMORY_BUDGET_TOKENS`.
- `consolidateMemories({ ctx, dgsm, memory, sessionId, moduleId, language })`
  → `ConsolidationResult | null`.

### The call

1. Build segments with `buildUserPromptSegments(ctx, { closing: { kind: "consolidate", protectedFrom, targetTokens } })` — the character's own decision prompt, byte-identical up to the closing so the cached prefix is reused.
2. `generateToolCalls` with `tools: [writeMemoryTool]`, `toolChoice: "any"`, `allowParallelCalls: true`, `modelClass: MEDIUM`, `operation: "memory-consolidate"`. No `act`, no `continue`: this is not a decision and consumes no tick.
3. Every returned call goes through `dispatchInstantTool("writeMemory", input, caps, deps)` with `caps = { writeMemory: CONSOLIDATION_WRITE_CAP }` and `deps.shownMemories = ctx.memories`. The dispatcher already enforces: `ref` resolves only against what was shown; `relationship` requires `targetId` and updates the graph; relationship rows are re-framed the same way as in a decision.
4. Results are **incremental**. A call whose dispatch returns an `Error:` line is logged and skipped; every other call is applied. There is no rollback and no all-or-nothing — the same posture as the decision loop, where a bad `writeMemory` fails alone.
5. Returns `{ applied, skipped, errors }` counts. Returns `null` when the model call throws or returns zero tool calls; the caller keeps the long block and the attempt repeats next decision.

One call per decision. If the block is still over budget afterwards, nothing
more happens this decision; the next decision triggers again. Chosen over an
in-call loop for the same reason perception compaction is one call: simpler,
and a partial pass is still progress.

### The closing instruction (`userPromptBuilder.ts`)

Add `{ kind: "consolidate"; protectedFrom: string; targetTokens: number }`
to `closing`. The text, in the voice of the existing `compact` closing:

- Your memories have grown too long to carry whole. Bring them down to about
  `targetTokens` tokens using `writeMemory`: `replace` to merge several lines
  about one thing into one, `delete` for what no longer matters, `add` only
  for a merged line that replaces several deleted ones.
- Lines stamped after `protectedFrom` are what you are in the middle of —
  leave them alone.
- Guidance by type: one `relationship` line per person, written as you now see
  them; `plan`s that are done or overtaken get deleted; `map` lines may be
  merged by area but **never lose a place name — a place you no longer have a
  line for is a place you no longer know**; `secret`s are not merged with
  anything else; the newest `long_term_intent` stays.
- `ref` is the `#M…` handle at the head of the line, exactly as shown. Never
  cite a handle you did not read.
- Make every call in this one turn. Write content in `${langName}`.

`protectedFrom` is the stamp of the `KEEP_RECENT_MEMORIES`-th newest row,
rendered with `formatForPrompt` so it matches what the character reads.

### Controller hook (`npcActionController.ts`)

In `buildContext`, next to `compactIfOverBudget`:

```
if (needsConsolidation(memories)) {
  const result = await consolidateMemories(...baseCtx...);
  if (result) memories = await this.loadAllMemories(npcId);   // decision reads the consolidated block
}
```

Ordered before `recordPerception` for the same reason as perception
compaction. After a successful consolidation the memories are reloaded so the
decision's prompt — and its `shownMemories` — reflect the rows that now exist;
otherwise the decision could `replace` a handle that was just deleted.

The decision prompt's cached prefix is invalidated by a consolidation. This is
rare by construction (the trigger is a ceiling, not a working size) and is
the same cost the perception compactor pays.

### Dispatcher (`toolDispatcher.ts`)

No behavioural change. `dispatchInstantTool` already takes `caps` per call,
so the consolidator passes its own map. The error-string convention
(`result` starting with `Error:`) is what the consolidator reads to count
skips; make that an exported predicate `isDispatchError(result)` rather than
re-stringly-typing it.

### Persistence

None new. Every operation lands in `npc_memories` through `NpcMemoryManager`
as it does during a decision. There is no `onMemoryConsolidated` hook: the
store is the source of truth and the next `loadAllMemories` reads it.

### Failure modes

| Case | Behaviour |
|---|---|
| Model call throws / no tool calls | `null`; long block kept; retry next decision |
| A call cites an unknown handle | that call skipped, logged; rest applied |
| A call is malformed (missing type/content/targetId) | same |
| Block still over budget after the pass | nothing more this decision; triggers again next |
| Model exceeds `CONSOLIDATION_WRITE_CAP` | excess calls rejected by the cap, logged |

### Out of scope

- The 2000-row `take` in `loadAllMemories` stays as the runaway guard.
- No change to the per-decision cap of 3.
- No change to `DecayEngine`; it still only scores.
- No summariser-side prompt; the character does it.

## Testing

- `memoryConsolidator.test.ts`: `needsConsolidation` thresholds (under
  budget, over budget but ≤ keep-window, over both); `consolidateMemories`
  with a stubbed `generateToolCalls` — applies valid calls, skips a call
  with a bad `ref` while applying the others, returns `null` on throw, counts
  match; `protectedFrom` is the stamp of the right row.
- `userPromptBuilder.test.ts`: `consolidate` closing renders the stamp and
  target, and the rest of the prompt is byte-identical to the `decide` one.
- `toolDispatcher.test.ts`: `isDispatchError`.
- `npcActionController` integration: over-budget character gets one
  consolidation call and the decision reads the reloaded memories.
