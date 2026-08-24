---
id: movement
engine: code
codeSubsystem: movement
title: Movement
description: >
  Move a character to a DIFFERENT scene / junction / road via topology pathfinding.
  Handled by the CodeEngine movement subsystem, not the LLM resolver. Must include
  a `destination` field with the target location id taken literally from the action
  text. Intra-scene motion (approaching, stepping closer, leaning, walking within
  the same room) is NOT movement — fold it into the surrounding beat's text.

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
