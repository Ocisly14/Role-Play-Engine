---
id: climb
title: Climb
description: "Scaling vertical or near-vertical surfaces using hands and feet. Does NOT cover stairs, ramps, jumping across gaps, or swimming."

skillCheck:
  skill: Climb
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, stats, conditions]
  scene:
    inject: [current]
    fields: [id, name, description, conditions, connections]

outputSchema:
  presets:
    - default
  use:
    - character.hp
    - character.position
  requireOnSuccess:
    - character.position

interpreter:
  examples:
    - "Scale the brick wall using the window ledges as handholds."
    - "Climb the drainpipe up to the second-floor balcony."
    - "Haul themselves up the cliff face hand over hand."
    - "Scramble up the chain-link fence to escape the yard."
---

# Climb Resolution Guidance

## On Success
- **Regular success**: The actor ascends or traverses the surface successfully, reaching their intended destination without incident. Fatigue is accumulated proportional to the effort.
- **Hard success**: The actor climbs quickly and efficiently, reaching the top with minimal fatigue. They may identify useful handholds or routes for others following behind.
- **Extreme success**: The actor moves with exceptional agility — they reach the destination rapidly and with almost no fatigue cost, and may spot something of interest (a hidden ledge, an unlocked window) that would otherwise go unnoticed.

## On Failure
- The actor fails to complete the climb. If partway up, they fall.
- Fall damage: 1d6 HP per 3 meters fallen. A fumble means the actor loses grip suddenly at the worst moment.
- Even a partial failure may leave the actor dangling, needing another attempt, or unable to proceed without assistance.
- If the surface is wet, unstable, or otherwise hazardous, the GM may apply additional consequences to a failure.
