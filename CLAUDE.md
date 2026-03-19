# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CoC NPC Simulation System is an autonomous NPC simulation engine for Call of Cthulhu (7th Edition) scenarios. The system uses a two-tier hierarchical planning architecture with pluggable handlers and world features to simulate NPC behaviors, interactions, and world events without player input.

**Tech Stack:** TypeScript, Prisma, SQLite

**Main Branch:** `main` (use for PRs)

## Essential Commands

### Development Workflow

```bash
# Install dependencies (required: pnpm >= 9.0.0)
pnpm install

# Build the project (compiles TypeScript to dist/)
pnpm build
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

### Core: NPC Simulation Engine

The system runs autonomous NPC simulation via `SimulationRunner` → `TickProcessor` in 1-minute time buckets. No player input pipeline exists.

```
SimulationRunner.start()
  → loop: runSimulationTick()
    → executeSingleTick() (1-min bucket)
      → Ensure NPC nodes (two-tier planning refill)
      → Fetch due NPC nodes
      → Execute via NodeHandlers
      → Post-execution (memory, relationships, knowledge transfer)
      → Impact propagation → plan revision
      → WorldFeature temporal ticks + propagation
      → Drain sanity emotions
```

### Project Structure

```
CoC-AI-agent/
├── src/
│   ├── dynamicworldagent/                  # NPC Simulation System (core)
│   │   ├── dynamicBasicAgent/npcPlanning/  # Two-tier NPC planning system
│   │   ├── engine/                         # Pluggable NodeHandlers + WorldFeatures
│   │   │   ├── handlers/                   # movement, routine, object, character, scene
│   │   │   ├── features/                   # fire, lighting, weather, sanity, stamina
│   │   │   └── shared/                     # Dice, skill rolls, pathfinding, topology
│   │   ├── simulation/                     # SimulationRunner (autonomous tick loop)
│   │   ├── state/DynamicGameState.ts       # DynamicGameState types + manager
│   │   ├── world_builder/                  # Scene/topology type definitions
│   │   └── memory/NpcMemoryManager.ts      # Unified NPC memory with retrieval
│   └── rag/                               # Embedding utilities (for semantic matching)
│
├── data/
│   └── Mods/                              # Module packages
│       └── [Module Name]/
│           ├── module_digest.json         # Module metadata
│           ├── npc/                        # NPC profiles (JSON)
│           └── [Module]_Scenarios/        # Scenario/location files
│
├── testmods/                              # Test module data (e.g. casssandra/)
├── prisma/schema.prisma                   # Database schema
└── test-*.ts                              # Standalone loader tests
```

## Key Workflows

### Simulation Execution Flow

1. Initialize `DynamicGameStateManager` with module data (scenes, NPCs, topology)
2. `NPCPlanningAgent.seedLongTermIntents()` — set NPC goals from character profiles
3. `NPCPlanningAgent.onNewDay()` — generate daily schedules for all NPCs
4. `SimulationRunner.start()` — begin autonomous tick loop:
   - Each tick = 1 minute of game time
   - NPC nodes are generated on-demand from schedule entries (two-tier refill)
   - Nodes executed via `GameEngineRegistry` handlers
   - Impact propagation triggers plan revision for affected NPCs
   - Day transitions trigger new daily schedules

### Module Loading

The system supports custom Call of Cthulhu scenario modules with NPCs, locations, and topology.

**Module Structure:**
- `module_digest.json`: Title, background, story outline, initial game time
- `npc/`: NPC profile JSON files
- `[Module]_Scenarios/`: Scene, road, and junction JSON files
- `scenarios_outline.json`: Macro location definitions
- `transport_network.json`: Outdoor topology edges

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

# Database (Prisma)
DATABASE_URL=file:./data/db.sqlite
```

**Model Strategy:**
- SMALL models: Daily schedule generation, impact gate (fast, structured output)
- MEDIUM models: Detailed node generation, plan revision (richer decisions)

### Embedding / Semantic Matching

Basic embedding functionality in `src/rag/` is used for:
- Discovery system: cosine similarity matching of NPC knowledge/evidence against action descriptions
- Not a full RAG pipeline — just point-to-point similarity

## Important Implementation Details

### Time System

Game time is tracked via `DynamicGameState`:
- `gameDay`: Current day number
- `timeOfDay`: HH:MM format
- Time advances in 1-minute tick increments via `TickProcessor`
- Day transitions trigger `NPCPlanningAgent.onNewDay()` (new daily schedules)

### Action Types (8 Categories)

CoC 7e mechanics organized into 8 action types:
1. **Exploration**: Finding clues, gathering information
2. **Social**: Influencing NPCs, persuasion, interrogation
3. **Combat**: Fighting, causing damage
4. **Stealth**: Sneaking, hiding, acting undetected
5. **Chase**: Pursuit or escape
6. **Mental**: Sanity checks, resisting psychological horror
7. **Environmental**: Surviving harsh conditions, physical endurance
8. **Narrative**: Key story choices, plot decisions

NPC plan nodes use `actionType` from these categories. Skill mapping in `actionTypeSkillMap.ts`.

## Testing

