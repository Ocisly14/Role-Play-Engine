---
id: item_exchange
title: Item Exchange
description: Giving, receiving, or trading items between characters without skill checks

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, conditions, inventory]
      targets: [id, name, conditions, inventory, relationship]
  scene:
    inject: [current]
    fields: [id, name, description]

outputSchema:
  use:
    - item.move
    - memory.event
    - relationship.change
  requireOnSuccess:
    - item.move
  durationGuidance:
    default: 1
    range: "1-3"
    notes: "simple handoff 1 min; a deliberate ceremony or negotiation around the item 2-3 min"

interpreter:
  examples:
    - "Hand the key over to Officer Harlow"
    - "Give the coin to the beggar"
    - "Trade my lantern for his rope"
    - "Return the stolen locket to its owner"

impactHint:
  default: 1
  range: "0-1"
  examples: "discreet handoff=0, open exchange=1"
---

# Item Exchange Resolution Guidance

## Execution Status
- **completed**: resolve the exchange normally.
- **interrupted**: exchange was interrupted — item may not have been transferred.

## Rules
- No skill check required — willing exchange between characters
- The target must be willing to accept the item (check relationship)
- If the target refuses, no item.move occurs
- Both characters form `memory.event` entries for the exchange
- Relationship may change based on the value or significance of the item through `relationship.change`
