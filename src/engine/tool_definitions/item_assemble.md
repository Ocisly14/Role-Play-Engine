---
id: item_assemble
title: Item Assembly / Crafting
description: Combine, assemble, or craft items together — combining ingredients, assembling components, crafting tools or devices from parts.

impactHint:
  default: 0
  range: "0-2"
  examples: "quietly assembling=0, noisy construction=2"

interpreter:
  examples:
    - "Combine the chemicals to create an explosive"
    - "Assemble the ritual components"
    - "Build a makeshift barricade from furniture parts"

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

outputSchema:
  use:
    - item.move
    - item.modify
    - item.destroy
    - item.create
    - character.fatigue
    - memory.event
---

# Item Assembly / Crafting Resolution Guidance

You are resolving an item assembly or crafting action. The actor is combining multiple items or components to produce something new.

## Execution Status
- **completed**: resolve the assembly normally.
- **failed**: the items were NOT successfully combined. Components may be damaged or wasted.
- **interrupted**: partial assembly. Components may be in an intermediate state.

## Items Array
Output an "items" array for source items that are consumed or changed:
- "itemId": exact item ID from provided data. NEVER invent item IDs.
- "location": final location — typically "destroyed" for consumed components.
- "updates": (optional) changed Item fields to deep-merge.

## New Items Array
Use "newItems" for the assembled/crafted result. Each entry:
- "id": new unique ID (descriptive slug, e.g. "makeshift_torch_01")
- "name": display name
- "type": item type (optional)
- "description": item description (optional)
- "category": "evidence" or "mundane" (optional)
- "location": where the new item appears — "inventory" (actor takes it) or "scene"
- "sourceItemId": one of the consumed component IDs — that component is automatically destroyed. Multiple new items can share the same sourceItemId.

## Assembly Rules
- All component items must exist in the provided actor inventory or scene items. NEVER fabricate components.
- Base decisions on: action description, skill roll result, physical plausibility.
- Critical success: perfect assembly, bonus properties or quality.
- Hard success: clean assembly, works as intended.
- Regular success: assembled but may have minor flaws.
- Failed: components may be wasted or damaged without producing the result.

## Skill Check Results
- **No skill check (auto success)**: simple combinations succeed.
- **Critical**: exceptional quality result.
- **Hard**: clean result.
- **Regular**: functional but imperfect.
- **Failed**: primary goal not achieved. Components may be partially consumed.

## Actor Conditions
If actor has conditions (detained, restrained, unconscious), the action should fail or be severely limited.

## CRITICAL: No Fabrication
- NEVER fabricate source items not in provided data.
- All components referenced must exist in actor inventory or scene items.
- Crafted results should be physically plausible for the CoC 7e setting.
- If data is sparse, outcome should be proportionally simple.

## Outcome
Always required. Factual third-person description. 1-2 sentences. Always in English.

## Output Schema
```json
{
  "items": [
    { "itemId": "rope_01", "location": "destroyed" },
    { "itemId": "stick_01", "location": "destroyed" }
  ],
  "newItems": [
    { "id": "makeshift_torch_01", "name": "Makeshift Torch", "type": "tool", "description": "A crude torch made from rope and a stick", "location": "inventory", "sourceItemId": "rope_01" }
  ],
  "outcome": "factual third-person description (REQUIRED)"
}
```
