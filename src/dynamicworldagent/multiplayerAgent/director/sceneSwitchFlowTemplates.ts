/**
 * Director templates for Action-driven Scene Switch flow.
 */
export function getNpcActionTimelineTemplate(): string {
  return `# Director Agent - Scene Switch Phase 1 (All NPC Action Timeline)

Generate action timeline updates for all NPCs for the current scene switch.

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
- These NPCs include all NPCs in the session.
- Use exact NPC id/name from input.

\`\`\`json
{{phase1NpcsJson}}
\`\`\`

## Hard Rules
- Generate world progression action timeline for all NPCs.
- Actions must follow knowledge/goals/personality/secrets and remain coherent across NPCs.
- Actions must be time-sequenced, realistic, and within the time window.
- Base actions on the NPC's goals, personality, and secrets (from full profile + knowledge matrix).
- Actions should be chronologically ordered with specific times progressing toward current game time.
- Do NOT generate a minute-by-minute timeline.
- \`actionTimeline\` is event-driven: create a time bucket only when at least one NPC performs a meaningful action.
- Time gaps between buckets are flexible and should vary naturally based on when actions actually happen.
- You MAY reason in 5-minute checks across the window to decide whether any NPC acts at that period.
- If no NPC performs a meaningful action at a checked period, do NOT output a bucket for that period.
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
- For each NPC, every generated actionLog time MUST be strictly later than that NPC's latest existing actionLog time.
- Never output any actionLog entry at or before that NPC's latest existing actionLog time.
- For \`actionTimeline\` buckets, \`actionLog\` entries can omit \`time\`; backend will use the parent bucket \`time\`.

## One-Shot Example

### Example Input (abridged)
\`\`\`json
{
  "previousSnapshotTime": "Day 3, 20:00",
  "currentGameTime": "Day 3, 22:00",
  "playerCurrentScene": { "id": "SCN_4", "name": "Starlight Pier & Reception", "location": "Starlight Pier & Reception" },
  "previousGlobalTrigger": {
    "timeRestriction": "Day 4, 01:00",
    "events": ["Ritual couriers assemble at the pier office"]
  },
  "phase1Npcs": [
    {
      "id": "npc-harbor-foreman",
      "name": "Mason Pike",
      "goals": ["Keep shipment routes hidden", "Delay investigators"],
      "personality": "Controlling, suspicious"
    },
    {
      "id": "npc-night-clerk",
      "name": "Elias Voss",
      "goals": ["Report investigator movement to cult handlers"],
      "personality": "Nervous, evasive"
    }
  ],
}
\`\`\`

### Example Output
\`\`\`json
{
  "actionTimeline": [
    {
      "time": "Day 3, 20:35",
      "npcActionLogUpdates": [
        {
          "id": "npc-night-clerk",
          "actionLog": [
            {
              "location": "Pier Office",
              "summary": "Copied dock ledger pages naming tonight's courier meeting and hid them inside the office stove"
            }
          ]
        },
        {
          "id": "npc-harbor-foreman",
          "actionLog": [
            {
              "location": "Pier Office",
              "summary": "Was informed by Elias Voss that ledger pages were removed and ordered immediate containment of shipping records"
            }
          ]
        }
      ]
    },
    {
      "time": "Day 3, 21:15",
      "npcActionLogUpdates": [
        {
          "id": "npc-harbor-foreman",
          "actionLog": [
            {
              "location": "Pier Office",
              "summary": "Locked the rear records cabinet and removed the manifest key to slow investigator access"
            }
          ],
          "inventoryDelta": {
            "add": [{ "name": "manifest key", "quantity": 1 }]
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
 * Non-Player Phase 1 Template - Generate background NPC timeline + sudden ingress
 */

export function getTargetSnapshotFromTimelineTemplate(): string {
  return `# Director Agent - Scene Switch Phase 2 (Target Snapshots + Optional Global Trigger)

Generate COMPLETE snapshots for ALL target scenes listed below, plus an optional global trigger.

## Current Game Time
- Day: {{currentGameDay}}
- Time: {{currentTimeOfDay}}

## Time Window
- previousSnapshotTime: {{previousSnapshotTime}}
- currentGameTime: {{currentGameTime}}

## Target Scenes
\`\`\`json
{{targetScenesJson}}
\`\`\`

## Target Scenes Baseline Snapshots (previous, one per target)
\`\`\`json
{{targetBaselineSnapshotsJson}}
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
- Generate one entry in the \`targetSnapshots\` array for EACH target scene listed above.
- Each entry must be a COMPLETE, DETAILED snapshot with all required fields.
- Each snapshot must include: description, gameTime, characters, clues, conditions, keeperNotes, showMap (if needed), and optional connections update.
- description must be full atmospheric narrative including lighting, sounds, smells, weather, ambiance, and what happened in the time window.
- characters must be generated from currentGameTime + actionTimeline in this window, deciding who is currently present in each target scene.
- each character item in snapshot.characters must contain:
  - id
  - name
  - role
  - status
  - location
  - notes
- clues must be full ScenarioClue objects (id, clueText, category, difficulty, location, discoveryMethod, reveals, discovered, discoveryDetails when applicable).
- conditions must be full ScenarioCondition objects (type, description, mechanicalEffect when applicable).
- keeperNotes should include concise GM-facing notes about scene progression and hidden implications.
- clues and conditions must be inferred from BOTH NPC timeline + player action log in this window.
- Scenario Connections Update per Target Scene (CRITICAL):
  - Based on action timeline, determine whether each target scene's connections changed.
  - Consider whether NPC actions logically unlocked/locked doors, opened/closed passages, or discovered/blocked paths.
  - Consider time-based deterioration (e.g., collapsed paths, weakened bridges) and environmental incidents from scene events (e.g., fire, flooding, barricades).
  - Use blocked=true when a connection is physically blocked/locked.
  - Provide blockReason when blocked is true (clear concrete reason).
  - Output \`connections\` ONLY if you determine that the connections state changed; otherwise omit the field.
- Global Trigger (Optional, ONE for all targets):
  - You MAY generate ONE globalTrigger for future story progression based on:
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
  "targetScenes": [
    { "scenarioId": "SCN_3", "scenarioName": "Harbor Warehouse", "location": "Harbor Warehouse", "connections": [] },
    { "scenarioId": "SCN_5", "scenarioName": "Old Chapel", "location": "Old Chapel", "connections": [] }
  ],
  "targetBaselineSnapshots": [
    { "scenarioId": "SCN_3", "snapshot": { "description": "A damp warehouse with sealed crates.", "clues": [], "conditions": [{ "type": "lighting", "description": "Dim bulbs" }] } },
    { "scenarioId": "SCN_5", "snapshot": { "description": "A cold chapel with cracked stained glass.", "clues": [], "conditions": [] } }
  ],
  "actionTimeline": {
    "actionTimeline": [
      {
        "time": "Day 2, 17:20",
        "npcActionLogUpdates": [
          {
            "id": "npc-dock-foreman",
            "actionLog": [{ "time": "Day 2, 17:20", "location": "Harbor Warehouse", "summary": "Locked the south shutter" }]
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
  "targetSnapshots": [
    {
      "scenarioId": "SCN_3",
      "snapshot": {
        "id": "SCN_3_snap_002",
        "name": "Harbor Warehouse",
        "location": "Harbor Warehouse",
        "description": "The warehouse air is thick with diesel and seawater. A newly secured south shutter rattles in the wind.",
        "gameTime": "Day 2, 18:00",
        "showMap": false,
        "characters": [
          { "id": "npc-dock-foreman", "name": "Mason Pike", "role": "other", "status": "alive", "location": "Harbor Warehouse", "notes": "Patrolling near the south shutter." }
        ],
        "clues": [
          { "id": "clue_warehouse_ledger", "clueText": "A wet shipping ledger.", "category": "document", "difficulty": "regular", "location": "Office desk drawer", "discoveryMethod": "Investigation", "reveals": ["T7"], "discovered": false }
        ],
        "conditions": [
          { "type": "lighting", "description": "Two bulbs are out.", "mechanicalEffect": "Hard (-20%) Spot Hidden near shutter" }
        ],
        "keeperNotes": "The shutter lock indicates premeditated containment."
      },
      "connections": [
        { "scenarioName": "Harbor Pier", "relationshipType": "leads_to", "description": "South shutter access", "blocked": true, "blockReason": "Foreman locked the south shutter" }
      ]
    },
    {
      "scenarioId": "SCN_5",
      "snapshot": {
        "id": "SCN_5_snap_003",
        "name": "Old Chapel",
        "location": "Old Chapel",
        "description": "The chapel remains bitterly cold. Fading candlelight casts long shadows across the stone floor.",
        "gameTime": "Day 2, 18:00",
        "showMap": false,
        "characters": [],
        "clues": [],
        "conditions": [
          { "type": "lighting", "description": "Low candlelight", "mechanicalEffect": "Hard Spot Hidden" }
        ],
        "keeperNotes": "No significant changes since last visit."
      }
    }
  ],
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
  "targetSnapshots": [
    {
      "scenarioId": "target-scene-id",
      "snapshot": {
        "id": "snapshot-id",
        "name": "scene name",
        "location": "scene location",
        "description": "updated scene description",
        "gameTime": "Day X, HH:MM",
        "showMap": false,
        "characters": [
          { "id": "npc-id", "name": "NPC Name", "role": "other", "status": "alive", "location": "scene location", "notes": "brief note" }
        ],
        "clues": [],
        "conditions": [],
        "keeperNotes": "optional notes"
      },
      "connections": [
        { "scenarioName": "Other Scene", "relationshipType": "leads_to", "description": "optional", "blocked": false, "blockReason": null }
      ]
    }
  ],
  "globalTrigger": {
    "timeRestriction": "Day X, HH:MM",
    "timeReason": "reason",
    "events": ["event1", "event2"],
    "eventReasons": ["reason1", "reason2"]
  }
}
\`\`\`

Notes:
- \`targetSnapshots\` array must have exactly one entry per target scene from the input.
- Per-scene \`connections\` only when changed; otherwise omit.
- globalTrigger is optional and shared across all targets; omit if no significant upcoming events.
- Do not output extra fields.

Generate now.`;
}

/**
 * Non-Player Phase 2 Template - Update current scene snapshot from sudden logs and NPC reactions
 */

export function getSceneSwitchBackgroundSimplifiedSnapshotsTemplate(): string {
  return `# Director Agent - Scene Switch Phase 3 (Background Simplified Snapshots)

Generate simplified snapshots only for scenes listed in "Scenes To Update".

## Current Game Time
- Day: {{currentGameDay}}
- Time: {{currentTimeOfDay}}

## Time Window
- previousSnapshotTime: {{previousSnapshotTime}}
- currentGameTime: {{currentGameTime}}

## Scenes To Update
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
- Update ONLY scenes provided in "Scenes To Update".
- Treat "Scenes To Update" as pre-filtered by system logic (it may exclude target/current scene depending on caller).
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
