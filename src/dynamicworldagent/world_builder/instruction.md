# Call of Cthulhu World-Driven Scenario Generation Specification

## Purpose

This document defines a structured, deterministic generation pipeline for creating a Call of Cthulhu (CoC) scenario using a **world-first, time-driven, sandbox-oriented approach**, designed for execution by an AI system (AI Keeper / Director / World Simulator).

The goal is to generate:
- A coherent setting (town, city, academic institution, etc.)
- A hidden mythos-driven truth layer
- Autonomous NPCs with long-term goals
- A time-sliced event system
- A non-scripted but inevitable end state

## Quick Reference: Generated Files

The world builder creates a complete module package in `data/Mods/[ModuleName]/`:

### Core World Files (Keeper-Only)
- `truth_timeline.json` - Objective event timeline (NO NPC names)
- `knowledge_matrix.json` - Knowledge distribution + red herrings
- `macro_scene.json` - Setting structure + mythos history + end state

### Scenario Files
- `scenarios_outline.json` - High-level scenario descriptions
- `[ModuleName]_Scenarios/[scenario_name].json` - Full scenarios with snapshots (one per scenario)

### Character Files
- `[ModuleName]_npc/[npc_name].json` - Individual NPC profiles (one per NPC)

### Module Metadata
- `module_digest.json` - Module notes, guidance, limitations, introduction

### Database Persistence
All data is also saved to SQLite database (`data/db.sqlite`):
- `module_backgrounds` table - Macro scene, truth timeline, knowledge matrix
- `characters` table - NPC profiles
- `scenarios` + `scenario_snapshots` tables - Scenario data
- `npc_clues` + `npc_relationships` tables - NPC-specific data

---

## Design Principles

1. **Truth precedes narrative**
2. **World exists independently of investigators**
3. **NPCs act based on goals, not plot**
4. **Time advances even without player action**
5. **Players are disruptive variables, not protagonists**

---

## Generation Pipeline Overview

The AI generates content in the following order:

### Currently Implemented Steps (1-10):

1. **Macro Scene Construction** (Setting-Adaptive)
   - Generate setting structure based on type (town, city, academic, etc.)
   - Output: `MacroSceneStructure` → `macro_scene.json`

2. **Historical Mythos Layer**
   - Generate mythos intrusion events from the past
   - Output: `MythosEvent[]` → `macro_scene.json`

3. **Truth Timeline** (Current Events, NO Names)
   - Generate objective event sequence (recent past to present)
   - Output: `TruthEvent[]` → `truth_timeline.json`

4. **Knowledge Matrix** (Abstract Holders)
   - Map knowledge to roles, places, organizations, objects
   - Output: `KnowledgeHolder[]` → `knowledge_matrix.json`

5. **Red Herrings**
   - Generate false but plausible explanations
   - Output: `RedHerring[]` → `knowledge_matrix.json`

6. **End State Definition**
   - Define inevitable outcome without intervention
   - Output: `EndStateDefinition` → `macro_scene.json`

7. **Scenario Outlines**
   - Generate scenarios from PLACE knowledge holders
   - Output: `ScenarioOutline[]` → `scenarios_outline.json`

8. **Starting Scene Selection & Snapshot**
   - Select initial scenario and generate full snapshot
   - Assign NPCs to non-starting scenarios
   - Output: `StartingSceneSelection` + `ScenarioNpcAssignments[]` → scenario files

9. **NPC Population** (Instantiate from Knowledge Holders)
   - Generate NPCs from ROLE/ORGANIZATION holders
   - Output: `NPCProfile[]` → `[Module]_npc/*.json`

10. **Module Digest**
    - Generate module notes, guidance, limitations, introduction
    - Output: `ModuleDigest` → `module_digest.json`

### Future Steps (Not Yet Implemented):

11. **Temporal Slicing** (Key Time Nodes) - Currently handled by Director during gameplay
12. **Resolution Space Definition** - Currently determined dynamically during gameplay

### Implementation Reference

- Main orchestrator: `WorldBuilderService` (`worldBuilderService.ts`)
- Agents:
  - `MacroSceneAgent` (Steps 1-6)
  - `ScenarioBuilderAgent` (Steps 7-8)
  - `NPCBuilderAgent` (Step 9)
  - `ModuleDigestAgent` (Step 10)
- Persistence: `persistence.ts` handles all file I/O and database writes

---

