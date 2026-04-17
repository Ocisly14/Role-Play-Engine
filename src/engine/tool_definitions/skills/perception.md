---
id: perception
title: Perception
description: "Noticing things that are physically hidden or deliberately concealed — secret doors and compartments, hidden intruders or ambushers, inconspicuous physical clues, disguises, or small details out of place in the immediate environment. Does NOT cover hearing sounds (Listen), identifying symbols/records/artifacts (Occult/Research/Archaeology/Law/History), tracking trails (Track), or reading people (Psychology)."

skillCheck:
  skill: Perception
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject:
      - actor
    fields:
      actor:
        - id
        - name
        - conditions
  scene:
    inject:
      - current
    fields:
      - id
      - name
      - description
      - conditions
      - items
      - connections
  item:
    inject:
      - sceneItems

outputSchema:
  presets: [default]
  use:
    - item.modify
    - memory.information

interpreter:
  examples:
    - "Check the walls for a hidden door"
    - "Search the desk for a hidden compartment"
    - "Notice the bloodstain on the carpet"
    - "Spot someone hiding in the shadows"
    - "Find the concealed trapdoor under the rug"
---

# Perception Resolution Guidance

## On Success

- **Regular success**: The actor notices something that was not immediately obvious — a hidden object, a displaced item, a detail out of place, or a clue relevant to the current situation. Record the discovery as memory.information; if the search itself is notable, the attempt can also be retained as memory.event. Update item or scene state accordingly.
- **Hard success**: The actor finds what they were looking for and also spots additional contextual details — the age of a disturbance, signs of struggle, fingerprints, or the direction something was moved. This provides richer investigative context beyond the primary find and may justify scene.condition or item.modify updates.
- **Extreme success**: The actor perceives the full picture of what occurred in the scene. They may reconstruct the sequence of events from physical evidence, locate multiple hidden items, or notice a detail of profound significance that would otherwise require a separate investigation. Record the important finding as memory.information and apply any matching scene or item changes.

## On Failure

- The actor finds nothing useful during their search. Hidden objects remain hidden; clues go unnoticed.
- On a partial failure, the actor may spend meaningful time searching without result — apply character.fatigue if the search was physically demanding or time-consuming.
- The actor cannot be certain whether there is nothing to find or whether they simply missed it. The GM may describe a fruitless but believable search to obscure this ambiguity.
- A second Perception attempt is allowed only if the actor changes their search method, gains a hint, or searches a different area.
