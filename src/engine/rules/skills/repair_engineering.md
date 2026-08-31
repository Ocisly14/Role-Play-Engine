---
id: repair_engineering
title: "Repair & Engineering"
description: "Diagnose, repair, improvise, and operate technical or mechanical equipment."
durationGuidance:
  default: 15
  range: "3-60"
  notes: "swap a fuse or make a quick adjustment 3-10 min; trace a fault or replace a part 15-30 min; rewire a system or rebuild an assembly 45-60 min"
---

# Repair & Engineering guidance

Use for diagnosing, fixing, improvising, and operating technical and
mechanical equipment — electrical and mechanical alike. Parts and tools are as
binding as skill: name what is missing when something is.

## Applicability

- Accepted for finding the fault, effecting the repair, jury-rigging a
  substitute, and running machinery that needs technique rather than a
  licence.
- Rejected for bypassing a lock as a security problem (Stealth & Security),
  for driving a vehicle (Land Vehicle Operation), and for building an object
  as craft rather than as a mechanism (Knowledge & Craft).
- A repair with no parts available is not a repair. It is either an
  improvisation with a stated compromise, or a rejection.

## Success levels

- **Regular** — It works again, or works well enough. An improvisation carries
  a named limitation — it will hold for a while, it will not take load.
- **Hard** — Properly fixed and faster than expected. The fault is understood,
  not just cleared, so it will not recur for the same reason.
- **Extreme** — Restored beyond its prior state, or a genuine improvisation out
  of what was at hand that nobody would expect to work.

## Failure

- The fault stands. Time and any consumed parts are gone, and the actor may
  have narrowed it down without fixing it.
- **Fumble** — The equipment is made worse: a part shears, a short is created,
  a working subsystem is broken in the attempt. Apply the item damage, and
  where the machine was doing something, stop it.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is an occurrence
fact, not a state change.

- `item.modify` — repaired, adjusted, or jury-rigged with its stated
  limitation; `item.damage` / `item.destroy` when the attempt makes it worse.
- `item.create` — an improvised part made from what was at hand.
- `scene.removeCondition` / `scene.addCondition` — power restored and the dark
  lifted, or a machine now running and audible.
- `scene.connectionBlock` — a door, gate, or shutter mechanism that now opens
  or no longer does.
- `character.fatigue` — sustained work costs it.
