# Occurrences and Dialogue

Occurrences are the objective, non-persistent record of what happened this
tick and the route by which other characters perceive action results. The
acting character also receives its own ending outcome directly. Both routes
must respect the same evidence and timing boundaries. One row
describes one moment for everyone who received any evidence of it, graded per
person. Determine sensory reach and each perceiver's grade under
`perception.md`, then encode that decision here.

## Shape and responsibility

Every occurrence has:

- `actionIds`: the non-empty set of actions whose trace this is;
- `speech`: whether this row delivers an utterance whose action ends this
  tick; code copies the words verbatim from the command;
- `perceivers`: one entry per character who received any evidence of this
  row, each `{ characterId, sight, hearing }`: sight `clear` / `partial` /
  `glimpse` / `none`, hearing `clear` / `muffled` / `faint` / `none` (see
  `perception.md`), never both `none`;
- `content`: an objective third-person description, required when
  `speech:false` and optional when `speech:true`.

It may also identify `targetIds` and `sanityChecks` where the schema calls for
them. The actor and location are derived from the cited action. `sight` and
`hearing` are the perception fields. Do not output an actor, location, signals, fact
arrays, fact types, reference-id arrays or affected-character arrays; those
are not part of this occurrence shape.

A `no_change` ending must not be cited by any occurrence. Its lifecycle
transition already tells the actor the action ended. Observation or waiting
creates no retrospective event: keep actual events on their original source
actions, with each perceiver's grades, and deliver them when they occur.
If there are no new perceptible facts, submit `[]`; do not manufacture an
"observed nothing new" fact to fill the space.

Content contains no model reasoning, corrections, character-perspective
phrasing or imposed subjective interpretation. State the supported world fact
once; keep any evidence-based analytical uncertainty explicit.

## One occurrence, one fact, graded audience

One row states one objective fact. Write `content` at full detail regardless
of who is listed — never at the lowest shared level. Each perceiver's grades
says how much of that fact reached them; the Renderer degrades per grade. Never
give a character a higher grade than the evidence they received supports.

Use separate occurrences citing the same action for distinct facts, including
its delivered speech and its physical result, or events in different places
with different audiences (a shove and a landing). Do not split copies of the
same fact merely by grade: those belong in one row, graded per perceiver.

For example, a whisper produces ONE `speech:true` row carrying the original
words, with `perceivers`:

- the intended listener at sight `clear`, hearing `clear`;
- the onlookers who saw her lean close but caught nothing at sight `clear`,
  hearing `faint`;
- someone through the wall who heard only an unplaceable voice at sight
  `none`, hearing `faint`.

Choose perceivers by following `perception.md`. Do not automatically add the
actor: unconsciousness, sensory loss or being moved without awareness can make
someone unable to perceive their own action's consequence.

## Naming new and found things

When an occurrence shows an item coming into being or an unnoticed item
being found, its `content` names the item with its `[id]` right after the
name — "pries the left leg [item.chair_leg_1] off the chair". That tag is the
only way the people who perceive the row can point at the thing afterwards;
a row that describes it without the tag leaves them knowing it exists with no
way to reach it. Name nothing that was not created or found this tick, and
never a thing the perceivers could not see.

## Speech

A `speech:true` occurrence cites exactly ONE action, and only one listed
under `endingWithUtterance` this tick: its command carries the words and it
ends now. Two people speaking are two rows, each with its own `targetIds` and
`perceivers` — code places a row where its cited actor stands. A starting
action's utterance is not delivered yet and takes no speech row; it is spoken
when the action ends (Words alone take 1 minute; an action that also does something takes the minutes of what it does, whatever is said while doing it.) and returns under
`endingWithUtterance` on that tick.

- Code copies that utterance verbatim onto the occurrence. Never restate,
  summarize, translate or quote it in `content`.
- `targetIds` is required for a speech row and states whom the actor addressed.
- `perceivers` states who received the words or any evidence of them, and at
  what grades: hearing `clear` for those who made out the words, `muffled` for
  a voice and its tone without the words, `faint` for an indistinct voice with
  no placeable source; sight as their view allows. Target and perceiver are
  not interchangeable.
- `content` is optional and, when present, describes only what lies outside the
  words: delivery, posture, accompanying gesture or another objective detail.
- A pure speech action is answered entirely by its `speech:true` occurrence.
  It was decided `mode: "pure_speech"` in the endings phase and so has no
  outcome prose anywhere.

If a command that both speaks and changes the world—handing over a cup while
speaking, for example—ENDS this tick, emit a speech occurrence for the words
and a separate `speech:false` occurrence for the physical result. Such an
action is a `mode: "outcome"` decision, never a pure-speech one, and an
outcome decision cited only by a speech row is rejected. While it is still
under `stillRunning`, the words are not delivered and no speech row exists.
A settlement may record a supported visible intermediate attempt with
`speech:false`; it must not summarize pending words, claim their intended
effect, or complete all later steps. Do not replay earlier physical effects.
Starts run in a separate session with no occurrence submission.

Intermediate work that changes position, ownership or another persistent field
needs the corresponding accepted change. This last phase cannot introduce that
change through narration after its owning phase has passed. Use the supported
attempt or existing state if no such change was established. Checking a window
during a longer inspection is possible; "every window checked, fire fed, gun
put away" needs evidence for that whole sequence, not just one minute elapsed.

## Other characters retain agency

For an interpersonal exchange, describe the actor's delivered words and
conduct at the time established by code, never the target's
unissued reply, nod, silence, concession, belief or emotional reaction. The target responds on
their own command. This does not prohibit an independently grounded physical
effect on a target, such as an injury or forced displacement.

Route the words, delivery, gestures and any evidence shown by the actor to
the people who actually perceive them. A recipient decides what to make of
that evidence.

Before submitting, check every clause about someone other than the action's
actor. A reply, nod, deliberate silence, refusal or group reaction needs that
person's own settled action or an already established fact, not an inference
from the speaker's roll. No response recorded is not a choice to remain silent.
Do not bridge two speech rows by inventing that one person answered, conceded
or ignored the other; keep their source actions and timing distinct.

Descriptions such as "nobody answers", "nobody laughs" and "the room stays
tense" need support from established facts or the other actors' own actions. Accepted
outcomes remain read-only, but citing an outcome requires a perceptible trace
of its actor's attempt, not repetition of every clause or speculative reaction.

## Sanity declarations

When perceiving this occurrence warrants an involuntary SAN check, attach the
declaration here and follow `sanity-check.md`. A checked character must appear
in this occurrence's `perceivers` with sight `clear` or `partial`, or hearing
`clear` or `muffled`; someone who only glimpsed it or heard it faintly cannot
be checked, since a movement or sound with no source is not exposure. Do not
describe SAN loss or a subjective fear reaction in `content`.
