# Session Protocol

This document governs how to use the Engine tools and submit one complete tick
resolution. Domain judgement belongs to the world-rule modules; this protocol
defines the envelope, worklist coverage and what a rejection asks for.

One resolution is submitted as **two calls in one turn**:

- `submit_actions` carries `starting` and `ending` — the action lifecycle.
- `submit_effects` carries `occurrences`, `characterChanges`, `sceneChanges`
  and `itemChanges` — everything those actions produced.

They are one submission. Code merges them before anything is validated, and
validates the result whole. A turn that calls only one of them has the other's
lists read as empty, which is correct only when there was genuinely nothing to
put in them.

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
- Most ticks need no lookup: the first and only turn is `submit_actions` and
  `submit_effects`, called together.
- When damage is actually dealt, issue every required `damageRoll` call in the
  same turn. Never spend one turn per roll.
- Never call `damageRoll` with a placeholder or zero formula.
- Finish with one submission turn: `submit_actions` once and `submit_effects`
  once, and nothing else in that turn. Do not call either tool twice, and do
  not mix the submission with damage calls.
- After a rejection, the only valid turn is another complete submission —
  both tools again, with the whole resolution.

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

A starting entry needs no occurrence: nothing has come of the action yet. A
`speech:false` occurrence MAY cite it when the attempt itself is visible as it
begins — the pick going into the lock, a hand reaching for the door — so that
bystanders perceive the attempt; its result belongs to the tick it ends. If
the command carries an `utterance`, the words are not spoken yet: code clocks
the action at one minute and it returns under `endingWithUtterance` next tick,
which is when its speech row is written. `startingWithUtterance` lists these
ids; no `speech:true` row may cite them.

### Ending

Every id under `ending` must be answered exactly one of two ways:

1. **A non-speech result:** write one `ending` entry containing `actionId` and
   an objective `outcome` paragraph. At least one occurrence with
   `speech:false` must cite that action id — a speech row is not the trace of
   an ending, and an entry cited only by speech rows is rejected.
2. **Pure speech:** write no `ending` entry. Write one `speech:true` occurrence
   citing the action. The command must carry an `utterance`; code attaches its
   exact words. An `ending` entry beside it is rejected.

`endingWithUtterance` identifies ending actions whose commands contain spoken
words — the only ids a `speech:true` occurrence may cite. It does not
automatically make an action pure speech. If an action that both speaks and
does something physical ends this tick, emit two occurrences—one `speech:true`
for the words and one `speech:false` for the physical event—and provide the
normal ending outcome.

An id under `replaced` stops this minute because its actor issued a successor
command. Account only for what was completed before the interruption. Do not
emit a replacement marker; code already owns that relationship.

### Still running

Ids under `stillRunning` need no entry and no occurrence merely to say they
continue. Silence leaves them active.

## Submission content

The submission always carries all six arrays across the two calls —
`starting` and `ending` in `submit_actions`; `occurrences`,
`characterChanges`, `sceneChanges` and `itemChanges` in `submit_effects`. A
group with nothing to say is an empty array `[]`, never omitted.

- Do not emit lifecycle status, progress, elapsed time or `nextWakeAt`.
- `resolvedDurationTicks` belongs only on a non-movement starting action.
  Movement time comes from code.
- Every persistent change names its `sourceActionId` and the applicable domain
  id. Emit only state that actually changed.
- Outcomes and occurrence content are objective, third-person and final. They
  contain no working, corrections or character-perspective interpretation.
- Write every line a person will read — outcomes, occurrence content, and the
  prose inside changes — in the language of the place descriptions in the
  request. These rules are in English; the world is not necessarily, and the
  words you write are read by the people living in it.

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

## Correcting a rejected submission

A rejection lists every error, each addressed to the element it is about:
`action:<id>`, `occurrence:<actionIds>`, `characterChange:<index>`,
`sceneChange:<index>`, `itemChange:<index>`, or the resolution as a whole.

There is no patch tool. Correct the listed elements and send the COMPLETE
resolution again — both calls in one turn, all six arrays:

- Keep every element that was not named unchanged.
- Fix or drop each element that was named. An element that should not have
  been sent at all is simply left out.
- An action the worklist requires must still be answered exactly once, in
  the list it belongs in. Dropping it does not fix an error about it.
- The resubmission is validated whole; nothing from the rejected submission
  is kept on the Engine's side.
