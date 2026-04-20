---
id: psychoanalysis
title: Psychoanalysis
description: "Conduct long-term therapeutic treatment to recover Sanity and resolve mental disorders over multiple sessions of days or weeks. Does NOT cover Psychology (single-session insight), Persuade (rational argument), or Charm (social warmth)."

skillCheck:
  skill: Psychoanalysis
  difficulty: hard
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, conditions, inventory]
      targets: [id, name, stats, conditions]
  scene:
    inject: [current]
    fields: [id, name, description]

outputSchema:
  presets: [default]
  use:
    - character.san
    - character.condition
  requireOnSuccess:
    - character.san
  durationGuidance:
    default: 30
    range: "15-60"
    notes: "brief therapeutic session 15-20 min; proper session 30-45 min; deep regression 60 min"

interpreter:
  examples:
    - "Conduct a structured therapy session to treat the investigator's acute trauma and recover Sanity"
    - "Systematically work through the patient's phobia over several sessions to resolve the mental disorder"
    - "Guide the traumatized witness through clinical psychoanalysis to clear the indefinite insanity condition"
    - "Perform therapeutic analysis to help the patient process repressed memories and regain psychological stability"
---

# Psychoanalysis Resolution Guidance

## On Success
- regular success: The investigator helps the patient process their trauma. The patient recovers 1d3 SAN and one acute mental condition — "terrified," "shaken," or "hysterical" — is resolved. The patient is calmer and capable of functioning again, though underlying trauma remains.
- hard success: The session breaks through to a deeper level. The patient recovers 1d3 SAN, the acute mental condition is resolved, and the investigator also identifies the root psychological mechanism driving the patient's distress.
- extreme success: The therapeutic intervention is transformative. The patient recovers 1d3+1 SAN, all acute mental conditions are cleared, and the patient gains a temporary sense of psychological resilience. The investigator may also uncover a repressed memory relevant to the case — something the patient witnessed but could not consciously hold.

## On Failure
- The session yields no therapeutic improvement. The patient's SAN and conditions remain unchanged — the walls are too high, the trauma too raw, or trust could not be established in the time available.
- On a fumble, the session inadvertently destabilizes the patient further. The investigator presses too hard on a wound that was not ready to be opened. The patient loses 1 SAN or gains an additional mental condition such as "withdrawn" or "paranoid."
