---
id: survival_forest
title: Survival (Forest)
description: "Surviving in woodland environments — building rain-proof shelters from timber and foliage, foraging edible plants and game, and avoiding forest predators. Does NOT cover Navigate, arctic survival, or desert survival."

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
  presets: [default]
  use:
    - character.hp
    - character.condition
  requireOnSuccess:
    - character.condition
  durationGuidance:
    default: 30
    range: "5-120"
    notes: "quick forage or berry-pick 5-10 min; build lean-to shelter or locate clean water 30-60 min; multi-hour survival task 60-120 min"

interpreter:
  examples:
    - "Lash fallen branches and broad leaves into a rain-proof lean-to shelter before nightfall."
    - "Identify edible mushrooms and wild berries that will sustain the group through the day."
    - "Set a simple snare trap using cord and bent saplings to catch small woodland game overnight."
    - "Recognize the signs of a wolf den nearby — gnawed bones, matted grass — and choose a campsite further away."
    - "Find a clean stream by following the downhill slope of the terrain and filter the water through layered cloth."
---

# Survival (Forest) Resolution Guidance

## On Success
- **Regular success**: The actor successfully forages edible plants, berries, or small game, and locates materials to build a serviceable shelter for the night. Basic needs for food and protection from the elements are met; the actor recovers fatigue from resting safely.
- **Hard success**: The actor reads the forest well — finding a more substantial food source (larger game signs, a berry patch), clean water from a running stream, and building an effective shelter that can withstand rain and wind. Navigation through the forest becomes manageable as landmarks are identified.
- **Extreme success**: The actor thrives in the wilderness — a full day's worth of food and water is secured, a well-constructed shelter is built, and the actor identifies signs of nearby predators or hazards in time to avoid them. A clear trail or route toward the destination is found and retained as useful information.

## On Failure
- The actor cannot find adequate food, water, or shelter before hunger, thirst, and exposure compound.
- Fatigue accumulates from exposure and unsuccessful searching; the actor risks becoming lost without a reference point.
- Misidentifying plants may lead to consuming something mildly poisonous, causing HP loss or a sickened condition.
- A fumble means the actor is now genuinely lost in the forest, has stumbled into animal territory (predator encounter risk), or has accidentally destroyed their emergency supplies trying to start a fire.
