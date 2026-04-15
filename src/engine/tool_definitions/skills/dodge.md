---
id: dodge
title: Dodge
description: "Avoiding attacks and danger — reflexive evasion"

skillCheck:
  skill: Dodge
  difficulty: regular
  type: opposed
  opposedDefense:
    - Dodge
  failBehavior: abort

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, stats, conditions]
  scene:
    inject: [current]
    fields: [id, name, description]

outputSchema:
  use:
    - character.condition
    - memory.event

interpreter:
  examples:
    - "Dodge the attack"
    - "Duck away from the thrown object"
    - "Dodge the incoming blow"
---

# Dodge Resolution Guidance

## On Success
- **Regular success**: The actor reacts in time and moves clear of the incoming attack or hazard. No damage is taken from this instance of the threat.
- **Hard success**: The actor's evasion is fluid and controlled. They not only avoid the hit but maintain a favorable position — not stumbling or losing ground in the process.
- **Extreme success**: The actor evades with exceptional precision, possibly turning the attacker's momentum against them. The GM may rule the attacker is briefly off-balance, providing the actor an advantageous opportunity next action.

## On Failure
- The actor fails to move clear in time and is struck by the attack or hazard.
- Damage is applied as determined by the incoming attack (weapon, fall, creature strike, etc.).
- Note: Dodge is typically selected automatically as a reactive defense — the actor uses it in response to being targeted, not as a proactive declared action.
- A fumble on Dodge means the actor stumbled or moved into the attack, potentially worsening the damage or resulting in a prone condition.
