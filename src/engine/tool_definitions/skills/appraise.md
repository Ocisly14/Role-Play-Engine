---
id: appraise
title: Appraise
description: "Judging the monetary value, quality, and authenticity of trade goods, art, jewelry, antiques, and everyday items. Does NOT cover dating or identifying ancient artifacts (Archaeology), evaluating occult or ritual objects (Occult), or visual searching for hidden features (Perception/Spot Hidden)."

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
  requireOnSuccess:
    - memory.information

interpreter:
  examples:
    - "Estimate how much this pocket watch is worth on the open market"
    - "Determine whether this diamond is genuine or a paste imitation"
    - "Judge the quality and price of the goods in the merchant's stall"
    - "Tell whether this painting is an original or a forgery"
---

# Appraise Resolution Guidance

## On Success
- regular success: The investigator provides a reliable estimate of the object's market value and determines whether it is genuine. They can advise on the general quality, condition, and likely buyer for the item.
- hard success: The investigator's appraisal is precise — they give a specific price range with confidence, identify the maker or origin, and note any factors that significantly affect value such as provenance, damage, or rarity.
- extreme success: The investigator's assessment is expert-level. They identify a feature of the object that the owner or seller was unaware of — an authentic hallmark hidden under tarnish, a concealed compartment, or a provenance that makes the item either vastly more or less valuable than assumed. The appraisal may reveal something beyond mere monetary worth.

## On Failure
- The investigator cannot reliably determine value or authenticity. Their estimate is a guess that may be significantly off, and they cannot tell whether the object is genuine.
- On a fumble, the investigator declares a worthless forgery to be valuable, or badly undervalues a genuine item — potentially at significant financial or investigative cost.
