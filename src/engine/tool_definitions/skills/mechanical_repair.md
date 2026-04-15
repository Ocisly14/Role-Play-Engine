---
id: mechanical_repair
title: Mechanical Repair
description: "Repairing mechanical devices, engines, locks — fixing cars, machines, mechanisms"

skillCheck:
  skill: Mechanical Repair
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
  item:
    inject: [sceneItems, actorInventory]

outputSchema:
  use:
    - item.modify
    - memory.event
    - character.fatigue

interpreter:
  examples:
    - "Repair the car engine"
    - "Fix the jammed mechanism"
    - "Fix the jammed lock mechanism"
---

# Mechanical Repair Resolution Guidance

## On Success
- **Regular success**: The mechanical fault is identified and corrected. An engine turns over, a seized gear is freed, a broken mechanism returns to working order. The repair holds for normal use.
- **Hard success**: The repair is solid and precise. The mechanism functions smoothly and the actor spots related wear or damage that might cause future problems, addressing it proactively with available time and parts.
- **Extreme success**: The actor's repair restores the mechanism to peak condition. Beyond simply fixing the fault, they leave the device in better shape than it was before the damage — quieter, more reliable, or with improved performance.

## On Failure
- The mechanism remains non-functional. The actor cannot identify the fault or cannot address it with the available tools and time.
- Effort and time are lost. In urgent situations this delay has direct consequences for the scenario.
- A fumble means the actor makes the damage worse — a misapplied wrench strips a bolt, a poorly reset component seizes harder, or a delicate spring breaks entirely under too much force.
- Subsequent repair attempts require better tools, replacement parts, or a different approach.
