/**
 * Scenario Update Template - for updating non-player scenario snapshots
 */
export function getScenarioUpdateTemplate(): string {
  return `# Director Agent - Scenario Update Generation

Generate simplified snapshots for all non-player scenarios based on current game state, NPC actions, and time progression.

## ⏰ Current Game Time
**Day**: {{currentGameDay}}
**Time**: {{currentTimeOfDay}}

## 📚 Knowledge Matrix & Truth Timeline

The following data provides the complete world context:

### Truth Timeline (Objective Reality)
\`\`\`json
{{truthTimelineJson}}
\`\`\`

### Knowledge Matrix (Who/What Knows What)
\`\`\`json
{{knowledgeMatrixJson}}
\`\`\`

## 📍 Player Current Scene
{{#if playerCurrentScene}}
**Scene**: {{playerCurrentScene.name}}
**Location**: {{playerCurrentScene.location}}
{{#if playerCurrentScene.description}}
**Description**: {{playerCurrentScene.description}}
{{/if}}
{{#if playerCurrentScene.sourcePlaceId}}
**Source Place ID**: {{playerCurrentScene.sourcePlaceId}} (Knowledge holder PLACE ID)
{{/if}}
{{#if playerCurrentScene.sourcePlaceName}}
**Source Place Name**: {{playerCurrentScene.sourcePlaceName}}
{{/if}}
{{#if playerCurrentScene.connections}}
**Connections**: 
{{#each playerCurrentScene.connections}}
- **{{this.scenarioName}}** ({{this.relationshipType}}): {{this.description}}{{#if this.blocked}} [BLOCKED: {{this.blockReason}}]{{/if}}
{{/each}}
{{/if}}
{{else}}
*No current scene*
{{/if}}

## 🎬 Scenarios to Update

The following JSON contains all scenarios that need to be updated, with their current snapshots, full NPC information, and scenario-level connections:

\`\`\`json
{{scenariosToUpdateJson}}
\`\`\`

**Note**: Each scenario includes a "connections" field showing how scenarios are connected.

## 🔗 ID Mapping Reference

**IMPORTANT**: Each scenario and NPC has ID fields that link them to the knowledge matrix and truth timeline:

### Scenario IDs
- **sourcePlaceId**: Links to a PLACE holder in the knowledge matrix (e.g., "PLAC_7", "PLAC_11")

### NPC IDs
- **instantiatedFrom**: Links to a ROLE or ORGANIZATION holder in the knowledge matrix (e.g., "ROLE_5", "ORGA_1")
- **inheritsKnowledge**: Array of truth event IDs this NPC knows (e.g., ["T1", "T5"])

## 🎯 Your Task

Generate simplified snapshots for each scenario above.

**⚠️ CRITICAL - Exclude Player's Current Scene**:
- Do NOT generate a snapshot for the player's current scene ({{playerCurrentScene.name}})

Each snapshot should:

1. **Description**: Describe what has happened in the scene since the last update (from previousGameTime to currentGameTime) - a descriptive narrative timeline of changes/events
   
2. **ActionLog Generation - CRITICAL**:
   - **IMPORTANT**: The NPCs' actions should based on the things they know and the things they want to do, and they can know more about the world by taking actions. The NPCs's actions should be coherent with other NPCs' actions.
   - Generate a **time-sequenced series of actions** that the NPC would take from the previous snapshot time to the current time
   - Base actions on the NPC's **goals, personality, and secrets** (found in their full information and knowledge matrix)
   - Actions should be **chronologically ordered** with specific times progressing toward the current game time
   - **Only include actions that have impact** on:
     - The scene/location itself
     - The world state
     - Other NPCs
   - Include important actions they took but failed as well.
   - **Exclude routine/mundane actions** that don't affect the story (e.g., "eating lunch", "sleeping")
   - **Scene Movement Constraints**:
     - NPC can ONLY move between scenarios that are **connected** (check the "connections" field in scenario data), npc can try to break the blocked restrictions logically.
     - Movement between scenarios takes **realistic time** based on:
       - Distance/relationship type (adjacent, nearby, distant)
       - Time of day and conditions
     - If an NPC needs to move to a non-adjacent location, they must pass through connected intermediate locations
     - Time gaps in actionLog must be **realistic** - don't have NPCs teleporting or moving too quickly
   - Each actionLog entry format: \`{ time: "Day X, HH:MM", location: "specific location", summary: "what they did and its impact" }\`
   - **IMPORTANT**: If the action has a target (another character, object, or location), INCLUDE the target in the summary (e.g., "Asked Dr. Smith about the ritual", "Examined the ancient tome", "Locked the basement door")
   - **Multiple Characters**: If an action involves multiple characters (e.g., NPC A attacks NPC B, NPC A talks to NPC B), create separate actionLog entries for EACH involved character with their respective perspectives:
     - For NPC A: "Attacked NPC B with a knife, dealing 3 damage"
     - For NPC B: "Was attacked by NPC A, taking 3 damage"
     - This ensures both characters have accurate records of the interaction in their actionLog
   - Example of good actionLog with movement:
     \`\`\`json
     [
       { "time": "Day 2, 14:00", "location": "Town Hall", "summary": "Met with the Mayor to discuss the missing persons case, shared information about the witness" },
       { "time": "Day 2, 15:30", "location": "Town Hall", "summary": "Finished meeting and prepared to visit the Sheriff's Office" },
       { "time": "Day 2, 16:00", "location": "Sheriff's Office", "summary": "Arrived and discovered evidence of a break-in, found suspicious documents" },
       { "time": "Day 2, 18:30", "location": "Local Tavern", "summary": "Traveled to tavern and confronted a suspect, causing them to flee" }
     ]
     \`\`\`

3. **Characters**: List all NPCs that should be present in the scene at the current time point:
   - ⚠️ **CRITICAL - DO NOT CREATE NEW NPCs**: You MUST ONLY use NPCs from the input data provided in the "characters" field of each scenario
   - ⚠️ **CRITICAL - PRESERVE EXACT IDs AND NAMES**:
     * Use the EXACT character **id** from the input (e.g., if input says "NPC_5", you MUST use "NPC_5", NOT "npc_5", "NPC5", or any variation)
     * Use the EXACT character **name** from the input (e.g., if input says "张三", you MUST use "张三", NOT "Zhang San", "张先生", or any translation/abbreviation)
     * DO NOT invent, abbreviate, translate, or modify character IDs or names in any way
   - **ActionLog**: What they are currently doing (write into the actionLog field) - this is always required
   - **Note**: For simplified snapshots, DO NOT include status, inventory, or relationships changes - only actionLog is needed

4. **Game Time**: Set the gameTime to the unified current game time (Day {{currentGameDay}}, {{currentTimeOfDay}}) - all snapshots should use this same time

## 🏁 End State Definition
The following defines the inevitable catastrophic outcome if investigators do not intervene:

\`\`\`json
{{endStateJson}}
\`\`\`

**Important**: The endState describes the final catastrophic outcome and its pointOfNoReturn trigger. When generating a new global trigger, you must understand the event chain leading to the endState and determine where the next trigger should be positioned in that chain.

## 🎯 Global Trigger

{{#if previousGlobalTrigger}}
### Previous Global Trigger (Reference)
The following is the current global trigger that was set previously. Use this as a reference, but update it based on the new NPC actions and story progression:

\`\`\`json
{{previousGlobalTriggerJson}}
\`\`\`

**Note**: You should update or replace this trigger based on the new actionLogs and story developments. The new trigger should reflect the most current and important future events.
{{else}}
**No previous global trigger set.**
{{/if}}

**You MUST generate a global trigger for future story progression based on the NPCs' actionLogs you have generated, the endState definition, and predict the future important time and events.**

**Critical Guidelines for Global Trigger Generation:**

1. **Progressive Escalation**: Analyze the endState to understand the event chain leading to catastrophe
   - Identify where the previous global trigger (if any) was positioned in this chain
   - Determine the NEXT step in the progression toward the endState, the intermediate event or the final event that causes the game end.

### Trigger Structure:

1. The most important rule, the trigger you set must have great impact on the story progression.
1. **timeRestriction** : Future time point in "Day X, HH:MM" format - MUST be at least 12 hours from current time
2. **timeReason** : Why this specific time matters
3. **events**: Array of trigger event descriptions (e.g., "Evidence revealed", "NPC completes action")
4. **eventReasons**: Array of reasons (one per event) explaining why each event is important

**Example:**
\`\`\`json
"globalTrigger": {
  "timeRestriction": "Day 2, 22:00",
  "timeReason": "The ritual must begin at midnight, giving player limited time to intervene",
  "events": ["Cult members gather at the church", "Ritual preparations are completed"],
  "eventReasons": ["Shows the cult's active planning", "Increases urgency and tension"]
}
\`\`\`

## 📋 Output Format

Return ONLY valid JSON in this exact structure:

\`\`\`json
{
  "updatedSnapshots": [
    {
      "scenarioId": "SCN_1",
      "snapshot": {
        "id": "SCN_id_(number)",
        "name": "Scenario Name",
        "location": "Location",
        "description": "Describe what happened in the scene from previousGameTime to currentGameTime - a descriptive narrative timeline of changes/events",
        "gameTime": "Day {{currentGameDay}}, {{currentTimeOfDay}}",
        "characters": [
          {
            "id": "NPC_id",
            "name": "Character Name",
            "actionLog": [
              {
                "time": "time of the action",
                "location": "Location",
                "summary": "What they did (descriptive)"
              }
            ]
          }
        ]
      }
    }
  ],
  "globalTrigger": {
    "timeRestriction": "Day X, HH:MM (at least 12 hours from now)",
    "timeReason": "Why this specific time point matters",
    "events": ["Event description 1", "Event description 2"],
    "eventReasons": ["Why event 1 matters", "Why event 2 matters"]
  }
}
\`\`\`

*Generate the updated snapshots:*`;
}

