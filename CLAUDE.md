# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CoC Multi-Agent System is an AI-powered Call of Cthulhu (7th Edition) game master built with LangGraph multi-agent architecture. The system uses 6 specialized AI agents working in a sequential pipeline to run complete tabletop RPG sessions.

**Tech Stack:** TypeScript, LangGraph, LangChain, SQLite, React, Express, WebSocket

**Current Branch:** `weaktime` (development branch for time mechanics improvements)
**Main Branch:** `main` (use for PRs)

## Essential Commands

### Development Workflow

```bash
# Install dependencies (required: pnpm >= 9.0.0)
pnpm install

# Build the project (compiles TypeScript to dist/)
pnpm build

# Run backend server (starts Express API + WebSocket server)
pnpm chat

# Run frontend (in separate terminal, starts Vite dev server)
pnpm chat:frontend

# Run both backend + frontend concurrently
pnpm chat:dev

# Development mode with debug logs
pnpm dev:debug
```

### Code Quality

```bash
# Format code with Biome
pnpm format

# Lint code
pnpm lint

# Format + lint + auto-fix
pnpm check

# Run tests
pnpm test

# Run tests with coverage
pnpm test:coverage
```

### Build Variants

```bash
# Default build (uses SWC for speed)
pnpm build

# Build with TypeScript compiler (slower, stricter type checking)
pnpm build:tsc

# Build with Turbo (monorepo-optimized)
pnpm build:turbo
```

## Architecture

### Multi-Agent Pipeline

The system processes player input through a **sequential agent pipeline** defined in `src/graph.ts`:

```
Player Input → Entry → Orchestrator → Memory → Action → Character → Director → Keeper → Output
```

**Agent Responsibilities:**

1. **Entry** (`src/graph.ts:60`): Routes input type, clears temporary state for new player turns
2. **Orchestrator** (`src/shared/agents/orchestrator/orchestratorAgent.ts`): Analyzes player intent and determines action type
3. **Memory** (`src/shared/agents/memory/memoryAgent.ts`): Enriches context with relevant game rules, scenario details, and RAG results
4. **Action** (`src/shared/agents/action/actionAgent.ts`): Executes dice rolls, updates character stats, manages inventory
5. **Character** (`src/shared/agents/character/characterAgent.ts`): Determines NPC responses and behaviors
6. **Director** (`src/shared/agents/director/directorAgent.ts`): Manages scene transitions, time progression, and game ending conditions
7. **Keeper** (`src/shared/agents/keeper/keeperAgent.ts`): Generates narrative output for the player

**Key State Management:**
- `GraphState` (graph-level): Messages, game state, turn tracking
- `GameState` (`src/state.ts`): Session data, character profiles, scenarios, clues, temporary agent outputs
- `temporaryInfo`: Cleared at start of each player turn, holds intermediate agent results

### Project Structure