**When Adding Tests:**
- Place in `tests/` or alongside modules as `*.spec.ts`
- Use Vitest (`vitest.config.ts` is configured)
- Run `pnpm build` to catch type errors

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
- Triggered on successful `scene_interaction` or `object_interaction`
- Candidates: `scene.items[]` where `category === "evidence"` and `!damaged`
- Item difficulty: has `discoveryMethod` → `"regular"`; no `discoveryMethod` → `"automatic"`
- ActionType must be a discovery type (exploration/social/stealth/narrative) to find non-automatic items; otherwise only automatic items are returned

**2. NPC Knowledge Discovery** (character interaction):
- Triggered on successful `character_interaction`
- Candidates: target NPC's `knowledge[]` (unrevealed, uses `knowledge.difficulty` field: regular/hard/extreme) + `secrets[]` (treated as hard difficulty)
- **Relationship score** gates difficulty: ≥80→extreme, ≥70→hard, ≥60→regular, <60→automatic only

**Success level → max discoverable difficulty:**
- `critical` → extreme | `hard` → hard | `regular` → regular | `fail` → automatic only | `fumble` → nothing + may damage evidence

**Semantic matching:** Non-automatic candidates matched via embedding cosine similarity (threshold 0.7) against action description.

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
│   ├── tickProcessor.ts          # Execution engine: 1-min buckets, discovery, impact propagation
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
├── simulation/
│   └── SimulationRunner.ts        # Autonomous tick loop runner
├── state/
│   └── DynamicGameState.ts        # DynamicGameState types + DynamicGameStateManager
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
  difficulty?: "regular" | "hard" | "extreme" | "luck_only";
  successLevel?: "critical" | "hard" | "regular" | "fail" | "fumble";
  status: "completed" | "failed";
  outcome: string;
  failureReason?: FailureReason;
  targetCharacterId?: string;
  discoveries?: DiscoveryEntry[];
  damagedEvidence?: { itemId: string; sourceName: string };
}

interface SimulationTickResult {
  actions: CharacterAction[];
  dayTransition: boolean;
}
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

Entry point:
- `runSimulationTick(dgsm, npcPlanningAgent, sessionId, language?, registry, ctx)` → `SimulationTickResult`

**Execution flow per tick (1-minute bucket):**
1. Ensure each NPC has detailed nodes available (two-tier refill)
2. Fetch due NPC nodes for current time range
3. Sort (gameTime ASC, DEX DESC), scan unplanned encounters (|relationship| >= 60)
4. Execute all nodes serially via `registry.getHandler(node.type).execute()`
5. Post-execution per node:
   - `character_interaction` success → `updateRelationshipViaLLM()` + mirror write (passive NPC gets event memory)
   - NPC action → write event memory via `NpcMemoryManager`, mark node completed
   - Knowledge transfer → write event memories to all present target NPCs
   - Discovery: evidence from `scene.items[category==="evidence"]` + NPC `knowledge[]`/`secrets[]` (semantic matching)
   - Fumble → damage random evidence item in scene
   - NPC failure → immediate `revisePlans()` (no gate)
6. Impact propagation: `findAffectedCharacters()` → batch `runImpactGateForNpc()` → `revisePlans()`/`reviseSchedule()`
7. Feature temporal tick → feature overlay detection → feature propagation
8. Drain pending sanity emotions

**Day transitions:** On day change, triggers `onNewDay()` (new daily schedules for all NPCs).

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
  characterActions: CharacterAction[]; // From TickProcessor (NPC actions)
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

### SimulationRunner Integration

```typescript
import { NPCPlanningAgent } from "../dynamicBasicAgent/npcPlanning/NPCPlanningAgent.js";
import { runSimulationTick } from "../dynamicBasicAgent/npcPlanning/tickProcessor.js";

const npcPlanningAgent = new NPCPlanningAgent(prisma, {});
const registry = createDefaultRegistry();
const executionCtx = createExecutionContext(registry);
```

## Development Best Practices

### Code Style

- TypeScript strict mode with NodeNext ES modules
- Always use `.js` extensions on internal imports (ESM requirement)
- 2-space indentation (enforced by Biome)
- Explicit return types preferred
- Avoid `any` type

### Extending the Engine

**Adding a NodeHandler:**
1. Implement `NodeHandler` interface in `src/dynamicworldagent/engine/handlers/`
2. Register in `registerDefaults.ts` via `registry.registerHandler()`
3. Handler's `description` and `exampleNode` are auto-injected into LLM planning prompts

**Adding a WorldFeature:**
1. Implement `WorldFeature` interface in `src/dynamicworldagent/engine/features/`
2. Register in `registerDefaults.ts` via `registry.registerFeature()`
3. Feature's `planningPrompt` and `planNodeSchema` are auto-injected into LLM planning prompts

### Database Access

- Use Prisma client for all DB access
- NPC planning data: `NpcDailyPlan`, `NpcLongTermIntent`, `NpcMemory` tables
- Simulation events: `SimulationEvent` table

### Module Creation

Key points:
- Use structured JSON for scene/NPC data
- Always include `module_digest.json`
- Scenes: `SCN_*.json`, Roads: `ROAD_*.json`, Junctions: `JUNC_*.json`
- NPC profiles: JSON files in `npc/` directory
- Topology: `scenarios_outline.json` + `transport_network.json`
