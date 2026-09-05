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

- Check only a character who actually perceives it. The same physical and
  sensory evidence sets the character's `clarity` on the occurrence's
  `perceivers`; a checked character must be listed at `full` or `limited`. A
  `trace` perceiver cannot be checked — a sound with no source is not exposure,
  and omniscient Engine knowledge is not exposure either.
- A sight that belongs to the character's own trade is not a shock: a doctor
  or nurse at a bedside, an undertaker at a body, a sheriff at a known death.
  The rule bites when the thing is outside what their work prepared them for.
- One check per character per tick, however many occurrences they appear in.
  A resolution that checks the same person twice is rejected; keep the
  exposure that actually shocked them. A continuing sight does not cause
  another check until it materially escalates or reveals something new.
- If an objective event already carries an explicit SAN result, it has
  already been resolved by code. Do not declare a check for it again.
- A character whose sheet has no sanity capacity (for example a Mythos entity
  with `maxSan: 0`) does not make sanity checks.

## How to declare

Put a `sanityChecks` entry on the occurrence in which that character
perceived the thing, in the occurrence phase itself — there is nowhere else it
can go. Name the `characterId` and the
`failureLoss`. Code reads their current SAN, rolls d100 and settles it. Never
invent, estimate or reroll any of those numbers, and never call a tool for
this — there is none.

**A passed check costs nothing at all**: no SAN, no consequence. So a
declaration is not a way to hang a mood on someone who merely saw something
unpleasant. It is a coin the world flips on whether this broke them a little.

**This is the only way SAN changes.** There is no `san` character operation:
code writes the loss from the roll, and nothing you write moves SAN directly.

## The loss

There is only a failure loss now — passing is free, so there is nothing to
pair it with. An authored module or event loss is authoritative. Otherwise
take the lowest one that fits:

- **1** — an exceptionally disturbing but human-scale shock.
- **1d4** — credible indirect Mythos evidence, or a brief minor
  manifestation.
- **1d6** — direct contact with a dangerous supernatural phenomenon.
- **1d10** — an overwhelming entity or a reality-breaking revelation; reserve
  it for genuinely extreme exposure.

A flat zero is refused. A check that cannot cost anything is a check that
should not happen: resolve the action without one.

## The optional severe consequence

A failed check normally changes SAN only. It does **not** automatically turn
fear, distress, or other inner activity into a world-state condition. Code
applies a consequence only when the actual loss is at least 5 SAN. That is the
boundary for a major impairment rather than an ordinary reaction.

Include `consequence` only when a sufficiently severe failure could leave an
objective state that radically impairs mental or physical function. It has
two fields:

- `description`: one present-tense description combining signs another
  observer could see or a clinician could independently verify with the major
  impairment, for example: "Speech is incoherent and the person cannot remain
  oriented to place, so they cannot communicate a coherent plan or act safely
  without guidance."
- `durationMinutes`: how long that objective impairment persists.

Do not write first-person narration or an inner state. "I am terrified," "she
feels watched," "he keeps thinking about the body," regret, suspicion, grief,
unease, resolve, and vigilance are not conditions. Do not write a mere
diagnostic label, a numerical mechanic, or an instruction. If you cannot name
a major functional impairment that a third party could verify, omit the whole
`consequence`.

## How long

When a severe consequence is present, use whole minutes from 5 to 1440. A
short-lived major disorientation may be minutes; a profound break may be an
hour or two. The rest of the day belongs to something that broke the world.

Nothing but the clock revokes it — there is no path by which you, or anyone,
lift it early. **A consequence that outlives the reason for it is worse than
no consequence at all**, so choose the shorter duration when you are unsure.

## The only SAN path

This document governs **involuntary horror exposure**, and that is the only
thing that moves SAN through you. A declaration is made only for something on
the list above; nothing else is a reason to declare one.

What is not on the list has no SAN number to write. A treatment session, a
disturbing conversation, an unsettling text: record what objectively happened
as an occurrence, and a persistent major impairment as a condition. Recovery
is not a sanity check and is not yours to write either. A scripted event's
authored cost is applied by code, not declared here.

## What you still write yourself

- The objective occurrence states what was perceived — not "they lose SAN",
  and not subjective fear prose. The Renderer turns the result into
  experience.
- SAN loss does not authorize an invented diagnosis or subjective mood. The
  optional consequence above is only an objective, major functional
  impairment; anything else remains an occurrence and character-authored
  memory. This Engine does not track daily SAN-loss totals, so it must not
  guess an indefinite-insanity threshold.
