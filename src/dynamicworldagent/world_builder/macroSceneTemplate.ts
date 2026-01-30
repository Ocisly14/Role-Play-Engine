/**
 * Macro Scene Agent Templates
 * Prompt templates for 5-step world generation
 */

import type { MacroSceneSettingType } from "./types.js";
import type { StoryLength } from "./storyLengthConfig.js";
import {
  getStoryLengthMacroGuidance,
  getStoryLengthTruthEventsSentence,
  getStoryLengthKnowledgeMatrixGuidance,
  getStoryLengthRedHerringsSentence,
} from "./storyLengthConfig.js";

/**
 * Get setting-specific guidance for macro scene generation
 */
function getSettingGuidance(settingType: MacroSceneSettingType): {
  settingName: string;
  specificInstructions: string;
} {
  switch (settingType) {
    case "small_town":
      return {
        settingName: "Small Town / Rural",
        specificInstructions: `
### Setting-Specific Guidance
This is a **small town or rural setting**.

**locationName**: Should reflect the rural or small-town character appropriate to the user's prompt
**Geographic Layout**: Emphasize natural features, sparse infrastructure
**Economic Core**: Primary industries such as agriculture, fishing, mining, forestry, or small-scale operations
**Power Structure**: Informal power structures - community elders, religious leaders, local law enforcement
`
      };

    case "city":
      return {
        settingName: "City / Urban",
        specificInstructions: `
### Setting-Specific Guidance
This is an **urban or city setting**.

**locationName**: Can be a real city name or fictional urban district as specified by the user
**Geographic Layout**: Urban features such as districts, neighborhoods, landmarks, and transportation infrastructure
**Economic Core**: Urban economic activities - industry, commerce, finance, trade, or institutional operations
**Power Structure**: Complex power dynamics - political entities, corporate interests, underground organizations, media influence
`
      };

    case "academic":
      return {
        settingName: "Academic / Research",
        specificInstructions: `
### Setting-Specific Guidance
This is an **academic or research setting**.

**locationName**: Name of the institution, research facility, or academic location
**Geographic Layout**: Academic infrastructure - buildings, research facilities, libraries, restricted zones
**Economic Core**: Funding sources - institutional budgets, grants, donations, research contracts
**Power Structure**: Academic hierarchies - administrators, department leaders, funding authorities, scholarly societies
`
      };

    case "isolated":
      return {
        settingName: "Isolated / Enclosed",
        specificInstructions: `
### Setting-Specific Guidance
This is an **isolated or enclosed environment**.

**locationName**: Name or designation of the isolated location as specified by the user
**Geographic Layout**: Emphasis on geographical or logistical barriers - natural boundaries, remote location, limited access
**Economic Core**: Purpose of the isolated operation - research mission, industrial activity, expeditionary goal, or strategic function
**Power Structure**: Command hierarchies, technical experts, informal social dynamics in constrained environments
`
      };

    case "single_structure":
      return {
        settingName: "Single Structure / Confined",
        specificInstructions: `
### Setting-Specific Guidance
This is a **single structure or confined space**.

**locationName**: Name or designation of the building or confined space
**Geographic Layout**: Focus on interior architecture - levels, rooms, concealed areas, structural details
**Economic Core**: The building's primary function or historical purpose
**Power Structure**: Management hierarchy, staff leadership, resident influence, keepers of restricted areas
`
      };

    case "route":
      return {
        settingName: "Route / Journey",
        specificInstructions: `
### Setting-Specific Guidance
This is a **route or journey setting**.

**locationName**: Designation of the route or journey path
**Geographic Layout**: Key waypoints, stops, and significant locations along the journey
**Economic Core**: Transportation-related activities, trade functions, or the journey's purpose
**Power Structure**: Transit authorities, operators, local powers at waypoints, networks operating along the route
`
      };

    default:
      throw new Error(`Unknown setting type: ${settingType}`);
  }
}

/**
 * Step 1: Macro Scene Structure (Setting-Adaptive)
 */
