---
id: research
title: Research
description: "Finding specific information in libraries, archives, newspapers, databases, or other written and recorded sources. Does NOT cover physical scene observation (Perception/Spot Hidden), dating or authenticating artifacts (Archaeology), or identifying occult knowledge (Occult)."

skillCheck:
  skill: Research
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
  use:
    - memory.information
  requireOnSuccess:
    - memory.information

interpreter:
  examples:
    - "Search the newspaper morgue for articles about the Marsh family"
    - "Look up the property deed records at the county registry"
    - "Find any published research on non-Euclidean geometry in the university library"
    - "Locate the asylum's admission records from 1921"
---

# Research Resolution Guidance

## On Success
- regular success: The investigator locates the relevant documents, articles, or records after a thorough search. The information found directly addresses what they were looking for and provides a useful lead or piece of evidence.
- hard success: The investigator finds the primary source material quickly and also uncovers related documents that provide important context or reveal a secondary connection to the case.
- extreme success: The investigator's search is exhaustive and inspired — they locate not only the target document but also a hidden or cross-referenced record that others have missed. The finding may be the keystone of the entire investigation.

## On Failure
- The search yields nothing useful. Either the records do not exist, are filed under an unexpected classification, or the investigator simply cannot navigate the system effectively within the available time.
- On a fumble, the investigator disturbs the archive, misfiled materials obscure future searches, or they attract unwanted attention from someone who notices what they were searching for.
