/**
 * Scenario Builder Agent Templates
 * Prompt templates for scenario outline generation and starting scene
 */

export function getScenarioBuilderTemplate(): string {
  return `You are a writer for a tabletop RPG scenario.

════════════════════════════════════════════════════════
🔴 SUPREME DIRECTIVE — READ THIS BEFORE ANYTHING ELSE 🔴
════════════════════════════════════════════════════════
STORY ELEMENTS (absolute mandate):
{{storyElements}}

These structured story elements are the SINGLE HIGHEST AUTHORITY for all content you generate.
All scenarios MUST be consistent with the story elements above — genre, tone, theme, era, and worldbuilding.
════════════════════════════════════════════════════════

# SCENARIO OUTLINES GENERATION

## Objective
Generate a list of scenarios (locations) with descriptions and connections.

## Inputs
### Macro Scene
{{macroSceneJson}}

### Truth Timeline (current events, no names)
{{truthTimelineJson}}

### Knowledge Matrix (all holders)
{{knowledgeMatrixJson}}

## Requirements
- Use EVERY PLACE holder from the knowledge matrix as a scenario.
- **Scenario Naming Rules**:
  - Each scenario MUST correspond to exactly one PLACE holder (tracked via sourcePlaceId and sourcePlaceName).
  - The scenario "name" should be a natural, story-appropriate location name that fits the setting and real-world naming conventions.
  - If the PLACE holder's "holderName" is already natural and story-appropriate, you may use it directly.
  - If the "holderName" is too technical, verbose, or doesn't fit real-world naming conventions, transform it into a more natural name while preserving the core meaning and ensuring it matches the story setting.
  - Examples: "The Utilidor service tunnels" → "The Utilidor service tunnels" (natural) or "Service Tunnels" (simpler); "The maintenance bay for the 'It's a Small World' tribute clocktower" → "Clocktower Maintenance Bay" (more natural).
- Provide a short, evocative description for each scenario.
- If a PLACE holder includes "containsEvidence", carry those strings into the matching scenario's "evidence" array.
- Expand each evidence item into at least one scenario-level clue and store them in "clues" (basic only).
- Add connections between scenarios so the graph is navigable.
- You MAY add connector scenarios (e.g., street, alley, trail, ferry, bridge) to link places.
- Do NOT generate snapshots, NPCs, or events.
- Output must be grounded in the macro scene and truth timeline atmosphere.

## Connections
Use relationshipType values:
- "leads_to"
- "concurrent"
- "prerequisite"
- "alternate"

Connections should reference other scenario names.

## Output Format
Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "scenarios": [
    {
      "id": "SCN_1",
      "name": "Scenario Name",
      "description": "Short descriptive paragraph.",
      "sourcePlaceId": "KH_PLACE_1",
      "sourcePlaceName": "Knowledge place name",
      "evidence": ["evidence string from containsEvidence"],
      "clues": [
        {
          "clueText": "Clue expanded from evidence.",
          "evidenceRef": "evidence string from containsEvidence",
          "notes": "Short note if needed."
        }
      ],
      "tags": ["place" , "connector"],
      "connections": [
        {
          "scenarioName": "Other Scenario",
          "relationshipType": "leads_to",
          "description": "How it connects."
        }
      ]
    }
  ]
}
\`\`\`
`;
}

/**
 * Select starting scene and build a DynamicScene (NO NPC assignments)
 */