```
CoC-AI-agent/
├── src/                                    # Backend source code
│   ├── graph.ts                           # LangGraph workflow definition
│   ├── state.ts                           # GameState types and manager
│   ├── index.ts                           # CLI entry point
│   ├── shared/
│   │   ├── agents/                        # 6 specialized AI agents
│   │   │   ├── orchestrator/              # Intent analysis
│   │   │   ├── memory/                    # Context enrichment & loaders
│   │   │   │   ├── database/              # SQLite schema & seed data
│   │   │   │   ├── moduleloader/          # Module digest loading
│   │   │   │   ├── scenarioloader/        # Scenario/location loading
│   │   │   │   ├── RagManager.ts          # RAG system (currently disabled)
│   │   │   │   ├── turnManager.ts         # Turn persistence
│   │   │   │   └── checkpointManager.ts   # Save/load functionality
│   │   │   ├── action/                    # Dice rolls & mechanics
│   │   │   │   └── tools.ts               # Action execution tools
│   │   │   ├── character/                 # NPC behavior
│   │   │   │   ├── npcloader/             # NPC profile loading
│   │   │   │   └── playerloader/          # Player character loading
│   │   │   ├── director/                  # Scene & time management
│   │   │   │   └── progressionMonitor.ts  # Story progression tracking
│   │   │   ├── keeper/                    # Narrative generation
│   │   │   └── models/                    # Shared types
│   │   │       ├── gameTypes.ts           # Character, inventory types
│   │   │       ├── scenarioTypes.ts       # Scenario, clue types
│   │   │       └── moduleTypes.ts         # Module digest types
│   │   └── rules/                         # CoC 7e mechanics (8 action types)
│   │       ├── exploration.ts
│   │       ├── social.ts
│   │       ├── combat.ts
│   │       ├── stealth.ts
│   │       ├── chase.ts
│   │       ├── mental.ts
│   │       ├── environmental.ts
│   │       └── narrative.ts
│   ├── dynamicworldagent/                  # Dynamic World system (NPC planning)
│   │   ├── dynamicBasicAgent/npcPlanning/  # Two-tier NPC planning system
│   │   ├── engine/                         # Pluggable NodeHandlers + WorldFeatures
│   │   │   ├── handlers/                   # movement, routine, object, character, scene
│   │   │   └── features/                   # fire, lighting, weather, sanity, stamina
│   │   ├── state/DynamicGameState.ts       # DynamicGameState types + manager
│   │   ├── graph/dynamicGraph.ts           # DynamicGraphState + graph wiring
│   │   └── memory/NpcMemoryManager.ts      # Unified NPC memory with retrieval
│   └── rag/                               # RAG infrastructure (WIP)
│
├── client/                                 # React frontend
│   ├── server.ts                          # Express server entry point
│   ├── server/                            # Backend API modules
│   │   ├── auth/                          # Authentication & JWT
│   │   ├── character/                     # Character CRUD
│   │   ├── game/                          # Game state management
│   │   ├── turn/                          # Turn execution (LangGraph invocation)
│   │   ├── checkpoint/                    # Save/load endpoints
│   │   ├── mod/                           # Module management
│   │   ├── core/                          # DatabaseManager, GraphManager
│   │   ├── websocket/                     # WebSocket for real-time updates
│   │   └── utils/                         # Shared utilities
│   └── src/                               # React UI
│       ├── App.tsx                        # Main application (82KB, complex)
│       ├── components/                    # UI components
│       │   └── GameChat.tsx               # Main chat interface
│       ├── views/                         # Page-level components
│       └── services/                      # API client

├── data/
│   ├── db.sqlite                          # Game database (auto-generated)
│   └── Mods/                              # Module packages
│       └── [Module Name]/
│           ├── module_digest.json         # Module metadata
│           ├── [Module]_npc/              # NPC profiles (JSON/docs)
│           └── [Module]_Scenarios/        # Scenario/location files

├── scripts/                                # Deployment scripts
├── deployment/                             # AWS Elastic Beanstalk config
└── test-*.ts                              # Standalone loader tests
```

## Key Workflows

### Turn Execution Flow

When a player submits an action via the web UI:

1. **Frontend** (`client/src/components/GameChat.tsx`) sends POST to `/api/turns/:sessionId`
2. **Turn Controller** (`client/server/turn/controller.ts`) validates session and invokes graph
3. **Graph Execution** (`src/graph.ts`):
   - Entry node clears temporary state, increments turn counter
   - Orchestrator analyzes intent → outputs `ActionAnalysis`
   - Memory enriches context (rules, scenario data, RAG if enabled)
   - Action executes mechanics → outputs `ActionResult[]`
   - Character determines NPC responses → outputs `NPCResponseAnalysis[]`
   - Director checks scene transitions, time progression, game ending → outputs `DirectorDecision`
   - Keeper generates narrative using all previous agent outputs
4. **Turn Manager** (`src/shared/agents/memory/turnManager.ts`) persists turn to database
5. **WebSocket** broadcasts updated game state to connected clients

### Module Loading

The system supports custom Call of Cthulhu scenarios (modules) with NPCs, locations, and clues.

**Module Structure:**
- `data/Mods/[Module Name]/module_digest.json`: Title, background, story outline, keeper guidance, initial game time
- `data/Mods/[Module Name]/[Module]_npc/`: NPC JSON files or documents (.docx, .pdf)
- `data/Mods/[Module Name]/[Module]_Scenarios/`: Scenario JSON files or documents

**Loaders:**
- `ModuleLoader` (`src/shared/agents/memory/moduleloader/`): Parses module digest
- `NPCLoader` (`src/shared/agents/character/npcloader/`): Loads NPC profiles with AI-powered document parsing
- `ScenarioLoader` (`src/shared/agents/memory/scenarioloader/`): Loads scenarios/locations

**Document Parsing:**
- Supports both structured JSON and unstructured documents (.docx, .pdf)
- Uses LLM-powered extraction when JSON is not available

### Database Schema

SQLite database (`data/db.sqlite`) managed by `src/shared/agents/memory/database/schema.ts`:

