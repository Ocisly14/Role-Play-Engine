---
id: character_interaction
title: Character Interaction
description: "Any interaction with one or more target characters that is not covered by a specific skill — casual conversation, greetings, asking open questions, giving an order, leading or escorting, or non-manipulative information exchange. FALLBACK: use a specific skill when the interaction has a manipulative mode (Persuade / Charm / Intimidate / Bluff), therapeutic intent (Psychoanalysis), physical violence (Brawling / Axe / Sword / Whip / Firearms / Throw), or pure item handoff without dialogue (Item Exchange)."

impactHint:
  default: 1
  range: "0-1"
  examples: "whispering=0, casual conversation=1, ordering someone=1"

interpreter:
  examples:
    - "Ask the innkeeper about the missing person"
    - "Chat casually with the bartender"
    - "Greet the deputy at the front desk"
    - "Order the guard to step aside"
    - "Lead the frightened witness to safety"
    - "Ask the shopkeeper what he knows about the neighborhood"

skillCheck:
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, occupation, appearance, personality, isAlive, conditions]
      targets: [id, name, occupation, appearance, personality, isAlive, position, conditions, relationship, knowledge]
    output: [character.position, character.fatigue, memory.event, relationship.change]
  scene:
    inject: [current]
    fields: [id, name, description, conditions, connections]
    output: []
  relationship:
    inject: [actorToTargets]
    output: [change]

outputSchema:
  presets: [default]
  use:
    - character.position
    - relationship.change
  requireOnSuccess:
    - relationship.change
---

# Character Interaction Resolution Guidance

You are resolving a character interaction that has already been determined to complete, fail, or be interrupted. Determine the concrete state changes for both characters.

You are resolving a non-combat, non-manipulative interaction with one or more target characters. This is the FALLBACK for interactions that do not fit a specific social skill (Persuade / Charm / Intimidate / Bluff / Psychoanalysis), a combat skill (Brawling / Axe / Sword / Whip / Firearms / Throw), or Item Exchange.

If the action is violent, therapeutic, manipulative, or a pure item handoff, the wrong definition was selected — still resolve minimally but do not apply heavy combat/social-manipulation mechanics here.

## Execution Status
- **completed**: resolve the interaction normally.
- **failed**: the exchange fell flat — awkward, ignored, or misunderstood. Record the attempt but avoid major state changes.
- **interrupted**: stopped partway through. Use elapsed time to decide no effect or partial effect.

## Movement (`character.position`)
- Use only when the interaction physically moves one of the characters (leading, escorting, urging someone to relocate).
- The destination must be an exact location ID from the connected locations in the scene data. Do not invent IDs.
- Omit when nobody changes location.

## Knowledge Transfer (`memory.event`)
When information is exchanged, encode what each character learned in their memory entries as first-person events.

- Select only facts relevant to the actor's intent. If the actor asked about the town, do not have the target volunteer unrelated secrets.
- A target freely shares information they would mention to anyone (automatic-tier knowledge). To extract guarded knowledge, the actor must use a specific social skill (Persuade / Charm / Intimidate / Fast Talk) — not this definition.
- Success level affects clarity and forthrightness, not whether hidden information unlocks:
  - **critical / hard**: target is especially warm and forthcoming; the actor picks up on subtle cues
  - **regular**: standard casual exchange
  - **fail / fumble**: awkward moment, misunderstanding, or target withholds even freely-shareable info

## Relationship Change (`relationship.change`)
Use `relationship.change` when the exchange meaningfully shifts mutual regard.
- Warm and well-received conversation: small positive shift.
- Rudeness, brushing off, or failed exchange: small negative shift.
- Brief greetings that do not move the relationship: omit.

## Memory
- Always required for the actor and every target involved.
- Write from each character's first-person perspective: what they experienced and understood.
- **Keep it concise: 1-3 sentences for routine exchanges.** Longer memories are for truly significant moments (a revelation, a public confrontation).
- Write in the specified language.

## Fatigue (`character.fatigue`)
- Usually `0` for casual talk — omit the field.
- `+1` only for prolonged or stressful interaction (e.g. leading a panicked witness through a crowd).

## CRITICAL: No Fabrication
- All judgments must be grounded in provided data.
- **Never fabricate knowledge**: characters may only learn information from provided "Candidate knowledge" or directly observable context.
- **Never fabricate locations**: `character.position` values must reference exact connected-location IDs.
- Dialogue, emotional reactions, and subjective judgments may be creative; factual content must match injected data.

## On Success

### character
- Actor and every target: `memory.event` describing what happened and what was learned from each character's perspective
- `relationship.change` when the exchange shifts mutual regard
- `character.position` when the interaction led someone to move

## On Failure

### character
- Actor: `memory.event` reflecting the unsuccessful exchange
- Target: `memory.event` noting the attempted interaction
- Usually no position or relationship change

## Output Schema Example
```json
{
  "memory.event": [
    { "characterId": "actor_id", "content": "I asked Helen about the missing man; she said she saw him yesterday near the docks." },
    { "characterId": "target_id", "content": "A stranger came asking about the missing man. I told him what little I knew." }
  ],
  "relationship.change": [
    { "fromId": "actor_id", "toId": "target_id", "delta": 1, "note": "polite inquiry, cooperative" }
  ]
}
```
