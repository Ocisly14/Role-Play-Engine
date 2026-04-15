---
id: brawling
title: Brawling
description: "Hand-to-hand combat — punching, kicking, grappling"

skillCheck:
  skill: Brawling
  difficulty: regular
  type: opposed
  opposedDefense:
    - Dodge
    - Brawling
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
    - "Swing a fist at him"
    - "Punch him in the face"
    - "Punch the cultist in the face"
---

# Brawling Resolution Guidance

## On Success
- **Regular success**: The actor lands a solid blow — deal 1d3+DB damage to the target. The strike connects cleanly, causing pain and disrupting the target's footing.
- **Hard success**: A powerful strike that achieves a secondary effect in addition to 1d3+DB damage — the actor may choose to either knock the target back (knockback effect, possible prone) or disarm the target if they are holding a weapon.
- **Extreme success**: The actor delivers a devastating hit — deal double damage (2d3+DB, or maximum 6+DB) or render the target temporarily unconscious (knockout). The target may be unable to act next round.

## On Failure
- The actor's swing goes wide or is deflected by the target's defense.
- No damage is dealt this exchange.
- The target may immediately attempt a counterattack at the GM's discretion, particularly if the attacker overextended or stumbled.
- A fumble means the actor has left themselves dangerously open — the target gains an automatic advantage on their next action against this actor.
