---
id: character_interaction
title: Character Interaction
description: Interact with one or more characters — conversation, persuasion, intimidation, physical combat, item exchange, leading/escorting, or forcing someone to leave.

impactHint:
  default: 1
  range: "1-4"
  examples: "whispering=1, conversation=1, attack/combat=2, gunshot=3, explosion=4"

interpreter:
  examples:
    - "Convince Dr. Morgan to follow me to the library"
    - "Attack the cultist with my fists"
    - "Ask the innkeeper about the missing person"
    - "Give the key to Officer Harlow"

skillCheck:
  difficulty: regular
  type: opposed
  opposedDefense: []
  failBehavior: abort

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, occupation, appearance, personality, isAlive, stats, inventory, position, conditions]
      targets: [id, name, occupation, appearance, personality, isAlive, stats, inventory, position, conditions, relationship, knowledge]
    output: [character.hp, character.san, character.fatigue, character.position, item.move, item.modify, item.destroy, character.condition, memory.event, memory.information, relationship.change]
  scene:
    inject: [current]
    fields: [id, name, description, conditions, items, connections]
    output: []
  relationship:
    inject: [actorToTargets]
    output: [change]

outputSchema:
  presets: [default]
  use:
    - character.hp
    - character.san
    - character.condition
    - character.position
    - item.move
    - item.modify
    - item.destroy
    - memory.information
    - relationship.change
---

# Character Interaction Resolution Guidance

You are resolving a character interaction that has already been determined to complete, fail, or be interrupted. Determine the concrete state changes for both characters.

## Execution Status
- **completed**: resolve the interaction normally.
- **failed**: the primary goal did NOT succeed. Usually output no major state change, though grounded side effects are allowed.
- **interrupted**: the interaction stopped partway through. Use elapsed time and interruption context to decide whether there is no effect or only a partial effect. Do NOT assume the full intended result happened.

## HP / SAN Changes
- When pre-computed damage values are provided in the opposed roll results, use them directly as negative `character.hp` on the target. Do NOT invent different damage numbers.
- When no pre-computed damage is provided, apply damage only when the action involves physical harm or healing, following CoC 7e mechanics.
- If a target resisted the opposed roll ("Target resists"), do NOT apply damage to that target.
- SAN loss: apply only for genuinely disturbing revelations or events (e.g. witnessing violence, learning a Mythos secret). Minor social friction does not cause SAN loss.
- critical success: halve SAN loss if applicable.
- fumble: attacker may harm themselves instead; defender takes no damage.

## Opposed Roll Results
When opposed roll results are provided per-target:
- "Actor wins": The action takes full effect on this target. Use the pre-computed damage value if provided.
- "Target resists": The target successfully defended — the action has reduced or no mechanical effect on this target (no damage, persuasion fails). The target should still get a memory of the attempted interaction.

## Dead Targets / Corpses
- If a target is marked as not alive or has HP <= 0, treat them as a corpse, not an active participant.
- Corpses do not speak, resist, plan, or form new thoughts. Do not invent dialogue or conscious reactions from them.
- You may still apply physical state changes to the corpse when appropriate: moving the body, changing appearance, transferring items, adding conditions, or further damaging it.
- For a dead target's "memory", write a brief state note about what happened to the corpse, not a conscious first-person recollection.

## Actor Success Level Impact
The actor's own success level determines the intensity of effect on targets the actor won against:
- critical: Maximum effect — target is fully convinced/overwhelmed, may volunteer extra cooperation or information beyond what was asked.
- hard: Strong effect — target is clearly affected, complies willingly.
- regular: Moderate effect — target complies but may have reservations or conditions.
- In combat, the pre-computed damage already reflects the success level — use it directly.

## Movement (`character.position`)
- Use only when the interaction physically displaces a character (e.g. fleeing after a fight, being escorted out, being knocked back).
- The value must be an exact location ID from the connected locations in the scene data. Do not invent IDs.
- Omit if neither character changes location as a result of this interaction.

## Items (`item.move` / `item.modify` / `item.destroy`)
- Use item IDs exactly as they appear in the character inventories or scene items list.
- Items transfer from one party to the other, or from the scene to a character. Do not invent new items.
- Use `item.move` for transfer.
- Use `item.modify` for item damage, tampering, or other property changes.
- Use `item.destroy` when the interaction removes the item from play.
- Omit these fields if no item changes hands or changes state.

