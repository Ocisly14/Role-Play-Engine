---
id: psychology
engine: llm
title: Psychology
description: "Reading a person's emotional state, detecting deception, and sensing hidden motivations through behavior and body language during direct interaction. Does NOT cover physical scene observation (Perception), therapy or trauma treatment (Psychoanalysis), or social persuasion (Persuade/Charm/Bluff)."

skillCheck:
  skill: Psychology
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject:
      - actor
      - targets
    fields:
      actor:
        - id
        - name
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
    - memory.event
  durationGuidance:
    default: 2
    range: "1-5"
    notes: "a quick read of body language 1-2 min; sustained observation during conversation 3-5 min"

interpreter:
  examples:
    - "Watch his face while he speaks to judge whether he is telling the truth"
    - "Assess whether her distress is genuine or performed"
    - "Read the suspect's body language to detect signs of guilt or fear"
    - "Sense what emotion the witness is suppressing beneath their calm exterior"
---

# Psychology Resolution Guidance

## On Success

- **Regular success**: The actor gains a meaningful read on the target's mental state. They can identify one truthful piece of insight — whether the target is lying, afraid, hiding something, or acting against their own interests. Record the observation and the conclusion as memory.event.
- **Hard success**: The actor reads the target with clarity. They understand the target's current emotional state and can detect deception or concealment with confidence. They may also sense the general nature of what is being hidden (fear, guilt, grief, desire) without knowing specifics.
- **Extreme success**: The actor perceives the target's deeper motivations and psychological state. They understand what the target truly wants or fears, not just their surface behavior. This may reveal a secret or contradiction not visible through normal observation.

## On Failure

- The actor gains no useful insight into the target's mental state.
- On a partial failure, they may form an inaccurate impression — believing someone honest who is actually lying, or seeing distress where there is only fatigue. Record the incorrect read and the inspection itself as memory.event with low confidence.
- This incorrect impression may affect subsequent interactions if the actor acts on faulty conclusions.
- Psychology cannot be re-attempted on the same target in the same scene for the same purpose.
