---
id: navigate
title: Navigate
description: "Determining direction and plotting courses using maps, compasses, stars, and landmarks across any terrain. Does NOT cover plant/animal knowledge (Natural World), tracking (Track), or terrain-specific survival."

skillCheck:
  skill: Navigate
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, conditions, inventory]
  scene:
    inject: [current]
    fields: [id, name, description, conditions, connections]

outputSchema:
  presets: [default]

interpreter:
  examples:
    - "Use a compass and topographic map to determine which valley leads toward the town."
    - "Orient by the position of the stars to maintain a heading north across the open moor."
    - "Identify the river bend on the map to confirm the group's current position."
    - "Plot a safe route around the flooded lowlands using landmarks visible from the hilltop."
    - "Correct course after the group drifted off-trail in heavy fog by retracing to a known landmark."
---

# Navigate Resolution Guidance

## On Success
- **Regular success**: The actor determines the correct route or current position. Using a map, compass, stars, or landmarks, they orient themselves and can guide the group toward the destination without becoming lost. The route can be retained as usable information.
- **Hard success**: The actor plots an efficient route that avoids obvious hazards or delays. They identify landmarks that will make the journey straightforward and can correct course if minor deviations occur.
- **Extreme success**: The actor has a precise and detailed understanding of their position and the terrain ahead. They identify shortcuts, safe shelter locations, or potential hazards along the route that a less skilled navigator would miss entirely, and the knowledge is retained for later use.

## On Failure
- The actor misjudges their position or chooses the wrong route. The group travels in the wrong direction or takes a significantly longer path.
- Time is lost — potentially hours in wilderness navigation or critical minutes in an urgent escape.
- A fumble means the actor is confidently wrong: they lead the group deeper into danger, away from the destination, or into terrain that is impassable or hazardous.
- Repeated navigation failures in the same environment may exhaust the group, accumulating fatigue or triggering other survival checks.
