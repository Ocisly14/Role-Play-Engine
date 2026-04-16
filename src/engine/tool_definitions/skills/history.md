---
id: history
title: History
description: "Knowledge of historical events, periods, and their significance"

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
  use:
    - memory.information

interpreter:
  examples:
    - "Recall the history of this building"
    - "Analyze the historical context of this event"
    - "Recall what happened at this location historically"
---

# History Resolution Guidance

## On Success
- regular success: The investigator recalls the relevant historical event, figure, or period with reasonable accuracy. They can provide context that illuminates the present situation and explain why the historical connection is significant.
- hard success: The investigator recalls detailed and specific facts — dates, names, lesser-known events, and the political or social forces at play. The information goes beyond common knowledge and may reveal a pattern others have missed.
- extreme success: The investigator's historical knowledge is encyclopedic on this point. They recall obscure documents, eyewitness accounts, or suppressed records that most historians have never encountered. The information may overturn an accepted narrative.

## On Failure
- The relevant history does not come to mind. The investigator draws a blank or can only recall vague generalities that provide no actionable insight.
- On a fumble, the investigator confidently recites incorrect history, potentially sending the group toward a false lead or provoking an informed NPC's contempt.
