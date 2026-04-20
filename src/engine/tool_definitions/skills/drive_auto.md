---
id: drive_auto
title: Drive Auto
description: "Operating cars, trucks, and motorcycles on roads — chases, evasion, and hazardous driving conditions. Does NOT cover aircraft (Pilot Aircraft), watercraft (Pilot Boat), or heavy machinery."

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
  presets: [default]
  use:
    - character.hp
    - character.position
    - memory.event
  requireOnSuccess:
    - character.position
  durationGuidance:
    default: 1
    range: "1-30"
    notes: "a single tense maneuver 1 min; sustained pursuit or evasion 5-10 min; long drive with hazard 15-30 min"

interpreter:
  examples:
    - "Floor the accelerator and lose the pursuing car through the back streets"
    - "Steer the truck through the flooded road without stalling"
    - "Execute a handbrake turn to escape the roadblock"
    - "Ride the motorcycle at high speed along the narrow cliff road"
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
