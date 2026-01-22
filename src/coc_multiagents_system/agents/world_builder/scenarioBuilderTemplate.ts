/**
 * Scenario Builder Agent Templates
 * Prompt templates for scenario outline generation (no snapshots yet)
 */

export function getScenarioBuilderTemplate(): string {
  return `You are a CoC world builder.

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
- Use EVERY PLACE holder from the knowledge matrix as a scenario (match holderName).
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
 * Step X: Select starting scene and build a snapshot
 */
export function getStartingSceneSnapshotTemplate(): string {
  return `You are a CoC world builder.

# STARTING SCENE SELECTION + SNAPSHOT

## Objective
Pick the best starting scene for investigators and generate a full scene snapshot.
Then assign every other NPC to a scenario with a short note of what they are doing there.

## Inputs
### Macro Scene
{{macroSceneJson}}

### Truth Timeline (current events, no names)
{{truthTimelineJson}}

### Knowledge Matrix (all holders)
{{knowledgeMatrixJson}}

### All Scenarios (outlines)
{{scenariosJson}}

### All NPCs (id, name, occupation, age, gender, appearance, personality, background, goals, secrets)
{{npcsJson}}

## Requirements
- Choose exactly ONE scenario from the provided list as the starting scene.
- Generate a ScenarioSnapshot for that starting scene (use the schema from ScenarioSnapshot).
- The snapshot must include: id, name, location, description, characters, clues, conditions, events.
- Populate snapshot.characters with NPCs present in the starting scene.
- Expand the starting scenario's "clues" into fully formatted snapshot.clues entries.
  - Every scenario clue must map to at least one snapshot clue.
  - Preserve the original clueText meaning while adding category/difficulty/location/discovered.
- Every NPC MUST be accounted for:
  - If in the starting snapshot, do NOT assign them elsewhere.
  - Otherwise, assign them to a scenario in the "otherScenarioNpcAssignments" list.
- Include ALL non-starting scenarios in "otherScenarioNpcAssignments" (empty npc lists are allowed).
- For each assigned NPC, add a short "activity" note describing what they are doing in that scenario.
- Do NOT invent new scenarios or NPCs beyond the provided input.
- Keep the output grounded in the macro scene and truth timeline.

## Output Format
Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "startingScene": {
    "scenarioId": "SCN_1",
    "scenarioName": "Scenario Name",
    "selectionReason": "Why this is the best first scene to explore.",
    "snapshot": {
      "id": "SCN_1",
      "name": "Scenario Name",
      "location": "Primary location",
      "description": "Detailed description of the scene.",
      "characters": [
        {
          "id": "NPC_1",
          "name": "Character Name",
          "role": "witness",
          "status": "alive",
          "location": "Specific spot in the scene",
          "notes": "What they are doing or how they appear."
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
          "mechanicalEffect": "Spot Hidden checks are hard."
        }
      ],
      "events": [
        "A notable ongoing or imminent event in this scene."
      ],
      "exits": [
        {
          "direction": "north",
          "destination": "Other Scenario",
          "description": "How it connects."
        }
      ],
      "keeperNotes": "Private note for the Keeper."
    }
  },
  "otherScenarioNpcAssignments": [
    {
      "scenarioId": "SCN_2",
      "scenarioName": "Other Scenario",
      "npcs": [
        {
          "id": "NPC_2",
          "name": "Character Name",
          "occupation": "Occupation",
          "activity": "What this NPC is doing here right now."
        }
      ]
    }
  ]
}
\`\`\`
`;
}