**Core Tables:**
- `users`: User authentication
- `sessions`: Game sessions (links user + module)
- `characters`: Player and NPC profiles
- `scenarios`: Scenario/location instances
- `turns`: Turn history with full state snapshots
- `checkpoints`: Manual save points
- `game_state`: Current game state per session

**Important:** Database is auto-created on first run. Use `DatabaseManager` singleton for all DB access.

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Model Provider (openai, google, anthropic)
MODEL_PROVIDER=google

# API Keys
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...

# Model Selection (SMALL for speed, MEDIUM for quality)
SMALL_GOOGLE_MODEL=gemini-2.0-flash
MEDIUM_GOOGLE_MODEL=gemini-2.5-flash

# Database
DATABASE_PATH=./data/db.sqlite

# Server
PORT=3000
NODE_ENV=development

# JWT (change in production!)
JWT_SECRET=CHANGE-THIS-TO-A-SECURE-RANDOM-STRING
```

**Model Strategy:**
- SMALL models: Orchestrator, Memory, Action, Character, Director (fast, structured output)
- MEDIUM models: Keeper only (creative narrative generation)

### RAG System Status

RAG (Retrieval-Augmented Generation) is **NOT USED** in the system:
- Dynamic World system does not use RAG (explicitly disabled)
- `RAG.md` contains an unimplemented design document (marked as deprecated)
- Only basic embedding functionality exists in `src/rag/` for skill matching feature
- Skill matching uses semantic similarity to suggest relevant character skills

## Important Implementation Details

### Time System (weaktime branch)

The `weaktime` branch implements in-game time tracking:
- `GameState.gameDay`: Current day number
- `GameState.timeOfDay`: HH:MM format
- `scenarioTimeState`: Tracks time consumption per player action
- Time advances based on action types and Director decisions
- Modified files: `client/server/turn/controller.ts`, `client/server/turn/routes.ts`, `client/src/App.tsx`, `client/src/components/GameChat.tsx`

### Simulated vs Real Input

The graph distinguishes between real player input and Director-simulated queries:
- `state.isSimulatedQuery`: If true, skips Orchestrator and Memory agents
- `state.simulatedQueryCount`: Safety counter (max 5) to prevent infinite loops
- Used when Director needs to generate autonomous NPC actions or environmental events

### Action Types (8 Categories)

CoC 7e mechanics organized into 8 action types (`src/state.ts:10-19`):
1. **Exploration**: Finding clues, gathering information
2. **Social**: Influencing NPCs, persuasion, interrogation
3. **Combat**: Fighting, causing damage
4. **Stealth**: Sneaking, hiding, acting undetected
5. **Chase**: Pursuit or escape
6. **Mental**: Sanity checks, resisting psychological horror
7. **Environmental**: Surviving harsh conditions, physical endurance
8. **Narrative**: Key story choices, plot decisions

Each type has corresponding rules in `src/shared/rules/[type].ts`

### NPC Response System

NPCs can respond autonomously to player actions:
- Character agent analyzes context and determines `NPCResponseAnalysis[]`
- Each NPC response has `responseType` (one of 8 action types or "none")
- `executionOrder`: Determines sequence when multiple NPCs respond
- Responses are processed in order, each can trigger additional mechanics

### State Cleanup

**Critical:** `temporaryInfo` in `GameState` is cleared at the start of each real player turn (Entry node):
- `actionResults`: Cleared
- `npcResponseAnalyses`: Cleared
- `currentActionAnalysis`: Cleared
- `narrativeDirection`: Cleared
- `rules`, `ragResults`: Cleared

Do not persist temporary agent outputs across turns unless explicitly moved to permanent state.

## Testing

**Current Status:** No automated test suite configured.

**Manual Testing:**
1. Run `pnpm build` to catch type errors
2. Use `pnpm chat:dev` to test full stack
3. Test module loading with standalone scripts:
   - `test-moduleloader.ts`: Module digest parsing
   - `test-npcloader.ts`: NPC loading
   - `test-playerloader.ts`: Player character loading
   - `test-scenarioloader.ts`: Scenario loading

**When Adding Tests:**
- Place in `tests/` or alongside modules as `*.spec.ts`
- Use Vitest (`vitest.config.ts` is configured)
- Mock SQLite layer to avoid mutating real data

## Scene & Topology Architecture (Dynamic World)

The scene system uses a three-layer hierarchy: macro locations → sub-scenes → outdoor topology graph.

### Scene Hierarchy

**ScenarioOutline** (macro location, e.g. "Hospital"):
- Defined in `scenarios_outline.json`
- Groups sub-scenes; has `entrySceneId`, optional `residents[]`
- Type: `src/dynamicworldagent/world_builder/types.ts:ScenarioOutline`

**DynamicScene** (room / sub-scene):
- Individual JSON files: `SCN_1_SUB_1.json`, etc.
- Contains `items[]`, `conditions[]`, `connections[]` (sibling sub-scene IDs), `events[]`
- `parentLocationId` → ScenarioOutline ID
- Type: `src/dynamicworldagent/world_builder/types.ts:DynamicScene`

**Outdoor Topology** (roads & junctions):
- `JunctionNode` (`JUNC_*.json`): intersection with `connectedSceneIds[]` (building entries)
- `RoadNode` (`ROAD_*.json`): path between two junctions with `endpointA/B`, `travelTimeMinutes`, `alongConnections[]` (`{ sceneId, position: 0.0–1.0 }`)
- `TransportEdge` (`transport_network.json`): macro edges connecting ScenarioOutline IDs
- Types: `src/dynamicworldagent/world_builder/topologyTypes.ts`

### Key Scene Types

```typescript
interface DynamicScene {
  id: string; name: string; description: string;
  parentLocationId: string;
  items: Item[];
  itemContexts?: Record<string, string>;  // itemId → contextual description
  conditions: ScenarioCondition[];
  connections: string[];        // sibling sub-scene IDs
  events: string[];
  indoor?: boolean;
  sceneImage?: SceneImage;
  // NOTE: JSON data files may contain a `clues[]` field, but DynamicScene type does NOT have it.
  // The tick processor discovers info from items (category==="evidence") and NPC knowledge instead.
}

