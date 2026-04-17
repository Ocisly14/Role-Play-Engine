---
id: charm
title: Charm
description: "Win genuine liking or favor from a target through personal charisma, warmth, or seduction. Does NOT cover Bluff (deception), Intimidate (threats/fear), or Persuade (logical argument)."

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
    - "Charm the librarian with warm flattery to win her goodwill and cooperation"
    - "Win over the innkeeper with a friendly joke and genuine interest in his stories"
    - "Use personal charisma to make the guard feel respected and disposed to help"
    - "Seduce the contact into sharing information by making her feel truly heard"
---

# Charm Resolution Guidance

## On Success

- **Regular success**: The target warms up noticeably. They become friendly or cooperative, willing to share information or grant a small favor. Record the interaction as memory.event; if they reveal something useful, keep that as memory.information. Relationship improves by one tier (e.g., Neutral → Friendly).
- **Hard success**: The target is genuinely won over. They trust the actor and may volunteer information beyond what was asked, or go out of their way to assist. Relationship improves and the effect lingers beyond this interaction; any concrete revelations should be preserved as memory.information.
- **Extreme success**: The target is completely charmed — they feel a strong personal connection to the actor. They will take meaningful risks to help and may become a recurring ally. Relationship improves significantly; record the notable bond and any lasting change as memory.event or memory.information as appropriate.

## On Failure

- The target is unmoved by the actor's attempt at charm. They remain at their prior disposition and do not offer assistance.
- If the target succeeded on Psychology to see through the attempt, they recognize it as manipulation — relationship may worsen slightly, and they become more guarded in future interactions.
- The actor cannot attempt Charm again on this target in the same scene without a meaningful change in circumstances.
