---
id: psychology
title: Psychology
description: "Understanding human behavior, detecting lies, reading emotions and intentions"

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
    - memory.information

interpreter:
  examples:
    - "Watch his facial expressions while he speaks to judge whether he is lying"
    - "Analyze her behavioral motivations"
    - "Read the suspect's body language to see if they're hiding something"
---

# Psychology Resolution Guidance

## On Success

- **Regular success**: The actor gains a meaningful read on the target's mental state. They can identify one truthful piece of insight — whether the target is lying, afraid, hiding something, or acting against their own interests. Record as memory.information.
- **Hard success**: The actor reads the target with clarity. They understand the target's current emotional state and can detect deception or concealment with confidence. They may also sense the general nature of what is being hidden (fear, guilt, grief, desire) without knowing specifics.
- **Extreme success**: The actor perceives the target's deeper motivations and psychological state. They understand what the target truly wants or fears, not just their surface behavior. This may reveal a secret or contradiction not visible through normal observation.

## On Failure

- The actor gains no useful insight into the target's mental state.
- On a partial failure, they may form an inaccurate impression — believing someone honest who is actually lying, or seeing distress where there is only fatigue. Record the incorrect read as memory.information with low confidence.
- This incorrect impression may affect subsequent interactions if the actor acts on faulty conclusions.
- Psychology cannot be re-attempted on the same target in the same scene for the same purpose.
