---
id: survival_navigation
title: "Survival & Navigation"
description: "Find a route, endure hostile terrain, and secure necessities outdoors."
durationGuidance:
  default: 15
  range: "3-120"
  notes: "a waypoint check or a quick forage 3-10 min; route plotting or a celestial fix 15-30 min; shelter, water, or a multi-hour survival task 60-120 min"
---

# Survival & Navigation guidance

Use for finding the way and for staying alive outdoors: route
finding, reading terrain and weather, shelter, water, food, and enduring cold
or heat. Terrain, season and equipment set the required level.

## Applicability

- Accepted for orienting without a map or in conditions that defeat one, for
  choosing a viable route, and for securing necessities in the field.
- Rejected for movement whose feasibility and duration the pathfinding and
  movementCost tools already own — consult those first and do not estimate.
- Rejected for tracking a person or animal (Investigation) and for treating
  the injuries exposure causes (Medicine & Psychology).

## Success levels

- **Regular** — The actor knows roughly where they are and which way to go, or
  gets what the body needs for now: fire, water, cover.
- **Hard** — A confident fix and a better route — shorter, safer, or unwatched
  — or provision that lasts beyond the immediate need.
- **Extreme** — The actor reads something out of the ground or sky that
  changes the plan: a way through that nobody uses, weather coming, a source
  where there should be none.

## Failure

- Lost time and no gain: the fix will not resolve, the forage is empty, the
  shelter will not hold. Fatigue accrues and exposure continues.
- **Fumble** — Committed in the wrong direction, or the water and food are
  bad. Move the actor somewhere they did not intend, or apply a real
  condition — dehydration, hypothermia, sickness.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is occurrence
`content`, not a state change.

- `movement.route` — ordinary travel along the actor-stated route;
  `character.position` only for discontinuous displacement.
- `character.fatigue` — always, and exposure accelerates it.
- `character.hp` and `character.addCondition` — dehydration, hypothermia,
  sickness from bad water; `removeCondition` when shelter, fire, or clean
  water actually resolves one.
- `item.create` — foraged food, gathered water, a made fire or shelter;
  `scene.addCondition` when the camp is the thing that persists.
- Knowing where they are is occurrence `content`, not a delta.
