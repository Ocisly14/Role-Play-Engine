---
id: occult
title: "Occult"
description: "Recognize folklore, supernatural practices, and forbidden or Mythos knowledge."
durationGuidance:
  default: 10
  range: "3-30"
  notes: "recognizing a folk belief 3-5 min; interpreting symbols or a ritual layout 10-20 min; deep ritual or Mythos analysis 20-30 min, which risks sanity"
---

# Occult guidance

Use for folklore, superstition, ceremonial practice, and forbidden or
Mythos knowledge — recognizing what a symbol, rite, or remnant is, and what it
was for.

## Applicability

- Accepted for identifying occult material, reading a ritual's purpose and
  state, and recalling forbidden lore the character could plausibly have met.
- Rejected for the physical examination of the object itself (Investigation or
  Science & Nature) and for reading the script it is written in (Languages).
- Mythos knowledge the character has no route to remains unavailable at every
  success level. The result is a correct account of what it is not, and that
  is worth emitting.

## Success levels

- **Regular** — The actor places the tradition and the general purpose:
  protective, summoning, funerary, a hoax.
- **Hard** — The specifics — which rite, what stage it reached, what is
  missing from it, what it is meant to keep out or bring in.
- **Extreme** — What it implies about the people who made it: how recent, how
  practiced, what they will do next.

## Failure

- No placement. Superstition and the real thing look the same from here.
- **Fumble** — A confident misreading — the protective sign read as a summons,
  the hoax taken as genuine. Where the material is genuinely dangerous,
  handling it on a fumble applies the real consequence, including a sanity
  check on the occurrence where the material meets `sanity-check.md`. Add a
  condition only for an objective, major functional impairment — never for
  fear, dread, obsession, or belief.

## Sanity

Sustained study of genuine Mythos material is not free: where the fiction
warrants it, apply a sanity cost as a real character change with an objective
`reason`, at any success level.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is occurrence
`content`, not a state change.

- No SAN delta: genuine Mythos material that meets the list in
  `sanity-check.md` is a `sanityChecks` declaration on the occurrence in which
  it was perceived, at any success level; code rolls it. `character.addCondition`
  is reserved for an objective, independently verifiable state that severely
  impairs function, not the character's inner reaction to what they learned.
- `item.set` / `item.destroy` — a ritual layout disturbed, a component
  taken, a text damaged in handling.
- `scene.removeCondition` / `scene.addCondition` — a ward broken, a rite
  interrupted or completed, a place that is now different for it.
- Recognizing what something is changes nothing by itself: put it in
  occurrence `content`.
