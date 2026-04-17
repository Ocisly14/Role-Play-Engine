---
id: operate_heavy_machinery
title: Operate Heavy Machinery
description: "Operating industrial machines such as cranes, bulldozers, and factory equipment. Does NOT cover automobiles (Drive Auto), aircraft (Pilot), or any personal-scale vehicle."

skillCheck:
  skill: Operate Heavy Machinery
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
    - scene.condition
    - item.modify
  requireOnSuccess:
    - scene.condition
    - item.modify

interpreter:
  examples:
    - "Use the dock crane to lift the crate from the ship's hold."
    - "Push the bulldozer through the collapsed wall to clear a path."
    - "Operate the industrial press to stamp out the required components."
    - "Lower the drilling rig's bit to the marked depth without hitting the pipe casing."
---

# Operate Heavy Machinery Resolution Guidance

## On Success
- **Regular success**: The actor operates the machine correctly for the intended task. A crane lifts and places its load, a bulldozer clears the obstruction, an industrial press performs its cycle without incident.
- **Hard success**: The actor operates the machine with practiced efficiency. The task is completed faster, with greater precision, or with less wear on the equipment than expected. The actor anticipates mechanical quirks and works around them.
- **Extreme success**: The actor achieves a result that would impress experienced operators — a delicate lift at the edge of the crane's tolerance, precise demolition work that leaves adjacent structures untouched, or maximum throughput on an industrial process.

## On Failure
- The machine does not perform the intended operation correctly. A load is dropped or placed badly, a vehicle runs into something, a process goes out of sequence.
- Malfunctions may endanger nearby people or damage surrounding structures. The GM determines the specific hazard based on the machine type.
- A fumble means a serious malfunction or accident — a load falls, the machine tips, or the actor loses control entirely. HP damage to the actor or bystanders may result.
- Damaged machinery may require Mechanical Repair before it can be safely operated again.
