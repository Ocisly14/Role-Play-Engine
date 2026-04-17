---
id: whip
title: Whip
description: "Melee attacks with a whip — lashing, entangling a limb, and disarming at close reach. Does NOT cover swords, axes, brawling, or any firearm or thrown attack."

skillCheck:
  skill: Whip
  difficulty: regular
  type: opposed
  opposedDefense:
    - Dodge
  failBehavior: abort

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, stats, conditions, inventory]
      targets: [id, name, stats, conditions]
  scene:
    inject: [current]
    fields: [id, name, description, conditions]

outputSchema:
  presets:
    - default
  use:
    - character.hp
    - character.condition

interpreter:
  examples:
    - "Crack the whip across the cultist's face."
    - "Snap the whip to wrap around his weapon hand and disarm him."
    - "Lash out with the whip to entangle the man's legs and trip him."
    - "Use my whip to coil around his wrist and yank him off balance."
---

# Whip Resolution Guidance

## On Success
- **Regular success**: The whip strikes or wraps around its target — deal 1d3 damage from the lash, or choose to entangle a limb (arm or leg) instead. An entangled limb is temporarily restricted, penalizing the target's actions involving that limb until freed.
- **Hard success**: A precise controlled strike that disarms the target — the whip snaps the weapon or object from the target's grasp, sending it skidding across the floor. No damage is dealt, but the target loses use of their weapon until retrieved.
- **Extreme success**: The whip coils around the target's body or limb with full force — entangle and pull, dragging the target off-balance or pulling them toward the actor. The target is prone or yanked up to a few meters in the actor's direction.

## On Failure
- The whip cracks wide of the mark or the target successfully ducks beneath it.
- No damage or entanglement is achieved this exchange.
- Whips require space to swing — a fumble in close quarters may lash the actor themselves (1 point of damage), wrap around nearby furniture, or tangle in a way that requires a full action to recover.
