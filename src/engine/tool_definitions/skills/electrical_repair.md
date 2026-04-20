---
id: electrical_repair
title: Electrical Repair
description: "Diagnose, fix, modify, or build electrical systems — wiring, circuits, electronics, radios, electrical locks. Does NOT cover passive observation (Spot Hidden) or general physics knowledge (Science: Physics)."

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
  presets: [default, item_modify]
  requireOnSuccess:
    - item.modify
    - scene.condition
  requireOnFailure:
    - item.modify

interpreter:
  examples:
    - "Rewire the fuse box to restore power to the basement"
    - "Diagnose why the monitor circuit has dropped feeds and restore the signal"
    - "Disable the electrical alarm by cutting and bridging the trigger wire"
    - "Build a makeshift transmitter from salvaged components"
    - "Repair the severed wiring in the radio so it can broadcast again"
---

# Electrical Repair Resolution Guidance

## State Changes
- Use `item.modify` for repaired wiring, restored devices, disabled alarms, and similar property changes.
- Use `item.destroy` when a component burns out, shorts, or is ruined during the attempt.
- Use `item.move` when parts are removed, reinstalled, or relocated as part of the repair.
- Use `item.create` only when the actor fabricates or replaces a grounded new component from available materials.
- Use `memory.event` only when the actor learns a concrete diagnostic fact about the fault, wiring layout, or cause of failure.

## On Success
- **Regular success**: The device is repaired and returns to functional operation. The fault — a blown fuse, severed wire, burnt component — is identified and corrected using available tools and materials.
- **Hard success**: The repair is clean and thorough. The device functions reliably and the actor identifies the root cause, preventing the same failure from recurring. Minor improvements to performance may be noted.
- **Extreme success**: The actor not only fixes the device but optimizes it. The repaired item operates better than before — improved range for a radio, increased brightness for lights, a disabled alarm circuit that cannot easily be restored by others.

## On Failure
- The device remains broken. The actor cannot identify the fault or lacks the means to fix it with available materials.
- Time and effort are wasted. If the repair was time-critical, this delay has consequences.
- An extreme failure or fumble may worsen the damage — a short circuit, a spark that starts a fire, or the complete destruction of the component being repaired.
- A second attempt may be possible with different tools or additional time, but not in the same immediate circumstances.