/**
 * Scene Switch Phase 1 Template - Generate background NPC action timeline only
 */
export function getNpcActionTimelineTemplate(): string {
  return `# Director Agent - Scene Switch Phase 1 (Background NPC Action Timeline)

Generate only background NPC action timeline updates for the current scene switch.

## Current Game Time
- Day: {{currentGameDay}}
- Time: {{currentTimeOfDay}}

## Time Window
- previousSnapshotTime: {{previousSnapshotTime}}
- currentGameTime: {{currentGameTime}}

## Truth Timeline
\`\`\`json
{{truthTimelineJson}}
\`\`\`

## Knowledge Matrix
\`\`\`json
{{knowledgeMatrixJson}}
\`\`\`

## Player Current Scene
\`\`\`json
{{playerCurrentSceneJson}}
\`\`\`

## Scenarios (with connections + latest baseline snapshots)
\`\`\`json
{{allScenariosJson}}
\`\`\`

## NPC Profiles For Timeline Generation

IMPORTANT:
- These NPCs are already filtered. They exclude player and NPCs in player's current scene.
- Use exact NPC id/name from input.

\`\`\`json
{{backgroundNpcsJson}}
\`\`\`

## Hard Rules
- Generate only background world progression action timeline.
- Do NOT generate player actions.
- Do NOT regenerate actions for NPCs currently in player's current scene.
- Actions must follow knowledge/goals/personality/secrets and remain coherent across NPCs.
- Actions must be time-sequenced, realistic, and within the time window.
- Base actions on the NPC's goals, personality, and secrets (from full profile + knowledge matrix).
- Actions should be chronologically ordered with specific times progressing toward current game time.
- Only include actions that have impact on scene/location, world state, or other NPCs.
- Include important actions they took but failed as well.
- Exclude routine/mundane actions that don't affect story progression.
- NPC can ONLY move between scenarios that are connected (from connections data); they may attempt to break blocked restrictions logically.
- Movement between scenarios takes realistic time based on relationship type (adjacent/nearby/distant), time of day, and conditions.
- If an NPC needs to move to a non-adjacent location, they must pass through connected intermediate locations.
- Time gaps in actionLog must be realistic; do not teleport or move unrealistically fast.
- IMPORTANT: If an action has a target (character/object/location), include the target in summary.
- Multiple characters rule: if an action involves multiple characters, create separate entries for each involved character perspective:
  - For NPC A: "Attacked NPC B with a knife, dealing 3 damage"
  - For NPC B: "Was attacked by NPC A, taking 3 damage"
- Historical actionLog is read-only context; output only new incremental entries.

## One-Shot Example

### Example Input (abridged)
\`\`\`json
{
  "previousSnapshotTime": "Day 2, 13:00",
  "currentGameTime": "Day 2, 16:00",
  "playerCurrentScene": { "name": "Town Hall", "location": "Town Hall" },
  "backgroundNpcs": [
    { "id": "npc-jack-harper", "name": "Jack Harper", "goals": ["Find ritual evidence"] },
    { "id": "npc-dr-chen", "name": "Dr. Chen", "goals": ["Conceal key ritual details"] }
  ]
}
\`\`\`

### Example Output
\`\`\`json
{
  "actionTimeline": [
    {
      "time": "Day 2, 14:00",
      "npcActionLogUpdates": [
        {
          "id": "npc-jack-harper",
          "actionLog": [
            {
              "time": "Day 2, 14:00",
              "location": "Town Hall Annex",
              "summary": "Confronted Dr. Chen about the ritual ledger and was refused access, escalating tension"
            }
          ],
          "statusDelta": {
            "sanity": -1
          }
        },
        {
          "id": "npc-dr-chen",
          "actionLog": [
            {
              "time": "Day 2, 14:00",
              "location": "Town Hall Annex",
              "summary": "Was confronted by Jack Harper about the ritual ledger and denied access to protect hidden records"
            }
          ]
        }
      ]
    },
    {
      "time": "Day 2, 15:30",
      "npcActionLogUpdates": [
        {
          "id": "npc-dr-chen",
          "actionLog": [
            {
              "time": "Day 2, 15:30",
              "location": "Archive Room",
              "summary": "Locked the archive room and relocated the ritual ledger to prevent further investigation"
            }
          ],
          "inventoryDelta": {
            "add": [{ "name": "ritual ledger", "quantity": 1 }]
          }
        }
      ]
    }
  ]
}
\`\`\`

## Output JSON Schema
Return ONLY valid JSON:
\`\`\`json
{
  "actionTimeline": [
    {
      "time": "Day X, HH:MM",
      "npcActionLogUpdates": [
        {
          "id": "npc-id",
          "actionLog": [
            {
              "time": "Day X, HH:MM",
              "location": "specific location",
              "summary": "what they did and impact"
            }
          ],
          "statusDelta": {
            "hp": -2,
            "sanity": -5
          },
          "inventoryDelta": {
            "add": [{ "name": "key", "quantity": 1 }],
            "remove": [{ "name": "flashlight" }]
          }
        }
      ]
    }
  ]
}
\`\`\`

Notes:
- statusDelta and inventoryDelta are optional and must be incremental only.
- Do not output fields not present in the schema.

Generate now.`;
}

