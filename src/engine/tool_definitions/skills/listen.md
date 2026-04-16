---
id: listen
title: Listen
description: "Hearing sounds, eavesdropping, detecting noises from adjacent areas"

skillCheck:
  skill: Listen
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject:
      - actor
    fields:
      actor:
        - id
        - name
        - conditions
  scene:
    inject:
      - current
    fields:
      - id
      - name
      - description
      - conditions
      - connections

outputSchema:
  presets: [default]
  use:
    - memory.information

interpreter:
  examples:
    - "Press my ear against the door to eavesdrop on the conversation inside"
    - "Listen carefully for any footsteps nearby"
    - "Listen at the door to hear what they're saying"
---

# Listen Resolution Guidance

## On Success

- **Regular success**: The actor hears something meaningful — fragments of conversation, distinctive footsteps, a specific sound that reveals activity nearby. Record the useful content as memory.information; the listening attempt itself can remain as memory.event when that matters.
- **Hard success**: The actor hears clearly and comprehensively. Full sentences are understood, the number of speakers can be estimated, and the emotional tone (argument, whispering, laughter) is apparent. The information gathered is actionable and reliable.
- **Extreme success**: The actor catches every word or sound in perfect clarity, including hushed details or sounds beneath ambient noise. They may overhear a key piece of information — a name, a location, a secret — that significantly advances their understanding of the situation.

## On Failure

- The actor hears nothing useful. Ambient noise, distance, or poor acoustics obscure whatever sounds exist.
- On a partial failure, the actor may hear something ambiguous — a muffled noise that could be voices or movement — but cannot extract meaningful information from it.
- Prolonged or strained listening in difficult conditions may apply character.fatigue, especially if the actor held still or concentrated for an extended period.
- If the actor's own noise or movement interfered, there is a chance those inside or nearby noticed them instead.
