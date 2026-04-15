---
id: art_and_craft
title: Art and Craft
description: "Artistic skills, craftsmanship, evaluating art and handmade objects"

skillCheck:
  skill: Art and Craft
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
    - "Determine whether this painting is genuine or a forgery"
    - "Craft a simple tool by hand"
    - "Evaluate whether this painting is authentic"
---

# Art and Craft Resolution Guidance

## On Success
- regular success: The investigator determines whether an artwork or handmade object is genuine or a reproduction, and can describe the style, period, and approximate skill level of the maker. If creating something, the result is functional and competent.
- hard success: The investigator identifies the specific artist or craftsman responsible, or recognizes the school and regional tradition with confidence. A created item is well-made and fit for its intended purpose.
- extreme success: The investigator reads the object as an expert — detecting hidden restorations, forgeries of exceptional quality, or concealed markings invisible to ordinary inspection. A created item is of exceptional quality, and may hold value beyond its immediate use.

## On Failure
- The investigator cannot determine authenticity or origin. The work yields no conclusions, and any attempt at creation produces something unusable or of poor quality.
- On a fumble, the investigator declares a forgery genuine — or vice versa — or creates something that fails at a critical moment.