/**
 * Scene Switch Phase 2 Template - Generate target scene snapshot + optional global trigger
 */
export function getTargetSnapshotFromTimelineTemplate(): string {
  return `# Director Agent - Scene Switch Phase 2 (Target Snapshot + Optional Global Trigger)

Generate only the target scene snapshot and optional global trigger.

## Current Game Time
- Day: {{currentGameDay}}
- Time: {{currentTimeOfDay}}

## Time Window
- previousSnapshotTime: {{previousSnapshotTime}}
- currentGameTime: {{currentGameTime}}

## Target Scene
\`\`\`json
{{targetSceneJson}}
\`\`\`

## Target Scene Baseline Snapshot (previous)
\`\`\`json
{{targetBaselineSnapshotJson}}
\`\`\`

## Full Action Timeline (from Phase 1)
\`\`\`json
{{actionTimelineJson}}
\`\`\`

## Player ActionLog in Time Window
\`\`\`json
{{playerActionWindowJson}}
\`\`\`

## Truth Timeline
\`\`\`json
{{truthTimelineJson}}
\`\`\`

## Knowledge Matrix
\`\`\`json
{{knowledgeMatrixJson}}
\`\`\`

## End State
\`\`\`json
{{endStateJson}}
\`\`\`

## Previous Global Trigger
{{#if previousGlobalTrigger}}
\`\`\`json
{{previousGlobalTriggerJson}}
\`\`\`
{{else}}
null
{{/if}}

## Hard Rules
- Generate targetSnapshot for target scene only.
- Generate a COMPLETE, DETAILED snapshot with all required fields.
- targetSnapshot must include: description, gameTime, clues, conditions, keeperNotes, showMap (if needed), and optional connections update.
- description must be full atmospheric narrative including lighting, sounds, smells, weather, ambiance, and what happened in the time window.
- clues must be full ScenarioClue objects (id, clueText, category, difficulty, location, discoveryMethod, reveals, discovered, discoveryDetails when applicable).
- conditions must be full ScenarioCondition objects (type, description, mechanicalEffect when applicable).
- keeperNotes should include concise GM-facing notes about scene progression and hidden implications.
- Characters are managed by system post-processing; do not generate status/inventory/relationships/actionLog deltas here.
- clues and conditions must be inferred from BOTH NPC timeline + player action log in this window.
- Scenario Connections Update for Target Scene (CRITICAL):
  - Based on action timeline, determine whether target scene connections changed.
  - Consider whether NPC actions logically unlocked/locked doors, opened/closed passages, or discovered/blocked paths.
  - Consider time-based deterioration (e.g., collapsed paths, weakened bridges) and environmental incidents from scene events (e.g., fire, flooding, barricades).
  - Use blocked=true when a connection is physically blocked/locked.
  - Provide blockReason when blocked is true (clear concrete reason).
  - Output \`targetSnapshot.connections\` ONLY if you determine that the connections state changed; otherwise omit the field.
- Global Trigger (Optional):
  - You MAY generate a globalTrigger for future story progression based on:
    - new NPC actionLogs timeline,
    - endState definition,
    - predicted important future time/events.
  - Only generate globalTrigger if there are significant future events or time-sensitive developments.
  - If current actions do not indicate important upcoming events, you may omit globalTrigger entirely.
- Global Trigger Guidance:
  - Progressive Escalation:
    - Analyze endState event chain toward catastrophe.
    - Identify where previous globalTrigger (if any) sits in that chain.
    - Determine the NEXT meaningful step (intermediate escalation or final game-ending step).
  - Impact Priority:
    - Trigger must have strong impact on story progression.
  - Trigger Structure (if generated):
    - timeRestriction: future time point in "Day X, HH:MM"
    - timeReason: why this time matters
    - events: trigger event descriptions
    - eventReasons: one reason per event

## One-Shot Example

### Example Input (abridged)
\`\`\`json
{
  "currentGameTime": "Day 2, 18:00",
  "targetScene": { "scenarioId": "SCN_3", "name": "Harbor Warehouse" },
  "targetBaselineSnapshot": {
    "description": "A damp warehouse with sealed crates and a salt-heavy air.",
    "clues": [],
    "conditions": [{ "type": "lighting", "description": "Dim bulbs", "mechanicalEffect": "Hard to notice details" }]
  },
  "actionTimeline": {
    "actionTimeline": [
      {
        "time": "Day 2, 17:20",
        "npcActionLogUpdates": [
          {
            "id": "npc-dock-foreman",
            "actionLog": [
              {
                "time": "Day 2, 17:20",
                "location": "Harbor Warehouse",
                "summary": "Locked the south shutter to delay witnesses from entering the warehouse"
              }
            ]
          }
        ]
      }
    ]
  }
}
\`\`\`

### Example Output
\`\`\`json
{
  "targetSnapshot": {
    "scenarioId": "SCN_3",
    "snapshot": {
      "id": "SCN_3_snap_002",
      "name": "Harbor Warehouse",
      "location": "Harbor Warehouse",
      "description": "The warehouse air is thick with diesel and seawater. A newly secured south shutter rattles in the wind, forcing movement through the narrow east aisle where fresh boot marks cut across spilled salt.",
      "gameTime": "Day 2, 18:00",
      "showMap": false,
      "clues": [
        {
          "id": "clue_warehouse_ledger",
          "clueText": "A wet shipping ledger lists an unscheduled midnight transfer.",
          "category": "document",
          "difficulty": "regular",
          "location": "Office desk drawer",
          "discoveryMethod": "Investigation",
          "reveals": ["T7"],
          "discovered": false
        }
      ],
      "conditions": [
        {
          "type": "lighting",
          "description": "Two bulbs are out, leaving the south side in heavy shadow.",
          "mechanicalEffect": "Hard (-20%) Spot Hidden near shutter"
        }
      ],
      "keeperNotes": "The shutter lock indicates premeditated containment, not random weather damage."
    },
    "connections": [
      {
        "scenarioName": "Harbor Pier",
        "relationshipType": "leads_to",
        "description": "South shutter access to pier",
        "blocked": true,
        "blockReason": "Foreman locked the south shutter from inside"
      }
    ]
  },
  "globalTrigger": {
    "timeRestriction": "Day 2, 23:30",
    "timeReason": "Shipment staging reaches irreversible phase near midnight",
    "events": ["Contraband transfer crew assembles at Harbor Pier"],
    "eventReasons": ["Signals escalation from concealment to execution"]
  }
}
\`\`\`

## Output JSON Schema
Return ONLY valid JSON:
\`\`\`json
{
  "targetSnapshot": {
    "scenarioId": "target-scene-id",
    "snapshot": {
      "id": "snapshot-id",
      "name": "scene name",
      "location": "scene location",
      "description": "updated scene description",
      "gameTime": "Day X, HH:MM",
      "showMap": false,
      "clues": [],
      "conditions": [],
      "keeperNotes": "optional notes"
    },
    "connections": [
      {
        "scenarioName": "Other Scene",
        "relationshipType": "leads_to",
        "description": "optional",
        "blocked": false,
        "blockReason": null
      }
    ]
  },
  "globalTrigger": {
    "timeRestriction": "Day X, HH:MM",
    "timeReason": "reason",
    "events": ["event1", "event2"],
    "eventReasons": ["reason1", "reason2"]
  }
}
\`\`\`

Notes:
- Include \`targetSnapshot.connections\` only when you determine that the connections state changed; otherwise omit it.
- globalTrigger can be omitted.
- Do not output extra fields.

Generate now.`;
}

