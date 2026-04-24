---
id: art_and_craft
engine: llm
title: Art and Craft
description: "Specialization-based creative work — Painting, Sculpture, Writing, Photography, Cooking, or Carpentry — including creation, restoration, and authentication. Does NOT cover social storytelling (Bluff/Charm) or languages."

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
  use:
    - item.create
  requireOnSuccess:
    - item.create
    - item.modify
  requireOnFailure:
    - item.modify
  durationGuidance:
    default: 30
    range: "10-120"
    notes: "quick sketch or small carving 10-15 min; proper artwork 30-60 min; major piece 90-120 min"

interpreter:
  examples:
    - "Determine whether this oil painting is a genuine Vermeer or a skilled forgery"
    - "Carve a replacement wooden component for the antique cabinet"
    - "Photograph the crime scene in a way that captures every relevant detail"
    - "Sculpt a clay likeness of the suspect from witness descriptions"
    - "Write a convincing short story to be planted as a distraction"
---

# Art and Craft Resolution Guidance

## State Changes
- Use `item.create` when the actor successfully crafts a new tool, artwork, forgery aid, or handmade object from available materials.
- Use `item.modify` when the actor restores, refines, decorates, or otherwise changes an existing object.
- Use `item.destroy` when source materials are consumed or a failed attempt ruins the workpiece.
- Use `item.move` when materials or finished goods are relocated between scene, inventory, or container.
- Use `memory.event` when the actor learns something concrete about authenticity, style, provenance, craftsmanship, or hidden alterations.

## On Success
- regular success: The investigator determines whether an artwork or handmade object is genuine or a reproduction, and can describe the style, period, and approximate skill level of the maker. If creating something, the result is functional and competent.
- hard success: The investigator identifies the specific artist or craftsman responsible, or recognizes the school and regional tradition with confidence. A created item is well-made and fit for its intended purpose.
- extreme success: The investigator reads the object as an expert — detecting hidden restorations, forgeries of exceptional quality, or concealed markings invisible to ordinary inspection. A created item is of exceptional quality, and may hold value beyond its immediate use.

## On Failure
- The investigator cannot determine authenticity or origin. The work yields no conclusions, and any attempt at creation produces something unusable or of poor quality.
- On a fumble, the investigator declares a forgery genuine — or vice versa — or creates something that fails at a critical moment.
