---
id: natural_world
title: Natural World
description: "Knowledge of flora, fauna, natural phenomena, weather patterns"

skillCheck:
  skill: Natural World
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
  presets: [default]
  use:
    - memory.information

interpreter:
  examples:
    - "Identify whether this plant is toxic"
    - "Assess the situation based on weather conditions"
    - "Identify whether this plant is poisonous"
---

# Natural World Resolution Guidance

## On Success
- regular success: The investigator correctly identifies the plant, animal, or natural phenomenon and can describe its key properties — edibility, toxicity, behavior, or predictive significance for weather and terrain.
- hard success: The investigator provides detailed knowledge — specific toxin mechanisms, behavioral patterns of the creature, or precise weather prediction with a high degree of confidence. They may also identify something anomalous about what they are observing.
- extreme success: The investigator's naturalist knowledge is exceptional. They recognize that the specimen or phenomenon deviates from natural norms in a way that cannot be explained by ordinary science. Something is wrong with this creature or this place — it does not follow the rules of the natural world.

## On Failure
- The investigator cannot reliably identify the specimen or predict the natural event. They may make a safe guess, but they cannot be certain.
- On a fumble, the investigator misidentifies a toxic plant as edible, or misreads the animal's behavior and triggers a dangerous response.
