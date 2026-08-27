---
id: medicine_psychology
title: "Medicine & Psychology"
description: "Provide first aid, diagnose or treat illness, and understand or treat the mind."
durationGuidance:
  default: 10
  range: "1-60"
  notes: "pressure on a wound or a bandage 1-5 min; stabilizing severe bleeding or reaching a proper diagnosis 15-30 min; surgery, prolonged treatment, or a full therapy session 45-60 min"
---

# Medicine & Psychology guidance

Use for keeping a body alive and for treating a mind: field first
aid, diagnosis, sustained treatment, and psychotherapy. Supplies and setting
bound what is achievable — name what is missing when it is.

## Applicability

- Accepted for stopping bleeding, stabilizing, splinting, diagnosing illness or
  injury, administering treatment, and talking someone down or through.
- Rejected for reading someone's intent in conversation (Social) and for
  laboratory analysis of a substance (Science & Nature).
- Without supplies, first aid is improvised at a higher required level and its
  effect is smaller; surgery without instruments is a rejection.

## Success levels

- **Regular** — The patient stops getting worse. Bleeding is halted, the wound
  is dressed, a small amount of HP is recovered and the bleeding condition is
  cleared. A mind is steadied enough to function this scene.
- **Hard** — Swift and correct: the same, plus a secondary problem noticed and
  named, and the patient stable enough to move under their own power.
- **Extreme** — Materially better than the situation allowed — a second
  condition resolved, sanity genuinely steadied rather than postponed, a
  diagnosis that reframes what is happening.

## Failure

- No measurable change. The wound is neither better nor worse, the diagnosis
  will not come, the session does not land. Supplies are consumed regardless.
- **Fumble** — Handled wrongly: a tourniquet too tight, a wound contaminated, a
  session that opens something. Worsen the condition — HP loss, infection, a
  sanity condition — and record it as a persistent character change.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is an occurrence
fact, not a state change.

- `character.hp` — recovered, in the small amounts field treatment allows.
- `character.removeCondition` — bleeding stopped, a break splinted, a panic
  talked down; `character.addCondition` when treatment goes wrong and adds
  infection, shock, or worse.
- `character.san` — steadied by a session, or shaken by what it opened.
- `item.modify` / `item.destroy` — bandages, drugs, and supplies consumed
  whether or not the treatment worked.
- The diagnosis itself is an occurrence fact with the patient and the medic as
  perceivers.
