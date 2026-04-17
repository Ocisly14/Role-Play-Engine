---
id: jump
title: Jump
description: "Making an explicit leap across a gap, over an obstacle, or down from a height. Does NOT cover climbing vertical surfaces or swimming."

skillCheck:
  skill: Jump
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, stats, conditions]
  scene:
    inject: [current]
    fields: [id, name, description, conditions, connections]

outputSchema:
  presets:
    - default
  use:
    - character.hp
    - character.position

interpreter:
  examples:
    - "Leap across the gap between the two rooftops."
    - "Jump down from the second-floor window to the alley below."
    - "Vault over the overturned table to reach the door."
    - "Spring across the flooded ditch blocking the path."
---

# Jump Resolution Guidance

## On Success
- **Regular success**: The actor clears the gap, obstacle, or landing distance safely. They land on the other side without injury, though the exertion costs some fatigue.
- **Hard success**: The actor lands cleanly and in a controlled stance, ready to continue moving immediately. No fatigue cost is significant and the landing is silent or precise as needed.
- **Extreme success**: The actor executes the jump with remarkable form — covering extra distance, landing silently, or clearing the gap with enough margin to catch a companion's hand if needed.

## On Failure
- The actor falls short of the destination or lands badly.
- A jump across a gap results in a fall — apply 1d6 HP damage per 3 meters of drop to the surface below.
- A jump from height with a failed roll results in a hard landing — damage based on height fallen.
- A fumble may mean the actor slips at the takeoff point, causing a worse fall or leaving them dangling from a ledge.
- The actor may end up in a prone or injured condition requiring time to recover before further movement.
