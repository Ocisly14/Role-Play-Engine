---
id: physics
title: Physics
description: "Apply expert knowledge of mechanics, optics, thermodynamics, and material forces to analyze physical phenomena and calculate outcomes. Does NOT cover chemical properties (Chemistry), equipment repair (Mechanical/Electrical Repair), or passive observation (Spot Hidden)."

skillCheck:
  skill: Physics
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
    - "Calculate whether this floor joist can bear the weight of the mechanism described"
    - "Determine the muzzle velocity and trajectory required to produce this bullet wound angle"
    - "Assess whether the optical properties of this lens arrangement could produce the observed refraction"
    - "Identify the thermodynamic anomaly in this steam pressure reading that defies the laws of physics"
---

# Physics Resolution Guidance

## On Success
- regular success: The investigator correctly solves the physical problem — calculating load limits, trajectory paths, energy requirements, or structural stress. The result is reliable enough to inform a practical decision.
- hard success: The investigator's calculation is precise and accounts for real-world variables like material fatigue, air resistance, or mechanical friction. Their answer is actionable and includes error margins that prove correct.
- extreme success: The investigator's physics analysis reveals a detail others would have missed entirely — an inconsistency in the evidence that proves the accepted account is wrong, or a structural weakness that makes a location far more dangerous than it appears. The numbers simply do not add up in a way that admits a natural explanation.

## On Failure
- The investigator cannot perform the calculation accurately without better instruments or data. Their estimate is too imprecise to be relied upon.
- On a fumble, the investigator's calculation contains a critical error. Acting on it leads to a structural failure, a missed shot, or a dangerous misjudgment of forces involved.
