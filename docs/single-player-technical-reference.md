# CoC AI Agent — Single-Player Technical Reference

> Last updated: 2026-02-27

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Agent Pipeline](#2-agent-pipeline)
3. [Graph Nodes & Routing](#3-graph-nodes--routing)
4. [Game State (DynamicGameState)](#4-game-state-dynamicgamestate)
5. [Agent Details](#5-agent-details)
6. [Combat System](#6-combat-system)
7. [Heartbeat System](#7-heartbeat-system)
8. [Time & Fatigue System](#8-time--fatigue-system)
9. [Scene Management & Transitions](#9-scene-management--transitions)
10. [Dynamic World System](#10-dynamic-world-system)
11. [RAG System](#11-rag-system)
12. [World Builder (AI Module Generation)](#12-world-builder-ai-module-generation)
13. [Scene Image & Map Generation](#13-scene-image--map-generation)
14. [Checkpoint / Save System](#14-checkpoint--save-system)
15. [Server API Reference](#15-server-api-reference)
16. [WebSocket Events](#16-websocket-events)
17. [Frontend UI](#17-frontend-ui)
18. [LLM Model Strategy](#18-llm-model-strategy)

---

## 1. System Overview

CoC AI Agent is a multi-agent AI Game Master for Call of Cthulhu 7th Edition tabletop RPG. The single-player mode processes player text input through a sequential pipeline of 6+ specialized AI agents, resolving game mechanics (dice rolls, skill checks, combat, scene transitions) and generating narrative prose.

**Tech Stack:** TypeScript, LangGraph, LangChain, PostgreSQL (Prisma), React, Express, WebSocket

**Key Design Principles:**
- Truth-first world generation — objective events exist before character knowledge
- Dynamic scenarios — LLM generates and updates scene snapshots as the world evolves
- Dice-constrained narrative — all narrative must obey pre-rolled dice outcomes
- Per-turn agent pipeline — each player turn runs a complete agent graph

---

## 2. Agent Pipeline

```
Player Input → Entry → Orchestrator → Memory → Action → Director → Game End Check → Keeper → RAG Recorder → END
```

| Agent | Model | Role |
|-------|-------|------|
| Entry | None | Clear per-turn state, evaluate heartbeats |
| Orchestrator | SMALL | Classify action intent, detect scene change requests |
| Memory | None | Enrich context via RAG + rules injection |
| Action | MEDIUM | Execute mechanics: dice, HP/SAN updates, combat entry, rest, heartbeats |
| Director | MEDIUM | Handle scene transitions, worldline updates, game-end checks |
| Keeper | MEDIUM | Generate narrative prose, reveal clues, update tension |
| RAG Recorder | None | Index completed turn for future retrieval |

Combat introduces 4 additional nodes (see [Section 6](#6-combat-system)).

---

## 3. Graph Nodes & Routing

**File:** `src/dynamicworldagent/graph/dynamicGraph.ts`

### 3.1 Full Node List

| Node | Purpose |
|------|---------|
| `entry` | Clear temp state, evaluate heartbeats, increment turn counter |
| `orchestrator` | Analyze player intent → ActionAnalysis + SceneChangeRequest |
| `memory` | Enrich context (RAG retrieval, action rules, conversation history) |
| `skillSelectionCheck` | Check if skill selection interrupt is needed |
| `skillSelectionRequired` | LangGraph `interrupt()` — pause graph, wait for player skill choice |
| `action` | Execute action: dice rolls, state updates, combat entry, rest |
| `director` | Handle scene transition, worldline update |
| `gameEndCheck` | Check HP/SAN/victory/global-trigger game-end conditions |
| `keeper` | Generate narrative, process clue revelations |
| `epilogueKeeper` | Generate game ending epilogue |
| `combatActionA` | Resolve player attack or defense (dice + state) |
| `combatEndCheck` | Check combat-end conditions |
| `combatBattleKeeper` | Generate combat victory narrative |
| `exitCombatAndRecord` | Exit combat state, record defeated NPCs |
| `combatActionB` | Generate NPC attack declarations |
| `combatNpcRecordAndEnd` | Complete combat round record |
| `ragRecorder` | Fire-and-forget RAG indexing |

### 3.2 Routing Logic

**Normal turn:**
```
START → entry → orchestrator → memory → skillSelectionCheck → action → director → gameEndCheck → keeper → ragRecorder → END
```

**Skill selection interrupt:**
```
… → skillSelectionCheck → skillSelectionRequired (INTERRUPT)
// Client provides selectedSkill, resumes:
START → entry (preserve state) → memory → skillSelectionCheck → action → …
```

**Ongoing combat turn:**
```
START → entry → memory → skillSelectionCheck → combatActionA → combatEndCheck → combatActionB → combatNpcRecordAndEnd → ragRecorder → END
```

**Combat victory:**
```
combatEndCheck → combatBattleKeeper → exitCombatAndRecord → ragRecorder → END
```

**Player death/insanity in combat:**
```
combatEndCheck → gameEndCheck → epilogueKeeper → ragRecorder → END
```

**Game end (normal play):**
```
gameEndCheck → epilogueKeeper → ragRecorder → END
```

### 3.3 Routing Conditions

| From | Condition | To |
|------|-----------|-----|
| `entry` | `isBattle` | `memory` |
| `entry` | `resumeFromInterrupt` | `memory` |
| `entry` | Default | `orchestrator` |
| `skillSelectionCheck` | `isBattle` | `combatActionA` |
| `skillSelectionCheck` | `requiresSkillSelection && !selectedSkill` | `skillSelectionRequired` |
| `skillSelectionCheck` | Default | `action` |
| `action` | `isBattle && round===1 && justEnteredCombat` | `combatActionB` |
| `action` | Default | `director` |
| `combatEndCheck` | `hp<=0 \|\| sanity<=0` | `gameEndCheck` |
| `combatEndCheck` | `combatEnded===true` | `combatBattleKeeper` |
| `combatEndCheck` | Default | `combatActionB` |
| `combatActionB` | `combatEnded===true` | `exitCombatAndRecord` |
| `combatActionB` | Default | `combatNpcRecordAndEnd` |
| `gameEndCheck` | `gameEnding.isEnded` | `epilogueKeeper` |
| `gameEndCheck` | Default | `keeper` |

---

## 4. Game State (DynamicGameState)

**File:** `src/dynamicworldagent/state/DynamicGameState.ts`

### 4.1 Core Fields

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Session identifier |
| `gameDay` | `number` | In-game day number (starts at 1) |
| `timeOfDay` | `string` | In-game time `"HH:MM"` |
| `tension` | `number` | Tension level 1-10, drives progression threshold |
| `isBattle` | `boolean` | Active combat flag |
| `combatState` | `CombatState \| null` | Round counter, participant NPCs, pending NPC actions |
| `currentScenario` | `DynamicScenarioSnapshot \| null` | Player's current scene |
| `playerCharacter` | `DynamicCharacterProfile` | Player: attributes, status, skills, inventory, actionLog |
| `npcCharacters` | `DynamicNPCProfile[]` | All NPCs in the world |
| `discoveredClues` | `DiscoveredClue[]` | Clues the player has found |
| `heartbeatActions` | `HeartbeatAction[]` | Scheduled NPC future actions |
| `gameEnding` | `GameEndingInfo \| null` | Game-end info: type, reason |
| `turnsInCurrentScene` | `number` | Turns since last scene change |
| `staminaState` | `{ minutesSinceLastRest, fatigueActive, fatigueStartedAtGameTime }` | Fatigue tracking |
| `scenarioTimeState` | `{ sceneStartTime, playerTimeConsumption }` | Per-scene time tracking |
| `defeatedNpcHistory` | `DefeatedNpcHistoryEntry[]` | Persistent defeat records |

### 4.2 Dynamic World Fields (Keeper-side)

| Field | Type | Description |
|-------|------|-------------|
| `moduleName` | `string` | Module identifier |
| `moduleDigest` | `ModuleDigest \| null` | Module metadata: background, guidance, global trigger |
| `macroScene` | `MacroSceneStructure \| null` | World map / scene connectivity |
| `truthTimeline` | `TruthEvent[]` | Objective events (hidden from player) |
| `knowledgeMatrix` | `KnowledgeHolder[]` | Who knows what truth events |
| `redHerrings` | `RedHerring[]` | False leads |
| `mythosEvents` | `MythosEvent[]` | Lovecraftian horror events |
| `endState` | `EndStateDefinition \| null` | Victory/failure/point-of-no-return conditions |
| `scenarioOutlines` | `ScenarioOutline[]` | All scene definitions with connections |
| `revealedTruthEvents` | `Set<string>` | Truth event IDs exposed to player |
| `activatedKnowledgeHolders` | `Set<string>` | Activated knowledge holder IDs |
| `deployedRedHerrings` | `Set<string>` | Used red herring IDs |
| `mythosRevelations` | `Set<string>` | Revealed mythos event indices |
| `pointOfNoReturnReached` | `boolean` | Whether the point of no return was hit |
| `globalTrigger` | `object \| null` | Active global event trigger |
| `updatedDynamicScenarioSnapshots` | `Map<string, DynamicScenarioSnapshot[]>` | Latest snapshots (max 2 in memory, older to DB) |

### 4.3 Temporary Info (per-turn, cleared at entry)

| Field | Type | Description |
|-------|------|-------------|
| `currentActionAnalysis` | `ActionAnalysis \| null` | Orchestrator output |
| `actionResults` | `ActionResult[]` | Action agent outputs (max 10) |
| `actionResultsDetailed` | `Record<string, unknown>[]` | Full LLM outputs |
| `npcResponseAnalyses` | `NPCResponseAnalysis[]` | Character agent outputs |
| `sceneChangeRequest` | `SceneChangeRequest \| null` | Scene change from orchestrator |
| `previousScenario` | `DynamicScenarioSnapshot \| null` | Saved for keeper transition context |
| `rules` | `string[]` | Action-type rules injected this turn |
| `contextualData` | `Record<string, any>` | Flexible per-turn scratch pad |

---

## 5. Agent Details

### 5.1 OrchestratorAgent

**File:** `src/dynamicworldagent/dynamicBasicAgent/orchestrator/orchestratorAgent.ts`

**Purpose:** Classify player intent and detect scene change requests.

**Output — ActionAnalysis:**
```typescript
{
  character: string,        // Who is acting
  action: string,           // What they're doing
  actionType: ActionType,   // One of 8 CoC action types
  target: {
    name: string | null,    // Target NPC/object
    intent: string          // Player's intent toward target
  },
  requiresSkillSelection: boolean
}
```

**8 Action Types:** `exploration`, `social`, `combat`, `stealth`, `chase`, `mental`, `environmental`, `narrative`

**Scene Change Detection:**
- Reads `scenarioOutlines[].connections[]` to find valid movement targets
- Enriches connections with `scenarioName`, `scenarioId`, `blocked`, `blockReason`
- If player intends to move, outputs `SceneChangeRequest { shouldChange, targetSceneName, reason }`

**Context Retrieval (before LLM call):**
- Last 3 completed turns via `extractRecentConversationHistory()`
- Hybrid RAG retrieval via `retrieveRelevantHistory()` — results stored in `contextualData` for downstream reuse

### 5.2 ActionAgent

**File:** `src/dynamicworldagent/dynamicBasicAgent/action/actionAgent.ts`

**Purpose:** Execute game mechanics — the most complex agent (~1870 lines).

**Output:**
```typescript
{
  diceUsed: string[],                    // "Skill (value%): rolled X → level"
  actionLog: ActionLogEntry[],           // Time/location/summary per character
  stateUpdate: {                         // HP/SAN/condition deltas
    playerCharacter?: { status?: {...} },
    npcCharacters?: Array<{ id, name, status?, inventory?, relationships? }>
  },
  timeElapsedMinutes: number,
  timeConsumption: "instant"|"short"|"medium"|"long"|"very long",
  summary: string,
  scenarioUpdate?: { ... },              // Scene condition changes (no clues)
  sceneChange?: { shouldChange, targetSceneName, reason },
  entersCombat?: boolean,
  combatParticipantIds?: string[],
  combatInitiatedBy?: "player"|"npc",
  openingPendingNpcActions?: PendingNpcAction[],
  npcResponses?: NpcInlineResponse[],    // NPC reactions resolved inline
  heartbeatActions?: HeartbeatAction[],  // Scheduled future NPC actions
  relationshipChanges?: RelationshipChange[]
}
```

**Key Features:**

1. **Pre-rolled Dice** — Before the LLM call, deterministic dice are rolled and injected into the prompt so the LLM uses real random values:
   - `1d100 × 10`, `1d100_opposed × 5`, `1d20 × 5`, `1d10 × 5`, `1d8 × 5`, `1d6 × 5`, `2d6 × 5`, `1d4 × 5`, `1d3 × 5`

2. **Rest Handling** — Detects rest/sleep intent via multilingual regex. Parses Chinese/English duration ("两个半小时" = 150 min, "overnight" = 480 min). Calls `applyRest()` for HP/SAN recovery.

3. **Combat Entry** — When `entersCombat === true`, creates `CombatState { round: 1, participantNpcIds, initiatedBy, pendingNpcActions }`.

4. **Heartbeat Scheduling** — Parses heartbeat actions from LLM output, validates NPC existence, deduplicates by fingerprint, upserts.

5. **NPC Inline Responses** — NPC reactions are resolved within the same turn (sorted by `executionOrder`), each producing its own `ActionResult`.

6. **Inventory Management** — Supports `{ add: [...], remove: [...] }` format or full replacement via `InventoryUtils`.

7. **Relationship Updates** — Attitude changes clamped to [-100, 100].

8. **ActionLog Routing** — Each `actionLog[].characterId` routes the entry to the correct character's persistent log.

### 5.3 CharacterAgent

**File:** `src/dynamicworldagent/dynamicBasicAgent/character/characterAgent.ts`

**Purpose:** Determine which NPCs respond to the player's action.

**NPC Scene Membership Algorithm:**
1. Include NPCs listed in `scenario.characters[]` — unless their latest actionLog entry shows them at a different location after the snapshot time
2. Include NPCs whose actionLog shows arrival at the current location after the snapshot time
3. Fuzzy name matching via Levenshtein distance (≥ 80% similarity)

**Output — NPCResponseAnalysis:**
```typescript
{
  npcName: string,
  willRespond: boolean,
  responseType: ActionType | "none",
  responseDescription: string,
  executionOrder: number,
  targetCharacter: string | null
}
```

### 5.4 DirectorAgent

**File:** `src/dynamicworldagent/dynamicBasicAgent/director/directorAgent.ts`

**Purpose:** Scene transitions, worldline updates, game-end evaluation (~3087 lines).

**Key Methods:**

#### `handleActionDrivenSceneChange()`
5-step process when player moves to a new scene:

1. Save current scenario as `previousScenario`
2. **Phase 1** (MEDIUM LLM): Generate NPC action timeline — NPC movements between snapshots
3. **Phase 2** (MEDIUM LLM): Generate target scene snapshot from timeline
4. **Phase 3** (MEDIUM LLM, parallel with Phase 2): Update background scene simplified snapshots
5. Execute scene transition via `updateCurrentScenario()`

#### `updateNonPlayerScenarios()`
Periodic background world update (triggered by `globalTrigger` or progression):

1. **Phase 1**: NPC timeline with "Sudden Action" detection — NPCs entering the player's current scene
2. **Phase 2**: Generate updated current scene snapshot reflecting NPC arrivals
3. **Phase 3**: Background simplified snapshots

#### `checkGlobalTriggerAndGameEnd()`
Multi-condition game-end checking:

1. **Time restriction check**: Parse `globalTrigger.timeRestriction`, compare to current game time
2. **Event evidence check**: Query RAG for evidence matching `globalTrigger.events[]` and `victoryTrigger.conditions[]`
3. **LLM judgment** (SMALL): Given evidence, determine `{ triggered, causesGameEnd, victoryAchieved }`
4. **Point of No Return**: Time-based or condition-based game termination

#### `checkStoryProgression()`
Stuck player detection:
- `turnsInCurrentScene >= progressionThreshold` (threshold: tension 1-3→5, 4-6→4, 7-8→3, 9-10→2)
- OR `minutesSinceLastInput >= 3 minutes`
- Max 3 consecutive triggers

### 5.5 KeeperAgent

**File:** `src/dynamicworldagent/dynamicBasicAgent/keeper/keeperAgent.ts`

**Purpose:** Generate the narrative prose that the player reads.

**Output:**
```typescript
{
  narrative: string,
  tensionLevel: number,     // 1-10
  clueRevelations: {
    scenarioClues: string[],       // Clue IDs to mark discovered
    npcClues: string[],            // NPC clue IDs to mark revealed
    npcSecrets: string[],          // NPC IDs to expose secrets
    damagedScenarioClues: string[]
  }
}
```

**Clue Access Control:**
- `deriveClueAccessFromTurn()` scans action results for success levels
- `difficulty: "automatic"` clues are always available
- Already-discovered/revealed clues are excluded (available via RAG)

**Epilogue Generation:**
- `generateEpilogue()` — game ending narrative using endState, victory condition, trigger evidence
- Output: same shape with `{ narrative, clueRevelations, updatedGameState }`

---

## 6. Combat System

### 6.1 Combat State

```typescript
interface CombatState {
  round: number;
  participantNpcIds: string[];
  initiatedBy: "player" | "npc";
  pendingNpcActions: PendingNpcAction[] | null;  // null = player attack turn
}

interface PendingNpcAction {
  npcId: string;
  npcName: string;
  actionNarrative: string;  // NPC's declared attack — player defends next turn
}
```

### 6.2 Combat Turn Alternation

`pendingNpcActions` drives the turn:
- `null` → Player's attack turn (resolved by `CombatActionAgentA.resolvePlayerAttack()`)
- `PendingNpcAction[]` → Player's defense turn (resolved by `CombatActionAgentA.resolvePlayerDefense()`)

### 6.3 Combat Agents

**CombatActionAgentA** — Resolves player combat action with pre-rolled dice:
- Attack mode: Player attacks NPCs, applies HP damage
- Defense mode: Player defends against each pending NPC attack
- Output: `CombatActionAResult { diceUsed, actionLog, stateUpdate, combatEnded, defeatedNpcs }`

**CombatActionAgentB** — Generates NPC attack declarations:
- No dice rolled — only narrative description of NPC intentions
- Sets up `pendingNpcActions` for next turn
- Output: `CombatActionBResult { narrative, pendingNpcActions, combatEnded }`

**BattleKeeperAgent** — Generates combat narrative:
- Strictly constrained by dice outcomes (OUTCOME CONSTRAINTS section in prompt)
- Three modes: `generateCombatNarrative()`, `generateEntryNarrative()`, `generateDefeatNarrative()`
- Supports streaming via `onNarrativeDelta`

### 6.4 Combat Flow

```
[Combat entry via Action Agent]
  ↓
Round 1 (player-initiated):
  action → combatActionB (NPC declarations) → combatNpcRecordAndEnd
  ↓
Round 2+ (alternating):
  entry → memory → combatActionA (player attack/defend)
    ↓ combatEndCheck
    → combatActionB (NPC attacks) → combatNpcRecordAndEnd
    or → combatBattleKeeper (victory) → exitCombatAndRecord
    or → gameEndCheck (player death)
```

### 6.5 Defeated NPC History

`defeatedNpcHistory: DefeatedNpcHistoryEntry[]` — persistent record of `{ name, count }` per defeated NPC. De-duplicated on recording.

---

## 7. Heartbeat System

### 7.1 Concept

Heartbeats are scheduled future NPC actions. When a player makes an appointment with an NPC (e.g., "Meet me at the library at 3 PM"), the Action Agent creates a `HeartbeatAction`.

### 7.2 HeartbeatAction

```typescript
interface HeartbeatAction {
  heartbeatId: string;
  scheduledGameTime: string;        // "Day N, HH:MM"
  npcId: string;
  npcName: string;
  task: string;                     // What the NPC will do
  location: string;
  status: "scheduled" | "due" | "overdue" | "completed" | "cancelled";
  createdAtGameTime: string;
  triggeredAtGameTime?: string;     // First time entering due/overdue
  sourceTurnId: string;
}
```

### 7.3 Lifecycle

1. **Creation**: Action Agent parses `heartbeatActions` from LLM output, validates NPC existence, deduplicates, upserts
2. **Evaluation**: HeartbeatAgent runs at `entry` node every turn:
   - Converts current game time to absolute minutes
   - `deltaMinutes = scheduledMinutes - nowMinutes`
   - `0 ≤ delta ≤ 10` → `"due"`
   - `delta < 0` → `"overdue"`
3. **Context Injection**: Due/overdue actions stored in `contextualData.heartbeatDueActions` + fetches source turn narrative → `contextualData.heartbeatActivatedNarratives`
4. **Consumption**: Action Agent reads due heartbeats and incorporates into LLM context; marks as completed
5. **Narrative**: Keeper Agent reads `heartbeatActivatedNarratives` and weaves NPC arrival into the narrative

---

## 8. Time & Fatigue System

### 8.1 Game Time

- `gameDay: number` — current day (starts at 1)
- `timeOfDay: string` — `"HH:MM"` format
- `updateGameTime(elapsedMinutes)` — advances time, handles midnight rollover (day increment)
- `getTimeOfDayDescription()` — returns Dawn/Morning/Noon/Afternoon/Evening/Night/Midnight
- `getFullGameTime()` — `"Day N, HH:MM (Description)"`
- Time helper: `toAbsoluteMinutes("Day N, HH:MM")` for cross-day comparison

### 8.2 Time Consumption Tracking

Per-scene tracking of action durations per player:
- `scenarioTimeState.playerTimeConsumption[playerName]` tracks counts of short/medium/long actions
- Medium/long actions count toward the short-action cap
- Reset on scene change

### 8.3 Fatigue System

- **Threshold:** `FATIGUE_TRIGGER_MINUTES = 360` (6 hours of accumulated action time)
- `addFatigueMinutes(minutes)` — accumulates minutes since last rest; triggers `fatigueActive` at 360 min
- `isFatigued()` — returns current fatigue state
- Fatigue affects combat prompts (combat agents inject fatigue status)

### 8.4 Rest & Recovery

`applyRest(restMinutes)` returns `{ restType, hpRestored, sanRestored, summary }`:

| Duration | Rest Type | Recovery |
|----------|-----------|----------|
| < 60 min | `"short"` | No benefit |
| 60-239 min | `"medium"` | Clears fatigue only |
| 240-479 min | `"long"` | Clears fatigue + restores 30% max HP, 10% initial SAN |
| ≥ 480 min | `"very long"` | Clears fatigue + scaled HP/SAN restoration based on duration |

Rest time does NOT add to fatigue counter.

---

## 9. Scene Management & Transitions

### 9.1 Scene Snapshots

`DynamicScenarioSnapshot` — A complete point-in-time state of a scene:
- `name`, `location`, `description`, `conditions`
- `characters[]` — NPCs present
- `clues[]` — Discoverable clues with `difficulty` and `discovered`/`damaged` flags
- `connections[]` — Links to other scenes with `blocked`/`blockReason`
- `keeperNotes`

### 9.2 Scene Transition Flow

When player moves to a new scene (via `director.handleActionDrivenSceneChange()`):

1. Save current scenario as `previousScenario` (for keeper transition narrative)
2. **Phase 1 (NPC Timeline)**: LLM generates NPC movements between previous snapshot time and now → merged into NPC `actionLog[]`
3. **Phase 2 (Target Snapshot)**: LLM generates complete destination scene snapshot
4. **Phase 3 (Background Update, parallel)**: LLM updates simplified snapshots for all non-target scenes
5. Execute transition: `updateCurrentScenario()` resets `scenarioTimeState` and `turnsInCurrentScene`
6. Fire-and-forget: Generate scene image + update macro map

### 9.3 Snapshot History

- `updatedDynamicScenarioSnapshots: Map<scenarioId, DynamicScenarioSnapshot[]>` — max 2 snapshots in memory per scene
- Older snapshots evicted to DB as `isDynamicHistorical` rows in `ScenarioSnapshot` table

### 9.4 Clue ID Stabilization

`stabilizeSnapshotClues(incoming, baseline)` protects clue IDs against LLM drift:
- Exact match by `clueId`
- Fuzzy match by normalized `clueText` (Levenshtein similarity ≥ 80%)
- Preserves `discovered`/`damaged` state from baseline

---

## 10. Dynamic World System

### 10.1 Truth-First Architecture

The world is built on objective facts hidden from the player:

1. **Truth Timeline** (`truthTimeline: TruthEvent[]`) — Chronological cause-and-effect events
2. **Knowledge Matrix** (`knowledgeMatrix: KnowledgeHolder[]`) — Who/what knows which truth events, with distortion level (`none`, `partial_amnesia`, `deliberate_suppression`, `misinterpretation`)
3. **Red Herrings** (`redHerrings: RedHerring[]`) — False explanations with plausible sources
4. **Mythos Events** (`mythosEvents: MythosEvent[]`) — Lovecraftian horror intrusions

### 10.2 Tracking Sets

- `revealedTruthEvents: Set<string>` — truth events the player has uncovered
- `activatedKnowledgeHolders: Set<string>` — knowledge holders that have been accessed
- `deployedRedHerrings: Set<string>` — red herrings used in narrative
- `mythosRevelations: Set<string>` — mythos events revealed

### 10.3 Global Trigger & Game End

`globalTrigger` — Active countdown to catastrophe:
```typescript
{
  timeRestriction: string,     // Game time deadline
  timeReason: string,
  events: string[],            // Condition events
  eventReasons: string[],
  keeperNotes: string
}
```

`endState` — Victory/failure conditions:
```typescript
{
  summary: string,
  catastropheNature: string,
  victoryConditions: string[],
  pointOfNoReturn: {
    type: "time" | "condition",
    trigger: string
  }
}
```

### 10.4 Worldline Updates

When the global trigger fires or progression is triggered, `updateNonPlayerScenarios()` updates the world:
- Generates NPC timelines for background scenes
- Detects "Sudden Actions" — NPCs entering the player's current scene
- Updates background scene snapshots
- Injects sudden action logs into keeper context for narration

### 10.5 Tension-Driven Progression

| Tension | Threshold (turns) |
|---------|-------------------|
| 1-3 | 5 turns in current scene |
| 4-6 | 4 turns |
| 7-8 | 3 turns |
| 9-10 | 2 turns |

When threshold reached, story progression triggers automatically (max 3 consecutive).

---

## 11. RAG System

### 11.1 Embedding Layer

**Local models** (primary, via `fastembed`/ONNX):
- English: `BGE-small-en-v1.5`
- Chinese: `BGE-small-zh`
- Max tokens: 512
- Cached to `./cache/<model-id>/`

**Remote fallback**: Google `text-embedding-004` or OpenAI `text-embedding-3-small`

### 11.2 Session RAG Service (Production)

**File:** `src/dynamicworldagent/dynamicBasicAgent/knowledge/sessionRagService.ts`

PostgreSQL table `session_rag_chunks`:
```
id, session_id, turn_id, turn_number, chunk_type (turn|clue),
scene_room_id, role, content, metadata JSONB, source_key,
embedding BYTEA, language, created_at, email_id
```

**Hybrid Search (`searchHybrid`):**
- Semantic: cosine similarity (in-process, no vector index)
- BM25: PostgreSQL full-text `ts_rank_cd`
- Fusion: `hybridScore = 0.7 × semNorm + 0.3 × bm25Norm` (min-max normalized)
- Filters: `chunkType`, `segmentType`

### 11.3 Turn Indexing

`TurnRagAgent` chunks each completed turn into:
1. **Narrative chunks** (`chunkType: "turn"`, `segmentType: "narrative"`) — 300 token chunks, 60 token overlap
2. **Action log chunks** (`segmentType: "actionlog"`) — formatted action results
3. **Clue chunks** (`chunkType: "clue"`) — extracted from clue revelations, deduplicated by SHA-256 hash

### 11.4 RAG Query Rewriting

`RagQueryRewriter` (SMALL LLM call):
- Resolves pronouns ("he" → NPC name, "there" → location name)
- Injects entity names for retrieval optimization
- Makes query self-contained

### 11.5 Knowledge QA Service

`SessionRagQaService` — full QA pipeline:
1. Rewrite query via `RagQueryRewriter`
2. Search session RAG (`topK=5`)
3. Fetch full turn records for narrative chunks
4. Build evidence block
5. Generate answer via SMALL LLM (Keeper voice, temperature 0.2)

### 11.6 Legacy RAG

`GameHistoryRag` (SQLite-backed) — hybrid BM25 + vector with location boost. Used as Tier 2 fallback when session RAG returns no results.

---

## 12. World Builder (AI Module Generation)

**File:** `src/dynamicworldagent/world_builder/worldBuilderService.ts`

### 12.1 Generation Pipeline (6 phases)

**Phase 1: Macro Scene Agent (5→40%, 6 sequential LLM calls):**

| Step | Output | Description |
|------|--------|-------------|
| 1 | `MacroSceneStructure` | Setting skeleton: geography, economy, power structure |
| 2 | `MythosEvent[]` | Historical Lovecraftian intrusions |
| 3 | `TruthEvent[]` | Objective events (NO character names) |
| 4 | `KnowledgeHolder[]` | Abstract holders (ROLE/ORGANIZATION/PLACE/OBJECT) |
| 5 | `RedHerring[]` | False leads with plausible sources |
| 6 | `EndStateDefinition` | Victory conditions, point of no return |

**Phase 2-3: Scenario + NPC Builders (45→75%, parallel):**

Scenario Builder:
- Maps PLACE holders from knowledge matrix → `ScenarioOutline[]`
- Each with connections, clue seeds, evidence refs

NPC Builder (4 steps per batch):
1. Instantiate from ROLE/ORG holders: name, occupation, age, background
2. Goals, secrets, relationships, mythosAwareness
3. Roll attributes via dice simulation
4. Batch LLM (4 per batch, 8 concurrent): personality, appearance, inventory, clues

**Phase 4: Starting Scene Snapshot (78→79%):**
- Generate initial `DynamicScenarioSnapshot` for the starting scene

**Phase 4.5: Macro Map (79→81%):**
- Generate map image via Gemini image model

**Phase 5: Module Digest (82→90%):**
- Generate `ModuleDigest`: keeperGuidance, moduleLimitations, introduction, globalTrigger, victoryTrigger

**Phase 6: Persistence (90→100%):**
- Save all JSON files to `data/Mods/<Module>/`

### 12.2 Story Length Scaling

| Length | Scenarios | Truth Events | Red Herrings |
|--------|-----------|-------------|-------------|
| Short | 5-7 | 3-5 | 1-2 |
| Medium | 9-12 | 5-8 | 2-4 |
| Long | 10-15 | 8-12 | 3-5 |

### 12.3 Setting Types

`small_town`, `city`, `academic`, `isolated`, `single_structure`, `route`

---

## 13. Scene Image & Map Generation

### 13.1 Scene Images

**File:** `src/dynamicworldagent/visual/sceneImage.ts`

- Sanitizes snapshot (strips clues and keeper notes)
- Generates via Gemini image model (requires `GOOGLE_API_KEY`)
- Saved to `data/Mods/<Module>/Sceneimage/<sceneName>_<timestamp>.png`
- Generated fire-and-forget after scene transitions

### 13.2 Macro Maps

**File:** `src/dynamicworldagent/visual/mapImage.ts`

Three modes:
1. **Initial**: All scenario outlines → labeled overview map
2. **Incremental**: Previous map as reference → add new scene, keep existing
3. **Merge**: Multiple parent maps → unified map

Saved to `data/Mods/<Module>/Map/<moduleName>_<timestamp>.png`

---

## 14. Checkpoint / Save System

### 14.1 Checkpoint Types

| Type | Trigger |
|------|---------|
| `manual` | Player clicks "Save" button |
| `auto` | After each turn (auto-save, max 10 per session) |
| `scene_transition` | On scene change |

### 14.2 Save Process

1. Serialize `DynamicGameState` to JSON (Sets → arrays, Maps → objects, Dates → ISO strings)
2. Save only latest snapshot per scenario in checkpoint blob; older snapshots go to `ScenarioSnapshot` table
3. Attach full conversation history and player memos
4. Write to `GameCheckpoint` via Prisma

### 14.3 Load Process

1. Verify ownership via session → character → emailId chain
2. Generate new session ID
3. Create new DB rows: Session, GameTurn, PlayerMemo
4. Deserialize `DynamicGameState` with game-time-aware filtering
5. Copy RAG chunks from old session to new (fire-and-forget)
6. Restore language setting

---

## 15. Server API Reference

### 15.1 Authentication (`/api/auth/*`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/register` | Register (requires referral code) |
| POST | `/api/auth/login` | Login (returns JWT access + refresh tokens) |
| POST | `/api/auth/logout` | Logout |
| POST | `/api/auth/refresh` | Refresh access token |
| GET | `/api/auth/me` | Get current user |
| POST | `/api/auth/send-verification` | Send email verification |
| POST | `/api/auth/verify-code` | Verify email with code |
| POST | `/api/auth/forgot-password` | Send reset email |
| POST | `/api/auth/reset-password` | Reset password |
| POST | `/api/auth/change-password` | Change password |

JWT: Access token (60 min) + Refresh token (60 min) + Sliding session on each request.

### 15.2 Game (`/api/game/*`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/game/start` | Start new game session |
| POST | `/api/game/stop` | Stop game |
| GET | `/api/gamestate` | Get current game state |
| POST | `/api/game/update-language` | Update language preference |

### 15.3 Turns (`/api/turns/*`, `/api/sessions/*`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/turns` | Submit player action (async) |
| GET | `/api/turns/:turnId` | Get turn result (supports long-poll) |
| GET | `/api/sessions/latest` | Get latest session |
| GET | `/api/sessions/:sessionId/conversation` | Get conversation history |
| GET | `/api/sessions/:sessionId/turns` | Get paginated turn history |

Turn processing is async: POST returns `{ turnId, status: "processing" }` immediately, client polls or receives results via WebSocket.

### 15.4 Characters (`/api/character*`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/character/random-attributes` | Generate random CoC 7e attributes |
| POST | `/api/character` | Create character |
| PUT | `/api/character/:characterId` | Update character |
| GET | `/api/characters` | List user's characters |
| GET | `/api/character/:characterId` | Get character details |

### 15.5 Checkpoints (`/api/checkpoints/*`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/checkpoints/save` | Save checkpoint |
| GET | `/api/checkpoints/list` | List checkpoints |
| POST | `/api/checkpoints/load` | Load checkpoint |
| DELETE | `/api/checkpoints/:checkpointId` | Delete checkpoint |
| POST | `/api/checkpoints/batch-delete` | Batch delete checkpoints |

### 15.6 Modules (`/api/mod/*`, `/api/module/*`, `/api/mods`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/mod/load` | Load module data (SSE progress) |
| GET | `/api/module/introduction` | Get module intro text |
| GET | `/api/mods` | List user's modules |
| GET | `/api/mods/shared` | List shared community modules |
| POST | `/api/mods/share` | Share module |
| POST | `/api/mods/unshare` | Unshare module |
| POST | `/api/mods/add` | Add shared module to library |
| POST | `/api/mods/delete` | Soft-delete module |
| POST | `/api/mods/restore` | Restore deleted module |
| POST | `/api/module/generate-world` | AI generate full world (SSE) |
| POST | `/api/module/generate-scene` | AI generate scenes only (SSE) |
| POST | `/api/module/generate-npcs` | AI generate NPCs for module (SSE) |

### 15.7 Other Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/occupations` | CoC occupation list (public) |
| GET | `/api/weapons` | Weapon list (public) |
| GET | `/api/maps/*` | Serve map images (public) |
| GET/POST/PUT/DELETE | `/api/memos` | Player memo CRUD |
| POST | `/api/skills/suggest` | Semantic skill matching |
| POST | `/api/rag/ask` | RAG knowledge QA |
| GET | `/api/analytics/daily` | Admin analytics |

---

## 16. WebSocket Events

**Connection:** `ws://HOST:PORT/ws?sessionId=<id>&token=<jwt>`

### Server → Client Events

| Event | When | Key Data |
|-------|------|----------|
| `connected` | On connect | `sessionId` |
| `keeper_stream_start` | Narrative begins | `turnId`, `turnNumber`, `gameDay`, `gameTime` |
| `keeper_stream_delta` | Narrative text chunk | `turnId`, `delta` |
| `keeper_stream_end` | Narrative complete | `turnId` |
| `keeper_dice_rolls` | Dice results ready | `turnId`, `diceRolls[]` |
| `scene_image` | Scene image generated | `imagePath`, `sceneName` |
| `scene_change_start` | Scene transition starting | `turnId` |
| `scene_change_end` | Scene transition complete | `turnId` |
| `worldline_update_start` | World state updating | `turnId` |
| `worldline_update_end` | World state update done | `turnId` |
| `map_update` | Macro map updated | `macroMapPath` |
| `combat_start` | Combat begins | `turnId`, `gameDay`, `gameTime` |
| `combat_end` | Combat ends | `turnId` |
| `pong` | Heartbeat response | `timestamp` |

### Client → Server Events

| Event | Purpose |
|-------|---------|
| `ping` | Heartbeat (server responds with `pong`) |

Narrative streaming only active when `MODEL_PROVIDER=google`. Delta buffering: flush at 48 chars or 50ms timeout.

---

## 17. Frontend UI

### 17.1 Route Map

| Route | Component | Description |
|-------|-----------|-------------|
| `/login` | Login | Email + password auth |
| `/register` | Register | New account (requires referral code) |
| `/` | HomePage | Main menu: New Game / Continue / Manage Mods |
| `/character/create` | CharacterCreationPage | Multi-tab character form |
| `/character/select` | CharacterSelectionPage | Pick investigator for game |
| `/mod/select` | ModSelectionPage | Module browser + AI generator |
| `/mod/intro` | ModuleIntroPage | Module introduction text |
| `/story/create` | StoryCreatorPage | AI world generation wizard |
| `/tutorial` | TutorialPage | 10-step interactive tutorial |
| `/game` | GamePage | Main game interface |

### 17.2 Game Interface (GamePage)

**Layout:** Header (module name + back button) | Main (GameChat + GameSidebar)

**GameChat Features:**
- Text input with Enter-to-send, Shift+Enter for newlines
- Skill picker dropdown with AI-suggested skills
- Auto/Manual skill selection mode toggle
- Rest button (1-8 hours, disabled in combat)
- Dice roll animations before narrative text
- Streaming narrative display
- Combat mode banners
- Game time display (Day + HH:MM)
- Fatigue indicator
- Save checkpoint button
- Game ending detection (disables input)

**GameSidebar Tabs:**
- **Status**: HP/SAN/Luck/MP bars, conditions, inventory, weapons, current scene info
- **Notes (Memo)**: Player sticky notes with game-day/time stamps, filterable
- **Knowledge**: AI Q&A about past events (RAG-powered)
- **Map**: Scenario map + macro map display

### 17.3 State Management

| Layer | Mechanism |
|-------|-----------|
| Authentication | `AuthContext` (global) |
| Game Session | `GameSessionContext` (global) |
| App Settings | `AppSettingsContext` (language, background) |
| Game UI | Local `useState` + custom hooks |

No external state library (no Redux/Zustand).

### 17.4 Key Custom Hooks

| Hook | Purpose |
|------|---------|
| `useTurnPolling` | Long-poll turn results |
| `useWebSocket` | Persistent WS for streaming events |
| `useGameMessages` | Chat message history management |
| `useDiceAnimation` | Dice roll visual sequence |
| `useSkillSelection` | AI skill suggestion + picker |
| `useAutoSave` | Auto checkpoint after each turn |
| `useSceneTransition` | Scene transition overlay state |
| `useInputCollapse` | Collapse input area when idle |

---

## 18. LLM Model Strategy

| Agent / Task | Model Class | Typical Provider Model |
|-------------|-------------|----------------------|
| Orchestrator | SMALL | gemini-2.0-flash |
| Memory Agent | None (no LLM) | — |
| Action Agent | MEDIUM | gemini-2.5-flash |
| Character Agent | SMALL | gemini-2.0-flash |
| Director (timeline, snapshots) | MEDIUM | gemini-2.5-flash |
| Director (trigger check) | SMALL | gemini-2.0-flash |
| Director (stuck hint) | SMALL | gemini-2.0-flash |
| Combat A (attack) | MEDIUM | gemini-2.5-flash |
| Combat A (defense) | SMALL | gemini-2.0-flash |
| Combat B | MEDIUM | gemini-2.5-flash |
| Battle Keeper | MEDIUM | gemini-2.5-flash |
| Keeper (narrative) | MEDIUM | gemini-2.5-flash |
| Keeper (epilogue) | MEDIUM | gemini-2.5-flash |
| RAG Query Rewriter | SMALL | gemini-2.0-flash |
| RAG QA | SMALL | gemini-2.0-flash |
| Heartbeat Agent | None (pure time arithmetic) | — |
| RAG Recorder | None (embedding only) | — |
| World Builder (all phases) | MEDIUM | gemini-2.5-flash |
| Embedding | Local BGE-small (EN/ZH) | fastembed ONNX |

**Provider Strategy:** Primary provider configured via `MODEL_PROVIDER`. OpenAI used as fallback for Director Phase 2/3 if primary fails. Embedding always tries local first, falls back to remote API.
