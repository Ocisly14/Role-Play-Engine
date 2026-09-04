# Scene Changes

Scene changes represent persistent properties of a place, road or passage.
Each entry names the causing `sourceActionId` and its `sceneId`.

## Available operations

- `addCondition {condition:{description, featureId?}}`
- `removeCondition {predicate:{id?, featureId?}}`
- `setDescription {description}`
- `connectionBlock {connectionId, blocked, reason}`
- `connectionDiscovered {connectionId, characterIds}`
- `connectionHidden {connectionId, hidden}`
- `environmentContribute {quantity, value}`, where quantity is `temperature`,
  `illumination`, `oxygen` or `noise`
- `environmentHazard {add?, remove?}` — at least one of the two; an
  operation that adds and removes nothing changes nothing

## Conditions and environment

Use a scene condition for a lasting, objectively present circumstance. Use an
environment contribution only for the numeric environmental quantity it owns,
and a hazard operation for named airborne or environmental hazards. Do not
encode the same change redundantly in several operations.

Conditions produced and expired by deterministic subsystems remain owned by
those subsystems. Do not imitate their mechanical fields or remove them without
an action-supported cause.

## Whole-description replacement

`setDescription` replaces the complete place prose. Preserve everything still
true, including every valid `[reference-id]`, and remove references to things
that are no longer visibly present. It changes description, not topology or
item ownership; pair it with the structural operation that caused the rewrite.

## Passages

A connection id identifies one exact passage, not a whole place.

- `connectionBlock` sets or clears whether that passage can be traversed and
  records the objective reason. One flag per passage, three writers — the
  weather engine, scripted events and you — and the last write wins: clearing
  it opens the passage whoever shut it. Use `blocked:false` only when an act
  actually removes the obstacle; a person getting past an obstacle that stays
  is `movement.passBlockedConnectionId` on their movement (see
  `movement-and-position.md`).
- `connectionDiscovered` records which characters learned about a still-hidden
  passage. Include everyone who could discover it from the event, not only the
  actor.
- `connectionHidden {hidden:false}` reveals the passage to the world, as when a
  wall is broken or a concealed door is left openly exposed.
- `connectionHidden {hidden:true}` conceals a passage only when an action truly
  restores or creates concealment.

Private discovery and public revelation are different changes. Do not reveal a
passage globally merely because one character found it.
