# Call of Cthulhu World-Driven Scenario Generation Specification

## Purpose

This document defines a structured, deterministic generation pipeline for creating a Call of Cthulhu (CoC) scenario using a **world-first, time-driven, sandbox-oriented approach**, designed for execution by an AI system (AI Keeper / Director / World Simulator).

The goal is to generate:
- A coherent town-scale setting
- A hidden mythos-driven truth layer
- Autonomous NPCs with long-term goals
- A time-sliced event system
- A non-scripted but inevitable end state

---

## Design Principles

1. **Truth precedes narrative**
2. **World exists independently of investigators**
3. **NPCs act based on goals, not plot**
4. **Time advances even without player action**
5. **Players are disruptive variables, not protagonists**

---

## Generation Pipeline Overview

The AI MUST generate content strictly in the following order:

1. Macro Scene Construction (Town)
2. Historical Mythos Layer
3. End State Definition (Hidden)
4. NPC Population (Goal-Oriented)
5. Temporal Slicing (Key Time Nodes)
6. Location State Injection
7. Resolution Space Definition

---

## Step 1: Macro Scene Construction — The Town

### Objective
Create the static structural skeleton of the setting.

### Required Fields
- Town Name
- Geographic Layout (natural + artificial)
- Economic Core
- Power Structure
- Information Asymmetry Map (who knows what, approximately)

### Constraints
- No plot events
- No daily life simulation
- No investigators yet

### Output (Current Implementation)
- `macro_scene.json` → `macroScene` object
- `knowledge_matrix.json` → `knowledgeMatrix` + `redHerrings`

---


## Step 2: Historical Mythos Layer

### Objective
Embed mythos influence into the town’s past through discrete historical events.

### Required Output
A list of **Mythos Intrusion Events**, each containing:
- Date / Period
- Event Description (objective, not folkloric)
- Mythos Entity / Phenomenon Involved
- Immediate Consequences
- Long-Term Residue (beliefs, institutions, bloodlines)

### Hard Rule
Each historical event MUST:
- Influence at least one currently living NPC OR
- Shape an existing institution or location

### Output (Current Implementation)
- `macro_scene.json` → `mythosHistory` array

---

## Step 3: End State Definition (Hidden from Players)

### Objective
Define the inevitable outcome of the world **if no investigators intervene**.

### Required Output
- End State Summary (1–3 paragraphs)
- Nature of the catastrophe / transformation
- Winners and survivors (if any)
- Point of no return (time-based or condition-based)

### Constraints
- Must be deterministic
- Must NOT depend on investigator actions
- Must be mythos-consistent

### Output (Current Implementation)
- `macro_scene.json` → `endState` object

---

## Step 4: NPC Population Generation

### Objective
Generate autonomous agents that drive the world forward.

### NPC Schema (Mandatory Fields)

Based on `NPCProfile` and `CharacterProfile` types:

**Core Identity:**
- `id`: string - Unique identifier
- `name`: string - Character name
- `occupation`: string - Role in town
- `age`: number 
- `gender`: string 
- `appearance`: string - Physical description
- `personality`: string - Personality traits
- `background`: string - Personal history

**Goals and Secrets:**
- `goals`: string[] - Long-term objectives they actively pursue
- `secrets`: string[] - Hidden fears/facts they desperately hide

**Attributes (CoC 7e):**
- `attributes`: CharacterAttributes
  - `STR`, `CON`, `DEX`, `APP`, `POW`, `SIZ`, `INT`, `EDU` (all numbers)

**Status:**
- `status`: CharacterStatus
  - `hp`, `maxHp`, `sanity`, `maxSanity`, `luck`, `mp` (numbers)
  - `conditions`: string[] - Current status effects
  - `damageBonus`, `build`, `mov` (optional)

**Capabilities:**
- `skills`: Record<string, number> - Skill name to value mapping
- `inventory`: InventoryItem[] - { name, quantity?, properties? }

**NPC-Specific:**
- `clues`: NPCClue[] - Information the NPC knows or can reveal
  - `id`, `clueText`, `category`, `difficulty`, `revealed`, `relatedTo`
- `relationships`: NPCRelationship[] - Links to other NPCs
  - `targetId`, `targetName`, `relationshipType`, `attitude` (-100 to 100), `description`, `history`
- `currentLocation`: string (optional) - Current physical location
- `isNPC`: true - Flag to distinguish from player characters