interface Item {
  id: string; name: string; description?: string;
  type?: "weapon" | "consumable" | "tool" | "lighting" | "container" | "key" | "document" | "other";
  category?: "evidence" | "mundane";  // "evidence" items are discoverable by tick processor
  reveals?: string[];
  discoveryMethod?: string;   // CRITICAL: tick processor uses this to set difficulty ("regular" if present, "automatic" if absent)
  era?: string;
  damaged?: boolean;
  damageDetails?: { damagedBy: string; damagedAt: string; reason: string };
  weaponStats?: WeaponStats;
  consumableStats?: ConsumableStats;
  containerStats?: ContainerStats;
  isLightSource?: boolean; lightLevel?: number;
}

interface ScenarioCondition {
  type: "weather" | "lighting" | "sound" | "smell" | "temperature" | "other";
  description: string;
  mechanicalEffect?: { skillPenalty?: Array<{ skill: string; delta: number }>; blocked?: boolean };
}

interface TownTopology {
  junctions: Map<string, JunctionNode>;
  roads: Map<string, RoadNode>;
  junctionToRoads: Map<string, RoadNode[]>;
  sceneToParent: Map<string, { type: "junction"; junctionId: string }
                             | { type: "road"; roadId: string; position: number }>;
}

type CharacterPosition =
  | { type: "junction"; junctionId: string }
  | { type: "road"; roadId: string; position: number }
  | { type: "scene"; sceneId: string };
