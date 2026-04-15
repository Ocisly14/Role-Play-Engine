---
id: survival_desert
title: Survival (Desert)
description: "Surviving in desert and arid environments — finding water, avoiding heatstroke, navigating sand"

skillCheck:
  skill: Survival (Desert)
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
    fields: [id, name, description, conditions]

outputSchema:
  use:
    - character.hp
    - character.fatigue
    - character.condition
    - memory.event
    - memory.information

interpreter:
  examples:
    - "Search for water in the desert"
    - "Avoid heatstroke in this heat"
    - "Find water in the desert"
---

# Survival (Desert) Resolution Guidance

## On Success
- **Regular success**: The actor locates a viable water source — a hidden spring, buried moisture, dew collected on rocks, or cached supplies — and finds shade to avoid the worst of the midday heat. The immediate threat of dehydration is managed for the next several hours.
- **Hard success**: The actor efficiently navigates the desert's dangers — they find sufficient water and identify edible plants or cached food nearby. Travel is planned to avoid peak heat hours, and a landmark or route to safety is identified. Fatigue partially recovers from effective rest management.
- **Extreme success**: The actor draws on deep desert knowledge to not only survive but make real progress — ample water and food are secured, a path to civilization or the objective is charted, and the actor gains useful information about the terrain ahead (memory.information update).

## On Failure
- The actor cannot find water or adequate shade in time before heat and thirst take their toll.
- Dehydration inflicts fatigue accumulation; heatstroke risk increases each hour without hydration, potentially causing 1d3 HP loss and hallucinations.
- Disorientation from the featureless terrain may cause the actor to wander in circles, wasting precious energy and water.
- A fumble means the actor made things worse — consumed contaminated water causing illness, wandered further from safety, or used up supplies without benefit.