**Mythos Awareness:**
Store in `secrets` or `clues` with appropriate difficulty levels:
- None: No clues related to mythos
- Partial: Fragmented clues with misunderstandings
- Distorted: Clues with incorrect interpretations
- Knowing: Accurate mythos clues with high difficulty to extract

### Constraints
- NPCs must NOT know the full truth
- Goals may conflict with each other
- Fear must be exploitable through investigation (stored in `secrets` and extractable via `clues`)

### Output (Current Implementation)
- `data/Mods/<ModuleName>_npc/*.json`

---

## Step 5: Temporal Slicing (Key Time Nodes)

### Objective
Define how the world evolves over time **without investigator intervention**.

### Time Model
Use **Key Nodes**, NOT daily simulation.

Example:
- T0: Status Quo
- T1: First Escalation
- T2: Social Breakdown
- T3: Ritual / Revelation Preparation
- T4: End State Trigger

### Per Time Node, Define:
- Active NPC Actions
- Locations that change state
- New dangers introduced
- Lines crossed (moral / physical / mythos)

### Constraints
- Time nodes must be strictly ordered
- Each node must increase irreversibility

---

## Step 6: Location State Injection

### Objective
Turn buildings and places into evolving systems.

### Location Schema

Based on `ScenarioSnapshot` type:

**Core Identity:**
- `id`: string - Unique scenario identifier
- `name`: string - Scenario/location name
- `location`: string - Primary location identifier
- `description`: string - Detailed description of the scene

**Visual Elements:**
- `showMap`: boolean (optional) - Whether to display map
- `mapImagePath`: string (optional) - Module-relative path to map image

**Characters Present:**
- `characters`: ScenarioCharacter[]
  - `id`, `name`, `role`, `status`, `location`, `notes`

**Available Clues:**
- `clues`: ScenarioClue[]
  - `id`: string
  - `clueText`: string - The actual clue content
  - `category`: "physical" | "witness" | "document" | "environment" | "knowledge" | "observation"
  - `difficulty`: "automatic" | "regular" | "hard" | "extreme"
  - `location`: string - Where this clue can be found
  - `discoveryMethod`: string (optional) - Required skill or method
  - `reveals`: string[] (optional) - What this clue points to
  - `discovered`: boolean - Discovery status
  - `discoveryDetails`: { discoveredBy, discoveredAt, method } (optional)

**Environmental Conditions:**
- `conditions`: ScenarioCondition[]
  - `type`: "weather" | "lighting" | "sound" | "smell" | "temperature" | "other"
  - `description`: string
  - `mechanicalEffect`: string (optional)

**Events and Connectivity:**
- `events`: string[] - Notable events that occurred or may occur
- `exits`: { direction, destination, description?, condition? }[] (optional)
  - `condition` examples: "locked", "hidden", "requires key"

**State Evolution:**
- `permanentChanges`: string[] (optional) - Persistent changes to this location
- `estimatedShortActions`: number (optional) - Estimated actions this scene can accommodate
- `timeRestriction`: string (optional) - Time constraints (e.g., "day1 evening", "day2 (after)")

**Keeper Information:**
- `keeperNotes`: string (optional) - Private notes for the Keeper/Director

### Constraints
- Locations may evolve even if never visited (tracked via `permanentChanges` and `events`)
- Some clues must decay or disappear over time (modify `discovered` status or remove from `clues` array)
- Environmental conditions can change dynamically (update `conditions` array)
- Time restrictions enforce temporal coherence (use `timeRestriction` field)

---

## Step 7: Resolution Space Definition

### Objective
Define all plausible endings based on world deformation.

### Required Endings
- Catastrophic Failure
- Partial Mitigation
- False Victory
- Costly Success

### Constraints
- No “perfect” ending
- Sanity loss and trauma must persist
- World must bear scars

---

## Non-Goals (Explicitly Out of Scope)

- Linear storytelling
- Scene-by-scene scripts
- Mandatory clue chains
- Player railroading
- Balanced combat encounters

---

## Output Expectations

The final generated module MUST be:
- Internally consistent
- Playable in non-linear order
- Robust to investigator inaction or chaos
- Capable of being run by either:
  - A human Keeper
  - An AI Keeper / Director system

---

## Authoring Note

This specification is optimized for:
- Sandbox-style CoC scenarios
- Long-form or replayable modules
- AI-driven narrative systems
- Agent-based world simulation
