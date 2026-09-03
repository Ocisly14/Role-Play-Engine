# Flat resolution shape — the Engine's submission stops nesting

Date: 2026-09-02
Status: design, implementing

## Problem

`submit_resolution` is the one tool call the World Action Engine makes per
tick, and on DeepSeek it arrives unreadable often enough to matter. Two
30-tick runs of the tlou2 module produced 11 broken argument strings; every
one is the same defect, read from the bytes saved under `broken-args-*.txt`:

- The break sits right after an `ending` entry's `occurrence` object closes.
  The model writes `}}` where `}` was due — closing the entry along with the
  occurrence — and then keeps writing the entry's remaining fields
  (`replacedBy`, `outcome`, `resolvedDurationTicks`) or the next entry's
  `actionId` with no `{` before it. Deleting the surplus `}` makes 10 of the
  11 parse; the eleventh lost a brace the other way.
- Once the model slips it tends to slip again: five payloads carry one
  slip, five carry two or three.
- The failure is load-dependent. Grouping every engine call by how many
  `ending` entries it carried: 0–1 entries never broke, 2 broke 7% of the
  time, 4–5 broke 31%, 6 and above broke 100%. run 8 had more multi-ending
  ticks than run 7 (17 vs 13 calls with four or more) and four times the
  breaks (8 vs 1).
- Not truncation (`finish_reason: length` never fired), not transport (one
  non-streaming POST), not a regression (run 7 predates every change made
  since).

Each unreadable submission costs a repair round — the whole request again,
around 25k prompt tokens — and the repair round carries the same odds: two
of the eleven breaks were `repair_resolution` calls. The harness's
repeat-error guard then stops the run on the third identical signature.

## Evidence on what shape a model writes reliably

- Depth is the hardest limit. DeepJSONEval grades 3–4 levels as medium and
  5–7 as hard; strict-score drops of 17–38% from medium to hard, nested
  lists inside lists at 0.58–0.72 accuracy against 0.90–1.00 for flat lists.
  JSONSchemaBench: 86–96% coverage on simple function signatures, 13–41% on
  complex real-world schemas.
- Long arrays of objects are the next hazard; structural errors are
  unbalanced brackets and misplaced nesting — the exact defect above.
- Field order matters because generation is left-to-right: the model must
  never have to "climb back" from a deep object to write a scalar sibling.
- Changing notation does not help: JSON stays the most reliable output
  format for nested data; YAML/TOON win only on flat tables.
- Vendor guidance converges on flat, few, short: Anthropic's tool-writing
  guide prefers flat over nested; OpenAI's asks for enums and structure that
  make invalid states unrepresentable and few functions per turn.

Measured against that, the current tool schema is on the wrong side of
every line:

| Metric | `submit_resolution` today | comfortable band |
|---|---|---|
| max nesting (property/items descents) | 8 | 3–4 |
| properties, total | 144 | < 50 |
| schema size | 22 KB | as small as it can be |
| one `ending` entry | 6 levels deep, 29 properties | scalars |
| deepest object's position in the entry | `occurrence`, followed by three scalar siblings | deepest last |
| constrained decoding | none (DeepSeek `strict` is beta and not used) | on |

## Principle

The Engine says *what happened*; code says *when* and *whether it is over*.
That split does not change. What changes is only the container the Engine
hands back: every object the model writes should be a bag of scalars and
string arrays, with at most one array of such objects inside it, placed
last. An action's trace stays mandatory — but "mandatory" becomes a check
the validator makes (every ended action is cited by an occurrence), not a
nested slot the model has to close correctly.

Downstream nothing moves: `finalizeResolution` keeps emitting the same
`Occurrence` rows (`src/engine/actions/types.ts`), so the orchestrator, the
controller and the renderer are untouched.

## Design

### Target shape

Top-level keys, in this order: `starting`, `ending`, `characterChanges`,
`sceneChanges`, `itemChanges`, `occurrences`. The deepest list is last.

**`starting[]`** — unchanged: `{ actionId, resolvedDurationTicks,
timingReason?, check?, opposedBy?, movement? }`.

**`ending[]`** — scalars only, longest string last:

