---
id: locksmith
title: Locksmith
description: "Picking locks, understanding security systems — bypassing physical security"

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
  use:
    - scene.condition
    - item.modify
    - memory.event
    - character.fatigue

interpreter:
  examples:
    - "Pick the lock"
    - "Use tools to open the safe"
    - "Pick the lock on the cabinet"
---

# Locksmith Resolution Guidance

## On Success
- **Regular success**: The lock yields to the actor's tools and technique. The door, cabinet, or container is opened without permanent damage. The time taken is proportional to the lock's complexity.
- **Hard success**: The actor opens the lock quickly and cleanly, leaving no obvious signs of tampering. The lock mechanism is undamaged and could be re-locked behind them if needed.
- **Extreme success**: The actor defeats the lock with expert efficiency — possibly identifying it as a specific model and knowing its weakness immediately. They may open it in seconds and could now reproduce the key from memory or tool marks.

## On Failure
- The lock does not open. The tumblers refuse to align, the combination eludes the actor, or the mechanism is beyond their current toolkit.
- Time is spent fruitlessly, which may have consequences in time-sensitive situations.
- A fumble means a tool breaks off inside the lock, jamming it permanently or making it impossible to open at all — even with a key. The scene's condition for that lock changes to damaged or destroyed.
- If the lock is alarmed or monitored, a failure may trigger an alert depending on how the attempt was made.
