---
id: language_other
title: Language (Other)
description: "Reading, speaking, and understanding foreign languages — translation, communication"

skillCheck:
  skill: Language (Other)
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
    fields: [id, name, description]
  item:
    inject: [sceneItems, actorInventory]

outputSchema:
  presets: [default]
  use:
    - memory.information

interpreter:
  examples:
    - "Translate this foreign text"
    - "Try to communicate with him in a foreign language"
    - "Translate this foreign inscription"
---

# Language (Other) Resolution Guidance

## On Success
- **Regular success**: The actor successfully translates the foreign text or communicates in the target language at a functional level — the meaning is conveyed accurately enough for practical purposes. The actor gains the information contained in the text or completes the conversation without critical misunderstanding (memory.information update).
- **Hard success**: The translation or communication is accurate and nuanced — idiomatic expressions, formal register, and cultural context are correctly handled. A written translation produced at this level reads naturally in the target language and captures the original's tone as well as its meaning.
- **Extreme success**: The actor demonstrates near-native fluency — the translation is precise and elegant, including any archaic, technical, or coded elements. In conversation, the actor can detect subtle emotional cues, regional dialect, or deliberate evasions in the speaker's foreign-language responses.

## On Failure
- The actor cannot reliably translate or communicate in the foreign language — vocabulary gaps, grammatical errors, or an unfamiliar dialect create an insurmountable barrier.
- No useful information is extracted from written text; spoken communication breaks down or fails to convey the intended message.
- The other party (if any) may realize the actor's language skill is insufficient and become unwilling to continue attempting communication.
- A fumble means the actor has produced a significant mistranslation — they believe they have understood the text or conversation correctly but have drawn a dangerously wrong conclusion, recorded as incorrect memory.information.
