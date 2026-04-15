---
id: electrical_repair
title: Electrical Repair
description: "Repairing electrical devices, wiring, circuits — fixing radios, lights, alarms"

skillCheck:
  skill: Electrical Repair
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
    fields: [id, name, description]
  item:
    inject: [sceneItems, actorInventory]

outputSchema:
  use:
    - item.modify
    - memory.event
    - character.fatigue

interpreter:
  examples:
    - "Fix the broken radio"
    - "Repair the severed electrical circuit"
    - "Repair the broken radio"
---

# Electrical Repair Resolution Guidance

## On Success
- **Regular success**: The device is repaired and returns to functional operation. The fault — a blown fuse, severed wire, burnt component — is identified and corrected using available tools and materials.
- **Hard success**: The repair is clean and thorough. The device functions reliably and the actor identifies the root cause, preventing the same failure from recurring. Minor improvements to performance may be noted.
- **Extreme success**: The actor not only fixes the device but optimizes it. The repaired item operates better than before — improved range for a radio, increased brightness for lights, a disabled alarm circuit that cannot easily be restored by others.

## On Failure
- The device remains broken. The actor cannot identify the fault or lacks the means to fix it with available materials.
- Time and effort are wasted. If the repair was time-critical, this delay has consequences.
- An extreme failure or fumble may worsen the damage — a short circuit, a spark that starts a fire, or the complete destruction of the component being repaired.
- A second attempt may be possible with different tools or additional time, but not in the same immediate circumstances.
