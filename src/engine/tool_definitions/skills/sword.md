---
id: sword
title: Sword
description: "Melee attacks with swords, daggers, and bladed weapons — slashing, thrusting, and parrying. Does NOT cover axes, whips, brawling, or any ranged attack."

skillCheck:
  skill: Sword
  difficulty: regular
  type: opposed
  opposedDefense:
    - Dodge
    - Sword
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
  requireOnSuccess:
    - character.hp
  durationGuidance:
    default: 1
    range: "1-5"
    notes: "single exchange ≈ 1 min; prolonged combat 2-5 min; pursuing a fleeing target longer"

interpreter:
  examples:
    - "Draw my sword and slash at the cultist's torso."
    - "Thrust the dagger into the creature's side."
    - "Parry the cultist's blade and riposte with my own sword."
    - "Drive the knife into the back of his neck."
---

# Sword Resolution Guidance

## On Success
- **Regular success**: The blade finds its mark — deal 1d8+DB damage. A clean slash or thrust that cuts through the target's guard, drawing blood and threatening vital areas.
- **Hard success**: A precise and controlled strike targeting a specific location — deal 1d8+DB damage to a chosen body part (arm, leg, weapon hand). Additional effects such as impaired movement or dropped weapon may apply at the GM's discretion.
- **Extreme success**: A devastating blow — a deep impaling thrust or a powerful cleave that deals maximum or doubled damage. The wound may cause the target to bleed out over subsequent rounds or suffer a lasting injury.

## On Failure
- The attack is parried, deflected, or dodged by the target's defense.
- No damage is dealt this exchange.
- A skilled opponent with Sword as their defense may riposte, potentially gaining a free attack.
- A fumble means the blade catches awkwardly — the actor may drop the weapon, injure themselves on a nearby surface, or stumble into a dangerous position.
