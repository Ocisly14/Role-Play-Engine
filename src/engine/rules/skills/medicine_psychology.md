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
  injury, and administering treatment.
- Talking someone down or reading their intent is interpersonal and needs no
  check. Laboratory analysis of a substance uses Science & Nature.
- Without supplies, first aid is improvised at a higher required level and its
  effect is smaller; surgery without instruments is a rejection.

## Success levels

- **Regular** — Resolve the specific feasible treatment: pressure may stop
  bleeding, a dressing may protect the wound, a splint may support the limb.
  These are not automatic HP recovery, a healed fracture or all conditions
  cleared. A diagnosis yields supported findings.
- **Hard** — More precise work within the same assessed time and resources.
  Notice a secondary problem only if evidence supports it; do not automatically
  make the patient ambulatory.
- **Extreme** — The best feasible treatment or most discriminating supported
  diagnosis. Do not exceed physiology, available supplies or elapsed time,
  invent another illness, restore SAN, or lift a code-timed SAN consequence.

## Failure

- No measurable change or supported diagnosis. Record only supplies actually used, in representable amounts; do not destroy
  an entire medical kit to account for one dressing.
- **Fumble** — Handled wrongly: a tourniquet too tight, a wound contaminated, a
  concrete harmful intervention. Record only proportionate bodily harm or an
  independently verifiable major impairment with a supported cause. A difficult
  conversation alone does not license infection, psychological injury or SAN loss.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is occurrence
`content`, not a state change.

- `character.hp` — recovered, in the small amounts field treatment allows.
- `character.removeCondition` — an existing bleeding condition actually resolved; a splint does
  not remove a fracture or its remaining functional limitations;
  `character.addCondition` when treatment goes wrong and adds an objective,
  major impairment such as infection, circulatory shock, loss of limb use, or
  severe disorientation. Anxiety or feeling calmer is not a condition.
- `item.set` / `item.destroy` — bandages, drugs, and supplies consumed
  only to the extent actually used, whether or not the treatment worked.
- `character.setAppearance` — repair an existing claim of active bleeding or
  an untreated wound when treatment changed it; preserve unrelated injuries.
  Dressings do not require a new major-impairment condition.
- The diagnosis itself is occurrence `content`, with the patient and the medic
  in `perceivers` when both actually receive it, each at the grade their
  evidence supports.