## Step 1: Macro Scene Construction — Setting Structure (Setting-Adaptive)

### Objective
Create the static structural skeleton of the setting. NOT limited to towns - supports multiple setting types.

### Setting Types (Current Implementation)
- `small_town`: Traditional CoC small town/village setting
- `city`: Urban environment with complex social structures
- `academic`: University, research facility, or scholarly institution
- `isolated`: Remote outpost, island, or enclosed location
- `single_structure`: Mansion, hotel, ship, or single building
- `route`: Journey-based scenario (train, expedition, road trip)

### Required Fields
- Module Name (CoC-style title)
- Location Name (setting name)
- Setting Type (one of the above)
- Geographic Layout (natural + artificial features, key locations)
- Economic Core (what sustains this setting)
- Power Structure (formal authorities + informal powers)
- Information Asymmetry Map (who knows what, approximately)

### Constraints
- No plot events at this stage
- No daily life simulation details
- No investigators yet
- Setting-adaptive prompts based on `settingType`

### Output (Current Implementation)
- Generated by: `MacroSceneAgent.generateTownStructure()`
- Template: `getMacroSceneStep1Template(settingType)` in `macroSceneTemplate.ts`
- Saved to: `macro_scene.json` → `macroScene` object

---


## Step 2: Historical Mythos Layer

### Objective
Embed mythos influence into the setting's past through discrete historical events.

### Required Output
A list of **Mythos Intrusion Events**, each containing:
- Date / Period
- Event Description (objective, not folkloric)
- Mythos Entity / Phenomenon Involved
- Immediate Consequences
- Long-Term Residue (beliefs, institutions, bloodlines)
- Affected NPCs (roles/types, not specific names yet)
- Affected Institutions

### Hard Rule
Each historical event MUST:
- Influence at least one currently living NPC OR
- Shape an existing institution or location

### Output (Current Implementation)
- Generated by: `MacroSceneAgent.generateHistoricalMythos()`
- Template: `getHistoricalMythosTemplateForSetting(settingType)` in `macroSceneTemplate.ts`
- Saved to: `macro_scene.json` → `mythosEvents` array

---

## Step 3: Truth Timeline Generation (Current Events, NO Names)

### Objective
Define objective events in the present/recent past that drive the scenario forward.

### Required Output
A list of **Truth Events** (current timeline), each containing:
- Event ID (e.g., "T1", "T2")
- Time (relative or absolute)
- Event Description (objective, NO NPC names)
- Cause (what triggered this event)
- Consequence (what this event causes)
- Mythos Involved (boolean flag)

### Hard Rules
- **NO NPC names** - only describe what happened, not who did it
- Events must form cause-effect chains
- Events exist independently of observers
- NPCs will NOT know this objective timeline (they have partial/distorted knowledge)

