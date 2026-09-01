# Sanity Check Guidance

A sanity check is an involuntary reaction to a concrete revelation or
experience. It is not a declared skill, never uses an action's `check`, and
never changes whether that action itself succeeded.

## When to check

**The default is NO check. Most ticks contain none at all — a quiet town on a
foggy evening should go hours without a single one.** A sanity check is a rare
event, not a step in resolving an action. If you are considering one for every
character who acted this tick, you have already misread this document.

Check ONLY when a character directly perceives something on this list:

- A corpse, a human body in pieces, or a death witnessed up close.
- A Mythos entity, deity, or servitor — seen, heard, or unmistakably touched.
- An impossible transformation of a body, a place, or physical law.
- Direct supernatural contact: possession, a mind touched from outside, a
  thing that should not move moving with intent.
- A revelation that overturns what the character believed the world to be.

Nothing outside that list warrants a check. In particular these do NOT:
ordinary danger, pain, injury, illness, a fistfight, an argument, grief, bad
news, being lost, being watched, darkness, fog, an eerie mood, a strange
noise, a broken machine, a locked door, an unfamiliar stranger, or a
character's own fear. **Record the event and move on.** Atmosphere is the
Renderer's job, not SAN's.

Further limits, all of which still apply on top of the list:

- Check only a character who actually perceives it. Use the same physical and
  sensory evidence that determines the occurrence's `perceiverCharacterIds`;
  omniscient Engine knowledge is not exposure.
- A sight that belongs to the character's own trade is not a shock: a doctor
  or nurse at a bedside, an undertaker at a body, a sheriff at a known death.
  The rule bites when the thing is outside what their work prepared them for.
- Roll once per character for one source in one tick. A continuing sight does
  not cause another check until it materially escalates or reveals something
  new.
- If an objective event already contains an explicit SAN result or SAN delta,
  it has already been resolved. Apply/report it; do not roll it again.
- A character whose sheet has no sanity capacity (for example a Mythos entity
  with `maxSan: 0`) does not make sanity checks.

## How to check

Call `sanityCheck` with the resolving `actionId`, exposed `characterId`,
and the success/failure loss formulas. Code reads the character's current SAN,
rolls d100, chooses the correct formula, and rolls the loss. Never invent,
estimate, or reroll any of those numbers.

**Both formulas may not be zero.** `0/0` is not a loss pair — it is a check
that cannot cost anything, and calling it wastes a turn the resolution needs.
If the lowest pair below (`0/1`) already feels too heavy for what happened,
that is the answer: **do not check at all.** There is no such thing as a
formality check.

**Send them all in one turn.** If several characters are exposed to the same
revelation, call `sanityCheck` once for each of them in a SINGLE turn. One
call per turn spends the whole session's budget before the resolution is
written, and the tick is then lost entirely.

An authored module/event loss pair is authoritative. When the fiction clearly
warrants a check but supplies none, use the lowest fitting pair:

- **0/1** — an exceptionally disturbing but human-scale shock.
- **0/1d4** — credible indirect Mythos evidence or a brief minor
  manifestation.
- **1/1d6** — direct contact with a dangerous supernatural phenomenon.
- **1d4/1d10** — an overwhelming entity or reality-breaking revelation;
  reserve this for genuinely extreme exposure.

The left formula is loss on a passed check; the right formula is loss on a
failed check.

## Applying the result

- If the tool returns `loss > 0`, emit exactly one `character.san` change
  for that character with `delta: -loss`, sourced to the same action and a
  reason naming the exposure. If loss is zero, emit no zero delta.
- The objective occurrence states what was perceived, not “they lose SAN” and
  not subjective fear prose. The Renderer turns the result into experience.
- SAN loss alone does not authorize an invented diagnosis or bout. Add a
  persistent mental condition only when the authored event specifies it or
  the current state provides a concrete rule for it. This Engine does not
  track daily SAN-loss totals, so it must not guess an indefinite-insanity
  threshold.
- Recovery is not a sanity check. Genuine treatment or recovery uses a
  positive `character.san` delta under its own causal rules and never calls
  `sanityCheck`.