```

### Discovery System (replaces old clue system)

**There are no standalone clue objects.** The tick processor discovers information from two sources:

**1. Evidence Discovery** (scene items):
- Triggered on player's successful `scene_interaction` or `object_interaction`
- Candidates: `scene.items[]` where `category === "evidence"` and `!damaged`
- Item difficulty: has `discoveryMethod` → `"regular"`; no `discoveryMethod` → `"automatic"`
- ActionType must be a discovery type (exploration/social/stealth/narrative) to find non-automatic items; otherwise only automatic items are returned

**2. NPC Knowledge Discovery** (character interaction):
- Triggered on player's successful `character_interaction`
- Candidates: target NPC's `knowledge[]` (unrevealed, uses `knowledge.difficulty` field: regular/hard/extreme) + `secrets[]` (treated as hard difficulty)
- When actionType is a discovery type (exploration/social/stealth/narrative), success level gates max difficulty
- Otherwise, **relationship score** gates difficulty: ≥80→extreme, ≥70→hard, ≥60→regular, <60→automatic only

**Success level → max discoverable difficulty:**
- `critical` → extreme | `hard` → hard | `regular` → regular | `fail` → automatic only | `fumble` → nothing + may damage evidence

**Semantic matching:** Non-automatic candidates matched via embedding cosine similarity (threshold 0.7) against player's action description.

**Fumble damage:** On fumble, a random undamaged `category === "evidence"` item in the current scene is damaged.

### DynamicGameState Scene Fields

```typescript
interface DynamicGameState {
  currentSceneId: string | null;
  scenes: Map<string, DynamicScene>;
  scenarioOutlines: ScenarioOutline[];
  transportEdges: TransportEdge[];
  topology: TownTopology | null;
  characterPositions: Record<string, CharacterPosition>;
  scenarioConditions: Record<string, SceneCondition[]>;   // runtime condition overlays
  blockedConnections: Map<string, string>;                 // "sceneA::sceneB" → reason
}
```

### Module Data Layout (example)

```
testmods/casssandra/
├── scenarios_outline.json               # ScenarioOutline[] (macro locations)
├── transport_network.json               # { outdoorScenes[], transportEdges[] }
├── Cassandra_Scenarios/                 # All scene JSON files
│   ├── SCN_1_SUB_1.json … SCN_21_SUB_3.json  # Sub-scenes (rooms)
│   ├── ROAD_1.json … ROAD_10.json             # Road nodes
│   └── JUNC_1.json … JUNC_11.json             # Junction nodes
├── npc/                                 # NPC profile JSONs
└── scene/scene.md                       # Scene narrative doc
```

## NPC Planning System (Dynamic World)

The NPC Planning System lives under `src/dynamicworldagent/` and drives autonomous NPC behavior via a **two-tier hierarchical planning** architecture.

### Two-Tier Architecture

**Layer 1 — Daily Schedule (Coarse):**
- Generated once per day per NPC via `NPCPlanningAgent.generateDailySchedule()`
- Produces `ScheduleEntry[]`: `{ location: string, activity: string }`
- Stored in Prisma `NpcDailyPlan.schedule` as JSON
- Uses SMALL model for token efficiency

**Layer 2 — Detailed Action Nodes (Fine):**
- Generated on-demand via `generateDetailedNodes()` when NPC reaches a schedule entry
- Consumes one schedule entry at a time via `consumeNextScheduleEntry()`
- Produces 1-3 `PlanNode` objects with actionType, payloads, mechanics
- Appended to `NpcDailyPlan.nodes` in database
- Uses MEDIUM model for richer decisions

### File Structure

```
src/dynamicworldagent/
├── dynamicBasicAgent/npcPlanning/
│   ├── types.ts                  # PlanNode, CharacterAction, ScheduleEntry, TickResult, etc.
│   ├── NPCPlanningAgent.ts       # Plan generation, revision, impact gate, relationship updates
│   ├── PlayerPlanAgent.ts        # Player action planning (converts intent → PlanNode[])
│   ├── PlayerPlanTemplate.ts     # Player plan prompt templates
│   ├── tickProcessor.ts          # Execution engine: 5-min buckets, discovery, impact propagation
│   ├── npcPlanningTemplates.ts   # LLM prompt templates (schedule, nodes, revision, impact gate)
│   ├── actionTypeSkillMap.ts     # Static mapping of ActionType → CoC skills
│   ├── horrorSourceData.ts       # Baseline Cthulhu horror sources for sanity loss
│   ├── sceneMapFormatter.ts      # Scene topology formatting for prompts
│   ├── itemFormatHelpers.ts      # Item/inventory formatting for prompts
│   └── index.ts                  # Public API exports
├── engine/
│   ├── types.ts                  # NodeHandler, WorldFeature, ExecutionContext interfaces
│   ├── registry.ts               # GameEngineRegistry (pluggable handlers + features)
│   ├── executionContext.ts        # createExecutionContext() — shared utilities for handlers
│   ├── registerDefaults.ts        # createDefaultRegistry() — registers built-in handlers/features
│   ├── handlers/                  # Built-in node handlers (movement, routine, object, character, scene)
│   ├── features/                  # WorldFeature plugins (fire, lighting, weather, sanity, stamina)
│   └── shared/                    # Dice, skill rolls, scene penalties, topology, pathfinding
├── state/
│   └── DynamicGameState.ts        # DynamicGameState types + DynamicGameStateManager
├── graph/
│   └── dynamicGraph.ts            # DynamicGraphState + graph wiring
└── memory/
    └── NpcMemoryManager.ts        # Unified NPC memory with retrieval
```

### Core Types (`types.ts`)

```typescript
type PlanNodeType = "routine" | "movement" | "character_interaction"
                  | "object_interaction" | "scene_interaction" | (string & {});

