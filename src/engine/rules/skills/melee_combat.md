---
id: melee_combat
title: "Melee Combat"
description: "Fight unarmed or with hand-held melee weapons."
durationGuidance:
  default: 1
  range: "1-5"
  notes: "a single exchange about 1 min; a prolonged fight 2-5 min; pursuing a fleeing opponent takes longer"
---

# Melee Combat guidance

Use for fighting at arm's length: fists, knives, clubs, blades,
improvised weapons, grappling. What the actor holds and where they are standing
matter more than the label of the attack.

## Applicability

- Accepted for any attempt to strike, grapple, restrain, or disarm a target
  within reach.
- Rejected beyond reach (Ranged Combat) and for a threat that is never carried
  out (Social).
- The weapon must be one the actor actually holds — check the inventory. An
  improvised weapon is accepted with its real properties, not a nominal one.

## Success levels

Combat is an opposed check. The Engine names the defender and their defense
skill; the defender's roll comes from the opposed-roll tool and the actor's
existing roll is never re-rolled. Higher success level wins, the defender wins
ties. Damage comes from the damage-roll tool, never from estimation.

- **Regular** — The blow lands as struck. Apply the rolled damage.
- **Hard** — Landed well: rolled damage plus a positional consequence —
  staggered, disarmed, driven back, grip established.
- **Extreme** — Decisive. Apply damage and a real condition that ends the
  target's participation for now: unconscious, pinned, an arm that will not
  work.

## Failure

- The attack misses or is turned. The actor is where the exchange left them
  and has spent the effort; fatigue accrues.
- **Fumble** — The actor is exposed: the weapon is dropped or breaks, footing
  is lost, or the swing hits something that was not the target. Apply the real
  consequence, including damage to the wrong thing.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is an occurrence
fact, not a state change.

- `character.hp` — the damage from the damage-roll tool, never estimated.
- `character.addCondition` — bleeding, stunned, pinned, unconscious, a limb
  that will not work; `removeCondition` when a hold is broken.
- `character.position` — driven back, dragged, or grappled into place.
- `item.move` — a weapon knocked away; `item.damage` / `item.destroy` when it
  breaks in the exchange.
- `character.fatigue` — every exchange costs it.
- Being attacked is an occurrence the target perceives, vividly. What it does
  to their view of the attacker is theirs to write.
