/**
 * Scene Switch Phase 1 Template - Generate all-NPC action timeline
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
export function getNpcActionTimelineWithPlayerSceneIngressTemplate(): string {
  return `# Director Agent - Non-Player Phase 1 (Background NPC Timeline + Sudden Ingress)

Generate background NPC action timeline updates, and you MAY additionally output a separate \`SuddenActionLogs\` set.

## Current Game Time
- Day: {{currentGameDay}}
- Time: {{currentTimeOfDay}}

## Time Window
- previousSnapshotTime: {{previousSnapshotTime}}
- currentGameTime: {{currentGameTime}}

## Global Trigger Reference
{{#if previousGlobalTrigger}}
\`\`\`json
{{previousGlobalTriggerJson}}
\`\`\`
{{else}}
null
{{/if}}

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
- Consider globalTrigger when generating actions; the related NPC actions should intent to behave around the globalTrigger events. Towards or against the globalTrigger events.
- If an event clearly maps to specific NPCs, those NPCs should prioritize preparatory or advancing actions toward that event.
- Do not force impossible behavior just to match globalTrigger; keep movement, knowledge, and motivation constraints valid.
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
- OPTIONAL extra output: \`SuddenActionLogs\`
  - This field is OPTIONAL.
  - Use it only when a background NPC should enter player's current scene at the current game time.
  - Each SuddenActionLogs item must contain ONLY: \`id\`, \`name\`, \`actionLog\`.
  - Each selected NPC must:
    - realistically move into player's current scene, and
    - perform exactly one impactful action there.
  - Keep it coherent with goals/personality/secrets/knowledge/globalTrigger.

## One-Shot Example

### Example Input (abridged)
\`\`\`json
{
  "previousSnapshotTime": "Day 2, 13:00",
  "currentGameTime": "Day 2, 16:00",
  "playerCurrentScene": { "name": "Town Hall", "location": "Town Hall" },
    "previousGlobalTrigger": {
    "timeRestriction": "Day 4, 01:00",
    "events": ["Ritual couriers assemble at the pier office"]
  },
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
  ],
  "SuddenActionLogs": [
    {
      "id": "npc-jack-harper",
      "name": "Jack Harper",
      "actionLog": [
        {
          "time": "Day 2, 15:50",
          "location": "Town Hall",
          "summary": "Entered Town Hall and publicly accused the investigators of evidence tampering to pressure nearby witnesses"
        }
      ]
    },
    {
      "id": "npc-dr-chen",
      "name": "Dr. Chen",
      "actionLog": [
        {
          "time": "Day 2, 15:50",
          "location": "Town Hall",
          "summary": "Entered Town Hall and demanded immediate closure of the records wing to block investigator access"
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
  ],
  "SuddenActionLogs": [
    {
      "id": "npc-id",
      "name": "NPC Name",
      "actionLog": [
        {
          "time": "Day X, HH:MM",
          "location": "player current scene location",
          "summary": "entered player scene and performed one impactful action"
        }
      ]
    }
  ]
}
\`\`\`

Notes:
- statusDelta and inventoryDelta are optional and must be incremental only.
- SuddenActionLogs is optional. If present, each NPC entry must contain only \`id\`, \`name\`, \`actionLog\` and exactly one in-window action in player's current scene.
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
- targetSnapshot must include: description, gameTime, characters, clues, conditions, keeperNotes, showMap (if needed), and optional connections update.
- description must be full atmospheric narrative including lighting, sounds, smells, weather, ambiance, and what happened in the time window.
- characters must be generated from currentGameTime + actionTimeline in this window, deciding who is currently present in target scene.
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
      "characters": [
        {
          "id": "npc-dock-foreman",
          "name": "Mason Pike",
          "role": "other",
          "status": "alive",
          "location": "Harbor Warehouse",
          "notes": "Patrolling near the south shutter with a ring of heavy keys, watching every movement."
        }
      ],
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
      "characters": [
        {
          "id": "npc-id",
          "name": "NPC Name",
          "role": "other",
          "status": "alive",
          "location": "scene location",
          "notes": "brief scene-presence note"
        }
      ],
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
 * Non-Player Phase 2 Template - Update current scene snapshot from sudden logs and NPC reactions
 */