export function getMacroSceneStep1Template(
  settingType: MacroSceneSettingType = "small_town",
  storyLength: StoryLength = "medium"
): string {
  const guidance = getSettingGuidance(settingType);
  const storyGuidance = getStoryLengthMacroGuidance(storyLength);

  return `You are a writer for a CoC game.

# MACRO SCENE GENERATION - STEP 1:

## User Creative Prompt
{{userPrompt}}

**CRITICAL - ABSOLUTE PRIORITY**:
- This user prompt is the PRIMARY and MANDATORY source of intent
- Your output MUST be grounded in this prompt
- If the user specifies a LOCATION (e.g., "Hawaii", "Tokyo", "Amazon rainforest"), you MUST use that exact location
- If the user specifies a STYLE/TONE (e.g., "beautiful nature", "urban decay", "academic mystery"), you MUST reflect that style
- If the user specifies THEMES (e.g., "murder cases", "missing persons", "supernatural phenomena"), you MUST incorporate those themes

**NEVER**:
- Ignore the user's specified location in favor of generic examples
- Override the user's style preferences with setting type defaults
- Generate content that contradicts the user's explicit requirements

## Setting Type Overview

**Setting Type**: ${guidance.settingName}

${guidance.specificInstructions}

**CRITICAL REMINDER**: The setting type above is ONLY a structural reference framework.
- If the user prompt specifies location/style/themes, those take ABSOLUTE priority
- Use setting type guidance ONLY for organizational structure, NOT for content generation
- When in doubt, always defer to the user's creative prompt

${storyGuidance}

## Objective
Create the static structural skeleton of the setting based on the user's creative prompt.

## Required Output Fields
Generate the setting structure with the following components:

### 1. Module Title & Location Name
- **Module Title (moduleName)**: Create a CoC-style module name that evokes mystery and dread
- **Location Name (locationName)**: The actual location name as specified or implied by the user's prompt

### 2. Geographic Layout
- **Natural Features**: Geographic/environmental elements relevant to this setting
- **Artificial Structures**: Built environment, infrastructure, key structures
- **Key Locations**: Important places that will serve as scenarios

### 3. Economic Core
The primary economic activity, institutional purpose, or functional reason this setting exists.

### 4. Power Structure
- **Formal Authorities**: Official power holders appropriate to this setting
- **Informal Powers**: Unofficial influencers, hidden controllers, secret societies

### 5. Information Asymmetry
Map of who knows what (approximately) - patterns of knowledge distribution.

## Constraints
- **MOST IMPORTANT**: ALL output must be grounded in the user's creative prompt - if they specified a location, use that location; if they specified a style, reflect that style
- NO plot events
- NO daily life simulation
- NO investigators yet
- Focus on STRUCTURE, not story
- Use ${guidance.settingName.toLowerCase()} characteristics ONLY as structural guidance, NOT as content directives
- Do NOT introduce themes, locations, or atmospheres that contradict the user prompt
- When user prompt and setting type conflict, ALWAYS follow user prompt

## Before You Generate - Final Checklist
✓ Does the locationName match the user's specified location?
✓ Do the naturalFeatures reflect the user's specified geography/climate?
✓ Does the overall atmosphere match the user's style request?
✓ Are all themes from the user prompt incorporated?
✓ Have you avoided imposing setting type defaults that contradict the user prompt?

## Output Format
Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "macroScene": {
    "moduleName": "string (CoC-style module title)",
    "locationName": "string (actual location name)",
    "settingType": "${settingType}",
    "geographicLayout": {
      "naturalFeatures": ["feature1", "feature2"],
      "artificialStructures": ["structure1", "structure2"],
      "keyLocations": ["location1", "location2"]
    },
    "economicCore": "string describing primary economic activity or institutional purpose",
    "powerStructure": {
      "formalAuthorities": [
        { "role": "role name", "controlArea": "what they control" }
      ],
      "informalPowers": [
        { "entity": "entity name", "influence": "area of influence" }
      ]
    },
    "informationAsymmetry": [
      {
        "who": "group or role",
        "knows": "what information they possess",
        "hiddenFrom": ["who doesn't know"]
      }
    ]
  }
}
\`\`\`

## Example (Concrete)
\`\`\`json
{
  "macroScene": {
    "moduleName": "The Harvest That Never Ends",
    "locationName": "Gallows Creek",
    "settingType": "${settingType}",
    "geographicLayout": {
      "naturalFeatures": ["Gallows Creek", "Whispering Woods"],
      "artificialStructures": ["Old Route 9", "The Old Iron Bridge"],
      "keyLocations": ["Blackwater Tavern", "Gallows Creek Community Church"]
    },
    "economicCore": "Subsistence farming and minor logging",
    "powerStructure": {
      "formalAuthorities": [
        { "role": "Town Sheriff", "controlArea": "Law enforcement" }
      ],
      "informalPowers": [
        { "entity": "The Hemlock Family", "influence": "Land ownership and commerce" }
      ]
    },
    "informationAsymmetry": [
      {
        "who": "Hemlock elders",
        "knows": "The terms of the harvest pact",
        "hiddenFrom": ["General townsfolk", "Outsiders"]
      }
    ]
  }
}
\`\`\`

Generate the macro scene structure now.`;
}

