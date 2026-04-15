---
id: law
title: Law
description: "Knowledge of legal systems, procedures, rights, and regulations"

skillCheck:
  skill: Law
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, conditions]
  scene:
    inject: [current]
    fields: [id, name, description, conditions, items]
  item:
    inject: [sceneItems, actorInventory]

outputSchema:
  use:
    - memory.event
    - memory.information
    - character.fatigue

interpreter:
  examples:
    - "Determine whether this action is lawful"
    - "Use legal knowledge to find a procedural loophole"
    - "Determine the legal implications of this evidence"
---

# Law Resolution Guidance

## On Success
- regular success: The investigator correctly identifies the legal standing of a situation — what is permissible, what constitutes a violation, and what remedies or procedures apply. They can advise on rights and likely legal consequences.
- hard success: The investigator identifies relevant case precedents and statutory nuances that most laypeople would miss. They spot a procedural vulnerability or legal protection that can be leveraged effectively.
- extreme success: The investigator's legal analysis is airtight. They identify a specific statute, loophole, or jurisdictional technicality that fundamentally changes the situation — potentially rendering evidence inadmissible or revealing that an authority figure has overstepped their power.

## On Failure
- The investigator is uncertain of the legal position. They cannot reliably advise on rights, procedures, or consequences, and must proceed without the benefit of legal knowledge.
- On a fumble, the investigator provides incorrect legal advice that backfires — waiving a right inadvertently or misreading a regulation in a way that creates new problems.
