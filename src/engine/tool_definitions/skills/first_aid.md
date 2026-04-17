---
id: first_aid
title: First Aid
description: "Emergency field treatment — bandaging wounds, stopping bleeding, and stabilizing an injured person on the spot. Does NOT cover professional diagnosis, surgery, or prescription (Medicine)."

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
  presets: [default]
  use:
    - character.hp
    - character.condition

interpreter:
  examples:
    - "Apply pressure to stop the victim's arterial bleeding"
    - "Bandage the gunshot wound before the patient loses any more blood"
    - "Splint the broken arm so the investigator can keep moving"
    - "Stabilize the unconscious man before he goes into shock"
---

# First Aid Resolution Guidance

## On Success
- regular success: The investigator stabilizes the patient effectively — wounds are bandaged, bleeding is halted, and the patient's condition is no longer deteriorating. The target recovers 1 HP and the "bleeding" condition is removed if present.
- hard success: The treatment is swift and efficient. The patient recovers 1 HP, the "bleeding" condition is removed, and the investigator identifies any secondary injuries that require attention. The patient is stable and alert enough to move.
- extreme success: The first aid is remarkably effective given the circumstances. The patient recovers 1 HP, all bleeding stops, and a minor condition such as "shocked" or "winded" is also resolved. The investigator's calm and competent manner also helps steady the patient.

## On Failure
- The treatment provides no measurable improvement. The wound remains as it was — neither worsening nor improving. The patient's HP and conditions are unchanged.
- The investigator has used up medical supplies without result. On a fumble, the wound is handled incorrectly — a tourniquet applied too tightly, a wound contaminated — and the patient's condition may worsen.
