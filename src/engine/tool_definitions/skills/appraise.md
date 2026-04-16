---
id: appraise
title: Appraise
description: "Estimating the value, quality, and authenticity of objects and antiques"

skillCheck:
  skill: Appraise
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
    - "Estimate the value of this antique"
    - "Authenticate whether this gemstone is genuine"
    - "Appraise the value of this jewelry"
---

# Appraise Resolution Guidance

## On Success
- regular success: The investigator provides a reliable estimate of the object's market value and determines whether it is genuine. They can advise on the general quality, condition, and likely buyer for the item.
- hard success: The investigator's appraisal is precise — they give a specific price range with confidence, identify the maker or origin, and note any factors that significantly affect value such as provenance, damage, or rarity.
- extreme success: The investigator's assessment is expert-level. They identify a feature of the object that the owner or seller was unaware of — an authentic hallmark hidden under tarnish, a concealed compartment, or a provenance that makes the item either vastly more or less valuable than assumed. The appraisal may reveal something beyond mere monetary worth.

## On Failure
- The investigator cannot reliably determine value or authenticity. Their estimate is a guess that may be significantly off, and they cannot tell whether the object is genuine.
- On a fumble, the investigator declares a worthless forgery to be valuable, or badly undervalues a genuine item — potentially at significant financial or investigative cost.
