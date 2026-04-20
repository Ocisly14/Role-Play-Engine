---
id: bow
title: Bow
description: "Ranged attacks with bows and crossbows — drawing, aiming, and loosing arrows or bolts. Does NOT cover firearms, thrown weapons, or any melee attack."

skillCheck:
  skill: Bow
  difficulty: regular
  type: single
  failBehavior: abort

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, stats, conditions, inventory]
      targets: [id, name, stats, conditions]
  scene:
    inject: [current]
    fields: [id, name, description, conditions]

outputSchema:
  presets:
    - default
  use:
    - character.hp
    - character.condition
  requireOnSuccess:
    - character.hp
  durationGuidance:
    default: 1
    range: "1-5"
    notes: "single exchange ≈ 1 min; prolonged combat 2-5 min; pursuing a fleeing target longer"

interpreter:
  examples:
    - "Nock an arrow and shoot the cultist from across the room."
    - "Draw my crossbow and fire a bolt at the fleeing figure."
    - "Aim at the torch on the wall and shoot it out with an arrow."
    - "Silently loose an arrow at the guard before he raises the alarm."

impactHint:
  default: 1
  range: "1-2"
  examples: "silent shot=1, visible shot=2"
---

# Bow Resolution Guidance

## On Success
- **Regular success**: The arrow flies true — deal 1d6+half DB damage. The arrow buries itself in the target, causing a painful puncture wound. Unlike firearms, the shot is nearly silent, preserving the actor's concealment if taken from cover.
- **Hard success**: A precisely aimed shot — deal 1d6+half DB damage to a chosen body location. A shot to the leg may slow the target's movement; a shot to the weapon arm may cause a dropped weapon; positioning and environment affect available options.
- **Extreme success**: A critical hit — the arrow finds a vital spot or impales deeply, dealing double damage (2d6+DB) or triggering an impaling wound. The target may be pinned to a surface or suffer an ongoing bleed if the arrow is not removed.

## On Failure
- The arrow flies wide or falls short — a miscalculation of wind, distance, or the target's movement throws the shot off.
- No damage is dealt this exchange and an arrow is spent.
- A bow attack is generally quiet; a near miss may not immediately alert the target to the shooter's position.
- A fumble means the bowstring snaps, the arrow slips and strikes the ground nearby, or the crossbow fires prematurely — the weapon may need repair or recocking before another shot can be taken.
