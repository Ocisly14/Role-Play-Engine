---
id: archaeology
title: Archaeology
description: "Knowledge of ancient cultures, artifacts, excavation techniques"

skillCheck:
  skill: Archaeology
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
    - "Determine the age of this ancient object"
    - "Analyze the history of this ruin"
    - "Date this artifact based on its construction"
---

# Archaeology Resolution Guidance

## On Success
- regular success: The investigator determines the approximate age and likely origin of the artifact or ruin, placing it within a known historical period and culture. They can describe the civilization that created it and its probable purpose.
- hard success: The investigator provides a precise dating and identifies the specific workshop or regional tradition responsible. They notice construction details that reveal how the object was used and any modifications made after creation.
- extreme success: The investigator extracts every detail the artifact can yield — its exact age, place of manufacture, the hands it passed through, and any inscriptions or markings interpreted with full accuracy. An anomaly in its construction may hint at something deeply wrong with the accepted historical record.

## On Failure
- The artifact remains unidentified. The investigator cannot place it within any known culture or period, and their examination yields no useful conclusions.
- On a fumble, the investigator handles the object carelessly or draws a wildly incorrect conclusion about its provenance, potentially damaging it or misdirecting the investigation.
