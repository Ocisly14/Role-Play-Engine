---
id: intimidate
title: Intimidate
description: "Frightening or coercing others through threats — physical or verbal intimidation"

skillCheck:
  skill: Intimidate
  difficulty: regular
  type: opposed
  opposedDefense:
    - Psychology
    - Intimidate
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
        - stats
      targets:
        - id
        - name
        - occupation
        - personality
        - conditions
        - relationship
        - stats

outputSchema:
  use:
    - character.condition
    - character.san
    - memory.event
    - memory.witness
    - relationship.change

interpreter:
  examples:
    - "Threaten him into telling the truth"
    - "Slam a fist on the table to frighten the other party"
    - "Threaten the shopkeeper to hand over the key"
---

# Intimidate Resolution Guidance

## On Success

- **Regular success**: The target is cowed and complies out of fear. They provide what was demanded or back down from opposition. They remain frightened for the duration of this scene. Relationship worsens due to coercion.
- **Hard success**: The target is badly shaken. They comply fully and may offer additional information or concessions unprompted to avoid further threat. They may be unable to act effectively this scene due to fear-induced paralysis.
- **Extreme success**: The target is overwhelmed with fear. They comply and may suffer 1 point of Sanity loss from the intensity of the threat. Witnesses present may also be disturbed. Record as a traumatic memory event for the target.

## On Failure

- The target is not intimidated — they hold their ground or respond with defiance. The actor's threat is dismissed or called out as empty.
- Relationship worsens significantly; the target may become actively hostile rather than merely uncooperative.
- If the target succeeded on Intimidate against the actor, the actor feels the pressure instead — record as a condition if appropriate.
- Witnesses to a failed intimidation attempt may side with the target or lose respect for the actor.
