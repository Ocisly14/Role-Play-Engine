---
id: bluff
title: Bluff
description: "Quick deception, misdirection, verbal tricks — lying convincingly in the moment"

skillCheck:
  skill: Bluff
  difficulty: regular
  type: opposed
  opposedDefense:
    - Psychology
    - Perception
  failBehavior: abort

stateDomains:
  character:
    inject:
      - actor
      - targets
    fields:
      actor:
        - id
        - name
        - occupation
        - personality
        - conditions
      targets:
        - id
        - name
        - occupation
        - personality
        - conditions
        - relationship
  scene:
    inject:
      - current
    fields:
      - id
      - name
      - description

outputSchema:
  use:
    - character.condition
    - memory.event
    - memory.information
    - relationship.change

interpreter:
  examples:
    - "Lie and claim to be a police officer"
    - "Make up a reason to deceive the guard"
    - "Bluff my way past the guard by pretending to be a doctor"
---

# Bluff Resolution Guidance

## On Success

- **Regular success**: The target believes the lie or misdirection. They accept the actor's fabricated story and act accordingly — standing aside, providing access, or changing their behavior based on the false information.
- **Hard success**: The target believes the bluff completely and does not question it. Even if later presented with mild contradicting evidence, they initially dismiss it. The false impression persists for a meaningful duration.
- **Extreme success**: The target is fully deceived and may actively reinforce the lie to others. They could unknowingly mislead third parties, compounding the bluff's reach. Record the deception in memory as established false information.

## On Failure

- The target sees through the bluff, recognizing the deception. The actor's credibility is damaged.
- Relationship with the target worsens — they become suspicious or hostile. They may warn others or increase vigilance.
- If the target succeeded on Psychology, they understand the actor was deliberately deceiving them; this may trigger an actively hostile response depending on the target's disposition.
- Re-attempting Bluff on the same target in this scene is at a higher difficulty unless the actor can establish new cover.
