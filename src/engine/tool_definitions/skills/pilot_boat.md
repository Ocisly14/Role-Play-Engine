---
id: pilot_boat
title: "Pilot (Boat)"
description: "Piloting boats and ships — navigating waterways, storms, docking"

skillCheck:
  skill: "Pilot (Boat)"
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
    - "Pilot the boat through the storm"
    - "Control the small boat in the rapids"
    - "Navigate the boat through rough waters"
---

# Pilot (Boat) Resolution Guidance

## On Success
- **Regular success**: The actor steers the vessel safely through the hazard — rough water, a narrow channel, a storm, a pursuit. The boat and crew reach the intended position or destination intact.
- **Hard success**: The actor pilots with skill and reads the water expertly. The vessel makes good speed, avoids hazards that would trap a less experienced sailor, and docks or maneuvers precisely as needed.
- **Extreme success**: The actor's seamanship is exceptional. They navigate a storm that should have been fatal, thread through rocks at high speed without a scratch, or handle a damaged vessel in a way that would be impossible for most pilots.

## On Failure
- The actor loses control of the vessel. The boat is pushed off course, broaches in heavy seas, or strikes an obstacle.
- Hull damage may cause the vessel to take on water. Passengers and actor may be thrown overboard.
- HP damage results from collision or capsizing (1d6 to 3d6 based on severity). Those in the water must make Swim rolls.
- A fumble means the vessel capsizes or is wrecked entirely. Everyone aboard is in the water and must fight to survive — Swim checks required immediately.
