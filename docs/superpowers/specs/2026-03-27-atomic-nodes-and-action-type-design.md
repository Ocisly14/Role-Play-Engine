# Atomic Node Generation & routine→action Type Rename

Date: 2026-03-27

## Problem

Two related issues with the current NPC detailed node generation system:

### 1. Non-atomic nodes

The LLM generates nodes that cram multiple distinct actions into a single node. Example:

> [routine] Put the folder into the cabinet and lock it, take out fake records to cover tracks, clean fingerprints off the handle, and write a fake log entry

This causes:
- **Simulation imprecision**: Interruption/encounter detection only happens between nodes, not within. A multi-action node is all-or-nothing.
- **Skill roll granularity lost**: Multiple potentially failable actions bundled under one roll (or no roll).
- **Narrative quality**: Outcomes are bloated; witness memories are imprecise.
- **Memory accuracy**: If interrupted mid-node, the memory records actions that never happened.

### 2. `routine` type conflation

The `routine` node type is a catch-all that absorbs actions involving objects and characters. Since `routine` does not trigger an LLM resolver, these actions have no mechanical effect — items don't move, information isn't transferred, state doesn't change.

Example misuses:
- `routine`: "Put USB drive and notebook back into the key ring" — should be `object_interaction`
- `routine`: "Watch Bruno's movements to assess his next move" — if using a skill, should be `character_interaction`

## Solution

### Part 1: Atomic node prompt rewrite

Replace the "Node Quality" and "Action Continuity" sections in the detailed node and revision prompts with explicit atomic decomposition rules.

**Split rule (physical continuity)**: Create a new node whenever:
- Switching to a different object
- Switching to a different person
- Changing method or intent
- There is a natural "then" / "and then" break

**Do NOT split**:
- Trivial micro-actions (adjusting posture, glancing around)
- Natural continuation of the same physical activity (opening a drawer and reaching inside)
- Actions that cannot produce an independent outcome (unlocking is part of opening)

### Part 2: `routine` → `action` rename

Rename the `routine` node type to `action` with a strict new definition:

> **"action"**: A self-contained action that does NOT change any object, character, or scene state. Use this for narrative-only behavior: waiting, thinking, eating, resting, watching (without using a skill), pretending, walking around a room, etc. No LLM resolver runs.

The definition uses **exclusion logic** — if the action involves an object, character, or scene state change, it must use the corresponding type instead.

### Part 3: Skill Checks rewrite with CoC 7e rules

Replace the existing Skill Checks prompt section with guidance based on official CoC 7e Keeper rules:

**Core principle**: Only roll when the outcome is genuinely uncertain AND failure has meaningful consequences.

**Skill determines node type**:
- Skill targeting a person → `character_interaction`
- Skill targeting an object → `object_interaction`
- Skill targeting the environment → `scene_interaction`
- No skill, no state change → `action`

## Detailed Prompt Changes

### New Node Type Reference

```
## Node Type Reference

- **"action"**: A self-contained action that does NOT change any object, character,
  or scene state. Use this for narrative-only behavior: waiting, thinking, eating,
  resting, watching (without using a skill), pretending, walking around a room, etc.
  No LLM resolver runs — the engine treats this as "the character did it, period."

  If your action involves:
  - Moving/hiding/using/modifying a physical item → use "object_interaction"
  - Talking to, persuading, threatening, or observing (with a skill) another character
    → use "character_interaction"
  - Searching, investigating, or modifying the environment → use "scene_interaction"
  - Going to a different location → use "movement"

- **"movement"**: Move to a destination. Set location to the exact destination name
  from "Places You Know".

- **"character_interaction"**: Interact with one or more characters. This includes
  any action that uses a skill targeting another character (e.g., Spot Hidden to
  observe someone, Psychology to read them, Persuade to convince them).
  - Describe what you do entirely in `action`.
  - Put all targets in top-level `targetCharacterIds`.

- **"object_interaction"**: Interact with a physical object — pick up, hide, move,
  use, combine, lock, unlock, destroy, etc. Describe what you do in `action`.
  Set `objectInteractionPayload.itemId` to the primary item. An LLM resolver
  handles all state changes.

- **"scene_interaction"**: Search, investigate, or modify the environment.
  - Only include `sceneConnectionEffect` when you are changing a real map connection.
  - `sceneConnectionEffect.targetScenarioId` must be an existing connected location ID.
  - Never invent internal sub-areas, doors, partitions, or descriptive labels.
```

### New Node Quality Section

