---
id: action
engine: llm
title: Current-Location Action
description: "A routine current-location action that needs no specialized skill — picking up an item, reading a visible note, operating a pre-existing device, resting, eating, waiting, or barricading with nearby furniture. FALLBACK: use a specific skill when one fits (Perception for searching hidden things, Listen for hearing through walls, Stealth for hiding in motion, Locksmith for picking locks, First Aid for treating wounds, Mechanical Repair / Electrical Repair for fixing gear)."

impactHint:
  default: 0
  range: "0-2"
  examples: "thinking/resting/observing=0, lighting a lamp=1, barricading=2"

interpreter:
  examples:
    - "Pick up the key from the desk"
    - "Read the old journal"
    - "Light the oil lamp"
    - "Rest and catch my breath"
    - "Put the registry log into my pocket from the counter"
    - "Barricade the entrance with furniture"

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, conditions]
    output: [character.hp, character.condition, character.fatigue, memory.event]
  scene:
    inject: [current]
    fields: [id, name, description, conditions, items, connections]
    output: [scene.condition, character.position]
  item:
    inject: [sceneItems, actorInventory]
    output: [item.move, item.modify, item.destroy, item.create]

outputSchema:
  presets: [default, item_modify]
  use:
    - character.hp
    - character.condition
    - character.position
    - scene.condition
  requireOnSuccess:
    - character.position
    - scene.condition
    - item.modify
    - item.move
    - item.create
    - item.destroy
  durationGuidance:
    default: 3
    range: "1-15"
    notes: "routine pickup/read 1-2 min; light or meaningful action 3-5 min; barricade or multi-step setup 10-15 min"
---

# Current-Location Action Resolution Guidance

You are resolving a current-location action. The node may be a quiet self-directed action or an environmental interaction. Many actions produce no scene delta at all.

## Execution Status
- **completed**: resolve the action normally.
- **failed**: the primary goal did NOT succeed. Usually output no scene change, though grounded side effects are allowed.
- **interrupted**: the action stopped partway through. Use elapsed time and the trigger information to decide whether there is no effect or only a partial effect. Do NOT assume the full intended result happened.

## Scene Conditions
Use `scene.condition` for observable environmental changes. Only include `mechanicalEffect` when it has a clear impact on dice rolls or movement.
Use the `add` list to add conditions and the `remove` list to remove existing conditions.

## Access / Passage
If the action blocks, clears, reveals, or hides access between locations, reflect the resulting state with `scene.condition`.
If the action physically moves the actor through that opening, also use `character.position`.

## Incidental Relocation (`character.position`)
Use `character.position` only when the action itself physically displaces the actor into a nearby valid location as a side effect, such as:
- jumping out a window into a courtyard
- diving through a newly opened passage
- crawling into a revealed hidden stairwell

Rules:
Do NOT use `character.position` for ordinary travel or deliberate navigation. Those belong in a movement node.
Use the exact destination scene ID from the provided relocation targets.
Omit `character.position` when the actor stays where they are.
On failed or interrupted actions, only use `character.position` if the action genuinely got the actor to the destination.
Never use `character.position` to teleport to a distant or unrelated location.

## Hidden Connections
Connections marked as [HIDDEN] are secret passages, trap doors, or concealed exits that the actor does not know about.
- Only reveal them when the actor's action is specifically a search or investigation AND the skill roll succeeds.
- A critical success may reveal even the most cleverly concealed passages.
- A regular success reveals passages that are moderately hidden.
- Without a skill check or on failure, hidden connections must NOT be revealed.
- Reflect any discovery in `scene.condition`, `character.position`, or `memory.event` as appropriate.

## Skill Check Results
- **No skill check (auto success)**: routine actions succeed as described. Hidden connections are NOT revealed without a skill check.
- **Critical success**: exceptional outcome — may reveal even extremely well-hidden passages.
- **Hard success**: strong outcome — reveals moderately hidden passages.
- **Regular success**: moderate outcome — reveals obvious-ish hidden passages.
- **Skill check failed**: the action did NOT succeed. Reflect this in the memory. The actor found nothing unusual.

## Items
Use `item.move`, `item.modify`, `item.destroy`, and `item.create` for item state changes:
- use exact item IDs from the provided scene or inventory data
- only include items that actually changed
- do not invent source items or unsupported item properties
- use `item.create` only when the action clearly transforms provided materials or opens an existing object into a grounded new item or recovered part

Common cases:
- tool gets damaged from forceful use
- consumable used up
- item dropped during action
- note or clue read, inspected, or discovered as `memory.event`
- simple improvised result created from available materials

## Actor Conditions
If the actor has physical conditions listed (e.g. "detained", "restrained", "unconscious"), these represent binding constraints. A detained or restrained actor cannot freely search rooms, barricade doors, or perform actions requiring free movement. Reflect these constraints in the outcome — the action should fail or be severely limited.

## Memory
Always required for the actor. Write from the actor's first-person perspective: what they did, what they observed, and the result.
- **Keep it concise: 1-3 sentences for routine interactions.** Only write longer memories (4+ sentences) for truly significant events — discovering a hidden passage, witnessing a supernatural phenomenon, or encountering something dangerous.
- Write in the specified language.

## Fatigue
Use `character.fatigue`.
- integer from -3 to 3
- Negative = reduced fatigue (resting, catching breath, safe downtime)
- Positive = increased fatigue (searching hard, forcing doors, sustained exertion)
- Omit or use 0 when negligible
- Interrupted actions should usually have smaller fatigue changes than completed ones

## CRITICAL: No Fabrication
- **All judgments must be grounded in the provided data.** You are a state resolver, not a story generator.
- **Never fabricate scene contents:** Do not invent objects, furniture, or environmental features not in the scene data.
- **Never fabricate connections:** any access change must reference real locations from the scene data and be expressed through `scene.condition` or `character.position`.
- **Never fabricate items:** existing items must reference exact item IDs from scene items or actor inventory. Newly created items must be grounded in the described action and available materials.
- **Memory must reflect actual events.** If the scene data is sparse, the outcome should be proportionally simple.

## On Success

### scene
- Add relevant `scene.condition` entries with mechanical effects where applicable.
- Reveal hidden connections if skill check warrants it.

### item
- Apply item state changes (damage, consume, move).

### character
- `character.fatigue`: based on exertion level
- `memory.event`: first-person account of what happened and what was learned

## On Failure

### scene
- Usually no scene changes on failure.

### character
- `character.fatigue`: +1 (the attempt still costs effort)
- `memory.event`: first-person account reflecting failure

## Output Schema Example
```json
{
  "scene.condition": [
    { "sceneId": "study_scene_id", "add": ["the door is barricaded with heavy furniture"] },
    { "sceneId": "study_scene_id", "add": ["the room is pitch dark"] }
  ],
  "character.position": [
    { "characterId": "actor_id", "sceneId": "courtyard_scene_id" }
  ],
  "item.modify": [
    { "itemId": "crowbar", "properties": { "damaged": true } }
  ],
  "character.fatigue": [
    { "characterId": "actor_id", "delta": 1 }
  ],
  "memory.event": [
    { "characterId": "actor_id", "content": "I barricaded the door and climbed into the courtyard." }
  ]
}
```
