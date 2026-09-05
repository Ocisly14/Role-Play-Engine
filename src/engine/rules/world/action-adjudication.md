# Action Adjudication

This module decides when an action is assessed, whether it needs a check, and
what objective result it earns. It does not define movement or domain-specific
state operations.

## Action before speech

A command is judged by what it ATTEMPTS, never by whether it carries words.
Most commands say something while doing something: a hand on a wound and a
"hold still", a lie told while sizing up the room, a question asked to pry
loose a fact. The words are delivered by code when the action ends; what you
judge is the attempt behind them.

- A command whose whole content is its words — a greeting, a remark, an answer
  that stakes nothing — is talk. It takes one minute and no check.
- A command that also attempts something is an action. Clock the attempt, not
  the sentence; check it where the declared skill covers it. The `utterance`
  rides along and lands when the action ends.
- Prying, deceiving, stalling, intimidating, persuading and reading a person
  are attempts, not talk. Declared `Social`, they take a `check`, and the person
  they work on is `opposedBy` with the skill they resist with. Whether the
  probe got anything, whether the lie held, whether the bluff was read — that
  is the outcome, and code's dice decide it, not your prose.
- The same holds for every other declared skill: treating a wound, forcing a
  lock, edging into a doorway unnoticed, reading a room. If success is in any
  doubt, it is checked; if the declared skill does not cover the attempt, it is
  not, and no substitute is named.

## Starting an action

Every id listed by the trigger under `starting` gets exactly one entry in the
starts phase, and is never also answered as an ending in the same tick. Even
the shortest action takes at least one minute and resolves on a later tick.

- Always write `actionId`.
- For a non-movement action, write `resolvedDurationTicks` as a whole number of
  minutes, at least 1. The actor's proposal is advisory. Talk — a command that
  is nothing but its words — takes 1. A command that also attempts something
  takes the attempt's minutes, whatever it says while doing it.
- For movement, provide `movement` as described in
  `movement-and-position.md`; code derives its duration from the route.
- When the declared skill covers the attempt and success is in doubt, write a
  `check` with `requiredLevel`: `regular`, `hard` or `extreme`. A declared
  skill is a stake the actor chose to put down: the default is to check it,
  and to omit the check only when the attempt cannot fail or the skill does
  not cover it.
- When someone actively resists — the person being pried, deceived, stalled,
  restrained or slipped past — list them in `opposedBy` with the skill they
  use to defend. `opposedBy` requires a `check`. Code rolls and compares both
  sides; ties go to the defender. The defense `skillId` must be one of the
  ability domains named in the skill reference, and never `Languages` — a
  defender is not asked to defend in a tongue.
- If the actor declared no skill, or the declared skill does not cover the
  attempt, omit `check`. Set no substitute skill.

Starting establishes an action's clock and check. It does not declare success,
failure, elapsed time, progress or lifecycle status. It does not deliver
words: an utterance on a starting command is spoken when the action ends, and
its speech row is written on that later tick.

## Ending an action

When an action is due or interrupted, decide the finished objective account.

- An action that produced something to account for is decided
  `mode: "outcome"`, with its `actionId` and that `outcome`.
- `outcome` is objective prose: what was achieved, where the attempt stopped,
  and what the actor can objectively know. It is not an enum, an explanation of
  your reasoning or a restatement of the dice.
- An action that was nothing but words said is decided `mode: "pure_speech"`
  and writes no outcome at all. Its complete answer is the `speech:true`
  occurrence defined in `occurrences-and-dialogue.md`. An action that carried
  a `check` is never pure speech: it attempted something, the dice answered,
  and what came of the attempt is its `outcome` — the probe that got nothing,
  the lie that held or did not, the wound that closed or kept bleeding. Its
  words still get their speech row.
- Every `mode: "outcome"` decision must be referenced by at least one non-speech
  occurrence. The decision is the result account; the occurrence is what was
  objectively perceptible.
- Do not emit duration, a new difficulty, progress or status at ending time.
  Code already knows whether elapsed time makes it completed or interrupted.

An action with a deterministic dice result must respect it:

- `extreme`, `hard` or `regular`: the attempt worked, with its quality shaded
  by the achieved level and the skill guidance.
- `failure`: the attempt did not work. Spend the time and stop without adding
  an unrelated lasting penalty.
- `fumble`: apply the skill document's appropriate lasting consequence.

## Interrupted and replaced actions

A replaced action ends at the current minute because its own actor issued a
new command. Describe only what was completed before the interruption: a
half-searched drawer may remain half searched, but the hoped-for discovery did
not occur. Do not write a replacement marker; the command relationship is
already known to code.

Resolve the successor against the world left by the interrupted action. The
old and new actions never both happen in full.

## Still-running and composite actions

An id listed under `stillRunning` needs no output. Silence keeps it active.

Resolve only the part of a composite instruction whose time has actually been
spent. A command such as "wait, then return to the room" does not authorize the
Engine to choose and perform the later movement after the wait; that next
decision belongs to the actor.

## Concurrent actions

Judge all actions against the same snapshot and settle conflicts once. An item
cannot be handed to two people, two actors cannot independently become the sole
winner of the same contest, and one passage cannot be both opened and left
sealed by the same resolved moment. The output must describe one coherent
post-tick world.
