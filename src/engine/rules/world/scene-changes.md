# Scene Changes

Scene changes represent persistent properties of a place, road or passage.
Each entry names the causing `sourceActionId` and its `sceneId`.

## Available operations

- `addCondition {condition:{description, featureId?}}`
- `removeCondition {predicate:{id?, featureId?}}`
- `setDescription {description}`
- `connectionBlock {connectionId, blocked, reason}`
- `connectionConcealed {connectionId, concealed}`
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

Before submitting, compare CURRENT place prose with accepted outcomes AND
accepted character and item changes. Check stated placement, posture, visible
presence and physical condition, including claims with no bracketed reference.
An object's holder or description being corrected does not correct the scene's
sentences about it. If a map was folded and taken off a table, remove the claim
that it is spread there; preserve the table and all other still-true details.
If a person changes position, repair any existing scene sentence that places
them in the old position, without adding a roster of everyone present.

No topology, environment or condition change does NOT mean no description
change. Conversely, do not rewrite a scene whose prose already matches the
accepted facts. Submit `[]` only after checking for obsolete descriptive claims
as well as structural changes. Never invent an event to make old prose true.

## Passages

A connection id identifies one exact passage, not a whole place.

- `connectionBlock` sets or clears whether that passage can be traversed and
  records the objective reason. One flag per passage, three writers — the
  weather engine, scripted events and you — and the last write wins: clearing
  it opens the passage whoever shut it. Use `blocked:false` only when an act
  actually removes the obstacle. A person merely getting past an obstacle that
  stays is `movement.passBlockedConnectionId` on their accepted start — a
  one-walker grant that leaves the passage shut for everybody else. Never both
  for the same passage in one tick: the grant already got that walker through,
  and `blocked:false` beside it says the obstacle is gone when it is not.
- `connectionConcealed {concealed:false}` lays a concealed passage open for
  everyone, as when a wall is broken or the bookshelf is left pushed aside;
  rewrite the place's description to cite where it leads.
- `connectionConcealed {concealed:true}` covers a passage again only when an
  action truly restores or creates concealment.

Finding a concealed passage is not a change here. It is an occurrence the
finder perceives, naming the place it leads to — their own knowledge. Do not
lay a passage open for everyone merely because one character found it.