export function getStartingSceneTemplate(): string {
  return `You are a writer for a tabletop RPG scenario.

════════════════════════════════════════════════════════
🔴 SUPREME DIRECTIVE — READ THIS BEFORE ANYTHING ELSE 🔴
════════════════════════════════════════════════════════
STORY ELEMENTS (absolute mandate):
{{storyElements}}

These structured story elements are the SINGLE HIGHEST AUTHORITY for all content you generate.
The starting scene MUST be consistent with the story elements above — genre, tone, theme, era, and worldbuilding.
════════════════════════════════════════════════════════

# STARTING SCENE SELECTION

## Objective
Pick the best starting scene for investigators and generate a full DynamicScene.
Do NOT assign NPCs — that will be handled in a separate step.

## Inputs
### Macro Scene
{{macroSceneJson}}

### Truth Timeline (current events, no names)
{{truthTimelineJson}}

### Knowledge Matrix (all holders)
{{knowledgeMatrixJson}}

### All Scenarios (outlines)
{{scenariosJson}}

## Requirements
- Choose exactly ONE scenario from the provided list as the starting scene.
- Generate a DynamicScene for that starting scene.
- The scene must include: id, name, description, domain, items, clues, conditions, events.
- "scene.id" MUST be exactly the same as the selected "startingScene.scenarioId" (no suffix/prefix/renaming).
- "scene.name" MUST be exactly the same as the selected "startingScene.scenarioName".
- "domain" is an optional thematic label for the scene (e.g., "urban", "wilderness", "underground").
- "items" lists notable interactable objects in the scene (id + name + optional description).
- Expand the starting scenario's "clues" into fully formatted scene.clues entries.
  - Every scenario clue must map to at least one scene clue.
  - Preserve the original clueText meaning while adding category/difficulty/location/discovered.
- Do NOT include characters/NPCs in the scene — NPCs are managed separately.
- Do NOT invent new scenarios beyond the provided input.
- Keep the output grounded in the macro scene and truth timeline.

## Output Format
Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "startingScene": {
    "scenarioId": "SCN_1",
    "scenarioName": "Scenario Name",
    "scene": {
      "id": "SCN_1",
      "name": "Scenario Name",
      "description": "Detailed description of the scene.",
      "domain": "urban",
      "items": [
        {
          "id": "item_1",
          "name": "Old Newspaper",
          "description": "A crumpled newspaper from last week."
        }
      ],
      "clues": [
        {
          "id": "CLUE_1",
          "clueText": "Clue description.",
          "category": "environment",
          "difficulty": "regular",
          "location": "Where it is found",
          "discovered": false
        }
      ],
      "conditions": [
        {
          "type": "lighting",
          "description": "Dim and flickering.",
          "mechanicalEffect": "Perception checks are hard."
        }
      ],
      "events": [
        "A notable ongoing or imminent event in this scene."
      ]
    }
  }
}
\`\`\`
`;
}

/**
 * Assign all NPCs to scenarios (separate step after starting scene generation)
 */
export function getNpcAssignmentTemplate(): string {
  return `You are a writer for a tabletop RPG scenario.

════════════════════════════════════════════════════════
🔴 SUPREME DIRECTIVE — READ THIS BEFORE ANYTHING ELSE 🔴
════════════════════════════════════════════════════════
STORY ELEMENTS (absolute mandate):
{{storyElements}}

These structured story elements are the SINGLE HIGHEST AUTHORITY for all content you generate.
NPC assignments MUST be consistent with the story elements above — genre, tone, theme, era, and worldbuilding.
════════════════════════════════════════════════════════

# NPC SCENARIO ASSIGNMENT

## Objective
Assign every NPC to exactly one scenario. For NPCs in the starting scene, add them to the "startingSceneCharacters" list. For all others, assign them to another scenario with an activity note.

## Inputs
### Starting Scene
{{startingSceneJson}}

### All Scenarios (outlines)
{{scenariosJson}}

### All NPCs
{{npcsJson}}

## Requirements
- Every NPC MUST be assigned to exactly ONE scenario — no duplicates, no omissions.
- For NPCs assigned to the starting scene: populate "startingSceneCharacters" with full character entries.
- For NPCs assigned to other scenarios: populate "otherScenarioNpcAssignments" with scenario + NPC + activity.
- Include ALL non-starting scenarios in "otherScenarioNpcAssignments" (empty npc lists are allowed).
- For each assigned NPC, add a short "activity" note describing what they are doing in that scenario.
- NPC placement should make narrative sense based on their occupation, background, goals, and secrets.
- Do NOT invent new scenarios or NPCs beyond the provided input.

## Output Format
Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "startingSceneCharacters": [
    {
      "id": "npc-character-name",
      "name": "Character Name",
      "role": "witness",
      "status": "alive",
      "location": "Specific spot in the starting scene",
      "notes": "What they are doing or how they appear."
    }
  ],
  "otherScenarioNpcAssignments": [
    {
      "scenarioId": "SCN_2",
      "scenarioName": "Other Scenario",
      "npcs": [
        {
          "id": "npc-character-name",
          "name": "Character Name",
          "activity": "What this NPC is doing here right now."
        }
      ]
    }
  ]
}
\`\`\`
`;
}
