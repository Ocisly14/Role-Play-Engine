---
id: stealth
title: Stealth
description: "Moving silently and staying visually unnoticed while in motion through an area. Does NOT cover static hiding while stationary, pickpocketing, or disguise."

skillCheck:
  skill: Stealth
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, conditions]
  scene:
    inject: [current]
    fields: [id, name, description, conditions]

outputSchema:
  presets:
    - default
  use:
    - memory.event
    - character.position
  requireOnSuccess:
    - character.position

interpreter:
  examples:
    - "Slip past the patrolling guard without making a sound."
    - "Creep down the corridor while the cultist's back is turned."
    - "Move through the darkened warehouse without disturbing any of the crates."
    - "Edge along the wall to reach the far door while the professor is speaking."
---

# Stealth Resolution Guidance

## On Success
- **Regular success**: The actor moves through the area without being detected. Guards, occupants, or observers fail to notice the actor's presence or passage. The actor reaches their intended position undetected.
- **Hard success**: The actor's movement is nearly inaudible and invisible. Even alert observers do not perceive any sign of intrusion. The actor may linger in a hidden position for an extended period without risk.
- **Extreme success**: The actor ghosts through the environment completely — no footsteps, no displaced shadows, no disturbed objects. Even if someone is specifically looking in the actor's direction, they see nothing suspicious.

## On Failure
- The actor makes a noise, casts a shadow, or otherwise betrays their presence.
- A nearby observer notices something is wrong — a sound, movement, a door that shifted. They may investigate or raise an alarm.
- The actor may be spotted directly, triggering an immediate alert or confrontation.
- A fumble means the actor makes a conspicuous noise or stumbles in plain sight, immediately drawing attention and potentially causing a hostile response.
- Once detected, further Stealth attempts in the same scene face increased difficulty unless the actor can reach cover and reset.
