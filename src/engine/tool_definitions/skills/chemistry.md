---
id: chemistry
title: Chemistry
description: "Scientific knowledge of chemicals, reactions, compounds, and poisons"

skillCheck:
  skill: Chemistry
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
    fields: [id, name, description, conditions, items]
  item:
    inject: [sceneItems, actorInventory]

outputSchema:
  use:
    - memory.event
    - memory.information
    - character.fatigue

interpreter:
  examples:
    - "Analyze this chemical substance for composition"
    - "Determine whether this liquid is toxic"
    - "Analyze this chemical substance"
---

# Chemistry Resolution Guidance

## On Success
- regular success: The investigator identifies the substance, its composition, and its primary properties — toxicity, reactivity, flammability, or medical application. They can advise on safe handling and predict how it will behave in the current environment.
- hard success: The investigator's analysis is precise — they determine concentration, purity, and likely synthesis method. They can identify whether the substance was manufactured professionally or improvised, and what it might be intended for.
- extreme success: The investigator extracts every chemical secret the substance holds. They identify its exact formula, recognize that it matches no known compound, or determine that its synthesis requires equipment or knowledge not available to ordinary humans. The implications of its existence may be profoundly disturbing.

## On Failure
- The investigator cannot identify the substance or predict its reactions with confidence. They know it warrants caution but cannot be more specific.
- On a fumble, the investigator misidentifies a dangerous compound as benign, or triggers an unintended reaction during the analysis that creates a new hazard.
