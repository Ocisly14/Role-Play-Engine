---
id: stealth_security
title: "Stealth & Security"
description: "Hide, sneak, disguise, pick locks, palm objects, and forge documents."
durationGuidance:
  default: 5
  range: "1-120"
  notes: "a palmed object or a dash across a room 1-3 min; a simple lock or a hat-and-coat cover 3-5 min; sustained infiltration or a full costume 15-30 min; a forged document 60-120 min"
---

# Stealth & Security guidance

Use for covert access and avoiding recognition: hiding, sneaking,
disguise, lockpicking, palming, and forgery. The precise method determines what
is exposed, bypassed, or left behind on failure.

## Applicability

- Accepted for moving unseen or unheard, defeating a physical lock or catch,
  taking or planting something by hand, passing as someone else, and producing
  a false document.
- Rejected for defeating an electrical alarm or a mechanism that must be
  repaired rather than bypassed (Repair & Engineering), and for talking a way
  past someone who has already noticed the actor. That exchange uses no check.
- Tools matter and their absence is stated: picks, materials, a costume. A
  lock attempted bare-handed is at a higher required level or rejected
  outright.

## Success levels

- **Regular** — The feasible access or concealment attempt succeeds. Describe
  supported traces only; success does not require scratches or a witness.
- **Hard** — Precise work with fewer supported traces. An intact lock stays
  intact; a convincing copy has suitable detail. Do not write a reader's
  acceptance or someone deciding not to look.
- **Extreme** — Especially precise work within the available tools and access.
  A one-person passage does not open the route globally; a forgery does not
  predetermine a future examiner's judgment.

## Failure

- The attempted access or concealment fails: the lock holds or the
  actor leaves perceptible evidence. Assign actual observers and clarity from
  the supplied conditions; no automatic second look, recognition or retry penalty.
- **Fumble** — A supported tool breaks, a mechanism jams, or a concrete flaw
  exposes the attempt. Damage is proportional and is not automatically permanent.
  Route perceptible evidence; do not invent recognition, identification of the
  forger, or a target raising an alarm. An existing automatic alarm can trigger
  only when its supplied mechanism and the attempt support it.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is occurrence
`content`, not a state change.

- `scene.addCondition` / `scene.removeCondition` — a door or container now
  open, jammed, or permanently blocked; `scene.connectionBlock` when a way
  through is opened or sealed.
- `item.set` — a lock, latch, keyway or pick altered or damaged but still in
  play; `item.destroy` when a pick or mechanism is irreversibly ruined.
- `item.move` / `item.create` — something taken, planted, or forged into
  existence.
- A clean unseen passage often produces NO delta: emit only traces with at least one supported perceiver.
  Empty perceiver lists are invalid, and absence of an observer is not an event
  stating that everyone chose to ignore the actor.
