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
- Persuasion, questioning, deception, intimidation, negotiation, stalling
  through conversation, and reading a person's intent use neither `check` nor
  `opposedBy`, regardless of the declared skill. A spoken line alone takes
  one minute. When the actor also does something observable, assess its time
  and settle that conduct. An independent task, such as treating a wound,
  fighting, or translating a learned language, may still need its own check.
- The same holds for every other declared skill: treating a wound, forcing a
  lock, edging into a doorway unnoticed, reading a room. If success is in any
  doubt, it is checked; if the declared skill does not cover the attempt, it is
  not, and no substitute is named.

## Starting an action

The character is responsible for submitting one atomic action: one immediate
objective with an independently settleable result. It can span several ticks;
atomic does not mean one minute or one bodily motion. Starts judges that
submitted action's timing and check. It does not expand a broad plan into a
queue of future actions or choose what the character does next. Separate tasks
and decisions belong in subsequent commands after the character receives the
current action's result. Incidental manner and words intended at this action's
completion can accompany it; words needed before a long task belong to an
earlier speech action, not to the long task's ending.

Every id listed by the trigger under `starting` gets exactly one entry in the
starts phase, and is never also answered as an ending in the same tick. Even
the shortest action takes at least one minute: it is judged here, at the
minute it was decided, and settled by the settlement a minute later — never
in the same judgement.

- Always write `actionId`.
- For a non-movement action, write `resolvedDurationTicks` as a whole number of
  minutes, at least 1. The actor's proposal is advisory. Talk — a command that
  is nothing but its words — takes 1. A command that also attempts something
  takes the attempt's minutes, whatever it says while doing it.
- For movement, provide `movement` as described in
  `movement-and-position.md`; code derives its duration from the route.
- When the declared skill covers the attempt and success is in doubt, write a
  `check` with `requiredLevel`: `regular`, `hard` or `extreme`, subject to the
  interpersonal rule above.
- When supplied conduct or standing defenses establish active resistance
  to an attempt — including concealment, evasion or guarding — list them in `opposedBy` with the skill they
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

When an action is due or interrupted, decide whether it has a new objective
result to settle. Closing an action's clock does not itself create a world event.

- `mode: "outcome"` carries `actionId` and the new objective `outcome`: what
  this attempt changed, exposed or failed to accomplish. State world facts,
  not a personal account of what the actor saw, heard, learned or concluded.
  A checked attempt always needs its objective result, consistent with the roll.
- `mode: "pure_speech"` carries no outcome. It is only for an unchecked action
  consisting entirely of its utterance, delivered by its `speech:true` occurrence.
- `mode: "no_change"` carries only `actionId` and `mode`. Use it when no new
  result, check or utterance needs settling, including routine observation,
  listening and waiting. It sources no state changes and no occurrences.
- Every `outcome` decision needs a non-speech occurrence for the perceptible
  result. Words, if present, get a separate speech occurrence.
- Do not emit duration, difficulty, progress or status at ending time. Code
  closes the action and wakes its actor even for `no_change`.

Ordinary perception is continuous event delivery, not a task whose ending
needs a retrospective summary. An event is recorded under its own source action,
with its actual perceivers and clarity, when it occurs. The Renderer supplies
the personal perspective; the character owns interpretation and memory.
Do not collect those events again into an observer's outcome, and do not invent
"no new information", silence or a negative finding just because the clock ended.

For a mixed command such as "sit down, take food and watch", settle only any
new, supported physical effects that still need settling. Previously applied
effects are not repeated. Do not append a recap of the room. A checked search
that actually exposes a clue still needs an objective result and a properly
routed occurrence, not the character's interpretation. An observer's action
never executes another person's pending command or delivers their pending words.

An action with a deterministic dice result must respect it:

- `critical`, `extreme`, `hard` or `regular`: apply the supplied resolved check verdict
  (`diceRoll.met`, including opposition), with quality shaded by the achieved level. A nominal
  success level that lost the opposition does not make the attempt succeed.
  For an interrupted action, credit only established partial work; a met roll
  does not complete unspent work.
- `failure`: the attempt did not work. Spend the time and stop without adding
  an unrelated lasting penalty.
- `fumble`: apply a supported, proportionate consequence under the skill
  guidance; examples are not a requirement to invent damage or a target reaction.

## Interpersonal actions

Record the actor's actual words and observable conduct, including any evidence
they show. Deliver those facts through occurrences to the people who can see
or hear them. For a silent read of someone, route existing cues through
ordinary perception. The observer interprets them. Use `no_change` if the
observation produces no new objective result.

Only the other actor's own settled action or an already established fact can
support describing their reply, silence, concession, belief or emotional
reaction. Preserve its source and timing. The recipient decides how to
respond based on what actually reaches them.

## Interrupted and replaced actions

A replaced action ends at the current minute because its own actor issued a
new command. Describe only what was completed before the interruption: a
half-searched drawer may remain half searched, but the hoped-for discovery did
not occur. Do not write a replacement marker; the command relationship is
already known to code.

Resolve the successor against the world left by the interrupted action. The
old and new actions never both happen in full.

## Still-running and composite actions

An id listed under `stillRunning` needs no ending entry. Code keeps it active.
It may source a supported intermediate effect in a settlement's change and
occurrence phases; it does not require one merely because time passed.

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
