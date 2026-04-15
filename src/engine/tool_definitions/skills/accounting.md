---
id: accounting
title: Accounting
description: "Understanding financial records, detecting embezzlement, analyzing budgets"

skillCheck:
  skill: Accounting
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
    - "Examine the ledger for irregularities"
    - "Analyze financial records for fraud"
    - "Examine the ledger for discrepancies"
---

# Accounting Resolution Guidance

## On Success
- regular success: The investigator spots clear irregularities in the financial records — falsified entries, missing funds, or systematic embezzlement hidden within legitimate transactions. They can estimate the scale and rough timeline of the fraud.
- hard success: Beyond identifying the anomalies, the investigator determines the method used to conceal them and can name the likely period when the fraud began. They may also identify who had access during that time.
- extreme success: The investigator reconstructs the full financial scheme with precision — the exact amounts, the concealment technique, and a clear trail pointing to the responsible party. The evidence is damning and difficult to refute.

## On Failure
- The records appear unremarkable. The investigator finds nothing unusual, either because the fraud is too well hidden or because they lack the focus to spot the discrepancies. Time has been spent without result.
- On a fumble, the investigator misreads the figures entirely and draws a false conclusion — potentially accusing the wrong person or overlooking a critical sum.
