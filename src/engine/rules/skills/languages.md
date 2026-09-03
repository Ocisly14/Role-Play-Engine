---
id: languages
title: "Languages"
description: "Read, write, speak, translate, or interpret languages and specialized registers."
durationGuidance:
  default: 10
  range: "2-120"
  notes: "a short passage or a brief spoken translation 2-5 min; a conversation or a dense archaic text 15-30 min; a full document or book-length translation 60-120 min"
---

# Languages guidance

Use for reading, writing, speaking, translating, and interpreting — foreign
tongues, dead tongues, dialects, jargon, and specialized registers.

This domain has no single value. A character carries a list of tongues: the
ones they grew up in, and the ones they learned, each with its own fluency.
The command names which one is in play (`declaredLanguage`), and code rolls
that language's number.

## A native tongue is never checked

Nobody rolls to speak the language they think in. An action carried out in a
character's own tongue reaches you with NO declared skill and no check, and
that is correct — settle it on its merits like any other unskilled action.
Do not reach for a bar because speech was involved.

What a native speaker can still fail at is not the language: persuading
(Social), noticing a slip (Investigation), knowing what the words mean in
their field (Knowledge & Craft, Science & Nature, Occult). Check that instead,
if the actor declared it.

## Applicability

- Accepted for translation, comprehension of speech or text, passing as a
  speaker, and reading a technical register the actor is not trained in —
  always in a NAMED language the actor has learned.
- Rejected for what the text MEANS in its field once translated — that is
  Knowledge & Craft, Science & Nature, or Occult by subject.
- A tongue the character does not have never reaches you: the boundary
  refuses it, because that is not a harder attempt but an impossible one.
- Fluency is the actor's number and is not yours to set. What you set is the
  difficulty of THIS passage: condition of the text, archaism, dialect, noise,
  speed of speech, how much hangs on precision.

## Success levels

- **Regular** — The gist, reliably: the actor knows what is being said or
  asked, with rough edges and gaps.
- **Hard** — Accurate and complete, including idiom, register, and what the
  phrasing implies about the speaker or writer.
- **Extreme** — Nuance the text was not meant to give up — a regional origin,
  a deliberate ambiguity, a hand that is imitating another.

## Failure

- Not understood, or understood so partially it cannot be acted on. Time is
  spent on the passage.
- **Fumble** — Confidently mistranslated. Emit the wrong reading as what the
  actor came away with, and let the world contradict it later; if the actor
  spoke, the error is heard and may offend or expose them.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is occurrence
`content`, not a state change.

- Usually NOTHING. Understanding is occurrence `content`, with the reader or
  listener in `perceivers` at `full`.
- `item.create` — a written translation or transcription that now exists;
  `item.set` when the actor annotates the original.
- A register that offends, or a fluency that opens someone up, is an
  OCCURRENCE the other party perceives — what they now make of the speaker is
  theirs to write, not yours to assert.
