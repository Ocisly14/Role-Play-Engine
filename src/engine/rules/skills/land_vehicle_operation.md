---
id: land_vehicle_operation
title: "Land Vehicle Operation"
description: "Drive cars, motorcycles, trucks, and heavy land machinery."
durationGuidance:
  default: 5
  range: "1-30"
  notes: "a single tense maneuver or lift 1-3 min; a pursuit, evasion, or sustained operation 5-15 min; a long haul or a complex excavation run 20-30 min"
---

# Land Vehicle Operation guidance

Use for driving and for running heavy land machinery: cars,
motorcycles, trucks, cranes, tractors. Road surface, load, visibility and the
vehicle's condition are inputs to the required level.

## Applicability

- Accepted for maneuvers that can fail — pursuit, evasion, bad conditions,
  precise placement of a heavy machine — and for operating machinery the actor
  is not obviously trained on.
- Rejected for routine travel with nothing pressing it: that is movement, and
  duration comes from movementCost, not from a check.
- Rejected for fixing the vehicle (Repair & Engineering) and for boats or
  aircraft (their own domains).

## Success levels

- **Regular** — The maneuver comes off. The vehicle ends where the actor
  intended, with wear and noise.
- **Hard** — Controlled and quick: distance opened on a pursuer, a load placed
  exactly, no damage taken.
- **Extreme** — Something the vehicle should not have done — a gap taken, a
  skid held, a lift that clears by inches.

## Failure

- The maneuver does not come off: ground lost, the vehicle stalls, the load
  swings wide. The actor keeps control but not the advantage.
- **Fumble** — A collision or a rollover. Damage the vehicle, apply HP loss to
  occupants proportional to speed, and change the scene where it happened —
  blocked road, wreck, fire risk. Bystanders perceive it.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is occurrence
`content`, not a state change.

- `movement.route` with `vehicleId` — ordinary travel by the vehicle;
  occupants remain in its interior scene. Use `character.position` only for
  boarding, leaving or discontinuous displacement.
- `item.set` / `item.destroy` — the vehicle itself, and its cargo.
- `character.hp` and `character.addCondition` — a collision injures occupants
  in proportion to speed.
- `scene.addCondition` and `scene.connectionBlock` — a wreck that blocks the
  road; `scene.environmentHazard` for spilled fuel or fire.
