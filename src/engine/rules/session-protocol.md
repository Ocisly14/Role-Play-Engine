# Session Protocol

This document governs how to use the Engine tools and submit one complete tick
resolution. Domain judgement belongs to the world-rule modules; this protocol
defines the envelope, worklist coverage and repair behavior.

## Read the request; do not look it up again

The request is the world; there is nothing to look up again. The World Graph gives the
place topology, Detailed Places gives the involved places, and Items gives the
relevant scene contents and inventories.

The only lookup tool is `damageRoll`, because a roll must never be invented by
the model. Pathfinding, movement time, inventory validation and SAN rolls are
not tool calls:

- code validates and advances the actor-stated route;
- code derives travel time;
- the request already contains the relevant items;
- SAN checks are declared on occurrences and rolled after submission.

## Turn and tool discipline

A turn is expensive: the whole request is resent every turn, so each
unnecessary turn is expensive.

- Your budget is {{MAX_ITERATIONS}} turns in all.
- Most ticks need no lookup: the first and only call is
  `submit_resolution`.
- When damage is actually dealt, issue every required `damageRoll` call in the
  same turn. Never spend one turn per roll.
- Never call `damageRoll` with a placeholder or zero formula.
- Finish with exactly one `submit_resolution` call, alone in its turn. Do not
  send two submissions or mix the submission with damage calls.
- `repair_resolution` is valid only after a submission has been rejected.

If the turn budget expires without a valid submission, nothing from this
session is applied.

## Answer the worklist

The trigger's `resolve` object is authoritative.

### Starting

Every id under `starting` must appear exactly once in `starting`. It cannot
also appear in `ending` or be answered by an occurrence alone.

A starting entry establishes duration, movement and any check permitted by the
schema. Nothing starts and ends in the same minute. An id under
`startingWithoutSkill` must not carry a check.

### Ending

Every id under `ending` must be answered exactly one of two ways:

1. **A non-speech result:** write one `ending` entry containing `actionId` and
   an objective `outcome` paragraph. At least one occurrence with
   `speech:false` must cite that action id.
2. **Pure speech:** write no `ending` entry. Write one `speech:true` occurrence
   citing the action. The command must carry an `utterance`; code attaches its
   exact words.

`endingWithUtterance` identifies ending actions whose commands contain spoken
words. It does not automatically make an action pure speech. If the action both
speaks and does something physical, emit two occurrences—one `speech:true` for
the words and one `speech:false` for the physical event—and provide the normal
ending outcome.

An id under `replaced` stops this minute because its actor issued a successor
command. Account only for what was completed before the interruption. Do not
emit a replacement marker; code already owns that relationship.

### Still running

Ids under `stillRunning` need no entry and no occurrence merely to say they
continue. Silence leaves them active.

## Submission content

The submission may contain `starting`, `ending`, `characterChanges`,
`sceneChanges`, `itemChanges` and `occurrences`. Omit empty groups when there
is nothing to say.

- Do not emit lifecycle status, progress, elapsed time or `nextWakeAt`.
- `resolvedDurationTicks` belongs only on a non-movement starting action.
  Movement time comes from code.
- Every persistent change names its `sourceActionId` and the applicable domain
  id. Emit only state that actually changed.
- Outcomes and occurrence content are objective, third-person and final. They
  contain no working, corrections or character-perspective interpretation.

Each occurrence has non-empty `actionIds`, a boolean `speech`, non-empty
`perceivers` — each entry `{characterId, clarity}` with `clarity` one of
`full` | `limited` | `trace` — and `content` when `speech:false`. A speech
occurrence also supplies `targetIds`; an empty list means the room was
addressed. When audiences receive different FACTS, send separate rows;
different degrees of one fact are ONE row graded per perceiver, as required by
`world/perception.md`.

Do not output occurrence locations, actors, signals, fact arrays, fact types,
reference-id arrays or affected-character arrays. Code derives what remains
from the cited actions and converts each occurrence into the downstream shape.

## Incremental repair

After rejection, call `repair_resolution` with only the elements named by the
errors. Everything not mentioned remains exactly as submitted.

- A starting or ending repair is addressed by `actionId` and replaces every
  copy of that action in the action lists.
- An occurrence repair is addressed by its non-empty `actionIds`. It replaces
  every existing occurrence that cites any of those ids, so resend the whole
  corrected occurrence rather than only the faulty field.
- A character, scene or item change is addressed by the `index` reported in
  the error.
- `remove:true` withdraws the addressed element when it should not have been
  submitted. Do not use removal to evade an action the worklist requires you
  to answer.
- Do not resend correct parts or the full resolution.
