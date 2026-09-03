# Action Adjudication

This module decides when an action is assessed, whether it needs a check, and
what objective result it earns. It does not define movement or domain-specific
state operations.

## Starting an action

Every id listed by the trigger under `starting` gets exactly one `starting`
entry and never an `ending` entry in the same tick. Even the shortest action
takes at least one minute and resolves on a later tick.

- Always write `actionId`.
- For a non-movement action, write `resolvedDurationTicks` as a whole number of
  minutes, at least 1. The actor's proposal is advisory. An action whose
  command carries an `utterance` takes one minute — code sets it, so the value
  is optional there.
- For movement, provide `movement` as described in
  `movement-and-position.md`; code derives its duration from the route.
- When the declared skill applies and uncertainty warrants a roll, write a
  `check` with `requiredLevel`: `regular`, `hard` or `extreme`.
- When someone actively resists, list them in `opposedBy` with the skill they
  use to defend. `opposedBy` requires a `check`. Code rolls and compares both
  sides; ties go to the defender.
- If the actor declared no skill, or the declared skill does not cover the
  attempt, omit `check`. Set no substitute skill.

Starting establishes an action's clock and check. It does not declare success,
failure, elapsed time, progress or lifecycle status. It does not deliver
words: an utterance on a starting command is spoken when the action ends, and
its speech row is written on that later tick.

## Ending an action

When an action is due or interrupted, decide the finished objective account.

- A non-speech result gets one `ending` entry with `actionId` and `outcome`.
- `outcome` is objective prose: what was achieved, where the attempt stopped,
  and what the actor can objectively know. It is not an enum, an explanation of
  your reasoning or a restatement of the dice.
- A pure speech action has no `ending` entry. Its complete answer is a
  `speech:true` occurrence as defined in `occurrences-and-dialogue.md`.
- Every non-speech ending must be referenced by at least one non-speech
  occurrence. The ending is the result account; the occurrence is what was
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