// Payload types used by tick processor node execution
interface CharacterInteractionPayload {
  transferType: "item" | "information";
  itemId?: string;
  informationContent?: string;    // tick processor writes event memories with this content
  targetCharacterIds?: string[];
  relatedKnowledgeIds?: string[];
}
interface ObjectInteractionPayload {
  action: "pickup" | "place" | "use" | "inspect" | "destroy";
  itemId?: string; targetItemId?: string;
  itemUpdates?: Partial<Item>; targetItemUpdates?: Partial<Item>;
}
interface SceneConnectionEffect { targetScenarioId: string; action: "block" | "unblock"; }

type FailureReason = "location_mismatch" | "location_blocked" | "target_absent"
                   | "object_not_found" | "skill_roll_failed" | "bad_luck";

interface DiscoveryEntry {
  id: string; text: string;
  source: "evidence" | "npc";
  sourceId: string; sourceName: string;
  difficulty: "automatic" | "regular" | "hard" | "extreme";
  similarity: number;  // cosine similarity score
}

interface PlayerWitnessEvent {
  characterName: string; action: string; outcome: string;
  location: string; gameTime: string; impact: number;
}

interface PlanNode {
  nodeId: string;
  characterId: string; characterName: string;
  gameTime: string;     // "HH:MM"
  action: string;       // action description
  location: string;     // scene ID
  type: PlanNodeType;
  actionType?: ActionType;
  impact: 0 | 1 | 2 | 3 | 4 | 5;
  difficulty?: "regular" | "hard" | "extreme";
  isPlayer?: boolean;
  timeAdvanceMinutes: number;
  status: "pending" | "completed" | "failed";
  outcome?: string;
  // Type-specific payloads
  targetCharacterId?: string;
  characterInteractionPayload?: CharacterInteractionPayload;
  objectInteractionPayload?: ObjectInteractionPayload;
  sceneConnectionEffect?: SceneConnectionEffect;
  [key: string]: unknown;  // Feature overlay fields
}

interface CharacterAction {
  characterId: string; characterName: string;
  gameTime: string; action: string; location: string;
  type: PlanNodeType; actionType?: ActionType;
  impact: 0 | 1 | 2 | 3 | 4 | 5;
  isPlayer?: boolean;
  difficulty?: "regular" | "hard" | "extreme" | "luck_only";
  successLevel?: "critical" | "hard" | "regular" | "fail" | "fumble";
  status: "completed" | "failed";
  outcome: string;
  failureReason?: FailureReason;
  targetCharacterId?: string;
  discoveries?: DiscoveryEntry[];
  damagedEvidence?: { itemId: string; sourceName: string };
}

type TickResult =
  | { type: "completed"; actions: CharacterAction[] }
  | { type: "player_interrupt"; actions: CharacterAction[];
      witnessEvents: PlayerWitnessEvent[];
      remainingMinutes: number; resumeFromMinutes: number; gameDay: number; };
```

### NPCPlanningAgent — Key Methods

```typescript
constructor(prisma: PrismaClient, runtime: any, memoryManager?: NpcMemoryManager)

// Initialization
seedLongTermIntents(dgsm, sessionId, moduleId): Promise<void>

// Two-tier planning
generateDailySchedule(dgsm, sessionId, moduleId, gameDay, language, registry?): Promise<void>
generateDetailedNodes(dgsm, sessionId, npcId, entry, gameDay, language, registry?): Promise<PlanNode[]>
ensureNpcNodesAvailable(dgsm, sessionId, npcId, gameDay, currentTime, language, registry?): Promise<void>
consumeNextScheduleEntry(sessionId, npcId, gameDay, currentTime): Promise<ScheduleEntry | null>

// Revision (reactive)
revisePlans(dgsm, sessionId, npcId, context: RevisePlansContext, language?, registry?): Promise<void>
reviseSchedule(dgsm, sessionId, npcId, triggerDescription, language?, registry?): Promise<void>

// Impact gate
runImpactGateForNpc(candidate, bucketTime, language?):
  Promise<{ shouldRevise: boolean; shouldReviseSchedule: boolean; witnessEntry: string }>

// Relationship
updateRelationshipViaLLM(dgsm, characterAId, characterBId, interactionOutcome, language?):
  Promise<{ scoreDelta: number; newScore: number; note: string }>

// Lifecycle
onNewDay(dgsm, sessionId, moduleId, gameDay, language?, registry?): Promise<void>
resolveModuleId(sessionId): Promise<string | null>

