---
id: conversation
title: Conversation
description: Ordinary conversation with another character — chatting, asking casual questions, sharing information without persuasion or deception

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, occupation, personality, conditions]
      targets: [id, name, occupation, personality, conditions, relationship, knowledge]
  scene:
    inject: [current]
    fields: [id, name, description]

outputSchema:
  use:
    - memory.event
    - memory.information
    - relationship.change
  requireOnSuccess:
    - memory.information
    - relationship.change

interpreter:
  examples:
    - "Chat with her for a while"
    - "Ask him how his day has been"
    - "Have a casual chat with the bartender"
    - "Ask him what he knows about the neighborhood"

impactHint:
  default: 1
  range: "0-1"
  examples: "whispering=0, casual conversation=1"
---

# Conversation Resolution Guidance

## Execution Status
- **completed**: resolve the conversation normally.
- **failed**: not applicable (no skill check).
- **interrupted**: the conversation was cut short.

## Rules
- No skill check required — this is a friendly or neutral exchange
- Information exchange depends on the relationship and target's knowledge
- The target will share information they know and are willing to share
- The target will NOT share secrets or sensitive information without persuasion
- Use `memory.event` for the conversation itself, `memory.information` for factual disclosures, and `relationship.change` for rapport shifts.
- Relationship may change slightly based on conversation topic and rapport
