---
id: locksmith
title: Locksmith
description: "Bypass, pick, or crack physical locks and safes using lockpicking tools or safecracking techniques. Does NOT cover repairing lock mechanisms (Mechanical Repair) or defeating electrical alarm systems (Electrical Repair)."

skillCheck:
  skill: Locksmith
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
    fields: [id, name, description, conditions, items]
  item:
    inject: [sceneItems, actorInventory]

outputSchema:
  presets: [default, item_modify]
  requireOnSuccess:
    - scene.condition
    - item.modify
  requireOnFailure:
    - item.modify

interpreter:
  examples:
    - "Pick the padlock on the warehouse door using a tension wrench and pick"
    - "Crack the combination safe by feel to find the correct dial positions"
    - "Bypass the lock trap on the chest before it can trigger"
    - "Probe the cabinet lock's tumblers to identify its type and force it open"
    - "Rake the cheap pin-tumbler lock open in under a minute"
---

# Locksmith Resolution Guidance

## State Changes
- Use `scene.condition` for the opened, jammed, or permanently blocked state of the door, safe, cabinet, or lockable passage.
- Use `item.modify` when the physical lock, latch, keyway, or alarmed hardware is altered but remains in play.
- Use `item.destroy` if the lock mechanism or a delicate tool breaks beyond recovery.
- Use `item.move` only when the attempt dislodges a removable locking part or physically frees an item trapped by the lock.
- Use `item.create` only when the attempt physically produces a new loose part, broken fragment, or improvised bypass piece.
- Use `memory.event` only when the actor learns a concrete fact about the lock, alarm, or security mechanism.

## On Success
- **Regular success**: The lock yields to the actor's tools and technique. The door, cabinet, or container is opened without permanent damage. The time taken is proportional to the lock's complexity.
- **Hard success**: The actor opens the lock quickly and cleanly, leaving no obvious signs of tampering. The lock mechanism is undamaged and could be re-locked behind them if needed.
- **Extreme success**: The actor defeats the lock with expert efficiency — possibly identifying it as a specific model and knowing its weakness immediately. They may open it in seconds and could now reproduce the key from memory or tool marks.

## On Failure
- The lock does not open. The tumblers refuse to align, the combination eludes the actor, or the mechanism is beyond their current toolkit.
- Time is spent fruitlessly, which may have consequences in time-sensitive situations.
- A fumble means a tool breaks off inside the lock, jamming it permanently or making it impossible to open at all — even with a key. The scene's condition for that lock changes to damaged or destroyed.
- If the lock is alarmed or monitored, a failure may trigger an alert depending on how the attempt was made.
