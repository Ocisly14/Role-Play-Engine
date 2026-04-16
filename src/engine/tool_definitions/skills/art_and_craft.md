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
  presets: [default, item_modify]

interpreter:
  examples:
    - "Determine whether this painting is genuine or a forgery"
    - "Craft a simple tool by hand"
    - "Evaluate whether this painting is authentic"
---

# Art and Craft Resolution Guidance

## State Changes
- Use `item.create` when the actor successfully crafts a new tool, artwork, forgery aid, or handmade object from available materials.
- Use `item.modify` when the actor restores, refines, decorates, or otherwise changes an existing object.
- Use `item.destroy` when source materials are consumed or a failed attempt ruins the workpiece.
- Use `item.move` when materials or finished goods are relocated between scene, inventory, or container.
- Use `memory.information` when the actor learns something concrete about authenticity, style, provenance, craftsmanship, or hidden alterations.

## On Success
- regular success: The investigator determines whether an artwork or handmade object is genuine or a reproduction, and can describe the style, period, and approximate skill level of the maker. If creating something, the result is functional and competent.
- hard success: The investigator identifies the specific artist or craftsman responsible, or recognizes the school and regional tradition with confidence. A created item is well-made and fit for its intended purpose.
- extreme success: The investigator reads the object as an expert — detecting hidden restorations, forgeries of exceptional quality, or concealed markings invisible to ordinary inspection. A created item is of exceptional quality, and may hold value beyond its immediate use.

## On Failure
- The investigator cannot determine authenticity or origin. The work yields no conclusions, and any attempt at creation produces something unusable or of poor quality.
- On a fumble, the investigator declares a forgery genuine — or vice versa — or creates something that fails at a critical moment.
