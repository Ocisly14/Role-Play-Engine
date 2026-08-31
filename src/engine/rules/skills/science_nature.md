---
id: science_nature
title: "Science & Nature"
description: "Apply natural history and scientific reasoning, including biology, chemistry, and physics."
durationGuidance:
  default: 10
  range: "1-60"
  notes: "a quick specimen or reagent identification 3-5 min; a measurement, assay, or dissection 15-30 min; a synthesis or extended study 45-60 min"
---

# Science & Nature guidance

Use for reasoning about the natural world and for the procedures that
test it: biology, chemistry, physics, and field natural history. Equipment and
sample quality bound the result as hard as the roll does.

## Applicability

- Accepted for identifying substances, organisms, and phenomena; for
  calculating a physical result; and for the bench work that produces one.
- Rejected when the actor lacks the equipment or reagent the procedure needs —
  state the missing thing — and for medical treatment of a person
  (Medicine & Psychology) or supernatural phenomena (Occult).
- A phenomenon with no natural explanation does not acquire one on a good
  roll. The correct outcome is a precise account of what it is NOT.

## Success levels

- **Regular** — Correct identification or a usable number, with the confidence
  the method allows.
- **Hard** — The result plus its significance: the concentration, not just the
  substance; the mechanism, not just the effect.
- **Extreme** — The actor gets an answer the method should not quite reach —
  an anomaly worth pursuing, a contamination that points somewhere, a
  prediction that will hold.

## Failure

- Inconclusive. The sample says nothing, or the calculation will not close.
  Consumed reagents are gone.
- **Fumble** — A wrong result taken as right, or the procedure goes physically
  wrong: a spill, a fire, a broken instrument, an exposure. Apply the real
  consequence to scene or character, not just to the finding.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is an occurrence
fact, not a state change.

- `item.modify` / `item.destroy` — reagents and samples consumed by the
  procedure, and equipment used up.
- `item.create` — a synthesized or isolated substance.
- `scene.environmentHazard` — a spill, fumes, or a fire the procedure starts;
  `scene.addCondition` for the lasting mess.
- `character.hp` / `character.addCondition` — exposure, burns, poisoning.
- The finding itself is an occurrence fact, not a delta.
