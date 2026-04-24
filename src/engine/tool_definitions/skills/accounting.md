---
id: accounting
engine: llm
title: Accounting
description: "Expertly interpret financial records, ledgers, and accounts to detect fraud, embezzlement, or hidden assets. Does NOT cover general document reading (Research/Library Use) or legal interpretation (Law)."

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
  presets: [default]
  durationGuidance:
    default: 10
    range: "3-60"
    notes: "single ledger entry check 3-5 min; full audit pass 15-30 min; forensic financial reconstruction 45-60 min"

interpreter:
  examples:
    - "Audit the ledger entries for signs of embezzlement or falsified figures"
    - "Trace the flow of funds through these account books to find hidden withdrawals"
    - "Estimate how long this systematic skimming of the payroll has been going on"
    - "Determine whether these balance sheets have been deliberately manipulated"
---

# Accounting Resolution Guidance

## On Success
- regular success: The investigator spots clear irregularities in the financial records — falsified entries, missing funds, or systematic embezzlement hidden within legitimate transactions. They can estimate the scale and rough timeline of the fraud.
- hard success: Beyond identifying the anomalies, the investigator determines the method used to conceal them and can name the likely period when the fraud began. They may also identify who had access during that time.
- extreme success: The investigator reconstructs the full financial scheme with precision — the exact amounts, the concealment technique, and a clear trail pointing to the responsible party. The evidence is damning and difficult to refute.

## On Failure
- The records appear unremarkable. The investigator finds nothing unusual, either because the fraud is too well hidden or because they lack the focus to spot the discrepancies. Time has been spent without result.
- On a fumble, the investigator misreads the figures entirely and draws a false conclusion — potentially accusing the wrong person or overlooking a critical sum.
