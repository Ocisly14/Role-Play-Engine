---
id: persuade
title: Persuade
description: "Convince a target to change their belief or action through rational argument, evidence, or negotiation — producing a lasting mind-change. Does NOT cover Bluff (quick deception), Charm (emotional warmth), or Intimidate (threats)."

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
    - "Convince the doctor with reasoned medical evidence to grant access to the records"
    - "Argue logically that the official's policy will backfire, persuading him to reconsider"
    - "Present a well-reasoned case to the officer with supporting evidence to gain scene access"
    - "Negotiate with clear factual points to bring the reluctant contact around to our side"
---

# Persuade Resolution Guidance

## On Success

- **Regular success**: The target is convinced by the actor's reasoning. They agree to the request, change their stated position, or grant access. Their belief or stance genuinely shifts based on the argument presented; record the exchange as memory.event and any concrete concessions as memory.information.
- **Hard success**: The target is fully persuaded and commits to their agreement. They may advocate for the actor's position to others or volunteer further support. Any future persuasion attempts by the actor on this topic face no additional resistance, and the committed support should remain in memory.event.
- **Extreme success**: The target becomes an active advocate. They believe the argument was their own conclusion and may take independent actions in line with what they were persuaded toward. Record the resulting belief shift as memory.information and the persuasion outcome as memory.event.

## On Failure

- The target is not convinced. They hold their current position and decline to act on the actor's request.
- Depending on the target's personality, they may become slightly irritated at the attempt to argue with them.
- If the target succeeded on Persuade or Psychology, they may identify weaknesses in the actor's argument and use them to counter-argue, leaving the actor at a disadvantage in follow-up negotiations.
- A new Persuade attempt on the same topic in this scene requires a materially different argument or new information.
