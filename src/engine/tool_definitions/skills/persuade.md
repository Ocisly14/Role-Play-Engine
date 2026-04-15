---
id: persuade
title: Persuade
description: "Convincing others through logical argument, negotiation, and reasoning"

skillCheck:
  skill: Persuade
  difficulty: regular
  type: opposed
  opposedDefense:
    - Psychology
    - Persuade
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
    - "Persuade the doctor to let me review the medical records"
    - "Use reason to talk him into changing his mind"
    - "Try to convince the officer to let me examine the crime scene"
---

# Persuade Resolution Guidance

## On Success

- **Regular success**: The target is convinced by the actor's reasoning. They agree to the request, change their stated position, or grant access. Their belief or stance genuinely shifts based on the argument presented.
- **Hard success**: The target is fully persuaded and commits to their agreement. They may advocate for the actor's position to others or volunteer further support. Any future persuasion attempts by the actor on this topic face no additional resistance.
- **Extreme success**: The target becomes an active advocate. They believe the argument was their own conclusion and may take independent actions in line with what they were persuaded toward. Record this as a meaningful information change in their belief system.

## On Failure

- The target is not convinced. They hold their current position and decline to act on the actor's request.
- Depending on the target's personality, they may become slightly irritated at the attempt to argue with them.
- If the target succeeded on Persuade or Psychology, they may identify weaknesses in the actor's argument and use them to counter-argue, leaving the actor at a disadvantage in follow-up negotiations.
- A new Persuade attempt on the same topic in this scene requires a materially different argument or new information.