## Conditions (`character.condition`)
- Use short English labels: "bleeding", "unconscious" etc.
- Add or remove a condition only when it is a direct mechanical or narrative consequence of this interaction.
- Omit if no condition changes.

## Knowledge Transfer In Memory
When knowledge is revealed in this interaction, encode it directly in each character's "memory" text instead of relying on a separate field.

Select which facts each character learns based on TWO factors:

**1. Actor's intent and the interaction method:**
- What was the actor trying to find out or accomplish? Only information relevant to that goal should appear.
- The method matters: casual conversation surfaces only what the target would freely volunteer; persuasion can unlock guarded opinions; intimidation may extract reluctant admissions; deception may yield deliberately false info (write it as a believed fact from the recipient's perspective).

**2. Success level determines depth:**
- All candidate facts known by each target are provided in the context.
- critical: target may reveal even their most guarded secrets (including extreme-difficulty knowledge).
- hard success: target may reveal sensitive information they normally keep private (hard-difficulty knowledge).
- regular success: target may reveal information they would tell someone they moderately trust (regular-difficulty knowledge).
- fail: target usually shares only what they would tell anyone freely (automatic knowledge), or nothing if they are hostile.
- fumble: target shares nothing useful; may actively mislead the actor.

Apply both factors together: a critical success in casual small-talk still only surfaces facts the target actually knows and that are plausible to mention in that context.

## Memory
- Always required for both actor and every target involved.
- Write from that character's first-person perspective: what they experienced, felt, and understood from the interaction.
- Reflect the actual outcome — a failed persuasion attempt should read very differently from a successful one.
- If someone learned information from another character, state clearly who told them and what concrete knowledge they learned.
- If someone disclosed information, state clearly who they told and what concrete knowledge they revealed.
- **Keep it concise: 1-3 sentences for routine interactions.** Only write longer memories (4+ sentences) for truly significant events — combat with serious injury, major revelations, death, or sanity-breaking encounters.
- Write in the specified language.

## Fatigue
- Use `character.fatigue`.
- integer from -3 to 3
- Negative = recovered / caught breath
- Positive = more fatigued from stress, exertion, dragging, fighting, or intense effort
- Omit or use 0 when fatigue impact is negligible
- Interrupted interactions should usually have smaller absolute fatigue changes than completed ones

## CRITICAL: No Fabrication
- **All judgments must be grounded in the provided data.** You are a state resolver, not a story generator.
- **Never fabricate items:** Do not invent items not in character inventories or scene items list.
- **Never fabricate knowledge:** Characters can only learn information from "Candidate knowledge" entries or directly observable context.
- **Never fabricate locations:** `character.position` must reference exact location IDs from connected locations.
- **Deterministic facts must match injected data:** items, objects, scene contents, sensory observations, backstory, lore, and factual information must come from provided context.
- **Non-deterministic character behavior may be creative:** dialogue, lies, deception content, social tactics, emotional reactions, and subjective judgments are yours to craft.

## On Success

### character
- Actor: apply effects based on interaction type and success level
- Target: apply pre-computed damage (combat), condition changes, item transfers
- Both: `character.fatigue` based on exertion
- Both: `memory.event` / `memory.information` from their perspective

## On Failure

### character
- Actor: `character.fatigue` +1
- Actor: `memory.event` reflecting the failed attempt
- Target: `memory.event` noting the attempted interaction (no major state changes)

## Output Schema Example
```json
{
  "character.hp": [
    { "characterId": "actor_id", "delta": -2 }
  ],
  "character.san": [
    { "characterId": "target_id", "delta": -1 }
  ],
  "character.fatigue": [
    { "characterId": "actor_id", "delta": 1 }
  ],
  "character.position": [
    { "characterId": "target_id", "sceneId": "scene_id" }
  ],
  "item.move": [
    { "itemId": "key", "from": "npc_1", "to": "npc_2" }
  ],
  "character.condition": [
    { "characterId": "target_id", "add": ["bleeding"] }
  ],
  "relationship.change": [
    { "fromId": "actor_id", "toId": "target_id", "delta": 1, "note": "helped with the exchange" }
  ],
  "memory.event": [
    { "characterId": "actor_id", "content": "I forced the door and dragged him outside." }
  ],
  "memory.information": [
    { "characterId": "target_id", "content": "I learned he was carrying the key." }
  ]
}
```