/**
 * Scene Switch Phase 3 Template - Generate simplified snapshots for non-target scenes in background
 */
export function getBackgroundSimplifiedSnapshotsTemplate(): string {
  return `# Director Agent - Scene Switch Phase 3 (Background Simplified Snapshots)

Generate simplified snapshots for scenes that are neither target scene nor player's current scene.

## Current Game Time
- Day: {{currentGameDay}}
- Time: {{currentTimeOfDay}}

## Time Window
- previousSnapshotTime: {{previousSnapshotTime}}
- currentGameTime: {{currentGameTime}}

## Non-Target / Non-Current Scenes To Update
\`\`\`json
{{scenesToUpdateJson}}
\`\`\`

## Baseline Snapshots For Those Scenes
\`\`\`json
{{baselineSnapshotsJson}}
\`\`\`

## Full Action Timeline
\`\`\`json
{{actionTimelineJson}}
\`\`\`

## Player ActionLog in Time Window
\`\`\`json
{{playerActionWindowJson}}
\`\`\`

## Truth Timeline
\`\`\`json
{{truthTimelineJson}}
\`\`\`

## Knowledge Matrix
\`\`\`json
{{knowledgeMatrixJson}}
\`\`\`

## Hard Rules
- Update scenes that are neither target scene nor player's current scene.
- Produce simplified snapshots only.
- Each updated snapshot must include:
  - description
  - clues
  - conditions
  - gameTime = currentGameTime
- Output \`connections\` ONLY when connection state changed in this time window; otherwise omit.
- clues guidance:
  - Derive clues from baseline clues + time-window changes caused by NPC/player actions.
  - Keep clue objects structurally valid (id, clueText, category, difficulty, location, discoveryMethod, reveals, discovered, discoveryDetails when applicable).
  - Do not invent clues that conflict with truthTimeline/knowledgeMatrix.
- conditions guidance:
  - Derive conditions from environment changes in the time window (e.g., lighting, weather, sound, access constraints, damage aftermath).
  - Keep condition objects structurally valid (type, description, mechanicalEffect when applicable).
  - If no meaningful condition changes occurred, preserve baseline conditions instead of fabricating noise.
- Do NOT generate globalTrigger.
- Do NOT generate character action/delta fields.
- If a scene has no meaningful changes in this window, it may be omitted.

## One-Shot Example

### Example Input (abridged)
\`\`\`json
{
  "currentGameTime": "Day 2, 18:00",
  "scenesToUpdate": [
    { "scenarioId": "SCN_5", "scenarioName": "Old Chapel" }
  ],
  "baselineSnapshots": [
    {
      "scenarioId": "SCN_5",
      "snapshot": {
        "description": "A cold chapel with cracked stained glass.",
        "clues": [],
        "conditions": [
          { "type": "lighting", "description": "Low candlelight", "mechanicalEffect": "Hard Spot Hidden" }
        ],
        "gameTime": "Day 2, 15:00"
      }
    }
  ],
  "actionTimeline": {
    "actionTimeline": [
      {
        "time": "Day 2, 16:40",
        "npcActionLogUpdates": [
          {
            "id": "npc-caretaker",
            "actionLog": [
              {
                "time": "Day 2, 16:40",
                "location": "Old Chapel",
                "summary": "Barred the west door after hearing footsteps outside"
              }
            ]
          }
        ]
      }
    ]
  }
}
\`\`\`

### Example Output
\`\`\`json
{
  "updatedSimplifiedSnapshots": [
    {
      "scenarioId": "SCN_5",
      "snapshot": {
        "id": "SCN_5_snap_004",
        "name": "Old Chapel",
        "location": "Old Chapel",
        "description": "The chapel remains bitterly cold, but the west aisle is now partially blocked by hastily stacked pews and rope, channeling movement toward the altar side.",
        "gameTime": "Day 2, 18:00",
        "clues": [
          {
            "id": "clue_chapel_rope_fibers",
            "clueText": "Fresh rope fibers and splinters suggest the west door was reinforced recently.",
            "category": "physical",
            "difficulty": "regular",
            "location": "West door frame",
            "discoveryMethod": "Spot Hidden",
            "reveals": ["T9"],
            "discovered": false
          }
        ],
        "conditions": [
          {
            "type": "other",
            "description": "West access is narrowed by improvised barricade",
            "mechanicalEffect": "Movement tests near west aisle become Hard"
          },
          {
            "type": "lighting",
            "description": "Low candlelight",
            "mechanicalEffect": "Hard Spot Hidden"
          }
        ]
      },
      "connections": [
        {
          "scenarioName": "Chapel Yard",
          "relationshipType": "leads_to",
          "description": "West door to yard",
          "blocked": true,
          "blockReason": "Caretaker reinforced west door with rope and pews"
        }
      ]
    }
  ]
}
\`\`\`

## Output JSON Schema
Return ONLY valid JSON:
\`\`\`json
{
  "updatedSimplifiedSnapshots": [
    {
      "scenarioId": "scene-id",
      "snapshot": {
        "id": "snapshot-id",
        "name": "scene name",
        "location": "scene location",
        "description": "simplified updated description",
        "gameTime": "Day X, HH:MM",
        "clues": [],
        "conditions": []
      },
      "connections": [
        {
          "scenarioName": "Other Scene",
          "relationshipType": "leads_to",
          "description": "optional",
          "blocked": false,
          "blockReason": null
        }
      ]
    }
  ]
}
\`\`\`

Notes:
- For each scene item, include \`connections\` only if you determine that the connections state changed; otherwise omit \`connections\`.

Generate now.`;
}

