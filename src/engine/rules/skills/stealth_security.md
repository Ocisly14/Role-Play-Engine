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
  past someone who has already noticed the actor (Social).
- Tools matter and their absence is stated: picks, materials, a costume. A
  lock attempted bare-handed is at a higher required level or rejected
  outright.

## Success levels

- **Regular** — The actor gets through or goes unnoticed, and there are traces:
  scratches on the keyway, a coat out of place, a hesitation someone saw.
- **Hard** — Clean. The lock is undamaged and could be relocked; nobody looked
  twice; the copy passes a normal reading.
- **Extreme** — Clean and reusable — the route can be walked again, the lock is
  now understood, the forgery survives an expert's attention.

## Failure

- No entry, or the actor is seen. The lock holds, the disguise draws a second
  look, the lift is felt. Time is spent and the approach is spent with it.
- **Fumble** — Something breaks or someone is certain: a pick snaps off in the
  keyway and jams the lock permanently, the disguise is recognized as a
  disguise, the forgery names its forger. Apply the item damage and emit an
  occurrence the observers can perceive; an alarmed or watched target raises
  the alert.

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
- A clean unseen passage often produces NO delta: that nobody noticed is an
  occurrence with an empty or narrow perceiver list, not a state change.
