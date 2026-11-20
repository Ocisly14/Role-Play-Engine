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
  movement runtime already owns; use the supplied graph and route,
  never call nonexistent pathfinding or movement-time tools.
- Rejected for tracking a person or animal (Investigation) and for treating
  the injuries exposure causes (Medicine).

## Success levels

- **Regular** — The actor knows roughly where they are and which way to go, or
  gets what the body needs for now: fire, water, cover.
- **Hard** — A confident fix and a better route — with advantages
  supported by the supplied geography and hazards — or durable provision.
  Do not invent a shortcut or assert that nobody is watching.
- **Extreme** — The actor reads something out of the ground or sky that
  offers a supported option: an existing passage, a weather sign or
  a source the supplied environment can provide. Do not invent topology,
  resources, future weather certainty or the actor's next decision.

## Failure

- Lost time and no gain: the fix will not resolve, the forage is empty, the
  shelter will not hold. Existing exposure can continue; do not duplicate code-owned fatigue or hazards.
- **Fumble** — An erroneous bearing or spoiled provision can follow where
  the method supports it. Do not choose a new travel route or teleport the
  actor for a navigation error. Illness requires actual consumption or exposure,
  not merely finding questionable water.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is occurrence
`content`, not a state change.

- `movement.route` — ordinary travel along the actor-stated route;
  `character.position` only for discontinuous displacement.
- `character.fatigue` — supported exertion not already applied by code.
- `character.hp` and `character.addCondition` — dehydration, hypothermia,
  sickness from bad water; `removeCondition` when shelter, fire, or clean
  water actually resolves one.
- `item.create` — foraged food, gathered water, a made fire or shelter;
  `scene.addCondition` when the camp is the thing that persists.
- Knowing where they are is occurrence `content`, not a delta.
