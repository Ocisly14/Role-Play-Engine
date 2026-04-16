---
id: forbidden_lore
title: Forbidden Lore
description: "Knowledge of forbidden truths, cosmic horrors, and things humanity was not meant to know"

skillCheck:
  skill: Forbidden Lore
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
    - character.san

interpreter:
  examples:
    - "Try to recall knowledge about this ancient entity"
    - "Analyze the meaning of these forbidden texts"
    - "Recall what is known about this ancient entity"
---

# Forbidden Lore Resolution Guidance

## On Success
- regular success: The investigator recalls dangerous knowledge — the name and nature of the entity, the purpose of the ritual, or the meaning of the text. The information is accurate and actionable, but it comes at a cost: the mind that holds this knowledge is changed by it. A minor SAN loss may occur upon recall.
- hard success: The investigator's knowledge goes deeper — they remember specific weaknesses, bargains, or historical encounters between humanity and this thing. The information could be decisive. The SAN cost reflects the weight of what they now consciously hold.
- extreme success: The investigator's understanding of the forbidden subject is comprehensive and terrible. They see the full picture — the entity's true scope, its relationship to other cosmic forces, and what it ultimately wants. This knowledge may be the only thing that saves the investigators, but the SAN cost is significant and the investigator may never view the world the same way again.

## On Failure
- The investigator's memory is blank on this subject. Either they never learned it, have suppressed it, or the knowledge is simply beyond what their mind has absorbed from their studies.
- On a fumble, a fragment surfaces — incomplete, distorted, and potentially more disturbing than useful. The investigator may still suffer a minor SAN effect from the partial contact with this knowledge.
