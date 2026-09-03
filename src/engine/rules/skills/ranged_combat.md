---
id: ranged_combat
title: "Ranged Combat"
description: "Use firearms, bows, crossbows, and thrown combat weapons."
durationGuidance:
  default: 1
  range: "1-5"
  notes: "a single exchange about 1 min; a prolonged firefight 2-5 min; pursuing a fleeing target takes longer"
---

# Ranged Combat guidance

Use for attacking at a distance: firearms, bows and crossbows, and
weapons thrown to injure. Range, cover, light, and the weapon's state set the
required level.

## Applicability

- Accepted for aimed and hurried shots, covering fire, and thrown weapons used
  as weapons.
- Rejected within grapple range where the weapon cannot be brought to bear
  (Melee Combat), and for throwing an object for distance or accuracy with no
  target to injure (Athletics).
- Ammunition and condition are checked, not assumed: an empty or jammed weapon
  is a rejection with that stated, and rounds spent are a real item change.

## Success levels

Combat is an opposed check. The Engine names the defender and their defense
skill; the defender's roll comes from the opposed-roll tool and the actor's
existing roll is never re-rolled. Higher success level wins, the defender wins
ties. Damage comes from the damage-roll tool, never from estimation.

- **Regular** — A hit. Apply the rolled damage.
- **Hard** — Well placed: rolled damage plus a consequence — the target is
  pinned, drops what it held, or loses the use of a limb.
- **Extreme** — Decisive placement. Apply damage and a condition that removes
  the target from the exchange.

## Failure

- The shot misses. The round is still spent and the noise still happens —
  everyone within earshot perceives it, and that is an occurrence.
- **Fumble** — The weapon jams, misfires, or breaks, or the shot hits
  something unintended: a bystander, a lamp, a fuel drum. Apply the real
  damage where it landed and the real state change to the weapon.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is occurrence
`content`, not a state change.

- `character.hp` — the damage from the damage-roll tool, never estimated.
- `character.addCondition` — bleeding, pinned, unconscious, a limb disabled.
- `item.set` — rounds and arrows spent, magazines emptied, or a weapon jammed
  or damaged but still in play; `item.destroy` for irreversible breakage.
- `scene.addCondition` — what the misses hit: a shattered lamp that leaves the
  room dark, a holed wall; `scene.environmentHazard` when the round finds fuel
  or lamp oil.
- The noise reaches everyone in earshot. That is an occurrence with a wide
  perceiver list, not a state change.
