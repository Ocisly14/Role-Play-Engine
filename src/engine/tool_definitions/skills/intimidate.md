---
id: intimidate
engine: llm
title: Intimidate
description: "Coerce compliance from a target through explicit threats, displays of violence, or fear-inducing physical presence. Does NOT cover Charm (friendly persuasion), Persuade (rational argument), or Bluff (deception)."

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
    - relationship.change
  requireOnSuccess:
    - relationship.change
  durationGuidance:
    default: 2
    range: "1-5"
    notes: "a single threatening demand 1-2 min; sustained pressure or interrogation 3-5 min"

interpreter:
  examples:
    - "Threaten the informant with exposure to his boss unless he reveals what he knows"
    - "Loom over the shopkeeper and growl a warning to make him hand over the key"
    - "Slam a fist on the table and threaten violence to break the guard's nerve"
    - "Press a weapon into sight and threaten consequences if she does not cooperate"
---

# Intimidate Resolution Guidance

## On Success

- **Regular success**: The target is cowed and complies out of fear. They provide what was demanded or back down from opposition. They remain frightened for the duration of this scene. Relationship worsens due to coercion, and the exchange should be kept as memory.event.
- **Hard success**: The target is badly shaken. They comply fully and may offer additional concessions unprompted to avoid further threat. They may be unable to act effectively this scene due to fear-induced paralysis; keep the intimidation result as memory.event.
- **Extreme success**: The target is overwhelmed with fear. They comply and may suffer 1 point of Sanity loss from the intensity of the threat. Witnesses present may also be disturbed. Record as a traumatic memory event for the target.

## On Failure

- The target is not intimidated — they hold their ground or respond with defiance. The actor's threat is dismissed or called out as empty.
- Relationship worsens significantly; the target may become actively hostile rather than merely uncooperative.
- If the target succeeded on Intimidate against the actor, the actor feels the pressure instead — record as a condition if appropriate.
- Witnesses to a failed intimidation attempt may side with the target or lose respect for the actor.
