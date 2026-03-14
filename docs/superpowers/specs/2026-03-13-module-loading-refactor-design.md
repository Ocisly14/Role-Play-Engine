# Module Loading Refactor Design

## Goal

Simplify module loading by replacing the complex multi-table schema and multi-loader pipeline with three JSON-blob tables and a clean three-step loading API.

## Current State (to be replaced)

```
JSON files → WorldModuleLoader → 7+ tables (Character, NpcKnowledge, NpcRelationship, Scenario, Scene, ScenarioCondition)
           → DynamicGameStateLoader → reads all tables, reassembles via NPCLoader → DynamicGameState
```

## New Architecture

```
JSON files → ModuleImporter → 3 tables (module_npcs, module_scenes, module_setups)
           → loadModule() → createSession() → initRuntime() → DynamicGameState
```

---

## DB Schema

Three new tables, JSON blob storage. `Module` table retained as parent.

### module_npcs

| Column | Type | Description |
|--------|------|-------------|
| moduleId | UUID (PK) | FK → modules |
| npcId | String (PK) | NPC logical ID |
| data | Json | Full DynamicNPCProfile (with memory[] field) |

### module_scenes

| Column | Type | Description |
|--------|------|-------------|
| moduleId | UUID (PK) | FK → modules |
| entryId | String (PK) | SCN_*, JUNC_*, ROAD_*, `__scenarios_outline__`, `__transport_edges__` |
| data | Json | Full DynamicScene / JunctionNode / RoadNode / ScenarioOutline[] / TransportEdge[] |

### module_setups

| Column | Type | Description |
|--------|------|-------------|
| moduleId | UUID (PK) | FK → modules |
| data | Json | ModuleSetup (introduction, weatherPresets) |

### Tables to delete

- `Character` (characters)
- `NpcKnowledge` (npc_knowledge)
- `NpcRelationship` (npc_relationships)
- `Scenario` (scenarios)
- `Scene` (scenes)
- `ScenarioCondition` (scenario_conditions)

---

## Import Flow

New file: `src/dynamicworldagent/state/moduleImporter.ts`

```typescript
async function importModule(params: {
  prisma: PrismaClient;
  moduleDir: string;
  moduleName: string;
  emailId?: string;
}): Promise<string>  // returns moduleId
```

Steps:
1. Upsert `Module` record, get moduleId
2. Read `module_setup.json` → upsert into `module_setups`
3. Read `scenarios_outline.json` → upsert into `module_scenes` (entryId = `__scenarios_outline__`)
4. Read `transport_edges.json` → upsert into `module_scenes` (entryId = `__transport_edges__`)
5. Scan `{ModuleName}_Scenarios/` → upsert each SCN/JUNC/ROAD JSON into `module_scenes`
6. Scan `{ModuleName}_npc/` → upsert each NPC JSON into `module_npcs`

No transformation — JSON stored as-is. Idempotent via upsert on compound PKs.

---

## Loading Flow

New file: `src/dynamicworldagent/state/moduleLoader.ts`

### Step 1: loadModule

```typescript
async function loadModule(prisma: PrismaClient, moduleId: string): Promise<ModuleData>
```

- Query `module_setups` → `ModuleSetup`
- Query `module_scenes` → classify by entryId prefix:
  - `SCN_*` → `Map<string, DynamicScene>`
  - `JUNC_*` → `Map<string, JunctionNode>`
  - `ROAD_*` → `Map<string, RoadNode>`
  - `__scenarios_outline__` → `ScenarioOutline[]`
  - `__transport_edges__` → `TransportEdge[]`
- Query `module_npcs` → `DynamicNPCProfile[]`

Pure data, no side effects.

### Step 2: createSession

```typescript
async function createSession(prisma: PrismaClient, params: {
  sessionId: string;
  moduleId: string;
  moduleData: ModuleData;
  embedClient: EmbeddingClient;
}): Promise<void>
```

- Upsert `Session` record
- Bootstrap NPC memory from `profile.memory[]` into `NpcMemory` table

### Step 3: initRuntime

```typescript
function initRuntime(params: {
  sessionId: string;
  moduleData: ModuleData;
  gameDay: number;
  timeOfDay: string;
}): DynamicGameState
```

- Merge scenes + junctions + roads into flat `scenes` map
- Build `TownTopology` from junctions + roads
- Initialize runtime fields: npcLocations, npcStats, npcInventories, npcRelationshipGraph, npcResidences, scenarioConditions, characterPositions

---

## Deletion List

| Delete | Reason |
|--------|--------|
| `WorldModuleLoader` (worldModuleLoader.ts) | Replaced by `ModuleImporter` |
| `NPCLoader` usage in simulation | Replaced by `loadModule` |
| `DynamicGameStateLoader.initializeCompleteDynamicGameState()` | Replaced by three-step API |
| `loadDynamicGameState()` | Replaced by `loadModule` |
| `sceneItemContextPayload.ts` | No encoding needed, raw JSON stored |
| `bootstrapNpcMemory.ts` | Logic merged into `createSession` |
| Old DB tables (6 tables listed above) | Replaced by 3 new tables |

### Retained

- `Module` + `ModuleBackground` tables — referenced by sessions/permissions
- `DynamicGameStateManager` — runtime state management unchanged
- `NpcMemory`, `NpcDailyPlan`, `NpcLongTermIntent` tables — simulation runtime data
