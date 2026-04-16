---
id: submachine_gun
title: Submachine Gun
description: "Using submachine guns — burst fire, suppressive fire"

skillCheck:
  skill: Submachine Gun
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
  presets:
    - default
  use:
    - character.hp
    - character.condition

interpreter:
  examples:
    - "Spray fire with the submachine gun"
    - "Lay down suppressive fire"
    - "Open fire with the submachine gun"

impactHint:
  default: 4
  range: "3-5"
  examples: "short burst=3, sustained fire=4, in crowd=5"
---

# Submachine Gun Resolution Guidance

## On Success
- **Regular success**: A controlled burst connects — deal 1d10 damage per bullet that hits. A short burst (3 rounds) may strike the target 1-3 times; roll separately for each round or use the burst-fire rules to determine the number of hits. Total damage can be severe.
- **Hard success**: A concentrated burst directed onto a single target — all rounds in the burst strike the same location, dealing accumulated 1d10 damage per hit with a strong chance of a major wound or knockdown from the volume of fire.
- **Extreme success**: A devastating full-auto burst — the target is shredded by multiple rounds, taking maximum damage from each hit. Human-scale targets are effectively neutralized; structural cover may be chewed through as well.

## On Failure
- The burst goes wide — the actor fails to control the weapon's recoil, the target moves unpredictably, or poor aim scatters the rounds.
- No hits are scored, and multiple rounds are wasted from the magazine.
- The noise and muzzle flash make the actor's position immediately obvious to all in the area.
- A fumble means the weapon jams mid-burst or the magazine is ejected — the actor must spend a full action clearing the jam or reloading before firing again.
