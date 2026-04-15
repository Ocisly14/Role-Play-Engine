---
id: disguise
title: Disguise
description: "Changing appearance to avoid recognition — costumes, makeup, impersonation"

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

interpreter:
  examples:
    - "Disguise myself as a doctor to blend into the hospital"
    - "Apply makeup to alter my appearance"
    - "Disguise myself as a nurse to enter the ward"
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
