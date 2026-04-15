---
id: medicine
title: Medicine
description: "Professional medical knowledge and practice — surgery, diagnosis, treatment"

skillCheck:
  skill: Medicine
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
  use:
    - character.hp
    - character.condition
    - memory.event
    - character.fatigue

interpreter:
  examples:
    - "Perform surgical treatment"
    - "Diagnose the patient's condition"
    - "Perform medical treatment on the patient"
---

# Medicine Resolution Guidance

## On Success
- regular success: The investigator diagnoses the condition correctly and provides effective treatment. The patient recovers 1d3 HP and a serious condition such as "infected," "broken bone," or "poisoned" is treated — not cured, but stabilized and on a path to recovery over the following days.
- hard success: The treatment is precise and professional. The patient recovers 1d3 HP, the primary serious condition is actively treated, and the investigator identifies any complications that would otherwise have gone unnoticed. Recovery time is significantly reduced.
- extreme success: The medical intervention is exceptional. The patient recovers 1d3+1 HP, all acute serious conditions are addressed, and the investigator performs the procedure in a way that minimizes scarring, re-injury risk, or long-term complications. Given available resources, this is the best possible outcome.

## On Failure
- The treatment is ineffective. The patient's HP and conditions remain unchanged — the diagnosis was incomplete or the procedure could not be completed properly under the circumstances.
- On a fumble, the treatment worsens the patient's condition. A surgical error, a misdiagnosis leading to contraindicated treatment, or an adverse reaction causes the patient to lose 1 HP or gain an additional condition such as "infection."
