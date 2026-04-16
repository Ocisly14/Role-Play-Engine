---
id: ride
title: Ride
description: "Riding horses and similar animals — maintaining control in difficult situations"

skillCheck:
  skill: Ride
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

interpreter:
  examples:
    - "Ride the horse in pursuit"
    - "Control the mount on rough terrain"
    - "Ride the horse through the forest"
---

# Ride Resolution Guidance

## On Success
- **Regular success**: The actor maintains control of the mount and completes the intended maneuver — a chase, a crossing, a difficult turn — without incident. Fatigue is accumulated proportional to the duration and intensity.
- **Hard success**: The actor rides skillfully, getting the best speed or performance out of the animal. Difficult terrain or spooked conditions are handled with minimal difficulty. The mount obeys promptly.
- **Extreme success**: The actor and mount move as one. The animal performs at its limit — maximum speed, a precise leap, a silent approach. Observers may be visibly impressed.

## On Failure
- The actor loses control of the mount. The animal may bolt, rear, or stop abruptly.
- If thrown, the actor takes 1d6 HP damage from the fall, plus potential trampling damage if the situation warrants it.
- The mount may flee, become agitated, or be lost — potentially stranding the actor.
- A fumble means a catastrophic loss of control: thrown at full gallop, or the animal injures itself or a bystander.
- Follow-up Ride attempts to calm or recapture a spooked animal face increased difficulty.
