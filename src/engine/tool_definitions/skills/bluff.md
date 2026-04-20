---
id: bluff
title: Bluff
description: "Fast Talk a target with quick lies or misdirection that are believed in the moment but may not hold up later. Does NOT cover Charm (genuine warmth), Intimidate (threats), or Persuade (rational argument)."

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
    - relationship.change
  requireOnSuccess:
    - relationship.change
  durationGuidance:
    default: 2
    range: "1-5"
    notes: "quick cover story 1-2 min; sustained deception 3-5 min"

interpreter:
  examples:
    - "Lie that I am a police detective to talk my way past the gate"
    - "Make up a fabricated errand to misdirect the suspicious guard"
    - "Fast-talk the receptionist with a plausible-sounding false story to gain entry"
    - "Invent a fake authority figure to deflect the shopkeeper's questions"
---

# Bluff Resolution Guidance

## On Success

- **Regular success**: The target believes the lie or misdirection. They accept the actor's fabricated story and act accordingly — standing aside, providing access, or changing their behavior based on the false information. Record the exchange and any concrete accepted claims as memory.event.
- **Hard success**: The target believes the bluff completely and does not question it. Even if later presented with mild contradicting evidence, they initially dismiss it. The false impression persists for a meaningful duration, and the successful deception remains part of memory.event.
- **Extreme success**: The target is fully deceived and may actively reinforce the lie to others. They could unknowingly mislead third parties, compounding the bluff's reach. Record the deception and any established false claims as memory.event.

## On Failure

- The target sees through the bluff, recognizing the deception. The actor's credibility is damaged.
- Relationship with the target worsens — they become suspicious or hostile. They may warn others or increase vigilance.
- If the target succeeded on Psychology, they understand the actor was deliberately deceiving them; this may trigger an actively hostile response depending on the target's disposition.
- Re-attempting Bluff on the same target in this scene is at a higher difficulty unless the actor can establish new cover.
