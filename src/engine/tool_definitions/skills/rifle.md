---
id: rifle
title: Rifle
description: "Using rifles and shotguns — aimed shots, long-range fire"

skillCheck:
  skill: Rifle
  difficulty: regular
  type: single
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
  use:
    - character.hp
    - character.condition
    - character.fatigue
    - memory.event
    - memory.witness

interpreter:
  examples:
    - "Aim and fire the rifle"
    - "Raise the shotgun and fire"
    - "Take aim with the rifle and fire"

impactHint:
  default: 3
  range: "3-4"
  examples: "silenced=2, normal shot=3, building echoes=4"
---

# Rifle Resolution Guidance

## On Success
- **Regular success**: The shot finds its target — deal 2d6+4 damage. Rifle rounds carry enormous stopping power at range; a solid hit causes a severe wound that will incapacitate most human targets within a few rounds if untreated.
- **Hard success**: A precisely placed shot — deal 2d6+4 damage to a chosen body location with a heightened wound effect. A leg shot may drop the target prone; a shoulder shot may force a weapon drop; a torso shot may pierce through to hit vital organs.
- **Extreme success**: A critical hit — deal maximum damage (16) or double dice damage (4d6+4). The target suffers a catastrophic wound; death or immediate unconsciousness is likely for human-scale targets.

## On Failure
- The shot misses — wind, distance, a moving target, or simply a bad trigger pull throws the round wide.
- No damage is dealt this exchange and the round is spent.
- The report of the rifle is extremely loud and will alert everyone in the area and beyond.
- A fumble means the weapon jams, the scope is knocked out of alignment, or the shooter loses their firing position — must spend a full action to recover and re-acquire the target.