```
{ actionId, replacedBy?, outcome?, reason }
```

`occurrence` leaves the entry. `resolvedDurationTicks` and `timingReason`
leave the entry: an ending's clock is the duration set at its start, and
`finalizeResolution` already falls back to the known one; a "revised
duration with no result block" could not be sent through `ending` anyway,
since `reason` is required there. The prose that still describes that path
is removed (below).

**`occurrences[]`** — one flat row per moment, `facts` last:

```
{
  actionIds: string[],            // which actions this is the trace of (≥1)
  locationId?: string,
  actorId?: string,               // was participants[role=actor]
  targetIds?: string[],           // was participants[role=target]
  affectedIds?: string[],         // was participants[role=directly_affected]
  perceiverCharacterIds: string[],
  signals?: [{ factIndexes?: number[], channel, originLocationId?, intensity? }],
  sanityChecks?: [{ characterId, failureLoss, consequence?: { description, durationMinutes } }],
  facts: [{ type, content, refIds?: string[] }]
}
```

- `participants` (an array of `{characterId, role}` objects) becomes three
  scalar/string-array fields. `finalizeResolution` rebuilds the
  `participants` rows the finalized type carries.
- `entityRefs` (an array of `{kind, id}` objects) becomes `refIds`, bare ids.
  Id spaces do not overlap (`npc_*`, `item.*`, `SCN_*`/`ROAD_*`, connection
  ids), so the validator resolves each id against the lookup in a fixed
  order — character, item/vehicle/created item, connection, place — and
  `finalizeResolution` writes the resolved `kind` into the finalized
  `entityRefs`. An id no space knows is the same error as today:
  `facts[i]: ref "x" does not exist`.
- `sourceActionIds` is renamed `actionIds`; it is what ties a trace to its
  action now that the entry no longer holds it.
- `signals` and `sanityChecks` keep their shape (they are rare and already
  flat) and sit before `facts` so the entry's last property is its only
  object array.

Depth after the change, counted the same way as the table above: 6 for the
`occurrences` path and the `characterChanges` path, no path deeper; the
innermost container of the hot path is a string array. The ending entry
has four properties.

### Validation

`worldDeltaValidator.ts`:

- `validateEnd` no longer reads `entry.occurrence`, `resolvedDurationTicks`
  or `timingReason`. The speech-only test (`isSpeechOnly`) reads the facts
  of every occurrence that cites the action; all `speech` → no `outcome`,
  as today.
- New whole-resolution check: **every `ending` actionId must appear in the
  `actionIds` of at least one occurrence.** Error text, addressed at the
  action: `no occurrence cites this ending — the actor perceives nothing,
  concludes nothing happened, and re-issues the same action next minute.
  Add an entry to \`occurrences\` with this actionId in its \`actionIds\`.`
  This is the guarantee the nested slot used to give.
- `validateOccurrence` reads the flat fields: `actionIds` (non-empty, every
  id a known action), `actorId`/`targetIds`/`affectedIds` (known characters),
  `perceiverCharacterIds`, `refIds` per fact (resolved as above), `signals`
  index bounds, `sanityChecks` as before (with `actionIds` in place of
  `sourceActionIds`).
- One-shock-per-character runs over `occurrences` only.
- `normalizeList` handles the six lists as before; `participants` and
  `entityRefs` tolerance goes away with the fields.

### Finalization

- The fold disappears: occurrences are already standalone. Occurrence ids
  stay `occ_<tickId>_<i>` over list order.
- **The spoken line.** Today the utterance is prepended to the ending's own
  occurrence. Now it is prepended to the **first occurrence, in list order,
  that cites the action** — that entry's perceivers are the people who made
  out the words. The rule text says so (below). An ended action whose
  command carried an utterance and which no occurrence cites is already an
  error by the check above.
- `participants` rebuilt from `actorId`/`targetIds`/`affectedIds`;
  `entityRefs` rebuilt from `refIds` with the resolved kind; `signals`
  mapped from `factIndexes` to fact ids as today.
- Ending transitions use the known `resolvedDurationTicks` only.

### Repair

