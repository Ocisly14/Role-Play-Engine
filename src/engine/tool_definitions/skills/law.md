---
id: law
engine: llm
title: Law
description: "Interpret and apply knowledge of legal systems, statutes, rights, procedures, and jurisdictional rules through expert legal reasoning. Does NOT cover general document reading (Research/Library Use), historical legal scholarship (History), or passive observation (Spot Hidden)."

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
  presets: [default]
  durationGuidance:
    default: 10
    range: "3-30"
    notes: "quick statute lookup 3-5 min; contract or case analysis 15-30 min"

interpreter:
  examples:
    - "Determine whether the warrant authorizes entry to the cellar under this jurisdiction's statutes"
    - "Identify whether this confession was obtained in violation of due process and is therefore inadmissible"
    - "Advise on what habeas corpus rights apply to a person detained without charge"
    - "Find the statutory loophole that would allow the estate to be transferred without probate"
---

# Law Resolution Guidance

## On Success
- regular success: The investigator correctly identifies the legal standing of a situation — what is permissible, what constitutes a violation, and what remedies or procedures apply. They can advise on rights and likely legal consequences.
- hard success: The investigator identifies relevant case precedents and statutory nuances that most laypeople would miss. They spot a procedural vulnerability or legal protection that can be leveraged effectively.
- extreme success: The investigator's legal analysis is airtight. They identify a specific statute, loophole, or jurisdictional technicality that fundamentally changes the situation — potentially rendering evidence inadmissible or revealing that an authority figure has overstepped their power.

## On Failure
- The investigator is uncertain of the legal position. They cannot reliably advise on rights, procedures, or consequences, and must proceed without the benefit of legal knowledge.
- On a fumble, the investigator provides incorrect legal advice that backfires — waiving a right inadvertently or misreading a regulation in a way that creates new problems.
