---
id: pilot_aircraft
title: "Pilot (Aircraft)"
description: "Operating fixed-wing aircraft, helicopters, and gliders — takeoff, landing, and emergency maneuvers in the air. Does NOT cover ground vehicles (Drive Auto) or watercraft (Pilot Boat)."

skillCheck:
  skill: "Pilot (Aircraft)"
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

interpreter:
  examples:
    - "Bring the biplane down for an emergency landing in the fog"
    - "Bank the aircraft hard to evade the pursuing fighter plane"
    - "Keep the helicopter stable while descending through the violent storm"
    - "Take off from the short jungle clearing without clipping the tree line"
---

# Pilot (Aircraft) Resolution Guidance

## On Success
- **Regular success**: The actor controls the aircraft through the intended maneuver — takeoff, landing, evasive banking, flying through poor visibility. The aircraft and passengers arrive safely at the intended position.
- **Hard success**: The actor handles the aircraft with confidence. A difficult landing is made cleanly, turbulence is navigated smoothly, or an evasive maneuver is completed with no altitude or speed loss.
- **Extreme success**: The actor performs a feat of exceptional airmanship — landing on an impossibly short strip, flying through a storm without damage, or executing a combat maneuver that fully outmaneuvers a pursuing aircraft.

## On Failure
- The actor loses control of the aircraft or fails to execute the maneuver correctly.
- The aircraft may enter a stall, sideslip, or deviate badly from the intended course.
- A crash landing or emergency descent may be necessary — passengers and actor take HP damage based on severity (2d6 to 4d6 for a hard crash landing).
- A fumble means catastrophic loss of control: the aircraft spins, stalls at low altitude, or suffers structural failure. Severe HP damage and possible fatalities are realistic outcomes.
