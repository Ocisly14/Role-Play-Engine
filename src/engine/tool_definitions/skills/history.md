---
id: history
title: History
description: "Recall and interpret documented historical events, periods, figures, and their significance through expert scholarly knowledge. Does NOT cover physical artifact dating (Archaeology), legal precedent (Law), passive observation (Spot Hidden), or document retrieval (Research/Library Use)."

skillCheck:
  skill: History
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
    notes: "date/period ID 3-5 min; contextual interpretation 10-15 min; deep archival recall 20-30 min"

interpreter:
  examples:
    - "Identify which political faction controlled this district during the 1890s and what atrocities they committed"
    - "Recall documented accounts of this cult from 18th-century ecclesiastical records"
    - "Place this seal within its correct dynastic period and explain its administrative significance"
    - "Determine whether the massacre described in this account matches any suppressed historical incident"
---

# History Resolution Guidance

## On Success
- regular success: The investigator recalls the relevant historical event, figure, or period with reasonable accuracy. They can provide context that illuminates the present situation and explain why the historical connection is significant.
- hard success: The investigator recalls detailed and specific facts — dates, names, lesser-known events, and the political or social forces at play. The information goes beyond common knowledge and may reveal a pattern others have missed.
- extreme success: The investigator's historical knowledge is encyclopedic on this point. They recall obscure documents, eyewitness accounts, or suppressed records that most historians have never encountered. The information may overturn an accepted narrative.

## On Failure
- The relevant history does not come to mind. The investigator draws a blank or can only recall vague generalities that provide no actionable insight.
- On a fumble, the investigator confidently recites incorrect history, potentially sending the group toward a false lead or provoking an informed NPC's contempt.
