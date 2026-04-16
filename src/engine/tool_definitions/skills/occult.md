---
id: occult
title: Occult
description: "Knowledge of supernatural beliefs, magic traditions, folklore, and mystical practices"

skillCheck:
  skill: Occult
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
    - "Identify these mysterious symbols"
    - "Analyze the purpose of this ritual"
    - "Identify the occult significance of these symbols"
---

# Occult Resolution Guidance

## On Success
- regular success: The investigator identifies the tradition, system, or folklore behind the symbols or ritual. They can name the belief system and describe the general purpose — protective, summoning, cursing, or devotional.
- hard success: The investigator recognizes specific texts, lineages, or practitioners associated with these symbols. They understand the intended effect of the ritual and whether it has been performed correctly.
- extreme success: The investigator's occult knowledge cuts deep. They identify not only the system but its hidden inner doctrine — and realize that what they are looking at is not mere superstition. The knowledge is real, and its implications are deeply unsettling. A mild SAN check may be appropriate upon realization.

## On Failure
- The symbols appear to be meaningless decoration or superstitious nonsense. The investigator cannot connect them to any tradition they know.
- On a fumble, the investigator dismisses genuinely dangerous signs as harmless, or incorrectly names a benign tradition as the source — potentially underestimating a serious threat.
