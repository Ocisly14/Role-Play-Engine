---
id: swimming
title: "Swimming"
description: "Swim, dive, stay afloat, and act effectively in water."
durationGuidance:
  default: 3
  range: "1-30"
  notes: "a short crossing 1-3 min; a river crossing 5-10 min; a long swim or a rescue 15-30 min"
---

# Swimming guidance

Use for staying up, getting across, going under, and doing anything
useful while in water. Current, cold, darkness, and what the actor is wearing
or carrying decide the difficulty far more than distance does.

## Applicability

- Accepted for swimming, diving, treading water, and acting under or on water,
  including pulling someone else out.
- Rejected for handling a boat (Watercraft Operation) and for dry-land
  movement (Athletics).
- Encumbrance is binding: a clothed, laden actor in cold moving water is at a
  higher required level regardless of how short the crossing looks.

## Success levels

- **Regular** — The actor makes it, winded. Anything loosely held may be gone.
- **Hard** — Made with control: cargo kept, breath kept, arriving able to act
  immediately.
- **Extreme** — The actor manages what the water should not have allowed —
  reaching a person going under, holding a dive long enough to finish the job.

## Failure

- No progress. The actor is swept back, loses the line, or surfaces where they
  started. Fatigue is spent and loose items may be lost to the water.
- **Fumble** — The actor goes under: water inhaled, an HP loss, and a drowning
  or exhaustion condition that persists until someone or something resolves
  it. A rescue attempt that fumbles endangers both.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is an occurrence
fact, not a state change.

- `character.position` — the far bank, the deck, the bottom.
- `character.fatigue` — always, and faster in cold or current.
- `character.hp` and `character.addCondition` — water inhaled, hypothermia,
  exhaustion. These persist until something resolves them.
- `item.move` / `item.destroy` — carried items lost to the water or ruined by
  it. Paper and powder do not survive.
