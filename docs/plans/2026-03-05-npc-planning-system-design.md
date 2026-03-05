# NPC Planning System Design

**Date:** 2026-03-05
**Branch:** multi
**Status:** Approved

## Overview

Replace the reactive NPC model (player acts → NPC reacts) with a proactive tick-plan system. NPCs have pre-generated plans that execute autonomously as game time advances. Players and NPCs are treated as the same type of actor, both producing `CharacterAction` outputs processed by the same pipeline.

## Core Concepts

### Two-Layer NPC State

| Layer | Name | Generated | Granularity | Stored |
|---|---|---|---|---|
| 1 | `NpcLongTermIntent` | Once at game start | Multi-day goals | DB table |
| 2 | `NpcDailyPlan` | Each in-game day | Time-stamped action nodes | DB table |

Daily plans are generated at each in-game midnight, driven by the NPC's long-term intent + world state at that time.

---

## Data Structures

### CharacterAction (Unified)

Both NPC plan nodes (after execution) and player actions produce the same structure:

```typescript
interface CharacterAction {
  characterId: string;           // NPC id or player character id
  characterName: string;
  gameTime: string;              // "HH:MM"
  action: string;
  location: string;              // scenarioId where action occurs
  targetCharacterId?: string;    // optional interaction target
  type: "routine" | "movement" | "critical";
  actionType?: ActionType;       // required when type = "critical" (8 CoC categories)
  impact: 0 | 1 | 2 | 3;        // see Impact Levels below
  successEffect?: string;        // written to ScenarioCondition on success
  status: "completed" | "failed" | "skipped";
  outcome: string;               // result description
}
```

### NpcPlanNode (Pre-execution form)

```typescript
interface NpcPlanNode {
  nodeId: string;
  gameTime: string;              // "HH:MM" scheduled time
  action: string;
  location: string;              // expected scenarioId
  targetCharacterId?: string;
  type: "routine" | "movement" | "critical";
  actionType?: ActionType;       // required when type = "critical"
  impact: 0 | 1 | 2 | 3;
  successEffect?: string;
  status: "pending" | "completed" | "failed" | "skipped";
  outcome?: string;
}
```

### Impact Levels

Single field drives both observability and effect propagation. Hearing = being affected.

| impact | Who perceives & is affected | KeeperAgent injection |
|---|---|---|
| 0 | Nobody (NPC only knows) | Never |
| 1 | Target character only | Only if target is player |
| 2 | All characters in current scene | If NPC in player scene or adjacent |
| 3 | All characters globally | Always |

Examples:
- NPC reads a book alone: `impact=0`
- NPC whispers to player: `impact=1`
- NPC fires a gun: `impact=2` (everyone in scene hears and reacts)
- NPC completes summoning ritual: `impact=3`

---

## Node Type Execution Logic

### TickProcessor (pure state machine, no LLM)

```
Node becomes due (prevTime < node.gameTime <= newTime)
  → type = "routine"
       NPC at node.location? → completed
       NPC not at location?  → failed

  → type = "movement"
       Target scene blocked? → failed (trigger plan revision)
       Not blocked?          → completed, update NPC location

  → type = "critical"
       NPC at node.location?
         No  → failed
         Yes → look up ActionType → candidate skills (actionTypeSkillMap)
               use RAG (EmbeddingClient) to match action description
               against NPC's actual skills
               roll 1d100 vs matched skill value
               success → completed
               failure → failed
               has targetCharacterId?
                 Yes → also check target at location; fail if absent
```

### successEffect Application

```
status = "completed" AND successEffect present
  → append new ScenarioCondition to node.location scene
    (with timestamp + source npcId)
```

---

## Turn Execution Flow

```
Player Input
  ↓
[ActionAgent] (rewritten)
  - Resolve player action + player-NPC direct interactions
  - Advance gameTime
  - Output: CharacterAction (player)

  ↓ after gameTime advances

[TickProcessor]
  - Scan all NPC daily plans for due nodes
  - Execute each node (routine / movement / critical)
  - Apply successEffect to ScenarioConditions
  - Output: CharacterAction[] (NPCs)

  ↓

[Impact Propagation]
  For each CharacterAction (player + NPC):
    impact=1 → targetCharacterId queued for plan revision
    impact=2 → all NPCs in same scene queued for plan revision
    impact=3 → all NPCs globally queued for plan revision

  ↓

[NPCPlanningAgent.revisePlans()] — only for queued NPCs
  - Re-evaluate remaining nodes for today
  - Modify/replace pending nodes based on new world state
  - Does NOT modify completed/failed history

  ↓

[Day change check]
  gameTime crossed midnight?
    → NPCPlanningAgent.generateDailyPlans(nextDay) for all NPCs

  ↓

[KeeperAgent]
  - Player CharacterAction results
  - NPC CharacterActions where:
      impact=2 and NPC in player scene or adjacent scene
      impact=3 always
  → Narrative output
```

---

## Game Initialization

