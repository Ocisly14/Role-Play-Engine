---
id: physics
title: Physics
description: "Scientific knowledge of mechanics, energy, forces, and structural properties"

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
  use:
    - memory.information

interpreter:
  examples:
    - "Calculate the load-bearing capacity of this structure"
    - "Analyze the ballistic trajectory"
    - "Figure out the trajectory of the projectile"
---

# Physics Resolution Guidance

## On Success
- regular success: The investigator correctly solves the physical problem — calculating load limits, trajectory paths, energy requirements, or structural stress. The result is reliable enough to inform a practical decision.
- hard success: The investigator's calculation is precise and accounts for real-world variables like material fatigue, air resistance, or mechanical friction. Their answer is actionable and includes error margins that prove correct.
- extreme success: The investigator's physics analysis reveals a detail others would have missed entirely — an inconsistency in the evidence that proves the accepted account is wrong, or a structural weakness that makes a location far more dangerous than it appears. The numbers simply do not add up in a way that admits a natural explanation.

## On Failure
- The investigator cannot perform the calculation accurately without better instruments or data. Their estimate is too imprecise to be relied upon.
- On a fumble, the investigator's calculation contains a critical error. Acting on it leads to a structural failure, a missed shot, or a dangerous misjudgment of forces involved.