/**
 * Global Trigger Event Check Template - for analyzing if trigger events have occurred
 */
export function getGlobalTriggerEventCheckTemplate(): string {
  return `# Director Agent - Global Trigger Event Check & Game End Analysis

Analyze recent game events to determine if global trigger events have been fulfilled, and whether this triggers game end.

## 🎯 Global Trigger
\`\`\`json
{{globalTriggerJson}}
\`\`\`

## 🏁 End State Definition
The following defines the inevitable outcome if no intervention occurs:

\`\`\`json
{{endStateJson}}
\`\`\`

**Note**: The endState contains the pointOfNoReturn trigger. If the global trigger events align with or directly cause the point of no return to be reached, this will cause game end.

## 📋 New ActionLog Entries (Last 3 Turns)

The following are **newly added** actionLog entries from the most recent 3 turns (not all historical actionLog, only the new entries added in these turns):

\`\`\`json
{{recentActionLogsJson}}
\`\`\`

**Note**: These are only the actionLog entries that were created/added during the last 3 game turns, representing the most recent character activities.

## 🎬 Task

### Step 1: Check if Global Trigger Events Have Occurred

Determine if the events described in the global trigger have occurred based on these newly added actionLog entries.

**Evaluation:**
- Check if the new actionLog entries provide clear evidence that the trigger events have happened
- Consider logical implications (e.g., if someone left for a destination, they may have arrived)
- Be strict - only return true if there's solid evidence in the recent activities

### Step 2: Determine if This Causes Game End

If the global trigger has been triggered, determine if this causes the game to end by checking:

1. **Does the global trigger event align with the pointOfNoReturn trigger?**
   - Compare the global trigger events with the endState's pointOfNoReturn trigger
   - If the events directly fulfill or align with the point of no return condition, this causes game end

2. **Is the pointOfNoReturn condition now met?**
   - For time-based triggers: Has the time restriction been reached?
   - For condition-based triggers: Have the required conditions been fulfilled?

**Important**: 
- Not all global trigger events cause game end
- Only trigger events that directly relate to or fulfill the pointOfNoReturn cause game end
- If the global trigger is just a story progression event (e.g., "NPCs gather", "Evidence revealed") but doesn't fulfill the point of no return, it does NOT cause game end

## 📋 Output Format

Return ONLY valid JSON:

\`\`\`json
{
  "triggered": true,
  "causesGameEnd": false,
  "reason": "Event description or null if not triggered"
}
\`\`\`

**Fields:**
- **triggered**: boolean - Whether the global trigger events have occurred
- **causesGameEnd**: boolean - Whether this trigger causes the game to end (only true if triggered AND aligns with pointOfNoReturn)
- **reason**: string | null - Brief description of what triggered (e.g., "时间限制到达", "事件已完成", "Point of no return reached") or null if not triggered

*Analyze:*`;
}