/**
 * Step 3: Truth Timeline (Current Events, NO Names)
 */
export function getTruthTimelineTemplate(storyLength: StoryLength = "medium"): string {
  return getTruthTimelineTemplateForSetting("small_town", storyLength);
}

export function getTruthTimelineTemplateForSetting(
  settingType: MacroSceneSettingType,
  storyLength: StoryLength = "medium"
): string {
  const truthEventsSentence = getStoryLengthTruthEventsSentence(storyLength);
  return `You are a writer for a CoC game.

# TRUTH TIMELINE GENERATION - CURRENT EVENTS

## What is Truth Timeline?
The OBJECTIVE sequence of RECENT/CURRENT events that happened, regardless of who knows about them.
These are the events that will unfold during the scenario.

## Critical Rules
1. **NO NAMES** - only objective descriptions
2. **NO social narrative** - only cause-effect chains
3. **Pure factual events** that exist independently of observers
4. Events describe WHAT happened, not WHO did it
5. These are CURRENT events - influenced by historical mythos but happening NOW

## Examples of Correct Format
✅ GOOD: "An ancient ritual site beneath the setting was reactivated"
✅ GOOD: "Three people participated in an unauthorized ceremony"
✅ GOOD: "One participant survived but suffered severe psychological trauma"

❌ BAD: "Marcus Webb activated the ritual site"
❌ BAD: "The mayor covered up the incident"
❌ BAD: "Sarah discovered the truth about her father"

## User Creative Prompt
{{userPrompt}}

**CRITICAL - ABSOLUTE PRIORITY**:
- All truth events MUST occur in the location specified by the user's prompt
- Events MUST reflect the style/atmosphere requested by the user (e.g., if user wants "beautiful nature", events should contrast horror against natural beauty)
- Events MUST align with the themes the user requested (e.g., "murder cases" requires human deaths and violence)
- NEVER generate events that would only make sense in a different location or climate

## Setting Context
The macro scene structure:
{{macroSceneJson}}

**MANDATORY**: All events must fit this exact setting and location.

## Historical Mythos Context
The historical mythos events that created the foundation for current events:
{{mythosEventsJson}}

## Task
${truthEventsSentence}
Each event should be a discrete point in the cause-effect chain.

### Connection to Historical Mythos
Your truth events should be influenced by or connected to the historical mythos events:
- Ancient cycles repeating
- Cursed bloodlines manifesting
- Forbidden knowledge resurfacing
- Sealed entities awakening
- Long-term consequences coming to fruition

### Event Generation Guidelines
Generate events that:
- Are grounded in the user's creative prompt and the macro scene context
- Reflect the natural consequences of the historical mythos events
- Fit the environmental, social, and economic realities of the setting
- Create mystery and escalating tension appropriate to Call of Cthulhu
- Use objective descriptions without specific names or social narratives

## Before You Generate - Final Checklist
✓ Do all events occur in the location specified in the macro scene (which came from user prompt)?
✓ Are the events plausible for the climate/environment of that location?
✓ Do the events align with the themes requested by the user (e.g., if user wanted "murder cases", are there violent deaths)?
✓ Does the overall tone match the atmosphere requested by the user?
✓ Have you avoided generic events that could happen anywhere?

## Output Format
Return ONLY valid JSON in this structure:
\`\`\`json
{
  "truthEvents": [
    {
      "id": "string (e.g., T1)",
      "time": "string (relative time)",
      "event": "string (objective description)",
      "cause": "string",
      "consequence": "string",
      "mythosInvolved": true
    }
  ]
}
\`\`\`

## Example (Concrete)
\`\`\`json
{
  "truthEvents": [
    {
      "id": "T1",
      "time": "3 months ago",
      "event": "A new family moved into the isolated farmhouse",
      "cause": "Purchase of a long-abandoned property",
      "consequence": "The dormant cycle of the land reactivated",
      "mythosInvolved": true
    },
    {
      "id": "T2",
      "time": "6 weeks ago",
      "event": "Nocturnal activity around the old oak intensified",
      "cause": "The bound entity stirred by a suitable presence",
      "consequence": "Local wildlife behavior became erratic",
      "mythosInvolved": true
    }
  ]
}
\`\`\`

CRITICAL REMINDER: NO NAMES. Only objective descriptions of what happened.

### Consistency Constraint
- Truth events MUST be derived from the user prompt, macro scene, and historical mythos.
- Do NOT introduce new locations, organizations, or entities not implied by the injected context.

Generate the truth timeline now.`;
}