// DB accessors
getLongTermIntent(sessionId, npcId): Promise<string>
getDailyPlan(sessionId, npcId, gameDay)
getPendingNodes(sessionId, npcId, gameDay): Promise<PlanNode[]>
getDueNpcNodes(sessionId, gameDay, upToTime, dgsm): Promise<PlanNode[]>
markNodeCompleted(sessionId, npcId, gameDay, nodeId, outcome)
```

### TickProcessor — Execution Engine

Entry points:
- `runPlayerAction(playerNodes, dgsm, npcPlanningAgent, sessionId, language?, registry, ctx)` → `TickResult`
- `resumePlayerAction(playerNodes, previousActions, resumeFromMinutes, remainingMinutes, dgsm, npcPlanningAgent, sessionId, language?, registry, ctx)` → `TickResult`

**Execution flow per tick (5-minute bucket):**
1. Ensure each NPC has detailed nodes available (two-tier refill)
2. Fetch due NPC nodes + filter player nodes in time range
3. Merge & sort (gameTime ASC, DEX DESC), scan unplanned encounters (|relationship| >= 60)
4. Execute all nodes serially via `registry.getHandler(node.type).execute()`
5. Post-execution per node:
   - `character_interaction` success → `updateRelationshipViaLLM()` + mirror write (passive NPC gets event memory)
   - NPC action → write event memory via `NpcMemoryManager`, mark node completed
   - Knowledge transfer → write event memories to all present target NPCs
   - Player `character_interaction` → trigger reasoning on novel information
   - **Player discovery**: evidence from `scene.items[category==="evidence"]` + NPC `knowledge[]`/`secrets[]` (semantic matching, see Scene Architecture above)
   - **Player fumble** → damage random evidence item in scene
   - NPC failure → immediate `revisePlans()` (no gate)
6. Impact propagation: `findAffectedCharacters()` → batch `runImpactGateForNpc()` → `revisePlans()`/`reviseSchedule()`
7. Feature temporal tick → feature overlay detection → feature propagation
8. Drain pending sanity emotions
9. Store player witness events in contextualData for KeeperAgent

**Multi-tick loop:** `runPlayerAction` loops in 5-min increments over `playerNode.timeAdvanceMinutes`. On `player_interrupt` (witness events), returns early so player can react. On day change, triggers `onNewDay()` (new daily schedules).

### GameEngineRegistry — Pluggable Architecture

```typescript
interface NodeHandler {
  type: string;                         // e.g. "movement", "fire_spread"
  execute(node, dgsm, ctx): CharacterAction;
  description: string;                  // For LLM prompt injection
  requiredFields: string[];
  optionalFields?: string[];
  exampleNode: Partial<PlanNode>;
}

interface WorldFeature {
  id: string;                           // e.g. "fire", "lighting"
  planningPrompt: string;               // Injected into planning agent prompts
  planNodeSchema?: FeatureNodeSchema;    // Output fields for LLM
  propagation?: FeaturePropagationConfig;
  stateDescription(dgsm): string;
  tick?(dgsm, runtime): void;           // Time-driven state updates
  activate?(node, dgsm): void;          // On first detection of overlay fields
  propagate?(sourceScene, hop, dgsm, runtime): Promise<PropagationResult>;
  getCharacterSkillModifiers?(characterId, dgsm): Array<{ skill: string; delta: number }>;
}
```

**Built-in handlers:** `routineHandler`, `movementHandler`, `characterInteractionHandler`, `objectInteractionHandler`, `sceneInteractionHandler`

**Built-in features:** `fireFeature`, `lightingFeature`, `weatherFeature`, `sanityFeature`, `staminaFeature`

### DynamicGameState — NPC Planning Runtime Fields

```typescript
interface DynamicGameState {
  // ... existing fields ...

  // NPC Planning runtime state
  npcLocations: Record<string, string>;                    // npcId → scenarioId
  npcStats: Record<string, { hp: number; san: number }>;
  npcInventories: Record<string, Item[]>;                  // npcId → items
  npcDiscoveredKnowledge: Record<string, string[]>;        // npcId → knowledge IDs
  npcRelationshipGraph: Record<string, Record<string, { score: number; note: string }>>;
  scenarioConditions: Record<string, SceneCondition[]>;    // sceneId → conditions
  blockedConnections: Map<string, string>;                 // "sceneA::sceneB" → reason
  npcResidences: Record<string, string>;                   // npcId → macroLocationId
}

interface DynamicTemporaryInfo {
  rules: string[];
  contextualData: Record<string, any>;
  playerNodes: PlanNode[];           // From Orchestrator (tick-plan system)
  characterActions: CharacterAction[]; // From TickProcessor (player + NPC)
}
```

### Prisma Schema (NPC Planning Tables)

```prisma
model NpcLongTermIntent {
  id, sessionId, moduleId, npcId, npcName, intent, updatedAt, createdAt
  @@index([sessionId])
  @@map("npc_long_term_intents")
}

