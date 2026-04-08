---
id: action
title: Current-Location Action
description: A current-location action performed in the actor's present scene — self-directed behavior, environmental interaction, searching, resting, listening, barricading, hiding in place.

impactHint:
  default: 0
  range: "0-2"
  examples: "thinking/resting/observing=0, searching a room openly=2, screaming=2"

interpreter:
  examples:
    - "Search the study carefully for signs that someone opened the desk"
    - "Rest and catch my breath"
    - "Listen at the door"
    - "Barricade the entrance with furniture"
    - "Hide behind the curtains"

skillCheck:
  skills: []
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, conditions]
    output: [fatigueDelta, memory]
  scene:
    inject: [current]
    fields: [id, name, description, conditions, items, connections]
    output: [addConditions, removeConditions, connectionEffects, moveTo]
  item:
    inject: [sceneItems, actorInventory]
    output: [move, modify, destroy]
---

# Current-Location Action Resolution Guidance

You are resolving a current-location action. The node may be a quiet self-directed action or an environmental interaction. Many actions produce no scene delta at all.

## Execution Status
- **completed**: resolve the action normally.
- **failed**: the primary goal did NOT succeed. Usually output no scene change, though grounded side effects are allowed.
- **interrupted**: the action stopped partway through. Use elapsed time and the trigger information to decide whether there is no effect or only a partial effect. Do NOT assume the full intended result happened.

## Scene Conditions
Use "addSceneConditions" for observable environmental changes. Only include "mechanicalEffect" when it has a clear impact on dice rolls or movement.
Use "removeSceneConditions" to remove existing conditions (use the exact description string).

## Connection Effects
Use "connectionEffects" when the action changes access between locations:
- **"block"**: The actor barricades, locks, or obstructs a passage. The "targetId" must be an existing connected location ID.
- **"unblock"**: The actor clears debris, unlocks, or removes an obstruction.
- **"reveal"**: The actor discovers a hidden passage or secret door. Only use this for connections marked as [HIDDEN] in the scene data. The actor must be actively searching/investigating, and the skill roll must succeed.
- **"hide"**: The actor conceals a passage (rare — e.g. pushing a bookshelf back to cover a secret door).

Each entry needs:
- "targetId": the exact connected location ID from the scene data
- "action": one of "block", "unblock", "reveal", "hide"

## Incidental Relocation (moveTo)
Use "moveTo" only when the action itself physically displaces the actor into a nearby valid location as a side effect, such as:
- jumping out a window into a courtyard
- diving through a newly opened passage
- crawling into a revealed hidden stairwell

Rules:
- Do NOT use "moveTo" for ordinary travel or deliberate navigation. Those belong in a movement node.
- "moveTo" must be the exact ID from the injected "Incidental Relocation Targets" list.
- Omit "moveTo" when the actor stays where they are.
- On failed or interrupted actions, only use "moveTo" if the action genuinely got the actor to the destination.
- Never use "moveTo" to teleport to a distant or unrelated location.

## Hidden Connections
Connections marked as [HIDDEN] are secret passages, trap doors, or concealed exits that the actor does not know about.
- Only reveal them when the actor's action is specifically a search or investigation AND the skill roll succeeds.
- A critical success may reveal even the most cleverly concealed passages.
- A regular success reveals passages that are moderately hidden.
- Without a skill check or on failure, hidden connections must NOT be revealed.
- Do NOT mention hidden connections in the actor's memory if they were not revealed.

## Skill Check Results
- **No skill check (auto success)**: routine actions succeed as described. Hidden connections are NOT revealed without a skill check.
- **Critical success**: exceptional outcome — may reveal even extremely well-hidden passages.
- **Hard success**: strong outcome — reveals moderately hidden passages.
- **Regular success**: moderate outcome — reveals obvious-ish hidden passages.
- **Skill check failed**: the action did NOT succeed. Reflect this in the memory. The actor found nothing unusual.

## Items
Use "items" to output state changes for items affected by the interaction:
- "itemId": the exact item ID
- "location": final location — "scene", "inventory", "destroyed"
- "updates": (optional) changed Item fields to deep-merge (e.g. "damaged", "damageDetails", "consumableStats")

Only include items that actually changed. Common cases:
- Tool gets damaged from forceful use
- Consumable used up
- Item dropped during action

## Actor Conditions
If the actor has physical conditions listed (e.g. "detained", "restrained", "unconscious"), these represent binding constraints. A detained or restrained actor cannot freely search rooms, barricade doors, or perform actions requiring free movement. Reflect these constraints in the outcome — the action should fail or be severely limited.

## Memory
Always required for the actor. Write from the actor's first-person perspective: what they did, what they observed, and the result.
- **Keep it concise: 1-3 sentences for routine interactions.** Only write longer memories (4+ sentences) for truly significant events — discovering a hidden passage, witnessing a supernatural phenomenon, or encountering something dangerous.
- Write in the specified language.

## Fatigue
- "fatigueDelta": integer from -3 to 3
- Negative = reduced fatigue (resting, catching breath, safe downtime)
- Positive = increased fatigue (searching hard, forcing doors, sustained exertion)
- Omit or use 0 when negligible
- Interrupted actions should usually have smaller fatigue changes than completed ones

## CRITICAL: No Fabrication
- **All judgments must be grounded in the provided data.** You are a state resolver, not a story generator.
- **Never fabricate scene contents:** Do not invent objects, furniture, or environmental features not in the scene data.
- **Never fabricate connections:** connectionEffects must only reference targetId values from the scene's Connections list.
- **Never fabricate items:** items must reference exact item IDs from scene items or actor inventory.
- **Memory must reflect actual events.** If the scene data is sparse, the outcome should be proportionally simple.

## On Success

### scene
- Add relevant scene conditions with mechanical effects where applicable.
- Reveal hidden connections if skill check warrants it.

### item
- Apply item state changes (damage, consume, move).

### character
- fatigueDelta: based on exertion level
- memory: first-person account of what happened

## On Failure

### scene
- Usually no scene changes on failure.

### character
- fatigueDelta: +1 (the attempt still costs effort)
- memory: first-person account reflecting failure

## Output Schema
```json
{
  "addSceneConditions": [
    { "description": "the door is barricaded with heavy furniture" },
    { "description": "the room is pitch dark", "mechanicalEffect": { "skillPenalty": [{ "skill": "Spot Hidden", "delta": -30 }] } }
  ],
  "removeSceneConditions": ["exact existing condition to remove"],
  "connectionEffects": [
    { "targetId": "location_id", "action": "reveal" }
  ],
  "moveTo": "courtyard_scene_id",
  "items": [
    { "itemId": "crowbar", "location": "inventory", "updates": { "damaged": true } }
  ],
  "fatigueDelta": 1,
  "memory": "first-person account (REQUIRED)"
}
```
