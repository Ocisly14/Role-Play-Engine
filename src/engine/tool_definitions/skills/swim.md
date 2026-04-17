---
id: swim
title: Swim
description: "Staying afloat and moving through water under one's own power. Does NOT cover piloting boats, riding rafts, or climbing out of water."

skillCheck:
  skill: Swim
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
    - character.condition

interpreter:
  examples:
    - "Swim across the river to reach the far bank."
    - "Keep their head above water while the floodwaters rush through the basement."
    - "Dive beneath the surface to retrieve the sunken lantern."
    - "Fight the current to avoid being swept downstream."
---

# Swim Resolution Guidance

## On Success
- **Regular success**: The actor crosses the water body or maintains safe position in the water. They arrive at the far bank or keep their head above water, accumulating fatigue from the effort.
- **Hard success**: The actor swims efficiently and makes good progress. They conserve energy, arriving with less fatigue than expected, and may be able to assist another person in the water.
- **Extreme success**: The actor crosses with impressive speed and control, barely winded. They may dive precisely, navigate a strong current with ease, or recover a submerged object in the same effort.

## On Failure
- The actor begins to drown or lose control in the water.
- Immediate fatigue is applied; if the actor cannot be rescued or reattempt, HP damage begins as drowning rules take effect.
- In fast-moving water, a failure means being swept downstream, possibly into hazards.
- A fumble means the actor goes under suddenly — they must be pulled out or make a desperate survival check, or begin losing HP each round.
- Conditions such as heavy clothing, cold water, or strong currents increase difficulty for subsequent attempts.