/**
 * Step 4: Knowledge Matrix (Abstract Holders, NOT NPCs)
 */
export function getKnowledgeMatrixTemplate(storyLength: StoryLength = "medium"): string {
  const storyGuidance = getStoryLengthKnowledgeMatrixGuidance(storyLength);
  return `You are a writer for a CoC game.

# KNOWLEDGE MATRIX GENERATION

## What is Knowledge Matrix?
Defines WHO/WHAT knows which truth events, using KNOWLEDGE HOLDERS (not NPCs).

## Knowledge Holder Types

### 1. ROLE
A social role or function (e.g., "Ritual Participant", "Construction Worker Who Found Site", "Night Shift Security Guard")

### 2. ORGANIZATION
A group or institution (e.g., "Local Historical Society Inner Circle", "Police Department", "Secret Occult Lodge")

### 3. PLACE
A location that contains physical evidence (e.g., "Abandoned Tunnel System", "Town Archive Room", "Crime Scene Location")

### 4. OBJECT
A physical artifact with information (e.g., "Altered Construction Blueprints", "Ritual Diary Fragment", "Police Report with Redactions")

## Setting Context
The macro scene structure that defines the setting, power structure, and key locations:
{{macroSceneJson}}

## Historical Mythos Events
The historical events that shaped the present:
{{mythosEventsJson}}

## Truth Timeline (Current Events)
{{truthTimelineJson}}

${storyGuidance}

## Task
For each truth event in the timeline, determine which abstract HOLDERS possess knowledge of it.

### Important Considerations
1. **Use macro scene structure**: Consider existing organizations, power structures, and locations
2. **Consider historical mythos**: Some knowledge holders may possess knowledge of BOTH historical and current events
   - Families with ancestral knowledge
   - Organizations founded to suppress/study historical events
   - Locations that witnessed both past and present events
   - Objects that survived from historical periods

### Examples of Multi-Temporal Knowledge Holders
- ROLE: "Descendant of ritual participants" (knows historical event + current manifestation)
- ORGANIZATION: "Historical Society" (preserves knowledge of both past events and current cover-up)
- PLACE: "Old church basement" (contains evidence from 1847 ritual + recent activities)
- OBJECT: "Family grimoire" (documents historical summoning + current ritual instructions)

## Distortion Types
- **none**: Accurate knowledge
- **partial_amnesia**: Fragmented, incomplete memories
- **deliberate_suppression**: Intentionally hidden/altered information
- **misinterpretation**: Wrong but sincere understanding

## Output Format
Return ONLY valid JSON in this structure:
\`\`\`json
{
  "knowledgeHolders": [
    {
      "holderType": "ROLE|ORGANIZATION|PLACE|OBJECT",
      "holderName": "string",
      "knows": ["T1", "T2"],
      "distortion": "none|partial_amnesia|deliberate_suppression|misinterpretation",
      "containsEvidence": ["T1", "T2"],
      "reliability": "high|medium|low|encoded"
    }
  ]
}
\`\`\`

## Example (Concrete)
\`\`\`json
{
  "knowledgeHolders": [
    {
      "holderType": "ROLE",
      "holderName": "Retired Sheriff",
      "knows": ["T1"],
      "distortion": "misinterpretation"
    },
    {
      "holderType": "PLACE",
      "holderName": "Old farmhouse root cellar",
      "containsEvidence": ["T1", "T2"],
      "reliability": "high"
    }
  ]
}
\`\`\`

IMPORTANT: Do NOT create specific NPCs here. Only define abstract knowledge holders.
Later, NPCs will be instantiated FROM these holders.

### Consistency Constraint
- All holders, places, and objects MUST be grounded in the user prompt, macro scene, mythos events, and truth timeline.
- Do NOT introduce unrelated towns, organizations, or lore not implied by the injected context.

Generate the knowledge matrix now.`;
}

/**
 * Step 5: Red Herrings (False but Plausible Explanations)
 */
