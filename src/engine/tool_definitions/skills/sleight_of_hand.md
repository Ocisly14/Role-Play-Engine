---
id: sleight_of_hand
title: Sleight of Hand
description: "Quick, precise hand movements to conceal, produce, or swap small objects WHILE being observed by at least one person. Does NOT apply when simply picking up an unattended item with no one watching."

skillCheck:
  skill: Sleight of Hand
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, conditions]
      targets: [id, name, conditions]
  scene:
    inject: [current]
    fields: [id, name, description]
  item:
    inject: [sceneItems, actorInventory]

outputSchema:
  use:
    - item.move
    - memory.event
  requireOnSuccess:
    - item.move

interpreter:
  examples:
    - "Palm the key from the desk without the guard behind the counter noticing."
    - "Slip the envelope into a coat pocket while shaking the detective's hand."
    - "Swap the real gem for a glass replica while the merchant watches the transaction."
    - "Produce the concealed knife from inside the sleeve while being frisked."
---

# Sleight of Hand Resolution Guidance

## On Success
- **Regular success**: The actor lifts, palms, or plants the item without the target or nearby observers noticing. The item transfer occurs invisibly within the context of natural movement or conversation.
- **Hard success**: The actor's execution is clean and efficient — the motion is so natural that even an attentive observer would have nothing to remark on. The actor may handle a second small item in the same action.
- **Extreme success**: The item is obtained or placed with surgical precision. No one in the scene has any reason to suspect anything occurred. The actor could repeat the action in the same moment if needed.

## On Failure
- The target notices their pocket being touched, or an observer sees the actor reach for the item in a suspicious way.
- The actor is caught in the act — the target confronts them, calls out, or physically stops them.
- A fumble means the actor drops the item conspicuously or makes an obvious grabbing motion, immediately drawing the attention of everyone nearby.
- Once caught attempting sleight of hand, all persons present will watch the actor closely, making further attempts in this scene extremely difficult or impossible.
