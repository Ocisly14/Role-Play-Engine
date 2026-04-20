---
id: criminology
title: Criminology
description: "Forensic analysis of crime scenes — interpreting blood spatter, fingerprints, wound patterns, and criminal MO to reconstruct events and profile the perpetrator. Does NOT cover general visual searching (Perception/Spot Hidden), following trails (Track), or finding records (Research/Library Use)."

skillCheck:
  skill: Criminology
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

interpreter:
  examples:
    - "Analyze the blood spatter to determine where the victim was standing when struck"
    - "Examine the wound pattern to identify what kind of weapon was used"
    - "Profile the killer based on how the body was arranged"
    - "Determine whether the room was ransacked by the killer or staged to look that way"
---

# Criminology Resolution Guidance

## On Success
- regular success: The investigator reads the crime scene and deduces the likely method, sequence of events, and possible motive. They can identify whether the perpetrator was professional or opportunistic, and what kind of person might commit this act.
- hard success: The investigator constructs a detailed behavioral profile — the perpetrator's experience level, emotional state during the act, familiarity with the victim or location, and what they were trying to achieve beyond the obvious.
- extreme success: The investigator's analysis is razor-precise. They identify a signature element that links this crime to others, a deliberate staging error the perpetrator made, or a psychological detail that narrows the suspect pool dramatically. The perpetrator left more behind than they intended.

## On Failure
- The scene yields no useful deductions. The investigator cannot determine method, motive, or profile from what is visible — the crime appears random or the evidence is too degraded.
- On a fumble, the investigator reaches a confident but incorrect conclusion — a profile that points away from the real perpetrator, or a staging misread as genuine.
