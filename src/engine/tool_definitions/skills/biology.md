---
id: biology
title: Biology
description: "Scientific knowledge of living organisms, anatomy, ecology"

skillCheck:
  skill: Biology
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
    - "Analyze this biological sample"
    - "Determine the cause of death of this body"
    - "Identify this biological specimen"
---

# Biology Resolution Guidance

## On Success
- regular success: The investigator correctly identifies the species, cause of death, or biological process at work. They can describe relevant properties — toxicity, disease vector, ecological role, or anatomical abnormality — and explain what they mean for the situation.
- hard success: The investigator provides a precise scientific analysis — naming the exact species, cause, or mechanism with clinical confidence. They may also identify a secondary detail, such as how long the organism has been dead, or that the disease follows an unusual progression.
- extreme success: The investigator's biological analysis reveals something that should not be possible. The specimen's anatomy defies known taxonomy, or the cause of death involves a mechanism that no recognized organism or disease could produce. The scientific impossibility of what they are observing is both inescapable and deeply troubling.

## On Failure
- The investigator cannot determine the species, cause of death, or biological process from available evidence. The specimen requires laboratory equipment or expertise they do not possess.
- On a fumble, the investigator reaches an incorrect conclusion — misidentifying a dangerous pathogen or declaring a cause of death that masks the true one.