### Validation
The system warns if potential names are detected (capitalized words that aren't at sentence start).

### Output (Current Implementation)
- Generated by: `MacroSceneAgent.generateTruthTimeline()`
- Template: `getTruthTimelineTemplateForSetting(settingType)` in `macroSceneTemplate.ts`
- Saved to: `truth_timeline.json` → `truthTimeline` array

---

## Step 4: Knowledge Matrix Generation (Who/What Knows What)

### Objective
Map knowledge distribution across abstract holders (NOT NPCs yet - roles, places, organizations, objects).

### Required Output
A list of **Knowledge Holders**, each containing:
- Holder ID
- Holder Type ("ROLE" | "ORGANIZATION" | "PLACE" | "OBJECT")
- Holder Name (abstract, e.g., "Ritual Participant", "Old Church Basement")
- Knows (array of truth event IDs)
- Distortion ("none" | "partial_amnesia" | "deliberate_suppression" | "misinterpretation")
- Contains Evidence (for PLACE/OBJECT types)
- Reliability ("high" | "medium" | "low")

### Constraints
- Knowledge holders are ABSTRACT (they will be instantiated into NPCs later)
- No single holder knows the full truth
- PLACE holders should specify `containsEvidence` (physical clues)

### Output (Current Implementation)
- Generated by: `MacroSceneAgent.generateKnowledgeMatrix()`
- Template: `getKnowledgeMatrixTemplate()` in `macroSceneTemplate.ts`
- Saved to: `knowledge_matrix.json` → `knowledgeMatrix` array

---

## Step 5: Red Herrings Generation

### Objective
Generate false but plausible explanations that investigators might pursue.

### Required Output
A list of **Red Herrings**, each containing:
- Red Herring ID
- False Belief (the plausible but incorrect explanation)
- Source Type ("MEDIA_RUMOR" | "MEDICAL_RECORD" | "OFFICIAL_REPORT" | "WITNESS_MISIDENTIFICATION" | "COINCIDENCE")
- Origin (where this false belief comes from)
- Why Plausible (why people would believe it)
- Contradicts Events (truth event IDs this contradicts)

### Constraints
- Each red herring must have a realistic source (not magic)
- Must be plausible enough to mislead investigators
- Should contradict at least one truth event

### Output (Current Implementation)
- Generated by: `MacroSceneAgent.generateRedHerrings()`
- Template: `getRedHerringsTemplate()` in `macroSceneTemplate.ts`
- Saved to: `knowledge_matrix.json` → `redHerrings` array

---

## Step 6: End State Definition (Hidden from Players)

### Objective
Define the inevitable outcome of the world **if no investigators intervene**.

### Required Output
- End State Summary (1–3 paragraphs)
- Catastrophe Nature (type of transformation/disaster)
- Winners and Survivors (who benefits/survives)
- Point of No Return:
  - Type ("time" | "condition")
  - Trigger (specific condition, e.g., "Day 8 0:00" or "All seals broken")

### Constraints
- Must be deterministic
- Must NOT depend on investigator actions
- Must be mythos-consistent
- Must specify when/how it becomes inevitable

### Output (Current Implementation)
- Generated by: `MacroSceneAgent.generateEndState()`
- Template: `getEndStateTemplate()` in `macroSceneTemplate.ts`
- Saved to: `macro_scene.json` → `endState` object

---

## Step 7: Scenario Outline Generation

### Objective
Generate scenario outlines from knowledge matrix PLACE holders.

### Required Output
A list of **Scenario Outlines**, each containing:
- Scenario ID
- Name (matches a PLACE holder name)
- Description
- Source Place ID (knowledge holder ID)
- Source Place Name
- Tags (categorization)
- Evidence (physical items from PLACE holder's `containsEvidence`)
- Clues (seed clues that expand the evidence)
- Connections (links to other scenarios with relationship types)

### Connection Types
- `leads_to`: Natural progression from this scenario
- `concurrent`: Can be explored simultaneously
- `prerequisite`: Must complete before accessing another
- `alternate`: Alternative path to same information

### Validation (Current Implementation)
- Warns if PLACE holders are not covered by scenarios
- Warns if evidence from PLACE holders is missing in scenarios
- Warns if scenario connections reference non-existent scenarios
- Warns if scenario graph is disconnected (unreachable scenarios)

### Output (Current Implementation)
- Generated by: `ScenarioBuilderAgent.generate()`
- Template: `getScenarioBuilderTemplate()` in `scenarioBuilderTemplate.ts`
- Saved to: `scenarios_outline.json` → `scenarios` array

---

## Step 8: Starting Scene Selection & Snapshot Generation

### Objective
Select the initial scenario for investigators and generate a complete snapshot.

### Required Output
- **Starting Scene Selection**:
  - Scenario ID
  - Scenario Name
  - Selection Reason
  - Full Snapshot (see Location State Injection below)

- **Other Scenario NPC Assignments**:
  - For each non-starting scenario, assign NPCs with activities

### Snapshot Generation (LLM-Generated for Starting Scene Only)
The starting scene gets a fully LLM-generated snapshot with:
- Initial game time
- Detailed scene description
- Characters present with roles and status
- Available clues with discovery methods
- Environmental conditions
- Events in progress

Non-starting scenarios get basic snapshots auto-generated from scenario outlines.

### Validation (Current Implementation)
- Warns if starting snapshot name doesn't match scenario name
- Warns if snapshot characters don't match NPCs
- Warns if NPCs are assigned multiple times
- Warns if some NPCs are not assigned to any scenario
- Auto-creates missing assignments for unassigned scenarios

### Output (Current Implementation)
- Generated by: `ScenarioBuilderAgent.generateStartingSceneSnapshot()`
- Template: `getStartingSceneSnapshotTemplate()` in `scenarioBuilderTemplate.ts`
- Saved to:
  - Starting scene snapshot embedded in scenario file
  - Other NPC assignments embedded in scenario files
  - Database: `scenarios` and `scenario_snapshots` tables

---

## Step 9: NPC Population Generation

### Objective
Generate autonomous agents that drive the world forward by instantiating NPCs from knowledge holders.

### Generation Process (4 Sub-Steps)

**Sub-Step 1: Instantiate from Knowledge Holders**
- LLM generates NPCBasicInfo from ROLE/ORGANIZATION knowledge holders
- Each NPC linked to knowledge holder via `instantiatedFrom` field
- Inherits knowledge from holder via `inheritsKnowledge` (truth event IDs)

**Sub-Step 2: Generate Attributes**
- Dice-rolled CoC 7e attributes using age-based modifiers
- Uses `generateRandomAttributes()` from character builder

**Sub-Step 3: Allocate Skills**
- Occupation-based skill allocation
- Uses `allocateSkillPoints()` from skill allocator
- Maps LLM-generated occupations to standard occupation list

**Sub-Step 4: Fill Identity and Inventory**
- LLM generates personality, appearance, inventory, notes
- LLM generates NPC clues based on inherited knowledge and red herrings
- Links NPC clues to truth events via `relatedTo` field

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
- NPCs must NOT know the full truth (only partial knowledge from their holders)
- Goals may conflict with each other
- Secrets must be exploitable through investigation (stored in `secrets` and extractable via `clues`)
- Each NPC should inherit knowledge distortion from their knowledge holder

### Occupation Mapping (Current Implementation)
The system automatically maps LLM-generated occupations to the standard CoC occupation list:
- Loads from `src/coc_multiagents_system/agents/character/Character occupation.json`
- Fuzzy matching with token-based scoring
- Falls back to original occupation if no good match (score < 0.5)

### Concurrency (Current Implementation)
- NPCs are generated concurrently (batch processing)
- Concurrency limit: 4 NPCs at a time
- Each NPC generation is independent

### Output (Current Implementation)
- Generated by: `NPCBuilderAgent.generateBatch()`
- Templates:
  - `getNPCInstantiationTemplate()` for Sub-Step 1
  - `getNPCIdentityTemplate()` for Sub-Step 4
- Saved to:
  - `data/Mods/<ModuleName>_npc/[npc_name].json` (one file per NPC)
  - Database: `characters`, `npc_clues`, `npc_relationships` tables
  - Action logs embedded in NPC files (initial activities from scenario assignments)

---

## Step 10: Module Digest Generation

### Objective
Generate module metadata for the Keeper and game system.

### Required Output
- **Module Notes**: Overview of the module, themes, and structure
- **Keeper Guidance**: How to run the module (pacing, key decision points, NPC guidance)
- **Module Limitations**: System constraints, assumptions, warnings
- **Introduction**: Opening narrative to read to players

### Output (Current Implementation)
- Generated by: `ModuleDigestAgent.generate()`
- Template: `getModuleDigestTemplate()` in `moduleDigestTemplate.ts`
- Saved to: `module_digest.json`

---

## Step 11 (Future): Temporal Slicing (Key Time Nodes)

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

### Current Status
**NOT YET IMPLEMENTED** - Temporal progression is currently handled by the Director agent during gameplay, not pre-generated.

---

## Location State Specification (Scenario Snapshots)

### Objective
Scenario snapshots represent the state of a location at a specific point in time.

### Snapshot Schema

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

**Note:** 
- Scenario connections are defined at the scenario level (in `ScenarioOutline.connections`), not in snapshots.
- Events are tracked via actionResults and NPC actionLogs, not in snapshot fields.

**State Evolution:**
- `estimatedShortActions`: number (optional) - Estimated actions this scene can accommodate
- `timeRestriction`: string (optional) - Time constraints (e.g., "day1 evening", "day2 (after)")

**Keeper Information:**
- `keeperNotes`: string (optional) - Private notes for the Keeper/Director

### Constraints
- Locations may evolve even if never visited (tracked via `events`)
- Some clues must decay or disappear over time (modify `discovered` status or remove from `clues` array)
- Environmental conditions can change dynamically (update `conditions` array)
- Time restrictions enforce temporal coherence (use `timeRestriction` field)

---

## Step 12 (Future): Resolution Space Definition

### Objective
Define all plausible endings based on world deformation.

### Required Endings
- Catastrophic Failure
- Partial Mitigation
- False Victory
- Costly Success

### Constraints
- No "perfect" ending
- Sanity loss and trauma must persist
- World must bear scars

### Current Status
**NOT YET IMPLEMENTED** - Endings are currently determined dynamically by the Director agent during gameplay based on investigator actions and world state.

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

## Generated File Formats

The world builder generates the following JSON files in `data/Mods/[ModuleName]/`:

### 1. `truth_timeline.json` (Keeper-Only)

Objective sequence of events. NPCs do NOT know this timeline; they have partial/distorted knowledge.

```json
{
  "truthTimeline": [
    {
      "id": "T1",
      "time": "2 months ago",
      "event": "A ritual artifact was unearthed during construction work",
      "cause": "Excavation disturbed ancient burial site",
      "consequence": "Dormant entity began to awaken",
      "mythosInvolved": true
    }
  ],
  "note": "KEEPER ONLY - Objective sequence of events..."
}
```

**Fields:**
- `id`: Event identifier (e.g., "T1", "T2")
- `time`: When the event occurred (relative or absolute)
- `event`: Objective description (NO NPC names, pure cause-effect)
- `cause`: What triggered this event (optional)
- `consequence`: What this event caused (optional)
- `mythosInvolved`: Boolean indicating mythos involvement

---

### 2. `knowledge_matrix.json` (Keeper-Only)

Knowledge distribution across abstract holders (roles, places, organizations) and false trails.

```json
{
  "knowledgeMatrix": [
    {
      "id": "KH_ROLE_1",
      "holderType": "ROLE",
      "holderName": "Ritual Participant",
      "knows": ["T1", "T3"],
      "distortion": "partial_amnesia",
      "reliability": "medium"
    },
    {
      "id": "KH_PLACE_1",
      "holderType": "PLACE",
      "holderName": "Old Church Basement",
      "knows": ["T2"],
      "containsEvidence": ["Ritual dagger", "Ancient manuscript"]
    }
  ],
  "redHerrings": [
    {
      "id": "RH1",
      "falseBelief": "The deaths were caused by a serial killer",
      "sourceType": "MEDIA_RUMOR",
      "origin": "Local newspaper speculation",
      "whyPlausible": "Victims showed similar wounds",
      "contradictsEvents": ["T4", "T5"]
    }
  ],
  "note": "KEEPER ONLY - Knowledge distribution and false trails..."
}
```

**KnowledgeHolder Fields:**
- `id`: Holder identifier
- `holderType`: "ROLE" | "ORGANIZATION" | "PLACE" | "OBJECT"
- `holderName`: Name of the abstract holder (NOT an NPC name)
- `knows`: Array of truth event IDs this holder knows
- `distortion`: "none" | "partial_amnesia" | "deliberate_suppression" | "misinterpretation"
- `containsEvidence`: Physical evidence (for PLACE/OBJECT types)
- `reliability`: "high" | "medium" | "low"

**RedHerring Fields:**
- `id`: Herring identifier
- `falseBelief`: The false but plausible explanation
- `sourceType`: "MEDIA_RUMOR" | "MEDICAL_RECORD" | "OFFICIAL_REPORT" | "WITNESS_MISIDENTIFICATION" | "COINCIDENCE"
- `origin`: Where this false belief comes from
- `whyPlausible`: Why people would believe it
- `contradictsEvents`: Truth event IDs this contradicts

---

### 3. `macro_scene.json`

World structure, mythos history, and inevitable end state.

```json
{
  "macroScene": {
    "moduleName": "The Shadow Over Innsmouth",
    "locationName": "Innsmouth",
    "settingType": "small_town",
    "geographicLayout": {
      "naturalFeatures": ["Coastal harbor", "Rocky cliffs"],
      "artificialStructures": ["Main Street", "Old refinery"],
      "keyLocations": ["Marsh Refinery", "Esoteric Order Hall"]
    },
    "economicCore": "Fishing and gold refining",
    "powerStructure": {
      "formalAuthorities": [
        { "role": "Town Marshal", "controlArea": "Law enforcement" }
      ],
      "informalPowers": [
        { "entity": "Esoteric Order", "influence": "Religious control" }
      ]
    },
    "informationAsymmetry": [
      {
        "who": "Order members",
        "knows": "True nature of the pact",
        "hiddenFrom": ["General population", "Town officials"]
      }
    ]
  },
  "mythosEvents": [
    {
      "period": "1846",
      "eventDescription": "Captain Marsh made pact with Deep Ones",
      "mythosEntityInvolved": "Deep Ones",
      "immediateConsequences": ["Town prosperity returned"],
      "longTermResidue": ["Hybrid bloodlines", "Esoteric Order formed"],
      "affectedNPCs": ["All Marsh descendants"],
      "affectedInstitutions": ["Esoteric Order of Dagon"]
    }
  ],
  "endState": {
    "summary": "If investigators do not intervene, the town will complete the final transformation ritual on the winter solstice...",
    "catastropheNature": "Mass transformation into Deep One hybrids",
    "winnersAndSurvivors": ["Transformed townspeople", "Deep Ones"],
    "pointOfNoReturn": {
      "type": "time",
      "trigger": "Day 8 0:00 (Winter solstice midnight)"
    }
  },
  "note": "World structure, mythos history, and inevitable end state..."
}
```

**MacroSceneStructure Fields:**
- `moduleName`: CoC-style module title
- `locationName`: Name of the setting
- `settingType`: "small_town" | "city" | "academic" | "isolated" | "single_structure" | "route"
- `geographicLayout`: Natural features, artificial structures, key locations
- `economicCore`: Economic foundation of the setting
- `powerStructure`: Formal authorities and informal powers
- `informationAsymmetry`: Who knows what and from whom

**MythosEvent Fields:**
- `period`: Historical time period
- `eventDescription`: What happened
- `mythosEntityInvolved`: Which mythos entity/phenomenon
- `immediateConsequences`: Short-term effects
- `longTermResidue`: Lasting impacts (beliefs, institutions, bloodlines)
- `affectedNPCs`: NPCs influenced by this event
- `affectedInstitutions`: Institutions shaped by this event

**EndStateDefinition Fields:**
- `summary`: 1-3 paragraphs describing the outcome
- `catastropheNature`: Type of catastrophe/transformation
- `winnersAndSurvivors`: Who survives or benefits
- `pointOfNoReturn`: When/how the end becomes inevitable
  - `type`: "time" | "condition"
  - `trigger`: Specific trigger condition

---

### 4. `scenarios_outline.json`

Scenario outlines derived from knowledge matrix places (snapshots generated separately).

```json
{
  "scenarios": [
    {
      "id": "scenario-old-church",
      "name": "Old Church Basement",
      "description": "A dusty basement beneath the abandoned church...",
      "sourcePlaceId": "KH_PLACE_1",
      "sourcePlaceName": "Old Church Basement",
      "tags": ["investigation", "clue_location", "dangerous"],
      "evidence": ["Ritual dagger", "Ancient manuscript"],
      "clues": [
        {
          "clueText": "The dagger bears symbols matching Deep One iconography",
          "evidenceRef": "Ritual dagger",
          "notes": "Requires Occult roll to identify"
        }
      ],
      "connections": [
        {
          "scenarioName": "Marsh Refinery",
          "relationshipType": "leads_to",
          "description": "Manuscript mentions the refinery"
        }
      ]
    }
  ],
  "note": "Scenario outlines derived from knowledge matrix places..."
}
```

**ScenarioOutline Fields:**
- `id`: Unique scenario identifier
- `name`: Scenario name (usually matches a PLACE holder)
- `description`: Brief description of the location/scenario
- `sourcePlaceId`: ID of the knowledge holder PLACE this came from
- `sourcePlaceName`: Name of the source PLACE
- `tags`: Categorization tags
- `evidence`: Physical evidence available (from knowledge holder)
- `clues`: Clue seeds to expand into full clues
  - `clueText`: What the clue reveals
  - `evidenceRef`: Which evidence item this relates to
  - `notes`: Additional context
- `connections`: Links to other scenarios
  - `scenarioName`: Target scenario name
  - `relationshipType`: "leads_to" | "concurrent" | "prerequisite" | "alternate"
  - `description`: How they're connected

---

### 5. `[ModuleName]_Scenarios/[scenario_name].json`

Individual scenario files with full snapshots (one array per file).

```json
[
  {
    "name": "Old Church Basement",
    "description": "A dusty basement beneath the abandoned church...",
    "evidence": ["Ritual dagger", "Ancient manuscript"],
    "clues": [...],
    "snapshot": {
      "id": "scenario-old-church-snapshot",
      "name": "Old Church Basement",
      "gameTime": "Day 1, 14:30",
      "location": "Old Church Basement",
      "description": "The basement is dark and musty...",
      "showMap": false,
      "characters": [
        {
          "id": "npc-caretaker",
          "name": "Old Caretaker",
          "role": "witness",
          "status": "alive",
          "location": "Old Church Basement",
          "notes": "Guarding the entrance nervously"
        }
      ],
      "clues": [
        {
          "id": "scenario-old-church-clue-1",
          "clueText": "The dagger bears symbols matching Deep One iconography",
          "category": "physical",
          "difficulty": "regular",
          "location": "Old Church Basement",
          "discoveryMethod": "Search the altar",
          "reveals": ["T2"],
          "discovered": false
        }
      ],
      "conditions": [
        {
          "type": "lighting",
          "description": "Dim candlelight only",
          "mechanicalEffect": "Penalty die on Spot Hidden"
        }
      ],
      "events": ["Investigators enter the basement"],
      "keeperNotes": "If investigators make noise, NPCs upstairs will investigate",
      "estimatedShortActions": 5,
      "timeRestriction": null,
      "initialSnapshot": false
    },
    "tags": ["investigation", "clue_location", "dangerous"],
    "connections": [...],
    "npcAssignments": [
      {
        "id": "npc-caretaker",
        "name": "Old Caretaker",
        "occupation": "Caretaker",
        "activity": "Guarding the basement entrance"
      }
    ]
  }
]
```

**ScenarioSnapshot Fields:** (See Step 6: Location State Injection for full specification)

---

### 6. `[ModuleName]_npc/[npc_name].json`

Individual NPC profile files (one NPC per file).

```json
{
  "id": "npc-old-caretaker",
  "name": "Old Caretaker",
  "occupation": "Caretaker",
  "age": 67,
  "gender": "male",
  "appearance": "Weathered face, hunched posture, nervous eyes",
  "personality": "Fearful, evasive, loyal to the Order",
  "background": "Served the church for 40 years, witnessed things he won't speak of",
  "goals": ["Keep outsiders away from the basement", "Protect the Order's secrets"],
  "secrets": ["Knows about the ritual artifacts", "Fears the Order's punishment"],
  "attributes": {
    "STR": 45,
    "CON": 50,
    "DEX": 40,
    "APP": 35,
    "POW": 55,
    "SIZ": 60,
    "INT": 60,
    "EDU": 50
  },
  "status": {
    "hp": 11,
    "maxHp": 11,
    "sanity": 45,
    "maxSanity": 99,
    "luck": 50,
    "mp": 11,
    "conditions": [],
    "damageBonus": "0",
    "build": 0,
    "mov": 6
  },
  "skills": {
    "Spot Hidden": 50,
    "Listen": 45,
    "Psychology": 35
  },
  "inventory": [
    { "name": "Rusty key ring", "quantity": 1 },
    { "name": "Old lantern", "quantity": 1 }
  ],
  "clues": [
    {
      "id": "npc-caretaker-clue-1",
      "clueText": "If pressured, will mention 'the old days when things changed'",
      "category": "witness",
      "difficulty": "hard",
      "revealed": false,
      "relatedTo": ["T1"]
    }
  ],
  "relationships": [
    {
      "targetId": "npc-order-leader",
      "targetName": "Order Leader",
      "relationshipType": "employer",
      "attitude": -20,
      "description": "Fears but obeys",
      "history": "Has served the Order for decades"
    }
  ],
  "notes": "Will flee if confronted directly",
  "isNPC": true,
  "actionLog": [
    {
      "time": "initial",
      "location": "Old Church Basement",
      "summary": "Guarding the basement entrance"
    }
  ]
}
```

**NPCProfile Fields:** (See Step 4: NPC Population Generation for full specification)

---

### 7. `module_digest.json`

Module metadata for the Keeper and game system.

```json
{
  "title": "The Shadow Over Innsmouth",
  "moduleNotes": "A sandbox investigation module featuring Deep One infiltration...",
  "keeperGuidance": "This module is designed to be run as a sandbox. Allow investigators to explore freely. The timeline advances even without player action. Key decision points: ...",
  "moduleLimitations": "This module assumes investigators arrive before Day 8. If they delay too long, the end state triggers automatically. Combat encounters are deliberately unbalanced - encourage stealth and investigation over confrontation.",
  "introduction": "The coastal town of Innsmouth has long been a place of whispered rumors and unease. When a colleague's letter arrives, mentioning strange disappearances and a lucrative opportunity, investigators are drawn into a web of ancient secrets..."
}
```

**ModuleDigest Fields:**
- `title`: Module name
- `moduleNotes`: Overview of the module, themes, and structure
- `keeperGuidance`: How to run the module (pacing, key decision points, NPC guidance)
- `moduleLimitations`: System constraints, assumptions, warnings
- `introduction`: Opening narrative to read to players

---

## Implementation Notes

### File Organization

```
data/Mods/[ModuleName]/
├── truth_timeline.json              # Keeper-only: Objective events
├── knowledge_matrix.json            # Keeper-only: Knowledge distribution
├── macro_scene.json                 # Setting + mythos + end state
├── scenarios_outline.json           # High-level scenario list
├── module_digest.json               # Module metadata
├── [ModuleName]_Scenarios/          # Scenario directory
│   ├── [scenario_1].json           # Individual scenario files
│   ├── [scenario_2].json
│   └── ...
└── [ModuleName]_npc/                # NPC directory
    ├── [npc_1].json                # Individual NPC files
    ├── [npc_2].json
    └── ...
```

### JSON Parsing Strategy

The system uses a robust JSON extraction strategy for LLM responses:
1. First tries to extract from markdown code blocks: ` ```json ... ``` `
2. Falls back to regex extraction: `\{[\s\S]*\}`
3. Validates and parses JSON
4. Auto-fills missing IDs and normalizes data

### Validation and Warnings

The system performs extensive validation and logs warnings (does not fail):
- **Truth Timeline**: Warns if potential NPC names detected in events
- **Scenario Coverage**: Warns if PLACE holders not covered by scenarios
- **Evidence Tracking**: Warns if evidence from PLACE holders missing in scenarios
- **Scenario Connectivity**: Warns if scenario graph is disconnected
- **NPC Assignment**: Warns if NPCs assigned multiple times or not at all
- **Occupation Mapping**: Logs when LLM-generated occupations are mapped to standard list

### Concurrency and Performance

- **NPC Generation**: 4 concurrent workers for batch processing
- **Scenario Generation**: Sequential (to ensure proper validation)
- **LLM Model Classes**:
  - `LARGE` for world structure, scenarios, NPCs (high quality)
  - `MEDIUM` for NPC identity details (balanced quality/cost)

### Database Schema Integration

Generated content integrates with existing game database:
- NPCs → `characters` table (with `is_npc = 1` flag)
- Scenarios → `scenarios` + `scenario_snapshots` tables
- NPC Clues → `npc_clues` table
- NPC Relationships → `npc_relationships` table
- World Structure → `module_backgrounds` table

### Usage Example

```typescript
import { WorldBuilderService } from './worldBuilderService.js';
import { DatabaseManager } from '../../coc_multiagents_system/agents/memory/database/index.js';

const db = DatabaseManager.getInstance();
const service = new WorldBuilderService(db);

const result = await service.generateWorld(
  "The Shadow Over Innsmouth",  // Module name
  "small_town",                   // Setting type
  "A coastal town with dark secrets involving Deep Ones...",  // Creative prompt
  (message) => console.log(message)  // Progress callback
);

console.log('Generated files:', result.generatedFiles);
```

### Extension Points

To extend the world builder:

1. **Add New Setting Types**:
   - Update `MacroSceneSettingType` in `types.ts`
   - Add setting-specific templates in `macroSceneTemplate.ts`

2. **Add New Knowledge Holder Types**:
   - Update `KnowledgeHolder.holderType` in `types.ts`
   - Update validation logic in `macroSceneAgent.ts`

3. **Add New Scenario Connection Types**:
   - Update `ScenarioConnectionType` in `types.ts`
   - Update validation in `scenarioBuilderAgent.ts`

4. **Customize NPC Skill Allocation**:
   - Modify `skillAllocator.ts` occupation skill mappings
   - Update occupation list in `Character occupation.json`

---

## Authoring Note

This specification is optimized for:
- Sandbox-style CoC scenarios
- Long-form or replayable modules
- AI-driven narrative systems
- Agent-based world simulation

The implementation prioritizes:
- **Truth-first design**: World exists independently of player observation
- **Knowledge fragmentation**: No single NPC knows the full truth
- **Sandbox flexibility**: Non-linear, robust to player chaos
- **AI compatibility**: Both human and AI Keepers can run generated modules
