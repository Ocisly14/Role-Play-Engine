---
id: movement
engine: code
codeSubsystem: movement
title: Movement
description: Move a character to a different location via topology pathfinding. Handled by the CodeEngine movement subsystem (deterministic per-tick processor), not the LLM resolver.

impactHint:
  default: 0

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, position]
    output: [character.position, character.fatigue, memory.event]

outputSchema:
  presets: [default]
  use:
    - character.position
  requireOnSuccess:
    - character.position
---

# Movement

Movement is handled by movementTool (pure code, cross-tick capable) rather than StateResolver.

## On Success
#### character
- `character.position`: updated to the destination
- `character.fatigue`: +1 (if long distance)
- `memory.event`: "Traveled to [destination]"

## On Failure
#### character
- `character.position`: unchanged
- `memory.event`: "Tried to reach [destination] but failed"
