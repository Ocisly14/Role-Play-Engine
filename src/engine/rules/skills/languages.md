---
id: languages
title: "Languages"
description: "Read, write, speak, translate, or interpret languages and specialized registers."
durationGuidance:
  default: 10
  range: "2-120"
  notes: "a short passage or a brief spoken translation 2-5 min; a conversation or a dense archaic text 15-30 min; a full document or book-length translation 60-120 min; plain talk takes one minute; checked translation or comprehension uses the assessed task duration and any utterance is delivered only when it ends"
---

# Languages guidance

Use for reading, writing, speaking, translating, and interpreting — foreign
tongues, dead tongues, dialects, jargon, and specialized registers.

This domain has no single value. A character carries a list of tongues: the
ones they grew up in, and the ones they learned, each with its own fluency.
The command names which one is in play (`declaredLanguage`), and code rolls
that language's number.

## A native tongue is never checked

Nobody rolls to speak the language they think in. Intake removes a Languages
declaration for a native tongue. Technical interpretation and noticing a
detail in already delivered speech can use an applicable declared skill.

## Applicability

- Accepted for translation, comprehension of speech or text, using a learned tongue, and decoding unfamiliar linguistic terminology —
  always in a NAMED language the actor has learned.
- Rejected for what the text MEANS in its field once translated — that is
  Knowledge & Craft, Science & Nature, or Occult by subject.
- A tongue the character does not have never reaches you: the boundary
  refuses it, because that is not a harder attempt but an impossible one.
- Fluency is the actor's number and is not yours to set. What you set is the
  difficulty of THIS passage: condition of the text, archaism, dialect, noise,
  speed of speech, how much hangs on precision.

Only supplied readable text or speech already delivered can be translated or
understood. Pending speech and hidden text are not sources. A private reading
is not automatically heard or understood by nearby people.

## Success levels

- **Regular** — The gist, reliably: the actor knows what is being said or
  asked, with rough edges and gaps.
- **Hard** — Accurate and complete, including idiom and register.
- **Extreme** — Subtle distinctions supported by the supplied text or delivered
  speech.

## Failure

- Not understood, or understood so partially it cannot be acted on. Time is
  spent on the passage.
- **Fumble** — A mistranslation or linguistic error may result. Distinguish
  the erroneous analysis from the original meaning; do not force belief or
  invent an offended listener. Code delivers a command's utterance verbatim:
  a failed check never authorizes rewriting those words. Describe only supported
  delivery or comprehension limitations, without changing quoted text.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is occurrence
`content`, not a state change.

- Usually NOTHING. Understanding is occurrence `content`, with the reader or
  listener in `perceivers` at `full`.
- `item.create` — a written translation or transcription that now exists;
  `item.set` when the actor annotates the original.
- An audible register or fluent delivery is an occurrence only to those
  who actually perceive it — what they now make of the speaker is
  theirs to write, not yours to assert.
