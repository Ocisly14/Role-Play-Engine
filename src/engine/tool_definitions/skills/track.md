---
id: track
title: Track
description: "Following physical trails left by people or animals — footprints, disturbed vegetation, blood drops, or other signs of passage through terrain. Does NOT cover stationary visual searching (Perception/Spot Hidden), identifying criminal methods (Criminology), or hearing movement (Listen)."

skillCheck:
  skill: Track
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
      - connections

outputSchema:
  presets: [default]
  use:
    - memory.information
  requireOnSuccess:
    - memory.information

interpreter:
  examples:
    - "Follow the muddy footprints leading into the woods"
    - "Determine how many people passed through here and which direction they went"
    - "Pick up the trail again after it disappears into the stream"
    - "Read the tracks to tell whether the animal was running or walking"
---

# Track Resolution Guidance

## On Success

- **Regular success**: The actor successfully identifies and follows a trail. They determine the direction of travel and can proceed to the next location along the quarry's path. Record the trail details as memory.information — footprint type, gait, approximate time since passage — and keep the tracking attempt itself as memory.event if it is worth remembering.
- **Hard success**: The actor reads the trail with expertise. Beyond direction, they can infer the quarry's physical state (injured, hurrying, carrying a load), the number of individuals, and whether the quarry was aware of being followed. The trail leads clearly to a specific connected scene.
- **Extreme success**: The actor reconstructs the quarry's full route and intent from the physical evidence. They may anticipate where the quarry was heading, discover a shortcut to intercept them, or uncover a secondary trail (a dropped item, a hidden cache) that reveals additional information.

## On Failure

- The actor loses the trail. Signs of passage become too faint, too disturbed, or too intermixed with other tracks to follow reliably.
- On a partial failure, the actor spends time pursuing a trail that leads nowhere or follows the wrong path — apply character.fatigue for the wasted effort and time.
- Poor environmental conditions (rain, wind, foot traffic) may make re-attempting Track impossible in this scene without new information about the quarry's likely destination.
- If tracking through multiple connected scenes, failure at any point may require the actor to backtrack and try a different approach.