model NpcDailyPlan {
  id, sessionId, moduleId, npcId, npcName, gameDay
  nodes: Json       // PlanNode[]
  schedule: Json?   // ScheduleEntry[]
  @@unique([sessionId, npcId, gameDay])
  @@index([sessionId, gameDay])
  @@map("npc_daily_plans")
}

model NpcMemory {
  id, sessionId, moduleId, npcId, type: NpcMemoryType
  content, metadata: Json?, tags: String[]
  gameDay, gameTime, location?
  importance, baseImportance, accessCount, lastAccessedAt
  embedding: Bytes?
  @@map("npc_memories")
}
```

**Note:** NPC action logs are stored as `NpcMemory` entries (type = action_log), not as a separate table.

### Graph Integration

In `src/dynamicworldagent/graph/dynamicGraph.ts`:

```typescript
import { NPCPlanningAgent } from "../dynamicBasicAgent/npcPlanning/NPCPlanningAgent.js";
import { PlayerPlanAgent } from "../dynamicBasicAgent/npcPlanning/PlayerPlanAgent.js";
import { runPlayerAction, resumePlayerAction } from "../dynamicBasicAgent/npcPlanning/tickProcessor.js";

const npcPlanningAgent = new NPCPlanningAgent(prisma, {});
const playerPlanAgent = new PlayerPlanAgent({});
const registry = createDefaultRegistry();
const executionCtx = createExecutionContext(registry);
```

## Known Issues & Limitations

1. **Single Player Only**: Multiplayer support under development
2. **RAG Disabled**: System being redesigned for better retrieval
3. **Frontend UX**: UI improvements in progress
4. **Large App.tsx**: Main app component is 82KB, needs refactoring
5. **Time Mechanics**: Still experimental on `weaktime` branch

## API Architecture (client/server)

The backend API is organized by domain:

**Authentication** (`/api/auth/*`):
- POST `/login`, `/register`, `/logout`
- JWT-based with refresh tokens
- Session management with idle timeout

**Game Management** (`/api/game/*`):
- POST `/game/init`: Initialize new game session
- GET `/game/:sessionId`: Get current game state
- PUT `/game/:sessionId`: Update game state

**Turn Execution** (`/api/turns/*`, `/api/sessions/*`):
- POST `/turns/:sessionId`: Execute player action (invokes LangGraph)
- GET `/sessions/:sessionId/turns`: Get turn history
- WebSocket `/ws`: Real-time game state updates

**Character Management** (`/api/character*`):
- GET `/characters`: List all characters in session
- POST `/character`: Create new character
- PUT `/character/:id`: Update character

**Module Management** (`/api/mod/*`, `/api/module/*`):
- GET `/mods`: List available modules
- POST `/mod/load`: Load specific module into session

**Checkpoint System** (`/api/checkpoints/*`):
- POST `/checkpoints/:sessionId`: Create save point
- GET `/checkpoints/:sessionId`: List checkpoints
- POST `/checkpoints/:checkpointId/restore`: Load from checkpoint

## Development Best Practices

### Code Style

- TypeScript strict mode with NodeNext ES modules
- Always use `.js` extensions on internal imports (ESM requirement)
- 2-space indentation (enforced by Biome)
- Explicit return types preferred
- Avoid `any` type

### Agent Development

When adding/modifying agents:
1. Agent logic goes in `src/shared/agents/[agent-name]/[agent-name]Agent.ts`
2. Prompt templates in `[agent-name]Template.ts`
3. Update `src/graph.ts` to wire into pipeline
4. Update `GraphState` or `GameState` if new state fields needed
5. Document agent's role and outputs

### Database Access

- Always use `DatabaseManager.getInstance()` singleton
- Never mutate database directly in agent code
- Use TurnManager for persisting turns
- Use CheckpointManager for save/restore
- Close database on shutdown (handled in `client/server.ts`)

### Module Creation

See README.md section "How to Upload Your Own Module" for detailed instructions. Key points:
- Use structured JSON for complex data
- Documents (.docx, .pdf) work for rapid prototyping
- Always include `module_digest.json`
- Test with standalone loaders before running full game

## Monorepo Structure

This is a pnpm workspace with two packages:
- Root: Backend (Express server, LangGraph agents)
- `client/`: Frontend (React app)

**Shared Dependencies:** Root `pnpm install` installs both backend and frontend dependencies.

**Build System:** Turbo.json configures monorepo tasks. Use `pnpm build:turbo` for optimized builds.
