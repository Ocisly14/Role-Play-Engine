---
id: pistol
title: Pistol
description: "Ranged attacks with handguns and revolvers — aiming, firing, and quick-drawing. Does NOT cover rifles, shotguns, submachine guns, bows, or any melee attack."

skillCheck:
  skill: Pistol
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

interpreter:
  examples:
    - "Draw my revolver and fire at the cultist."
    - "Shoot the man in the leg with my pistol."
    - "Fire a shot at the fleeing figure before he reaches the door."
    - "Quick-draw and put two rounds into the creature's chest."
    - "Aim my .45 at his head and pull the trigger."

impactHint:
  default: 3
  range: "2-4"
  examples: "suppressed=2, normal shot=3, in a crowd=4"
---

# Pistol Resolution Guidance

## On Success
- **Regular success**: The shot connects — deal 1d10 damage to the target. At standard range the round strikes center mass, punching through clothing and causing a serious wound.
- **Hard success**: A precisely aimed shot — deal 1d10 damage to a specific chosen location (head, gun hand, leg). A head shot at hard difficulty is not automatically lethal but inflicts full damage with potential for a major wound.
- **Extreme success**: A headshot or critical hit — deal double damage (2d10) or an automatic major wound. The target is likely incapacitated or killed outright depending on their remaining HP.

## On Failure
- The shot goes wide — a poor grip, sudden movement, or nerves spoiling the aim.
- No damage is dealt this exchange and the bullet is spent.
- The sound of the shot still echoes through the scene regardless of whether it hit; nearby observers may react according to the scene.
- A fumble means the pistol jams, misfires, or is accidentally dropped — the actor must spend a full action to clear the malfunction before firing again.
