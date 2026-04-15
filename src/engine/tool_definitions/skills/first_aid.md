---
id: first_aid
title: First Aid
description: "Emergency medical treatment — bandaging wounds, stopping bleeding, basic stabilization"

skillCheck:
  skill: First Aid
  difficulty: regular
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
    - "Bandage the injured person's wound"
    - "Perform emergency bleeding control"
    - "Bandage the wound to stop the bleeding"
---

# First Aid Resolution Guidance

## On Success
- regular success: The investigator stabilizes the patient effectively — wounds are bandaged, bleeding is halted, and the patient's condition is no longer deteriorating. The target recovers 1 HP and the "bleeding" condition is removed if present.
- hard success: The treatment is swift and efficient. The patient recovers 1 HP, the "bleeding" condition is removed, and the investigator identifies any secondary injuries that require attention. The patient is stable and alert enough to move.
- extreme success: The first aid is remarkably effective given the circumstances. The patient recovers 1 HP, all bleeding stops, and a minor condition such as "shocked" or "winded" is also resolved. The investigator's calm and competent manner also provides a morale effect on the patient and any witnesses.

## On Failure
- The treatment provides no measurable improvement. The wound remains as it was — neither worsening nor improving. The patient's HP and conditions are unchanged.
- The investigator has used up medical supplies without result. On a fumble, the wound is handled incorrectly — a tourniquet applied too tightly, a wound contaminated — and the patient's condition may worsen.
