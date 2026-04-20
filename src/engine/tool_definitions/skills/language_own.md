---
id: language_own
title: Language (Own)
description: "Master the native language through rhetoric, nuanced writing, and deciphering archaic or highly technical native-language texts. Does NOT cover Language (Other) (foreign languages) or Library Use (research navigation)."

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

interpreter:
  examples:
    - "Decipher the archaic seventeenth-century English in the handwritten journal to extract its meaning"
    - "Write a persuasive public speech in native English to sway the crowd's opinion"
    - "Parse the dense legalese in the Victorian contract to determine what rights it grants"
    - "Interpret the cryptic phrasing in the old newspaper editorial to uncover the editor's hidden meaning"
---

# Language (Own) Resolution Guidance

## On Success
- **Regular success**: The actor successfully reads and comprehends the text — archaic vocabulary, unusual phrasing, or dense technical language no longer obscures the meaning. The actor gains the information contained within (memory.event update) and understands the gist of what the document communicates.
- **Hard success**: The actor reads deeply and carefully, extracting not just the surface meaning but subtle implications, hidden references, and context clues embedded in the text's style or word choice. Secondary information — authorial intent, time period, regional dialect — is also gleaned.
- **Extreme success**: A thorough and expert reading — the actor extracts every meaningful detail from the text, including marginalia, corrections, and coded language if present. They may notice that the text references other sources or contains deliberate omissions, and can recall specific passages with clarity.

## On Failure
- The archaic grammar, obsolete vocabulary, or highly technical terminology defeats the actor's reading comprehension.
- The actor cannot determine the meaning of the text in its current form and gains no information from this attempt.
- Repeated failure may induce frustration and eye strain; a fatigue penalty may apply if the actor has been studying for an extended period.
- A fumble means the actor has fundamentally misread a key passage — they believe they understood the text but have drawn a wrong conclusion, which may be recorded as a false memory.event entry.
