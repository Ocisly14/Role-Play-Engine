---
id: movement
engine: code
codeSubsystem: movement
title: Movement
description: >
  Move a character to a DIFFERENT scene / junction / road via topology pathfinding.
  Handled by the CodeEngine movement subsystem, not the LLM resolver. Must include
  a `destination` field with a location id chosen from the Known Locations list in
  the system prompt (output the id, never the display name; the narrative may name
  the place informally or in another language — pick the best-matching listed id).
  Intra-scene motion (approaching, stepping closer, leaning, walking within
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
