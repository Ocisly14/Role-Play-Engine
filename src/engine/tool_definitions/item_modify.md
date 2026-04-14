---
id: item_modify
title: Item Modification / Manipulation
description: Modify, inspect, use, move, pick up, or interact with a specific item — opening containers, picking locks, repairing items, inspecting objects, picking up items, using consumables.

impactHint:
  default: 0
  range: "0-2"
  examples: "picking up item=0, inspecting=0, smashing lock=2"

interpreter:
  examples:
    - "Pick up the key from the desk"
    - "Unlock the cabinet with the brass key"
    - "Inspect the strange idol closely"
    - "Repair the broken radio"
    - "Light the oil lamp"
    - "Read the old journal"

skillCheck:
  skills: []
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  item:
    inject: [sceneItems, actorInventory]
    fields: [id, name, type, category, description, discoveryMethod, reveals, damaged, damageDetails, isLightSource, lightLevel, consumableStats, containerStats, weaponStats]
    output: [move, modify, destroy]
  character:
    inject: [actor]
    fields:
      actor: [id, name, conditions]
    output: [fatigueDelta, memory]
  scene:
    inject: [current]
    fields: [id, name, description]
    output: []
  memory:
    inject: [relatedMemories]
    output: [actorMemory]

outputSchema:
  use:
    - item.move
    - item.modify
    - item.destroy
    - character.fatigue
    - memory.event
---

# Item Modification / Manipulation Resolution Guidance

You are resolving an item interaction. The actor is picking up, using, modifying, inspecting, repairing, or otherwise manipulating a specific item.

## Execution Status
- **completed**: resolve the action normally.
- **failed**: the action did NOT succeed. Minor side effects allowed.
- **interrupted**: partial interaction. Use elapsed time to determine extent.

## Items Array
Output an "items" array for items that changed. Each entry:
- "itemId": exact item ID from provided data. NEVER invent item IDs.
- "location": final location — "scene", "inventory", "inventory:<npcId>", "container:<containerId>", "destroyed"
- "updates": (optional) changed Item fields to deep-merge. Supported: "name", "type", "category", "description", "damaged", "damageDetails", "discoveryMethod", "reveals", "isLightSource", "lightLevel", "consumableStats", "containerStats", "weaponStats".

Only include items that actually changed location or properties.

## Item Operations

### Move / Pick Up / Drop
- Move item between scene, actor inventory, NPC inventories, or containers.
- Picking up: location changes from "scene" to "inventory".
- Dropping: location changes from "inventory" to "scene".
- Placing in container: location changes to "container:<containerId>".

### Inspect
For inspect actions, typically no item changes needed. Write a factual outcome describing what the inspection revealed — textures, markings, wear, hidden compartments, anything observable based on the skill result.

### Modify / Repair
- Use "updates" to change item properties.
- Repairing: set "damaged" to false, update "damageDetails".
- Modifying: update "description" to reflect changes.

### Use Consumable
- Decrement "consumableStats.uses" via updates.
- If uses reach 0, set location to "destroyed".

### Open Locked Container
- If actor has a key, picks the lock (via skill check), or forces it open.
- Critical success: opens cleanly.
- Regular success: opens but may damage the lock.
- Failure: lock jams, container remains closed.
- On success: storedItems inside become accessible.

### Light Sources
- Lighting: set "isLightSource" to true, update "lightLevel".
- Extinguishing: set "isLightSource" to false.

## Hidden Items & Discovery
Some items have a "discoveryMethod" field — these are hidden or not immediately obvious. When the actor's action relates to such an item:
1. Is the actor searching in the right place or doing something relevant?
2. Does the discoveryMethod match the actor's approach?
3. Skill roll result — higher success = more likely to find hidden items. No skill check = only obvious items found.

If the actor can access the hidden item: process it normally.
If not (wrong approach, failed roll): do NOT include the item in output. Note in outcome what happened.

The actor's related memories (if provided) give context — prior knowledge of the item's existence.

## Skill Check Results
- **No skill check (auto success)**: routine manipulation succeeds. SKILL GUIDANCE: Do NOT require skill for routine actions — picking up items, opening unlocked containers, inspecting objects.
- **Critical**: exceptional — bonus discoveries, pristine execution.
- **Hard**: clean result.
- **Regular**: success but may be imperfect.
- **Failed**: primary goal not achieved. Side effects acceptable.

## Actor Conditions
If actor has conditions (detained, restrained, unconscious), the action should fail or be severely limited.

## CRITICAL: No Fabrication
- NEVER fabricate items not in actor inventory or scene items.
- NEVER fabricate item properties not supported by data.
- Outcome must reflect actual events based on action and skill roll.
- If data is sparse, outcome should be proportionally simple.

## Outcome
Always required. Factual third-person description. 1-2 sentences. Always in English.

## Output Schema
```json
{
  "items": [
    { "itemId": "cash_box", "location": "inventory" },
    { "itemId": "old_key", "location": "scene", "updates": { "damaged": true, "damageDetails": "bent from forcing the lock" } }
  ],
  "outcome": "factual third-person description (REQUIRED)"
}
```