export function getRedHerringsTemplate(storyLength: StoryLength = "medium"): string {
  const redHerringsSentence = getStoryLengthRedHerringsSentence(storyLength);
  return `You are a writer for a CoC game.

# RED HERRINGS GENERATION

## What are Red Herrings?
False but plausible explanations that MUST have a physical or psychological source.

## Purpose
Red herrings explain why the world contains "reasonable but wrong" interpretations of events.
They are NOT just lies - they are emergent misunderstandings with traceable origins.

## Source Types
- **MEDIA_RUMOR**: Newspaper speculation, social media theories
- **MEDICAL_RECORD**: Misdiagnosis, psychiatric evaluation
- **OFFICIAL_REPORT**: Government/institutional explanation that's incorrect
- **WITNESS_MISIDENTIFICATION**: Genuine mistake by observer
- **COINCIDENCE**: Unrelated events that appear connected
- **HISTORICAL_DISTORTION**: Sanitized history, mythology treated as legend

## Historical Mythos Events (for Reference)
The historical events that may have been covered up or rationalized:
{{mythosEventsJson}}

## Truth Timeline (Current Events)
{{truthTimelineJson}}

## Knowledge Matrix (for Reference)
{{knowledgeMatrixJson}}

## Task
${redHerringsSentence}

### Red Herrings Can Target
1. **Current Events**: Misinterpret recent truth events (e.g., "serial killer" instead of "ritual murders")
2. **Historical Events**: Rationalize past mythos events (e.g., "1847 harbor disaster was just a gas leak")
3. **Connections**: Obscure the link between historical and current events (e.g., "these are unrelated coincidences")

### Important Considerations
- Historical mythos events may have spawned PERSISTENT red herrings (official cover stories, local legends)
- Some red herrings may have been deliberately created to suppress knowledge of historical events
- Red herrings should feel internally consistent even if factually wrong

## Requirements
1. Must explain WHY people would believe it
2. Must have a specific SOURCE
3. Must be plausible enough that reasonable investigators would consider it
4. Should contradict or obscure specific truth events

### Consistency Constraint
- Red herrings MUST be derived from the user prompt, mythos events, truth timeline, and knowledge matrix.
- Do NOT introduce unrelated places, organizations, or backstories.

## Output Format
Return ONLY valid JSON in this structure:
\`\`\`json
{
  "redHerrings": [
    {
      "id": "string (e.g., RH1)",
      "falseBelief": "string",
      "sourceType": "MEDIA_RUMOR|MEDICAL_RECORD|OFFICIAL_REPORT|WITNESS_MISIDENTIFICATION|COINCIDENCE|HISTORICAL_DISTORTION",
      "origin": "string",
      "whyPlausible": "string",
      "contradictsEvents": ["T1", "T2"]
    }
  ]
}
\`\`\`

## Example (Concrete)
\`\`\`json
{
  "redHerrings": [
    {
      "id": "RH1",
      "falseBelief": "The decay is caused by a contaminated well",
      "sourceType": "OFFICIAL_REPORT",
      "origin": "County health notice citing bacteria levels",
      "whyPlausible": "Matches symptoms seen in livestock and crops",
      "contradictsEvents": ["T1", "T2"]
    }
  ]
}
\`\`\`

Generate the red herrings now.`;
}

/**
 * Step 2: Historical Mythos Layer
 */