/**
 * Stuck Hint Narrative Template - for when the player appears stuck
 * Injects game time, tension, current scene snapshot, scenario connections, and last 3 investigator inputs/narratives.
 * Asks the LLM to produce a short in-world hint (clues, items, places, NPCs) without direct revelation.
 */
export function getStuckHintNarrativeTemplate(): string {
  return `# Director Agent - Stuck Hint Narrative

The player appears stuck and does not know what to do next. Your task is to generate a **short in-world hint narrative** that subtly nudges them—without directly revealing solutions or secrets. The narrative must **sound natural**, **follow smoothly from the recent GM narratives above**, and read as one continuous, fluent story—not a detached hint box.

## Game State
- **Game Time**: {{gameTime}}
- **Tension**: {{tension}} / 10

## Current Scene (Full Snapshot)

\`\`\`json
{{currentSceneSnapshotJson}}
\`\`\`

## Scenario Connections

Available connections from the current scene (other locations the character could go or consider):

\`\`\`json
{{scenarioConnectionsJson}}
\`\`\`

## Recent Character Actions (Last 3 turns)

{{#if recentTurns}}
{{#each recentTurns}}
**Turn #{{this.turnNumber}}**
- Character input: "{{this.characterInput}}"
- GM narrative: {{#if this.keeperNarrative}}"{{this.keeperNarrative}}"{{else}}*none*{{/if}}

{{/each}}
{{else}}
*No recent turns*
{{/if}}

## Task

Based on the current situation (scene, connections, recent inputs and narratives), produce a **brief narrative hint** (2–4 sentences) that:

- **Output language**: Write the narrative in the **same language** as the investigator's recent inputs (see "Character input" above). If they wrote in Chinese, respond in Chinese; if in English, respond in English. Match the player's language.
- **Quantity**: Give **at most two** clue/location/NPC hints in the narrative. Do not list more than two distinct nudges; one or two is enough.
- **Tone and continuity**: Use a **natural, in-world tone**. The hint must **flow directly from the last GM narrative**—same voice, same pacing, no abrupt shift. It should feel like the next paragraph of the story, not a separate "hint" message. Keep the prose **coherent and fluent**.
- **Allowed**: Subtle hints about clues, items, locations, or NPCs—e.g. atmosphere, something worth noticing, a nudge toward a person or place. Write as in-world description (what the investigator might sense, notice, or recall), not meta-advice.
- **Not allowed**: Do NOT spell out the solution, directly reveal secrets, or tell the player what to do in plain language.

## Response

Return ONLY valid JSON in this form:

\`\`\`json
{
  "narrative": "Your hint narrative here (2-4 sentences, in-world, same language as investigator input, at most two hints)"
}
\`\`\`

*Generate the hint narrative:*`;
}
