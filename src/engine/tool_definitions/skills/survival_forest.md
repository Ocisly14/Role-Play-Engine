---
id: survival_forest
title: Survival (Forest)
description: "Surviving in forest and wilderness — foraging, shelter-building, avoiding predators"

skillCheck:
  skill: Survival (Forest)
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
  use:
    - character.hp
    - character.fatigue
    - character.condition
    - memory.event
    - memory.information

interpreter:
  examples:
    - "Forage for food in the forest"
    - "Build a temporary shelter"
    - "Forage for edible plants in the forest"
---

# Survival (Forest) Resolution Guidance

## On Success
- **Regular success**: The actor successfully forages edible plants, berries, or small game, and locates materials to build a serviceable shelter for the night. Basic needs for food and protection from the elements are met; the actor recovers fatigue from resting safely.
- **Hard success**: The actor reads the forest well — finding a more substantial food source (larger game signs, a berry patch), clean water from a running stream, and building an effective shelter that can withstand rain and wind. Navigation through the forest becomes manageable as landmarks are identified.
- **Extreme success**: The actor thrives in the wilderness — a full day's worth of food and water is secured, a well-constructed shelter is built, and the actor identifies signs of nearby predators or hazards in time to avoid them. A clear trail or route toward the destination is found (memory.information update).

## On Failure
- The actor cannot find adequate food, water, or shelter before hunger, thirst, and exposure compound.
- Fatigue accumulates from exposure and unsuccessful searching; the actor risks becoming lost without a reference point.
- Misidentifying plants may lead to consuming something mildly poisonous, causing HP loss or a sickened condition.
- A fumble means the actor is now genuinely lost in the forest, has stumbled into animal territory (predator encounter risk), or has accidentally destroyed their emergency supplies trying to start a fire.