export function getHistoricalMythosTemplateForSetting(
  _settingType: MacroSceneSettingType
): string {
  return `You are a writer for a CoC game.

# MACRO SCENE GENERATION - STEP 2: Historical Mythos Layer

## Objective
Define the historical mythos intrusions that created the foundation for the current scenario.

## User Creative Prompt
{{userPrompt}}

**CRITICAL - ABSOLUTE PRIORITY**:
- This user prompt is the PRIMARY source of creative intent
- If the user specified a LOCATION, all historical events must occur in or relate to that exact location
- If the user specified a STYLE/ATMOSPHERE (e.g., "beautiful nature", "tropical paradise"), historical events should enhance that atmosphere with horror, not contradict it
- If the user specified THEMES, historical events must connect to those themes

## Setting Context
{{macroSceneJson}}

**MANDATORY**: Your output MUST fit this generated setting exactly. The location, geography, and atmosphere defined in the macro scene are NON-NEGOTIABLE.

## Task
Generate 2-4 historical mythos intrusion events that occurred in the PAST (decades or centuries ago).
These events shape the current situation and will influence the truth timeline generated in the next step.

### Requirements for Each Historical Event
- **Date/Period**: When it occurred (must be in the past, not current events)
- **Event Description**: Objective description of mythos intrusion
- **Mythos Entity/Phenomenon**: What mythos element was involved (choose appropriate entities from Call of Cthulhu lore)
- **Immediate Consequences**: What happened right after the event
- **Long-Term Residue**: How it STILL affects the setting today
  - Corrupted bloodlines, cursed locations, forbidden knowledge
  - Institutions founded to suppress/study the event
  - Physical alterations to the environment
  - Lingering psychic or supernatural effects

### Critical Rule
Each historical event MUST have traceable influence on the present:
- Creates or corrupts an existing organization/institution
- Taints a bloodline or family
- Leaves evidence in a location or object
- Establishes a recurring pattern or cycle

### Consistency Constraint
- Ground every event in the user prompt and the injected macro scene.
- Do NOT introduce unrelated towns, cities, organizations, or mythos frameworks.
- Any new detail must be a refinement of, or directly tied to, the injected setting.

## Before You Generate - Final Checklist
✓ Do all historical events occur in or directly relate to the location from the macro scene?
✓ Are the mythos entities and phenomena appropriate to the location's geography/culture?
✓ Do the long-term residues make sense for the setting's environment (e.g., no "frozen artifacts" in tropical settings)?
✓ Do the historical events enhance the atmosphere requested by the user?
✓ Have you avoided generic mythos tropes that don't fit this specific location?

## Output Format
Return ONLY valid JSON in this structure:
\`\`\`json
{
  "mythosEvents": [
    {
      "period": "string (past date/period)",
      "eventDescription": "string",
      "mythosEntityInvolved": "string",
      "immediateConsequences": ["string"],
      "longTermResidue": ["string"],
      "affectedInstitutions": ["string"],
      "affectedLocations": ["string"]
    }
  ]
}
\`\`\`

## Example (Concrete)
\`\`\`json
{
  "mythosEvents": [
    {
      "period": "1812",
      "eventDescription": "Settlers bound a harvest entity beneath an oak",
      "mythosEntityInvolved": "A nameless earth spirit",
      "immediateConsequences": [
        "A bountiful harvest followed",
        "Three settlers vanished"
      ],
      "longTermResidue": [
        "A family line maintains the pact",
        "The oak exudes black sap during storms"
      ],
      "affectedInstitutions": ["Founding families"],
      "affectedLocations": ["The old oak", "The farmhouse grounds"]
    }
  ]
}
\`\`\`

Generate the historical mythos events now.`;
}

/**
 * Step 6: End State Definition
 */
export function getEndStateTemplate(): string {
  return `You are a writer for a CoC game.

# MACRO SCENE GENERATION - STEP 6: End State Definition

## Objective
Define the inevitable catastrophic outcome if investigators do not intervene.

## Previous Context
### Setting Structure
{{macroSceneJson}}

### Historical Mythos Events
{{mythosEventsJson}}

### Truth Timeline (Current Events)
{{truthTimelineJson}}

## Task

Define what WILL happen if investigators do not intervene.

### Requirements
- **Summary**: 1-3 paragraphs describing the catastrophic outcome
- **Catastrophe Nature**: Type of disaster (awakening, transformation, massacre, etc.)
- **Winners and Survivors**: Who benefits or survives (if anyone)
- **Point of No Return**: Time-based or condition-based trigger

### Constraints
- Must be deterministic (not dependent on investigator actions)
- Must be mythos-consistent with Call of Cthulhu lore
- Should be dire enough to justify intervention
- Must remain within the injected setting and continuity
- Must align with the user prompt and injected macro scene, mythos events, and truth timeline

## Output Format
Return ONLY valid JSON in this structure:
\`\`\`json
{
  "endState": {
    "summary": "string",
    "catastropheNature": "string",
    "winnersAndSurvivors": ["string"],
    "pointOfNoReturn": {
      "type": "time|condition",
      "trigger": "string"
    }
  }
}
\`\`\`

## Example (Concrete)
\`\`\`json
{
  "endState": {
    "summary": "The ritual completes and the entity spreads through the valley. Crops rot overnight and the town falls into a silent trance as the land consumes the living.",
    "catastropheNature": "Regional decay and psychic domination",
    "winnersAndSurvivors": [
      "The pact-keepers retain power for a season",
      "Anyone who leaves the county two days before the event survives"
    ],
    "pointOfNoReturn": {
      "type": "time",
      "trigger": "The next new moon at midnight"
    }
  }
}
\`\`\`

Generate the end state definition now.`;
}
