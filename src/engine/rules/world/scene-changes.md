# Scene Changes

Scene changes represent persistent properties of a place, road or passage.
Each entry names the causing `sourceActionId` and its `sceneId`.

## Available operations

- `addCondition {condition:{description, featureId?}}`
- `removeCondition {predicate:{id?, featureId?}}`
- `setSetting {setting}`
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

## Whole-setting replacement

A place's `setting` is the place itself: size, layout, materials, fixtures and
ways out — what is true of it at 3 a.m., empty, in any weather. It cites only
fixtures and the places it leads to. Who is here, what they are doing, the
light, the weather, loose things and conditions are not in it: those live in
their own state and are rendered from it.

`setSetting` replaces the whole setting, and only the place itself changing
calls for it: a window smashed, a wall scorched, a fixture torn out or put
in, a concealed passage laid open. Preserve everything still true, including
every valid `[reference-id]`, and drop the citation of a fixture that is
gone. It changes the setting, not topology or item ownership; pair it with
the structural operation that caused it.

Never rewrite a setting because someone moved, sat down, left, or because a
loose thing was picked up or set down — positions, people and loose things
are not in it. Never write the hour, the crowd, the weather or what someone
is doing into it. Submit `[]` when the place itself did not physically change.

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
  rewrite the place's setting (`setSetting`) to cite where it leads.
- `connectionConcealed {concealed:true}` covers a passage again only when an
  action truly restores or creates concealment.

Finding a concealed passage is not a change here. It is an occurrence the
finder perceives, naming the place it leads to — their own knowledge. Do not
lay a passage open for everyone merely because one character found it.
