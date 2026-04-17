---
id: throw
title: Throw
description: "Hurling an object at a target — rocks, knives, grenades, and other thrown items. Does NOT cover point-blank melee strikes, firearms, bows, or unarmed grappling."

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
    - "Hurl the grenade into the middle of the cultist group."
    - "Throw the rock at the guard's head to knock him out."
    - "Fling the knife at the fleeing suspect."
    - "Toss the lit dynamite stick through the doorway."
    - "Chuck the heavy book at the creature to distract it."
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
