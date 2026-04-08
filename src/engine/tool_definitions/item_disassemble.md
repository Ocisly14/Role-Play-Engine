---
id: item_disassemble
title: Item Disassembly
description: Disassemble, break apart, or deconstruct an item into component parts — breaking a clock into gears, tearing apart a book, smashing open a locked container.

impactHint:
  default: 0
  range: "0-2"
  examples: "careful disassembly=0, smashing/forcing open=2"

interpreter:
  examples:
    - "Break open the locked cash box"
    - "Disassemble the old clock to get the gears"
    - "Tear apart the journal to find hidden pages"

skillCheck:
  skills: []
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  item:
    inject: [sceneItems, actorInventory]
    fields: [id, name, type, category, description, discoveryMethod, reveals, damaged, damageDetails, isLightSource, lightLevel, consumableStats, containerStats, weaponStats]
    output: [move, modify, destroy, newItems]
  character:
    inject: [actor]
    fields:
      actor: [id, name, conditions]
    output: [fatigueDelta, memory]
  scene:
    inject: [current]
    fields: [id, name, description]
    output: []
---

# Item Disassembly Resolution Guidance

You are resolving an item disassembly action. The actor is breaking apart, deconstructing, or forcing open an item to obtain its components or contents.

## Execution Status
- **completed**: resolve the disassembly normally.
- **failed**: the item was NOT successfully disassembled. Minor side effects allowed (item damaged but intact).
- **interrupted**: partial disassembly. Use elapsed time to determine extent.

## Items Array
Output an "items" array for items that changed. Each entry:
- "itemId": exact item ID from provided data. NEVER invent item IDs.
- "location": final location — "scene", "inventory", "inventory:<npcId>", "container:<containerId>", "destroyed"
- "updates": (optional) changed Item fields to deep-merge. Supported: "name", "type", "category", "description", "damaged", "damageDetails", "discoveryMethod", "reveals", "isLightSource", "lightLevel", "consumableStats", "containerStats", "weaponStats".

The source item being disassembled should typically end up "destroyed" or with "damaged: true".

## New Items Array
Use "newItems" for parts produced by disassembly. Each entry:
- "id": new unique ID (descriptive slug, e.g. "broken_gear_01")
- "name": display name
- "type": item type (optional)
- "description": item description (optional)
- "category": "evidence" or "mundane" (optional)
- "location": where the new item appears (same format as items.location)
- "sourceItemId": the original item this was produced from — the source is automatically destroyed. Multiple new items can share the same sourceItemId (source removed once).

## Disassembly Rules
- Base decisions on: action description, skill roll result, physical plausibility within CoC 7e setting.
- A person can break a wooden box but not a steel vault with bare hands.
- Critical success: clean disassembly, all parts intact, bonus discoveries.
- Hard success: successful disassembly, parts mostly intact.
- Regular success: disassembly works but may damage some parts.
- Failed: item may be damaged but not successfully taken apart.

## Opening Locked Containers
- If the actor has a key, picks the lock (via skill check), forces it open, or finds creative means.
- Critical success might open cleanly; regular success might damage the lock; failure might jam it.
- On success: container's storedItems become accessible — move them to appropriate locations.

## Skill Check Results
- **No skill check (auto success)**: routine disassembly succeeds.
- **Critical**: exceptional — pristine parts, everything recovered.
- **Hard**: clean result.
- **Regular**: success but imperfect (slight damage, noise).
- **Failed**: primary goal not achieved. Side effects acceptable (partial damage).

## Actor Conditions
If actor has conditions (detained, restrained, unconscious), the action should fail or be severely limited.

## CRITICAL: No Fabrication
- NEVER fabricate items not in actor inventory or scene items.
- "newItems" only from disassembling existing items — sourceItemId must reference a real item.
- Do not invent item properties not supported by the data.
- If data is sparse, outcome should be proportionally simple.

## Outcome
Always required. Factual third-person description of what happened. 1-2 sentences. Always in English.

## Output Schema
```json
{
  "items": [
    { "itemId": "clock_01", "location": "destroyed" }
  ],
  "newItems": [
    { "id": "gear_01", "name": "Small Gear", "type": "other", "description": "A tiny brass gear", "location": "scene", "sourceItemId": "clock_01" }
  ],
  "outcome": "factual third-person description (REQUIRED)"
}
```
