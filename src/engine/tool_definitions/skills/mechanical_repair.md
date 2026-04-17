---
id: mechanical_repair
title: Mechanical Repair
description: "Diagnose, fix, modify, or build mechanical devices — engines, gears, clockwork, and mechanical locks. Does NOT cover electrical systems (Electrical Repair) or passive observation."

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
  presets: [default, item_modify]
  requireOnSuccess:
    - item.modify
    - scene.condition

interpreter:
  examples:
    - "Strip down the seized engine and replace the cracked piston"
    - "Diagnose why the printing press keeps jamming and free the stuck gear train"
    - "Rebuild the clockwork mechanism so the timer operates correctly"
    - "Weld the broken axle back into alignment so the vehicle can move"
    - "Fabricate a replacement gear from scrap metal to restore the winch"
---

# Mechanical Repair Resolution Guidance

## State Changes
- Use `item.modify` for repaired machinery, cleared jams, replaced settings, or restored moving parts.
- Use `item.destroy` when a spring, bolt, gear, or other component is ruined during the attempt.
- Use `item.move` when parts are removed, reinstalled, or repositioned as part of the repair process.
- Use `item.create` only when the actor fabricates or recovers a grounded replacement part during the repair.
- Use `memory.information` only when the actor learns a concrete diagnostic detail about the fault, wear pattern, or mechanism design.

## On Success
- **Regular success**: The mechanical fault is identified and corrected. An engine turns over, a seized gear is freed, a broken mechanism returns to working order. The repair holds for normal use.
- **Hard success**: The repair is solid and precise. The mechanism functions smoothly and the actor spots related wear or damage that might cause future problems, addressing it proactively with available time and parts.
- **Extreme success**: The actor's repair restores the mechanism to peak condition. Beyond simply fixing the fault, they leave the device in better shape than it was before the damage — quieter, more reliable, or with improved performance.

## On Failure
- The mechanism remains non-functional. The actor cannot identify the fault or cannot address it with the available tools and time.
- Effort and time are lost. In urgent situations this delay has direct consequences for the scenario.
- A fumble means the actor makes the damage worse — a misapplied wrench strips a bolt, a poorly reset component seizes harder, or a delicate spring breaks entirely under too much force.
- Subsequent repair attempts require better tools, replacement parts, or a different approach.
