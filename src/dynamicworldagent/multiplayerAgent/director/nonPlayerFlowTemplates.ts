/**
 * Director templates for Non-Player Scene Update flow.
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
- Do NOT generate a minute-by-minute timeline.
- \`actionTimeline\` is event-driven: create a time bucket only when at least one NPC performs a meaningful action.
- Time gaps between buckets are flexible and should vary naturally based on when actions actually happen.
- You MAY reason in 5-minute checks across the window to decide whether any NPC acts at that period.
- If no NPC performs a meaningful action at a checked period, do NOT output a bucket for that period.
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
- Global Trigger (REQUIRED):
  - You MUST evaluate and output a globalTrigger field based on the NPC action timeline and endState progression.
  - Generate a new globalTrigger if there are significant future events or time-sensitive developments ahead.
  - If no significant upcoming events exist, omit the globalTrigger field entirely — the system will clear the previous one.
- Global Trigger Guidance:
  - Progressive Escalation:
    - Analyze endState event chain toward catastrophe.
    - Identify where previousGlobalTrigger (if any) sits in that chain.
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
  ],
  "globalTrigger": {
    "timeRestriction": "Day 4, 01:00",
    "timeReason": "Ritual couriers scheduled to assemble at the pier office for final preparations",
    "events": ["Ritual couriers assemble at the pier office"],
    "eventReasons": ["Signals transition from concealment to active ritual execution"]
  }
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
- statusDelta and inventoryDelta are optional and must be incremental only.
- SuddenActionLogs is optional. If present, each NPC entry must contain only \`id\`, \`name\`, \`actionLog\` and exactly one in-window action in player's current scene.
- globalTrigger can be omitted when no significant future events are identified.

Generate now.`;
}

/**
 * Scene Switch Phase 2 Template - Generate target scene snapshot + optional global trigger
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

export function getNonPlayerBackgroundSimplifiedSnapshotsTemplate(): string {
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
