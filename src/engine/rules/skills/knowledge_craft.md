---
id: knowledge_craft
title: "Knowledge & Craft"
description: "Apply humanities, law, finance, appraisal, art, and practical craft knowledge to a problem."
durationGuidance:
  default: 10
  range: "1-120"
  notes: "a glance-value appraisal or a date/period identification 1-5 min; a document analysis, ledger audit, or artifact reading 15-30 min; a made object or a full forensic reconstruction 60-120 min"
---

# Knowledge & Craft guidance

Use for learned knowledge and made things: history, law, finance,
anthropology, archaeology, appraisal, and the practical crafts. What the actor
knows or can build is bounded by their background and what is in front of them.

## Applicability

- Accepted for recalling or interpreting human knowledge, valuing an object,
  reading a document for what it means in its field, and making or restoring
  something by hand.
- Rejected for natural-science reasoning (Science & Nature), for finding the
  source in the first place (Investigation), for reading a language the actor
  does not have (Languages), and for repairing machinery (Repair & Engineering).
- Knowledge the setting has no record of cannot be recalled at any success
  level. Say so in the check's `basis` rather than inventing a source.

## Success levels

- **Regular** — The actor places the thing correctly: period, provenance,
  legal effect, rough value, or a serviceable piece of work. Enough to act on,
  short on detail.
- **Hard** — Specifics come with it — the maker, the statute that governs it,
  the discrepancy in the ledger, a piece made well enough to pass inspection.
- **Extreme** — The actor sees what the object or record implies beyond
  itself: who wrote it and why, what is deliberately missing, a piece of work
  that is genuinely superior. Surface it as an occurrence fact.

## Failure

- No usable conclusion. The actor cannot place it, or a made piece comes out
  crude and obviously so. Materials and time are spent either way.
- **Fumble** — A confidently wrong conclusion, or the work is ruined: the
  artifact is damaged, the ledger entry is defaced, the material is wasted.
  Record the damage as a real item change.

## State surface

Typical deltas this domain produces. Not a requirement and never a substitute
for what actually happened — a one-off descriptive result is an occurrence
fact, not a state change.

- `item.create` — a made, forged, or restored object that now exists.
- `item.modify` — an object worked on and still in play; `item.damage` /
  `item.destroy` when the work ruins it or consumes the material.
- Knowing something is NOT a state change. The conclusion is an occurrence
  fact with the actor as perceiver; the character records it or does not.
