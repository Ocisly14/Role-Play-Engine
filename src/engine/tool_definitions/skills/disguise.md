---
id: disguise
title: Disguise
description: "Alter physical appearance through makeup, costume, or gait to impersonate another person or role. Does NOT cover verbal deception (Fast Talk/Persuade), environmental concealment (Stealth), or producing fake documents (Forgery)."

skillCheck:
  skill: Disguise
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, conditions, inventory]
  scene:
    inject: [current]
    fields: [id, name, description]

outputSchema:
  use:
    - character.condition
    - memory.event
  requireOnSuccess:
    - memory.event

interpreter:
  examples:
    - "Apply stage makeup and a wig to pass as the missing professor"
    - "Dress in a janitor's uniform and adopt a slouched gait to move through the building unrecognized"
    - "Pad the coat and adjust posture to impersonate the heavyset night watchman"
    - "Use greasepaint and a fake moustache to alter facial features before entering the gala"
---

# Disguise Resolution Guidance

## On Success
- **Regular success**: The disguise holds under casual scrutiny. People the actor encounters accept the altered appearance at face value. The actor can move through the environment without being recognized.
- **Hard success**: The disguise is convincing even under moderate scrutiny — a brief conversation, a direct look from someone who knows the person being impersonated. Minor inconsistencies are not noticed.
- **Extreme success**: The disguise is flawless. Even acquaintances or colleagues of the person being impersonated are fully deceived. The actor could sustain the persona through extended interaction without risk of slippage.

## On Failure
- Someone notices that something is off — the actor's voice, a detail of the costume, body language, or an unfamiliar face in a place where everyone knows each other.
- The observer may pull the actor aside for questioning, alert others, or simply become suspicious and watchful.
- A fumble means the disguise fails conspicuously — a mask slips, a costume tears, or the actor is recognized immediately by someone they were trying to avoid.
- Once the disguise is compromised, it cannot be re-applied in the same scene without significantly different materials or circumstances.
