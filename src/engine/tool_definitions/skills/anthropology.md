---
id: anthropology
title: Anthropology
description: "Knowledge of human cultures, rituals, social structures and customs"

skillCheck:
  skill: Anthropology
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
    - "Analyze the cultural background of this ritual"
    - "Determine the cultural meaning of these symbols"
    - "Identify the cultural origin of this artifact"
---

# Anthropology Resolution Guidance

## On Success
- regular success: The investigator recognizes the cultural origin of the ritual, artifact, or custom. They can identify which people or tradition it belongs to and describe the general social significance it holds within that group.
- hard success: Beyond identification, the investigator understands the deeper social and ceremonial role of the practice. They can explain how it fits into the broader belief system and what violations of it might mean to the group.
- extreme success: The investigator possesses detailed scholarly knowledge — they know variant forms, historical evolution, and any unusual deviations present in what they are observing. They may recognize that this ritual has been corrupted or adapted in a disturbing way.

## On Failure
- The cultural context remains unclear. The investigator cannot place the symbols or practices within any known tradition, leaving the meaning opaque.
- On a fumble, the investigator confidently misidentifies the cultural source, potentially causing offense or drawing a dangerously wrong conclusion about what the ritual entails.