`repair_resolution` keeps its addressing: `starting`/`ending` by
`actionId`, the other four lists by `index`, `remove: true` withdraws. An
ending repair now re-sends four scalars; an occurrence repair re-sends one
flat row. The strict-subset comment in the schema (optional counts) is
updated to the new totals.

### Rule text

`src/engine/rules/world-action-resolution.md`:

- **One occurrence, one audience**: the two-column example becomes two
  `occurrences` entries with the same `actionIds`; "the ending's own
  occurrence is where the actor's words live" becomes "the first occurrence
  citing the action is where the actor's words live — its perceivers are
  exactly the people who made out what was said".
- **Talk is delivered**: "into the ending's occurrence" → "into the first
  occurrence that cites the action".
- The `occurrence` bullet under `ending` becomes: "`occurrences` — every
  ending MUST be cited by at least one entry there (`actionIds`). Without
  one the actor perceives nothing … List the actor among its
  `perceiverCharacterIds`."
- Under **Nothing else**, the sentence "To change how long it will take,
  send a revised `resolvedDurationTicks` and no result block" is removed;
  the Output rules bullet loses "a revised duration changes when it will
  end".
- A short **Shape** note near the top of the ending section: an ending is
  four scalars; the trace goes in `occurrences`; write `facts` last.

`src/engine/rules/session-protocol.md`: the resolvedDurationTicks bullet
loses "and again only if you revise the estimate"; the repair bullet is
unchanged.

`worldActionEngine.ts` trigger note: "carried into its occurrence verbatim"
→ "carried verbatim into the first occurrence that cites the action".

Schema descriptions (`worldDeltaSchema.ts`) are rewritten alongside: the
ending description no longer claims the trace lives there; the
`occurrences` description says every ending is cited here and that `facts`
is written last.

### Types

`RawActionEnd` → `{ actionId, replacedBy?, outcome?, reason }`.
`RawOccurrence` → the flat row above (`actionIds`, `actorId?`, `targetIds?`,
`affectedIds?`, `refIds` on facts). `OCCURRENCE_BODY` is no longer shared
between two placements; it becomes the single `occurrences` item schema.

## Out of scope, deliberately

Each of these is a separate experiment and is not part of this change:

- DeepSeek `strict` mode (beta endpoint; needs all-required +
  `additionalProperties: false` + no `minItems`; one reported bug).
- Splitting a large resolution across several tool calls
  (`parallel_tool_calls`).
- Local brace-balance repair in `jsonParse.ts` for mid-document slips.
- Trying `deepseek-v4-pro` instead of the `deepseek-chat` alias.

## Implementation order

1. `worldDeltaSchema.ts` — types, `submitResolutionTool`, repair derivation,
   strict-subset comment.
2. `worldDeltaValidator.ts` — `validateEnd`, `validateOccurrence`, the
   cited-ending check, `isSpeechOnly` over citing occurrences,
   `withSpokenWords` on the first citing occurrence, participants/refIds
   rebuild in `finalizeResolution`, `normalizeList`, `applyRepair` untouched
   in logic.
3. Rule docs and the trigger note.
4. Tests: `schemaAgreement.test.ts` field lists; `worldDeltaValidator.test.ts`
   builders (`occurrence()`, `end()`) and the tests that pin the nested
   placement; `worldDeltaValidatorPlaces.test.ts` fixtures;
   `worldActionEngine.test.ts` literals; `tickOrchestrator.test.ts`
   `stubResolve`; `sanityConsequence.integration.test.ts` fixture; a new test
   for "ending not cited" and one for "utterance lands on the first citing
   occurrence".
5. `pnpm exec vitest run src/engine`, `pnpm check`, `tsc --noEmit`.

## Testing

- Unit: the validator suite as adjusted, plus the two new cases.
- Agreement: `schemaAgreement.test.ts` keeps the schema and the types
  honest by name.
- Live: a fresh 30-tick tlou2 run on DeepSeek, comparing broken-argument
  count per engine call against runs 7 and 8 (2/57 and 9/59). The
  expectation is a visible drop, not zero: the model still writes free
  JSON. Any residual break should no longer sit at an `occurrence` boundary.
