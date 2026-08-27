---
id: athletics
title: "Athletics"
description: "Climb, jump, run, throw, ride, and perform other non-swimming physical feats."
durationGuidance:
  default: 3
  range: "1-30"
  notes: "a single leap, throw, or evasion about 1 min; a wall to climb or a brief mounted maneuver 3-5 min; a technical climb or an endurance ride 15-30 min"
---

# Athletics guidance

Use for what the body does on land: climbing, jumping, running,
throwing, riding, and dodging. Load, footing, weather and injury bound the
attempt as much as skill does — say which one is binding.

## Applicability

- Accepted for feats of strength, agility, and balance, for getting a body or
  an object across a gap, and for evading a physical attack.
- Rejected in water (Swimming) and for moving through a place the movement
  runtime already handles — ordinary travel between locations is not an
  Athletics check, it is pathfinding.
- Fatigue is a real input. A heavily fatigued actor attempting a demanding
  feat justifies a higher required level.

## Success levels

- **Regular** — The feat comes off. The actor is where they meant to be, or
  the throw lands where aimed, at the cost of breath.
- **Hard** — Cleanly and fast, with something to spare: quietly, without
  dropping what they carry, or with enough control to keep going immediately.
- **Extreme** — Beyond what the situation seemed to allow — a hold that should
  not have held, a throw that lands exactly, ground covered ahead of pursuit.

## Failure

- The actor does not get there. They fall back to where they started, the
  throw goes wide, the mount refuses. Fatigue is spent regardless.
- **Fumble** — A fall or a wrench. Apply real HP loss or an injury condition
  proportional to the height and surface, and put the actor where the fall
  actually leaves them.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is an occurrence
fact, not a state change.

- `character.position` — the actor got where they were going.
- `character.fatigue` — spent on every attempt, success or not.
- `character.hp` and `character.addCondition` — a fall, a wrench, a broken
  bone. Put the actor where the fall leaves them.
- `item.move` — a thrown or dropped object; `item.damage` when it lands hard.
- `scene.addCondition` — a rope left hanging, a railing broken through.
