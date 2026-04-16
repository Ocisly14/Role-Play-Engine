---
id: throw
title: Throw
description: "Throwing objects accurately at targets — rocks, grenades, improvised weapons"

skillCheck:
  skill: Throw
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, stats, conditions, inventory]
      targets: [id, name, stats, conditions]
  scene:
    inject: [current]
    fields: [id, name, description]

outputSchema:
  presets:
    - default
  use:
    - character.hp
    - character.condition

interpreter:
  examples:
    - "Throw the rock at the window"
    - "Hurl a grenade at the enemy"
    - "Throw the rock at the target"
---

# Throw Resolution Guidance

## On Success
- **Regular success**: The thrown object hits its intended target or destination. Damage is applied based on the nature of the object — improvised weapons deal 1d4–1d6, grenades follow explosive rules.
- **Hard success**: The throw is accurate and well-timed. The object strikes a precise point — a weak spot on a creature, a specific window pane, or a target's hand. The GM may allow a bonus effect or increased damage.
- **Extreme success**: The throw is exceptional — a perfect hit with maximum impact. For weapons this may deal maximum damage; for utility throws (a rope, a key) the object lands exactly where intended with no follow-up needed.

## On Failure
- The thrown object misses its target. The GM determines where it lands — possibly near the target, possibly dangerously off course.
- For grenades or explosives, the GM rolls deviation to determine where they land.
- Nearby observers may respond — alerted guards, frightened bystanders, or an antagonist given time to react.
- A fumble may mean the object drops nearby, strikes an unintended target, or in the case of a grenade, creates a hazard for the actor.
