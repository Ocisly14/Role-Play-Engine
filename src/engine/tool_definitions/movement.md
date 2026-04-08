---
id: movement
title: Movement
description: Move a character to a different location via topology pathfinding. Handled by movementTool (pure code), not StateResolver.

impactHint:
  default: 0

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, position]
    output: [position, fatigueDelta, memory]
---

# Movement

Movement is handled by movementTool (pure code, cross-tick capable) rather than StateResolver.

## On Success
#### character
- Position updated to destination
- fatigue: +1 (if long distance)
- memory: "Traveled to [destination]"

## On Failure
#### character
- Position unchanged
- memory: "Tried to reach [destination] but failed"
