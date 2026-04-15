---
id: charm
title: Charm
description: "Being likeable, making friends, seduction — winning someone over with personality"

skillCheck:
  skill: Charm
  difficulty: regular
  type: opposed
  opposedDefense:
    - Psychology
    - Charm
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
    - "Use charm to convince her to help"
    - "Try to win him over with personal charisma"
    - "Try to charm the receptionist into letting me pass"
---

# Charm Resolution Guidance

## On Success

- **Regular success**: The target warms up noticeably. They become friendly or cooperative, willing to share information or grant a small favor. Relationship improves by one tier (e.g., Neutral → Friendly).
- **Hard success**: The target is genuinely won over. They trust the actor and may volunteer information beyond what was asked, or go out of their way to assist. Relationship improves and the effect lingers beyond this interaction.
- **Extreme success**: The target is completely charmed — they feel a strong personal connection to the actor. They will take meaningful risks to help and may become a recurring ally. Relationship improves significantly; record as a notable bond in memory.

## On Failure

- The target is unmoved by the actor's attempt at charm. They remain at their prior disposition and do not offer assistance.
- If the target succeeded on Psychology to see through the attempt, they recognize it as manipulation — relationship may worsen slightly, and they become more guarded in future interactions.
- The actor cannot attempt Charm again on this target in the same scene without a meaningful change in circumstances.
