---
id: drive_auto
title: Drive Auto
description: "Driving automobiles — chases, evasion, dangerous road conditions"

skillCheck:
  skill: Drive Auto
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
    fields: [id, name, description, conditions]

outputSchema:
  use:
    - character.hp
    - character.fatigue
    - memory.event

interpreter:
  examples:
    - "Drive at high speed to escape"
    - "Drive through the narrow alley"
    - "Drive through the narrow alley at high speed"
---

# Drive Auto Resolution Guidance

## On Success
- **Regular success**: The actor navigates the vehicle through the hazardous situation — a sharp turn, a chase, difficult road conditions — without losing control. The vehicle and occupants reach the destination or maintain position safely.
- **Hard success**: The actor drives with skill and precision. A pursuit is opened or closed significantly, a difficult maneuver is executed cleanly, or the vehicle passes through dangerous terrain without damage to itself or passengers.
- **Extreme success**: The actor performs an exceptional driving feat — a perfect handbrake turn, threading through an impossibly narrow gap, or pushing the vehicle to its mechanical limit in a way that decisively ends a chase or avoids all hazards.

## On Failure
- The actor loses control of the vehicle. A skid, an overcorrected turn, or a collision results.
- Passengers and the actor may take HP damage depending on the speed and nature of the crash (1d6 to 3d6 as the GM determines).
- The vehicle may be damaged, stuck, or disabled — potentially stranding everyone inside.
- A fumble means a serious crash: the vehicle rolls, strikes a wall at full speed, or impacts another vehicle. Severe HP damage and vehicle destruction are possible outcomes.