```
## Node Quality — Atomic Actions

Each node must be **one atomic action** — a single, physically continuous activity
with one verb and one target. Split into separate nodes whenever:

- You **switch to a different object** (putting away notebook → picking up keys = 2 nodes)
- You **switch to a different person** (talking to A → turning to B = 2 nodes)
- You **change method or intent** (hiding a file → wiping fingerprints = 2 nodes)
- There is a natural **"then"** or **"and then"** break in the activity

**Good decomposition:**
- Node 1: [object_interaction] Put the sealed folder into the filing cabinet and lock it
- Node 2: [object_interaction] Take out irrelevant records and place them on the archive shelf as cover
- Node 3: [action] Wipe down the cabinet handle and surrounding surfaces
- Node 4: [object_interaction] Write a brief routine inspection entry in the mortuary log

**Bad (crammed into one node):**
- [routine] Put the folder into the cabinet and lock it, take out fake records to cover tracks,
  clean fingerprints off the handle, and write a fake log entry

**What is NOT a separate node:**
- Trivial micro-actions embedded in a larger action (adjusting posture, glancing around)
- Natural continuation of the same physical activity (opening a drawer and reaching inside)
- Actions that cannot produce an independent outcome (unlocking a lock is part of opening a container)

## Action Continuity

- Atomic nodes must still form a **logical, coherent sequence**. Each action should
  naturally follow from the previous one.
- The sequence should read as a believable chain of behavior — no abrupt jumps
  between unrelated activities.
- Think: what would a real person do next given where they are and what just happened?
```

### New Skill Checks Section

```
## Skill Checks (Call of Cthulhu 7e Rules)

The engine acts as Keeper. A skill roll is called ONLY when:
1. The outcome is **genuinely uncertain** for someone with this character's ability
2. Failure has **meaningful consequences** (danger, lost time, alerting enemies,
   missing information, psychological harm)

**Do NOT use a skill when:**
- The task is trivially easy for a competent person (opening an unlocked door,
  reading a sign, walking down a street, picking up an object in plain sight)
- Failure would have no interesting consequence ("nothing happens" is not a stake)
- The outcome is a foregone conclusion (attacking a sleeping person, entering an
  empty unlocked room)

**DO use a skill when:**
- There is opposition or resistance (another character resists, a lock is locked,
  information is hidden)
- There is danger or time pressure (even a routine task becomes roll-worthy under
  stress or pursuit)
- The character is attempting something deceptive, forceful, or creative beyond
  normal capability

**Skill use determines node type:**
- Action with NO skill → type is usually "action" (pure narrative, no state change)
- Skill targeting a **person** (Spot Hidden to observe, Psychology to read, Persuade
  to convince, Intimidate to threaten) → "character_interaction" with targetCharacterIds
- Skill targeting an **object** (Locksmith to pick a lock, Mechanical Repair to fix
  something, Sleight of Hand to hide an item) → "object_interaction"
- Skill targeting the **environment** (Spot Hidden to search a room, Track to follow
  footprints, Navigate to find a path) → "scene_interaction"

**Social interactions:**
- Normal conversation, greetings, small talk, sharing information → NO skill,
  use "character_interaction" only if it meaningfully affects the target
- Coercion, seduction, deception, intimidation, extracting secrets, convincing
  someone to act against their interest → USE skill (Charm/Persuade/Intimidate/
  Fast Talk), type "character_interaction"

**Difficulty:**
- "regular" (roll <= skill value): Standard challenge — vast majority of rolls
- "hard" (roll <= skill/2): Exceptionally difficult, would challenge a professional
- "extreme" (roll <= skill/5): Borders of human capability — very rare
```

## Code Changes

### Type definition (`types.ts`)

Rename `PlanNodeType` value: `"routine"` → `"action"`.

### Handler rename

- `routineHandler.ts` → `actionHandler.ts`
- Class/function names: `routine` → `action`
- Registry registration key: `"routine"` → `"action"`

### TickProcessor (`tickProcessor.ts`)

All `"routine"` string comparisons → `"action"`.

### Prompt templates (`npcPlanningTemplates.ts`)

- Replace `DEFAULT_DETAILED_NODE_TYPE_REF` with the new Node Type Reference
- Replace "Node Quality" and "Action Continuity" sections with the new atomic rules
- Replace "Skill Checks" section with the new CoC 7e-based version
- Update output schema: `"routine|movement|..."` → `"action|movement|..."`
- Apply same changes to the revision prompt (`buildRevisePlansPrompt`)

## What does NOT change

- Handler internal execution logic (action handler still only does rest subtype + narrative)
- LLM resolver call pattern (action still does not call resolver)
- Impact/memory/revision/encounter pipeline
- Movement, character_interaction, object_interaction, scene_interaction handler logic
- Database schema
