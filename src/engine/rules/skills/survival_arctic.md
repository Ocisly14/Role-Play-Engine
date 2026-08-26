---
id: survival_arctic
engine: llm
title: Survival (Arctic)
description: "Surviving cold, snowy, and icy environments — building snow shelters, preventing hypothermia, sourcing water from ice, and traveling over frozen terrain. Does NOT cover Navigate, Climb, desert survival, or forest survival."

skillCheck:
  skill: Survival (Arctic)
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, conditions, inventory]
  scene:
    inject: [current]
    fields: [id, name, description, conditions]

outputSchema:
  presets: [default]
  use:
    - character.hp
    - character.condition
  requireOnSuccess:
    - character.condition
  durationGuidance:
    default: 30
    range: "5-120"
    notes: "quick forage or ice-check 5-10 min; establish snow shelter or melt water 30-60 min; multi-hour survival task 60-120 min"

interpreter:
  examples:
    - "Dig a snow cave into the drift to shelter the group from the blizzard overnight."
    - "Recognize the early signs of frostbite on the actor's fingers and apply proper field treatment."
    - "Melt snow in a tin cup over a small flame to obtain safe drinking water in sub-zero conditions."
    - "Choose a path across the frozen river by testing ice thickness with a pole before crossing."
    - "Insulate a sleeping position with packed snow walls and salvaged clothing to prevent hypothermia through the night."
---

# Survival (Arctic) Resolution Guidance

## On Success
- **Regular success**: The actor successfully finds or constructs adequate shelter against the cold — a snow cave, a wind-blocked hollow, or a makeshift lean-to. The immediate threat of hypothermia is averted for several hours, and the actor may rest without further HP loss from exposure.
- **Hard success**: The actor not only survives but thrives in the conditions — they locate a particularly effective shelter site, find cached food or fuel, or identify a route that avoids the worst of the weather. Fatigue is partially recovered from the improved conditions.
- **Extreme success**: The actor demonstrates expert-level cold-weather survival — the shelter is warm and defensible, resources are located (food, water from melted snow, dry fuel), and a navigable path through the terrain is identified. The useful route and shelter knowledge can be carried forward as information.

## On Failure
- The actor fails to find adequate shelter or warmth before conditions deteriorate further.
- Exposure to the cold inflicts ongoing damage — the actor suffers fatigue accumulation and may lose 1d3 HP per hour from hypothermia if they cannot find protection.
- Frostbite may develop on exposed extremities over time, imposing penalties to DEX-based skills.
- A fumble means the actor has moved further into danger — perhaps wandering into deeper snow, breaking through ice, or exhausting their emergency supplies without benefit.
