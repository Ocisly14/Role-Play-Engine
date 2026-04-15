---
id: axe
title: Axe
description: "Combat with axes and heavy chopping weapons — powerful but slower strikes"

skillCheck:
  skill: Axe
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
  use:
    - character.hp
    - character.condition
    - character.fatigue
    - memory.event
    - memory.witness

interpreter:
  examples:
    - "Chop with the axe"
    - "Swing the axe in an attack"
    - "Swing the axe at the target"
---

# Axe Resolution Guidance

## On Success
- **Regular success**: The axe head bites deep — deal 1d8+1+DB damage. The heavy chopping blow is difficult to fully stop once committed; armor provides less protection against this crushing, splitting force.
- **Hard success**: The actor brings the axe down with controlled power, breaking through the target's guard — deal 1d8+1+DB damage and ignore any parry or armor bonus the target might have had, as the sheer force smashes through defensive positioning.
- **Extreme success**: A devastating cleave — deal maximum damage (9+DB) or split through to cause a grievous wound. The target may suffer a broken limb or be knocked prone from the sheer impact of the blow.

## On Failure
- The heavy swing misses entirely or the target sidesteps just in time.
- No damage is dealt this exchange.
- Overswinging with an axe is dangerous — the actor may be momentarily off-balance, giving the target a positional advantage on their next action.
- A fumble means the axe has swung completely wide; the actor stumbles forward and may drop the weapon or fall prone, leaving themselves open to a free counterattack.
