---
id: biology
title: Biology
description: "Identify species, analyze biological specimens, and interpret life processes — including pathogens, anatomy, and ecology — through expert scientific reasoning. Does NOT cover medical treatment (First Aid/Medicine), chemical composition analysis (Chemistry), or passive observation (Spot Hidden)."

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
  requireOnSuccess:
    - memory.information

interpreter:
  examples:
    - "Classify this fungal specimen to genus and assess whether its spores are pathogenic"
    - "Determine whether the tissue necrosis pattern matches any known parasitic infection"
    - "Identify the species of this creature from its anatomical features and ecological niche"
    - "Assess how long this organism has been dead based on its decomposition stage"
---

# Biology Resolution Guidance

## On Success
- regular success: The investigator correctly identifies the species, cause of death, or biological process at work. They can describe relevant properties — toxicity, disease vector, ecological role, or anatomical abnormality — and explain what they mean for the situation.
- hard success: The investigator provides a precise scientific analysis — naming the exact species, cause, or mechanism with clinical confidence. They may also identify a secondary detail, such as how long the organism has been dead, or that the disease follows an unusual progression.
- extreme success: The investigator's biological analysis reveals something that should not be possible. The specimen's anatomy defies known taxonomy, or the cause of death involves a mechanism that no recognized organism or disease could produce. The scientific impossibility of what they are observing is both inescapable and deeply troubling.

## On Failure
- The investigator cannot determine the species, cause of death, or biological process from available evidence. The specimen requires laboratory equipment or expertise they do not possess.
- On a fumble, the investigator reaches an incorrect conclusion — misidentifying a dangerous pathogen or declaring a cause of death that masks the true one.