export function getCurrentSceneReactionSnapshotTemplate(): string {
  return `# Director Agent - Non-Player Phase 2 (Current Scene Reaction Snapshot)

Generate an updated COMPLETE snapshot for the current player scene, driven by sudden ingress logs and in-scene NPC reactions.

## Current Game Time
- Day: {{currentGameDay}}
- Time: {{currentTimeOfDay}}

## Time Window
- previousSnapshotTime: {{previousSnapshotTime}}
- currentGameTime: {{currentGameTime}}

## Current Scene
\`\`\`json
{{currentSceneJson}}
\`\`\`

## Current Scene Baseline Snapshot (previous)
\`\`\`json
{{currentBaselineSnapshotJson}}
\`\`\`

## SuddenActionLogs (from Phase 1)
\`\`\`json
{{suddenActionLogsJson}}
\`\`\`

## Current Scene NPC Full Profiles
\`\`\`json
{{currentSceneNpcProfilesJson}}
\`\`\`

## Hard Rules
- Update ONLY the current scene snapshot.
- Focus on immediate in-scene consequences of SuddenActionLogs and how present NPCs react.
- Generate a COMPLETE snapshot with fields:
  - description
  - characters
  - clues
  - conditions
  - keeperNotes
- characters must be generated from currentGameTime + suddenActionLogs in this window, deciding who is present in current scene.
- \`snapshot.characters\` must be present and include scene-presence fields per character:
  - id
  - name
  - role
  - status
  - location
  - notes
- clues must be full ScenarioClue objects (id, clueText, category, difficulty, location, discoveryMethod, reveals, discovered, discoveryDetails when applicable).
- clues should be inferred from: current baseline snapshot + suddenActionLogs + reactionNpcActionLogUpdates + current scene NPC reactions in this window.
- conditions must be full ScenarioCondition objects (type, description, mechanicalEffect when applicable).
- conditions should reflect environmental/mechanical changes caused by sudden intrusion and NPC reactions (e.g., lighting, access pressure, hazards, crowd panic, barricades).
- If no meaningful clue/condition changes occurred, preserve baseline clues/conditions instead of fabricating noise.
- Output reaction NPC actions separately in \`reactionNpcActionLogUpdates\`.
- Each reaction actionLog entry must include:
  - time: "Day X, HH:MM"
  - location
  - summary
- Reaction action logs must:
  - be in the time window (previousSnapshotTime, currentGameTime],
  - happen in current scene,
  - be impactful and coherent with goals/personality/knowledge.
- If an action has a target, include target in summary.
- If no meaningful reaction happened, output empty \`reactionNpcActionLogUpdates\` and keep snapshot changes minimal.
- Connection updates are optional:
  - Output \`currentSceneUpdate.connections\` ONLY when connection state changed in this window.
  - Use \`blocked\` and \`blockReason\` when relevant.
- Do NOT generate globalTrigger.

## One-Shot Example

### Example Input (abridged)
\`\`\`json
{
  "previousSnapshotTime": "Day 2, 17:00",
  "currentGameTime": "Day 2, 18:00",
  "currentScene": {
    "scenarioId": "SCN_3",
    "scenarioName": "Harbor Warehouse",
    "location": "Harbor Warehouse"
  },
  "currentBaselineSnapshot": {
    "description": "A damp warehouse with sealed crates and a salt-heavy air.",
    "characters": [],
    "clues": [],
    "conditions": [
      {
        "type": "lighting",
        "description": "Dim bulbs",
        "mechanicalEffect": "Hard to notice details"
      }
    ]
  },
  "suddenActionLogs": {
    "SuddenActionLogs": [
      {
        "id": "npc-dock-foreman",
        "name": "Mason Pike",
        "actionLog": [
          {
            "time": "Day 2, 17:20",
            "location": "Harbor Warehouse",
            "summary": "Entered Harbor Warehouse and locked the south shutter to delay witnesses"
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
  "currentSceneUpdate": {
    "scenarioId": "SCN_3",
    "snapshot": {
      "id": "SCN_3_snap_003",
      "name": "Harbor Warehouse",
      "location": "Harbor Warehouse",
      "description": "The warehouse air is thick with diesel and seawater. A newly secured south shutter rattles in the wind, forcing movement through the narrow east aisle where fresh boot marks cut across spilled salt.",
      "gameTime": "Day 2, 18:00",
      "characters": [
        {
          "id": "npc-dock-foreman",
          "name": "Mason Pike",
          "role": "other",
          "status": "alive",
          "location": "Harbor Warehouse",
          "notes": "Patrolling near the south shutter with a ring of heavy keys, watching every movement."
        }
      ],
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
      "keeperNotes": "The shutter lock creates controlled access, signaling deliberate containment inside the warehouse."
    },
    "connections": [
      {
        "scenarioName": "Harbor Pier",
        "relationshipType": "leads_to",
        "description": "South shutter access to pier",
        "blocked": true,
        "blockReason": "Dock foreman locked the south shutter from inside"
      }
    ]
  },
  "reactionNpcActionLogUpdates": [
    {
      "id": "npc-dock-foreman",
      "name": "Mason Pike",
      "actionLog": [
        {
          "time": "Day 2, 17:35",
          "location": "Harbor Warehouse",
          "summary": "Warned nearby workers away from the shutter corridor and redirected foot traffic to preserve the lock-down"
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
  "currentSceneUpdate": {
    "scenarioId": "current-scene-id",
    "snapshot": {
      "id": "snapshot-id",
      "name": "scene name",
      "location": "scene location",
      "description": "updated scene description",
      "gameTime": "Day X, HH:MM",
      "characters": [
        {
          "id": "npc-elias-thorne",
          "name": "Elias Thorne",
          "role": "other",
          "status": "alive",
          "location": "Royal Deep Blue Villa",
          "notes": "Standing guard outside the villa door with a tactical shotgun, enforcing the quarantine and watching the shadows aggressively."
        }
      ],
      "clues": [
        {
          "id": "clue-id",
          "clueText": "clue text",
          "category": "document",
          "difficulty": "regular",
          "location": "specific location",
          "discoveryMethod": "Investigation",
          "reveals": ["T7"],
          "discovered": false
        }
      ],
      "conditions": [
        {
          "type": "lighting",
          "description": "environmental change",
          "mechanicalEffect": "mechanical impact"
        }
      ],
      "keeperNotes": "optional keeper notes"
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
  "reactionNpcActionLogUpdates": [
    {
      "id": "npc-id",
      "name": "NPC Name",
      "actionLog": [
        {
          "time": "Day X, HH:MM",
          "location": "current scene location",
          "summary": "reaction action and impact"
        }
      ]
    }
  ]
}
\`\`\`

Notes:
- \`currentSceneUpdate.connections\` is optional and should be omitted when unchanged.
- \`reactionNpcActionLogUpdates\` can be empty.
- Do not output extra fields.

Generate now.`;
}

/**
 * Scene Switch Phase 3 Template - Generate simplified snapshots for non-target scenes in background
 */
export function getBackgroundSimplifiedSnapshotsTemplate(): string {
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
