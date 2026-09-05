# Occurrences and Dialogue

Occurrences are the objective, non-persistent record of what happened this
tick and the only route by which characters perceive action results. One row
describes one moment for everyone who received any evidence of it, graded per
person. Determine sensory reach and each perceiver's grade under
`perception.md`, then encode that decision here.

## Shape and responsibility

Every occurrence has:

- `actionIds`: the non-empty set of actions whose trace this is;
- `speech`: whether this row delivers an utterance whose action ends this
  tick; code copies the words verbatim from the command;
- `perceivers`: one entry per character who received any evidence of this
  row, each `{ characterId, clarity }` with `clarity` one of `full` (the event
  and its relevant detail), `limited` (the kind of event and its immediate
  result, no fine detail) or `trace` (only that something happened);
- `content`: an objective third-person description, required when
  `speech:false` and optional when `speech:true`.

It may also identify `targetIds` and `sanityChecks` where the schema calls for
them. The actor and location are derived from the cited action. `clarity` is
the one perception field. Do not output an actor, location, signals, fact
arrays, fact types, reference-id arrays or affected-character arrays; those
are not part of this occurrence shape.

Content contains no reasoning, corrections, character-perspective phrasing or
subjective interpretation. State the settled world fact once.

## One occurrence, one fact, graded audience

One row states one objective fact. Write `content` at full detail regardless
of who is listed — never at the lowest shared level. Each perceiver's `clarity`
says how much of that fact reached them; the Renderer degrades per grade. Never
give a character a higher `clarity` than the evidence they received supports.

Split into separate occurrences citing the same action ids ONLY when audiences
receive different FACTS — the shove in one room and the landing in the
courtyard. Different degrees of one fact are one row, graded per perceiver.

For example, a whisper produces ONE `speech:true` row carrying the original
words, with `perceivers`:

- the intended listener at `full`;
- the onlookers who saw her lean close but caught nothing at `limited`;
- someone through the wall who heard only an unplaceable voice at `trace`.

Choose perceivers by following `perception.md`. Do not automatically add the
actor: unconsciousness, sensory loss or being moved without awareness can make
someone unable to perceive their own action's consequence.

## Speech

A `speech:true` occurrence cites exactly ONE action, and only one listed
under `endingWithUtterance` this tick: its command carries the words and it
ends now. Two people speaking are two rows, each with its own `targetIds` and
`perceivers` — code places a row where its cited actor stands. A starting
action's utterance is not delivered yet and takes no speech row; it is spoken
when the action ends — after one minute for plain talk, after the attempt's
own minutes for a command that also does something — and returns under
`endingWithUtterance` on that tick.

- Code copies that utterance verbatim onto the occurrence. Never restate,
  summarize, translate or quote it in `content`.
- `targetIds` is required for a speech row and states whom the actor addressed.
- `perceivers` states who received the words or any evidence of them, and at
  what grade: `full` for those who made out the words, `limited` for those who
  know who spoke but not what was said, `trace` for an indistinct voice with
  no placeable source. Target and perceiver are not interchangeable.
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
under `starting`, the words are not delivered and no speech row exists; a
`speech:false` row may record the visible attempt.

## Other characters retain agency

An action aimed at another person is complete once the actor's attempt is
delivered — describe the actor's words and conduct, never the target's
unissued reply, nod, silence, concession, belief or emotional reaction. The target responds on
their own next command.

A successful social check may be delivered downstream as pressure or evidence
the target must consider; it does not authorize the Engine to write the
target's decision in advance.

## Sanity declarations

When perceiving this occurrence warrants an involuntary SAN check, attach the
declaration here and follow `sanity-check.md`. A checked character must appear
in this occurrence's `perceivers` at `full` or `limited`; a `trace` perceiver
cannot be checked, since a sound with no source is not exposure. Do not
describe SAN loss or a subjective fear reaction in `content`.