```
Game starts
  → NPCPlanningAgent.generateLongTermIntents()
      For each NPC: multi-day goal driven by truth timeline + NPC profile
      Stored in NpcLongTermIntent DB table

  → NPCPlanningAgent.generateDailyPlans(day=1)
      For each NPC: time-stamped node sequence for day 1
      Driven by long-term intent + current world state
      Stored in NpcDailyPlan DB table
```

---

## NPC Planning Agent Responsibilities

- `generateLongTermIntents(dgsm)` — one-time, all NPCs
- `generateDailyPlans(dgsm, gameDay)` — all NPCs, called at day change
- `revisePlans(dgsm, npcIds, trigger)` — targeted NPCs, called after impact propagation

Plan generation context includes:
- NPC profile (personality, goals, skills)
- Long-term intent
- Current world state (ScenarioConditions, known events)
- Recent CharacterAction history (what happened today)

For `critical` nodes, `NPCPlanningAgent` selects `actionType` based on the action description. Skill selection happens at tick time via RAG, not at plan generation time.

---

## ActionType → Skill Mapping (actionTypeSkillMap.ts)

Static mapping used by TickProcessor for critical node skill resolution:

```typescript
const ACTION_TYPE_SKILL_MAP: Record<ActionType, string[]> = {
  exploration: ["Perception", "Listen", "Research", "History", "Occult", ...],
  social:      ["Charm", "Persuade", "Intimidate", "Bluff", "Psychology", ...],
  combat:      ["Brawling", "Pistol", "Rifle", "Sword", "Axe", "Dodge", ...],
  stealth:     ["Stealth", "Sleight of Hand", "Disguise", ...],
  chase:       ["Drive Auto", "Ride", "Climb", "Jump", "Swim", ...],
  mental:      ["Psychology", "Psychoanalysis", "Occult", "Forbidden Lore", ...],
  environmental: ["Survival (Forest)", "Survival (Arctic)", "Navigate", "First Aid", ...],
  narrative:   ["Language (Own)", "Language (Other)", "Charm", "Persuade", ...],
}
```

RAG selects the best match from the NPC's actual skill values against this candidate list.

---

## Database Schema

```prisma
model NpcLongTermIntent {
  id        String   @id @default(uuid()) @db.Uuid
  sessionId String   @map("session_id")
  moduleId  String   @map("module_id") @db.Uuid
  npcId     String   @map("npc_id")
  npcName   String   @map("npc_name")
  intent    String
  createdAt DateTime @default(now()) @map("created_at")

  session   Session  @relation(fields: [sessionId], references: [sessionId], onDelete: Cascade)
  module    Module   @relation(fields: [moduleId], references: [moduleId], onDelete: Cascade)

  @@index([sessionId])
  @@map("npc_long_term_intents")
}

model NpcDailyPlan {
  id          String   @id @default(uuid()) @db.Uuid
  sessionId   String   @map("session_id")
  moduleId    String   @map("module_id") @db.Uuid
  npcId       String   @map("npc_id")
  npcName     String   @map("npc_name")
  gameDay     Int      @map("game_day")
  nodes       Json     // NpcPlanNode[]
  generatedAt DateTime @default(now()) @map("generated_at")

  session     Session  @relation(fields: [sessionId], references: [sessionId], onDelete: Cascade)
  module      Module   @relation(fields: [moduleId], references: [moduleId], onDelete: Cascade)

  @@unique([sessionId, npcId, gameDay])
  @@index([sessionId, gameDay])
  @@map("npc_daily_plans")
}
```

`nodes` stored as JSON array (4–8 nodes per NPC per day). Whole plan read/written together, no row-level JOIN needed.

---

## Files Changed

### New Files
```
src/dynamicworldagent/dynamicBasicAgent/npcPlanning/
├── NPCPlanningAgent.ts      # LLM: generate intents, daily plans, revise plans
├── NPCPlanningTemplate.ts   # prompt templates
├── actionTypeSkillMap.ts    # static ActionType → skills mapping
└── tickProcessor.ts         # pure state machine, no LLM calls
```

### Rewritten
- `action/actionAgent.ts` — output `CharacterAction`, handle player-NPC interactions, remove passive NPC response generation

### Modified
- `state/DynamicGameState.ts` — remove `heartbeatActions`, no in-memory plan storage (plans live in DB)
- `prisma/schema.prisma` — add `NpcLongTermIntent`, `NpcDailyPlan` tables
- `director/directorAgent.ts` — major simplification: remove NPC timeline generation, scene snapshot generation, global RAG trigger checks; keep only game ending condition checks

### Deleted
- `heartbeat/heartbeatAgent.ts`

---

## What DirectorAgent No Longer Does

| Removed | Replaced by |
|---|---|
| NPC action timeline generation | NPCPlanningAgent daily plans |
| Scene entry snapshot generation | NPC locations read from plan state |
| Global trigger RAG checks | `impact=3` node execution (explicit, not inferred) |
| Heartbeat evaluation | TickProcessor |

**DirectorAgent retains:** game ending condition checks only.
