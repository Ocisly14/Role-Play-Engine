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
- Ranged Combat covers attacks beyond melee reach. A spoken threat uses no
  check.
- The weapon must be one the actor actually holds — check the inventory. An
  improvised weapon is accepted with its real properties, not a nominal one.

## Success levels

For active resistance, name the defender and an applicable defense skill
in the starts phase. Code supplies the resolved dice verdict, including
opposition, at settlement; there is no opposed-roll tool here. Use `diceRoll.met`,
not the actor's success level alone. Damage, when the attempted effect deals it,
comes from `damageRoll`. A disarm or restraint need not deal HP damage.

The levels below describe possible quality, not automatic extra injuries.
Every displacement, disarm or impairment needs the actual attack and physical
effect to support it; a good roll alone never makes a healthy target unconscious.

- **Regular** — The blow lands as struck. Apply the rolled damage.
- **Hard** — Precise execution of the declared attack. A positional
  consequence is possible only where its force and method support it.
- **Extreme** — The best feasible execution. Apply only rolled damage and
  supported effects; incapacitation still needs an adequate physical cause.

## Failure

- The attack misses or is turned. The actor is where the exchange left them
  and has spent the effort; do not duplicate code-owned fatigue.
- **Fumble** — The actor is exposed: the weapon is dropped or breaks, footing
  is lost, or the swing hits something that was not the target. Apply the real
  consequence, including damage to the wrong thing.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is occurrence
`content`, not a state change.

- `character.hp` — damage from `damageRoll`, never estimated.
- `character.addCondition` — bleeding, stunned, pinned, unconscious, a limb
  that will not work; `removeCondition` when a hold is broken.
- `character.spot` — driven back or grappled elsewhere in the same scene;
  `character.position` when a throw or drag truly crosses into another scene.
- `item.move` — a weapon knocked away; `item.set` when damaged but still in
  play, or `item.destroy` when irreversibly broken.
- `character.fatigue` — actual exertion not already applied by code.
- An attack is an occurrence for those with supported sensory access;
  a target does not automatically see an unseen attacker. What it does
  to their view of the attacker is theirs to write.
