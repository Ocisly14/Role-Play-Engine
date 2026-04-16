---
id: language_own
title: Language (Own)
description: "Reading and understanding archaic or complex texts in native language"

skillCheck:
  skill: Language (Own)
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
    - "Read this old document in my native language"
    - "Try to understand this obscure passage"
    - "Read the archaic text in my native language"
---

# Language (Own) Resolution Guidance

## On Success
- **Regular success**: The actor successfully reads and comprehends the text — archaic vocabulary, unusual phrasing, or dense technical language no longer obscures the meaning. The actor gains the information contained within (memory.information update) and understands the gist of what the document communicates.
- **Hard success**: The actor reads deeply and carefully, extracting not just the surface meaning but subtle implications, hidden references, and context clues embedded in the text's style or word choice. Secondary information — authorial intent, time period, regional dialect — is also gleaned.
- **Extreme success**: A thorough and expert reading — the actor extracts every meaningful detail from the text, including marginalia, corrections, and coded language if present. They may notice that the text references other sources or contains deliberate omissions, and can recall specific passages with clarity.

## On Failure
- The archaic grammar, obsolete vocabulary, or highly technical terminology defeats the actor's reading comprehension.
- The actor cannot determine the meaning of the text in its current form and gains no information from this attempt.
- Repeated failure may induce frustration and eye strain; a fatigue penalty may apply if the actor has been studying for an extended period.
- A fumble means the actor has fundamentally misread a key passage — they believe they understood the text but have drawn a wrong conclusion, which may be recorded as a false memory.information entry.
