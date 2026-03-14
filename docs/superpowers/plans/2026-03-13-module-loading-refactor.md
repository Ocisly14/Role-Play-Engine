# Module Loading Refactor Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the complex multi-table module loading pipeline with three JSON-blob tables and a clean three-step loading API.

**Architecture:** Add three new Prisma tables (`module_npcs`, `module_scenes`, `module_setups`) storing raw JSON. Create `moduleImporter.ts` to import JSON files into these tables. Create `moduleLoader.ts` with `loadModule()` → `createSession()` → `initRuntime()`. Delete old tables and loaders.

**Tech Stack:** TypeScript, Prisma, SQLite

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `prisma/schema.prisma` | Add 3 new tables, remove 6 old tables, update Module relations |
| Create | `src/dynamicworldagent/state/moduleImporter.ts` | Import JSON files → DB |
| Create | `src/dynamicworldagent/state/moduleLoader.ts` | `loadModule()` + `createSession()` + `initRuntime()` |
| Modify | `src/dynamicworldagent/state/DynamicGameStateLoader.ts` | Replace `initializeCompleteDynamicGameState` to delegate to new API |
| Delete | `src/dynamicworldagent/memory/bootstrapNpcMemory.ts` | Logic merged into `createSession` |
| Modify | `src/dynamicworldagent/memory/index.ts` | Remove bootstrapNpcMemory export |
| Modify | `src/dynamicworldagent/state/types.ts` | Remove `ItemContexts` import if unused |

---

## Chunk 1: Schema + Import

### Task 1: Add three new Prisma tables

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add ModuleNpc, ModuleScene, ModuleSetup models**

Add after the `Module` model block:

```prisma
model ModuleNpc {
  moduleId String @map("module_id") @db.Uuid
  npcId    String @map("npc_id")
  data     Json

  module Module @relation(fields: [moduleId], references: [moduleId], onDelete: Cascade)

  @@id([moduleId, npcId])
  @@map("module_npcs")
}

model ModuleScene {
  moduleId String @map("module_id") @db.Uuid
  entryId  String @map("entry_id")
  data     Json

  module Module @relation(fields: [moduleId], references: [moduleId], onDelete: Cascade)

  @@id([moduleId, entryId])
  @@map("module_scenes")
}

model ModuleSetup {
  moduleId String @id @map("module_id") @db.Uuid
  data     Json

  module Module @relation(fields: [moduleId], references: [moduleId], onDelete: Cascade)

  @@map("module_setups")
}
```

Add relation fields to `Module` model:

```prisma
  moduleNpcs    ModuleNpc[]
  moduleScenes  ModuleScene[]
  moduleSetup   ModuleSetup?
```

- [ ] **Step 2: Remove old table models from schema**

Delete these model blocks from `prisma/schema.prisma`:
- `Character` (lines 189-219)
- `NpcKnowledge` (lines 221-237)
- `NpcRelationship` (lines 239-258)
- `Scenario` (lines 364-387)
- `Scene` (lines 389-411)
- `ScenarioCondition` (lines 413-426)

Remove their relation fields from `Module` model:
- `scenarioConds  ScenarioCondition[]`
- `scenes         Scene[]`
- `scenarios      Scenario[]`

- [ ] **Step 3: Push schema changes**

Run: `npx prisma db push`

Note: This will drop data in the deleted tables. That's expected.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "refactor(schema): add module_npcs/module_scenes/module_setups, remove old Character/Scene/Scenario tables"
```

### Task 2: Create moduleImporter.ts

**Files:**
- Create: `src/dynamicworldagent/state/moduleImporter.ts`

- [ ] **Step 1: Implement importModule**

```typescript
/**
 * Import a module from the filesystem into the database.
 * Reads JSON files and stores them as-is in module_npcs, module_scenes, module_setups.
 * Idempotent — uses upsert on compound PKs.
 */

import fs from "fs";
import path from "path";
import type { PrismaClient } from "@prisma/client";

export async function importModule(params: {
  prisma: PrismaClient;
  moduleDir: string;
  moduleName: string;
  emailId?: string;
}): Promise<string> {
  const { prisma, moduleDir, moduleName, emailId } = params;

  // 1. Upsert Module record
  const normalizedName = moduleName.toLowerCase().replace(/\s+/g, "_");
  const mod = await prisma.module.upsert({
    where: {
      uq_modules_owner_name_normalized: {
        ownerEmailId: emailId ?? "__system__",
        moduleNameNormalized: normalizedName,
      },
    },
    create: {
      moduleName: moduleName,
      moduleNameNormalized: normalizedName,
      ownerEmailId: emailId ?? "__system__",
    },
    update: {
      updatedAt: new Date(),
    },
  });
  const moduleId = mod.moduleId;

  // 2. Import module_setup.json
  const setupPath = path.join(moduleDir, "module_setup.json");
  if (fs.existsSync(setupPath)) {
    const data = JSON.parse(fs.readFileSync(setupPath, "utf8"));
    await prisma.moduleSetup.upsert({
      where: { moduleId },
      create: { moduleId, data },
      update: { data },
    });
  }

  // 3. Import scenarios_outline.json
  const outlinesPath = path.join(moduleDir, "scenarios_outline.json");
  if (fs.existsSync(outlinesPath)) {
    const data = JSON.parse(fs.readFileSync(outlinesPath, "utf8"));
    await prisma.moduleScene.upsert({
      where: { moduleId_entryId: { moduleId, entryId: "__scenarios_outline__" } },
      create: { moduleId, entryId: "__scenarios_outline__", data },
      update: { data },
    });
  }

  // 4. Import transport_edges.json
  const edgesPath = path.join(moduleDir, "transport_edges.json");
  if (fs.existsSync(edgesPath)) {
    const data = JSON.parse(fs.readFileSync(edgesPath, "utf8"));
    await prisma.moduleScene.upsert({
      where: { moduleId_entryId: { moduleId, entryId: "__transport_edges__" } },
      create: { moduleId, entryId: "__transport_edges__", data },
      update: { data },
    });
  }

  // 5. Import scene/junction/road files
  const scenarioDirs = fs.readdirSync(moduleDir).filter((d) => {
    const full = path.join(moduleDir, d);
    return fs.statSync(full).isDirectory() && d.endsWith("_Scenarios");
  });
  for (const dir of scenarioDirs) {
    const scenariosDir = path.join(moduleDir, dir);
    const files = fs.readdirSync(scenariosDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(scenariosDir, file), "utf8"));
      const entryId = data.id ?? path.basename(file, ".json");
      await prisma.moduleScene.upsert({
        where: { moduleId_entryId: { moduleId, entryId } },
        create: { moduleId, entryId, data },
        update: { data },
      });
    }
  }

  // 6. Import NPC files
  const npcDirs = fs.readdirSync(moduleDir).filter((d) => {
    const full = path.join(moduleDir, d);
    return fs.statSync(full).isDirectory() && (d.endsWith("_npc") || d.endsWith("'s_npc"));
  });
  for (const dir of npcDirs) {
    const npcsDir = path.join(moduleDir, dir);
    const files = fs.readdirSync(npcsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const raw = fs.readFileSync(path.join(npcsDir, file), "utf8");
      const parsed = JSON.parse(raw);
      // NPC files can be a single object or an array
      const npcs = Array.isArray(parsed) ? parsed : [parsed];
      for (const npc of npcs) {
        const npcId = npc.id ?? path.basename(file, ".json");
        await prisma.moduleNpc.upsert({
          where: { moduleId_npcId: { moduleId, npcId } },
          create: { moduleId, npcId, data: npc },
          update: { data: npc },
        });
      }
    }
  }

  console.log(`[ModuleImporter] Imported module "${moduleName}" (${moduleId})`);
  return moduleId;
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/state/moduleImporter.ts
git commit -m "feat(module): add moduleImporter — imports JSON files into module_npcs/module_scenes/module_setups"
```

---

## Chunk 2: Loading API

### Task 3: Create moduleLoader.ts

**Files:**
- Create: `src/dynamicworldagent/state/moduleLoader.ts`

- [ ] **Step 1: Define ModuleData type and implement loadModule**

```typescript
/**
 * Module loading API — three-step pipeline.
 * loadModule() → createSession() → initRuntime()
 */

import type { PrismaClient } from "@prisma/client";
import type { EmbeddingClient } from "../../rag/embedding.js";
import { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { DynamicGameState } from "./DynamicGameState.js";
import { buildTopology } from "./topologyTypes.js";
import type {
  JunctionNode,
  RoadNode,
  TownTopology,
  TransportEdge,
} from "./topologyTypes.js";
import type {
  DynamicNPCProfile,
  DynamicScene,
  ModuleSetup,
  ScenarioOutline,
} from "./types.js";

export interface ModuleData {
  moduleId: string;
  moduleName: string;
  setup: ModuleSetup | null;
  npcs: DynamicNPCProfile[];
  scenes: Map<string, DynamicScene>;
  junctions: Map<string, JunctionNode>;
  roads: Map<string, RoadNode>;
  scenarioOutlines: ScenarioOutline[];
  transportEdges: TransportEdge[];
}

/**
 * Step 1: Load module data from DB. Pure data, no side effects.
 */
export async function loadModule(
  prisma: PrismaClient,
  moduleId: string
): Promise<ModuleData | null> {
  const mod = await prisma.module.findUnique({
    where: { moduleId },
    select: { moduleId: true, moduleName: true },
  });
  if (!mod) return null;

  // Load setup
  const setupRow = await prisma.moduleSetup.findUnique({
    where: { moduleId },
  });
  const setup = (setupRow?.data as ModuleSetup) ?? null;

  // Load all scene entries
  const sceneRows = await prisma.moduleScene.findMany({
    where: { moduleId },
  });

  const scenes = new Map<string, DynamicScene>();
  const junctions = new Map<string, JunctionNode>();
  const roads = new Map<string, RoadNode>();
  let scenarioOutlines: ScenarioOutline[] = [];
  let transportEdges: TransportEdge[] = [];

  for (const row of sceneRows) {
    const data = row.data as any;
    if (row.entryId === "__scenarios_outline__") {
      scenarioOutlines = Array.isArray(data) ? data : [];
    } else if (row.entryId === "__transport_edges__") {
      transportEdges = Array.isArray(data)
        ? data
        : data?.transportEdges ?? [];
    } else if (row.entryId.startsWith("JUNC_")) {
      junctions.set(row.entryId, data as JunctionNode);
    } else if (row.entryId.startsWith("ROAD_")) {
      roads.set(row.entryId, data as RoadNode);
    } else {
      scenes.set(row.entryId, data as DynamicScene);
    }
  }

  // Load NPCs
  const npcRows = await prisma.moduleNpc.findMany({
    where: { moduleId },
  });
  const npcs = npcRows.map((row) => row.data as unknown as DynamicNPCProfile);

  return {
    moduleId: mod.moduleId,
    moduleName: mod.moduleName,
    setup,
    npcs,
    scenes,
    junctions,
    roads,
    scenarioOutlines,
    transportEdges,
  };
}

/**
 * Step 2: Create session and bootstrap NPC memory.
 */
export async function createSession(
  prisma: PrismaClient,
  params: {
    sessionId: string;
    moduleId: string;
    moduleData: ModuleData;
    embedClient: EmbeddingClient;
    emailId?: string;
  }
): Promise<void> {
  const { sessionId, moduleId, moduleData, embedClient, emailId } = params;

  // Upsert session
  await prisma.session.upsert({
    where: { sessionId },
    create: {
      sessionId,
      moduleId,
      emailId: emailId || null,
      modName: moduleData.moduleName || undefined,
      characterId: null,
      characterName: null,
      status: "active",
      metadata: {},
    },
    update: {
      lastActivityAt: new Date(),
      moduleId,
      emailId: emailId || null,
      modName: moduleData.moduleName || undefined,
    },
  });

  // Bootstrap NPC memory from profile.memory[]
  const memoryManager = new NpcMemoryManager(prisma, embedClient);

  for (const npc of moduleData.npcs) {
    if (!npc.memory || npc.memory.length === 0) continue;

    // Idempotent: skip if NPC already has memories
    const existing = await prisma.npcMemory.count({
      where: { npcId: npc.id, sessionId },
    });
    if (existing > 0) continue;

    for (const entry of npc.memory) {
      if (!entry.content || entry.content.trim() === "") continue;
      await memoryManager.add({
        npcId: npc.id,
        sessionId,
        moduleId,
        type: entry.type as any,
        content: entry.content.trim(),
        gameDay: 1,
        gameTime: "00:00",
        metadata: entry.metadata,
      });
    }
  }
}

/**
 * Step 3: Build DynamicGameState with runtime fields. Pure, no DB access.
 */
export function initRuntime(params: {
  sessionId: string;
  moduleData: ModuleData;
  gameDay: number;
  timeOfDay: string;
}): DynamicGameState {
  const { sessionId, moduleData, gameDay, timeOfDay } = params;

  // Merge all spatial data into flat scenes map
  const allScenes = new Map(moduleData.scenes);
  for (const [id, junc] of moduleData.junctions) {
    allScenes.set(id, junc as unknown as DynamicScene);
  }
  for (const [id, road] of moduleData.roads) {
    allScenes.set(id, road as unknown as DynamicScene);
  }

  // Build topology
  const topology: TownTopology | null =
    moduleData.junctions.size > 0 || moduleData.roads.size > 0
      ? buildTopology(moduleData.junctions, moduleData.roads)
      : null;

  // Determine default starting scene
  const defaultSceneId =
    moduleData.scenarioOutlines?.[0]?.entrySceneId ??
    moduleData.scenarioOutlines?.[0]?.id ??
    "unknown";

  // Initialize runtime NPC state
  const npcLocations: Record<string, string> = {};
  const npcStats: Record<string, { hp: number; san: number }> = {};
  const npcInventories: Record<string, any[]> = {};
  const npcRelationshipGraph: Record<
    string,
    Record<string, { score: number; note: string }>
  > = {};
  const npcResidences: Record<string, string> = {};
  const characterPositions: Record<string, any> = {};

  // Build residence lookup from scenarioOutlines
  const residentToLocation: Record<string, string> = {};
  for (const outline of moduleData.scenarioOutlines) {
    if (outline.residents) {
      for (const residentId of outline.residents as string[]) {
        residentToLocation[residentId] = outline.id;
      }
    }
  }

  for (const npc of moduleData.npcs) {
    // Location: use residence if available, else default
    const residence = npc.residence ?? residentToLocation[npc.id];
    npcLocations[npc.id] = residence ?? defaultSceneId;
    if (residence) npcResidences[npc.id] = residence;

    // Stats
    npcStats[npc.id] = {
      hp: npc.status?.hp ?? npc.attributes?.CON ?? 10,
      san: npc.status?.sanity ?? npc.attributes?.POW ?? 50,
    };

    // Inventory
    npcInventories[npc.id] = Array.isArray(npc.inventory)
      ? npc.inventory.map((item: any) => {
          if (typeof item === "string") return { id: item, name: item };
          return { id: item.name ?? String(item), name: item.name ?? String(item), ...(item.properties ?? {}) };
        })
      : [];

    // Relationships
    const rels: Record<string, { score: number; note: string }> = {};
    for (const rel of npc.relationships ?? []) {
      if (rel.targetId) {
        rels[rel.targetId] = {
          score: (rel as any).score ?? rel.attitude ?? 0,
          note: (rel as any).note ?? "",
        };
      }
    }
    npcRelationshipGraph[npc.id] = rels;
  }

  // Build scenarioConditions from scenes
  const scenarioConditions: Record<string, any[]> = {};
  for (const [sceneId, scene] of allScenes) {
    if (scene.conditions && scene.conditions.length > 0) {
      scenarioConditions[sceneId] = scene.conditions;
    }
  }

  return {
    sessionId,
    scenes: allScenes,
    gameDay,
    timeOfDay,
    npcCharacters: moduleData.npcs,
    moduleName: moduleData.moduleName,
    moduleSetup: moduleData.setup,
    scenarioOutlines: moduleData.scenarioOutlines,
    featureState: {},
    npcLocations,
    npcStats,
    npcInventories,
    npcRelationshipGraph,
    scenarioConditions,
    blockedConnections: new Map(),
    npcResidences,
    transportEdges: moduleData.transportEdges,
    topology,
    characterPositions,
    loadedAt: new Date(),
    lastUpdated: new Date(),
  };
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`

- [ ] **Step 3: Commit**

```bash
git add src/dynamicworldagent/state/moduleLoader.ts
git commit -m "feat(module): add moduleLoader — loadModule/createSession/initRuntime three-step API"
```

---

## Chunk 3: Wire Up + Cleanup

### Task 4: Update DynamicGameStateLoader to use new API

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameStateLoader.ts`

- [ ] **Step 1: Rewrite initializeCompleteDynamicGameState**

Replace the body of `initializeCompleteDynamicGameState` to delegate to the new three-step API. Keep the same function signature for backward compatibility with callers:

```typescript
import { ModelProviderName } from "../../models/types.js";
import { EmbeddingClient } from "../../rag/embedding.js";
import { getPrismaClient } from "../../shared/agents/memory/database/prismaClient.js";
import {
  resolveModuleIdByName,
} from "../../shared/agents/memory/database/moduleScope.js";
import { resolveEmailId } from "../../shared/agents/memory/database/userContext.js";
import type { DynamicGameState } from "./DynamicGameState.js";
import { DynamicGameStateManager } from "./DynamicGameState.js";
import { loadModule, createSession, initRuntime } from "./moduleLoader.js";

export async function initializeCompleteDynamicGameState(params: {
  db: any;
  sessionId: string;
  moduleName: string;
  emailId?: string;
}): Promise<DynamicGameState | null> {
  const prisma = getPrismaClient();
  const resolvedEmailId = params.emailId
    ? resolveEmailId(params.emailId)
    : undefined;

  // Resolve moduleId from name
  const moduleId = await resolveModuleIdByName(
    prisma,
    params.moduleName,
    resolvedEmailId
  );
  if (!moduleId) {
    console.warn(`[DynamicGameState] Module "${params.moduleName}" not found`);
    return null;
  }

  // Step 1: Load
  const moduleData = await loadModule(prisma, moduleId);
  if (!moduleData) {
    console.warn(`[DynamicGameState] Failed to load module data for "${params.moduleName}"`);
    return null;
  }

  // Step 2: Session + memory bootstrap
  const embedClient = new EmbeddingClient(
    (process.env.MODEL_PROVIDER as ModelProviderName) || ModelProviderName.OPENAI
  );
  await createSession(prisma, {
    sessionId: params.sessionId,
    moduleId,
    moduleData,
    embedClient,
    emailId: resolvedEmailId,
  });

  // Step 3: Build runtime state
  // Parse initial game time from ModuleBackground if available
  const bg = await prisma.moduleBackground.findUnique({ where: { moduleId } });
  let gameDay = 1;
  let timeOfDay = "08:00";
  if (bg?.initialGameTime) {
    const parsed = parseInitialGameTime(bg.initialGameTime);
    if (parsed) {
      if (parsed.gameDay) gameDay = parsed.gameDay;
      timeOfDay = parsed.timeOfDay;
    }
  }

  const state = initRuntime({
    sessionId: params.sessionId,
    moduleData,
    gameDay,
    timeOfDay,
  });

  console.log(
    `[DynamicGameState] Initialized module "${params.moduleName}" — ${moduleData.npcs.length} NPCs, ${moduleData.scenes.size} scenes`
  );
  return state;
}
```

Keep the `parseInitialGameTime` helper function unchanged. Remove all other functions and imports that are no longer needed (loadDynamicGameState, loadModuleSetupFromFiles, normalizeIdToModuleScope, old imports).

- [ ] **Step 2: Remove old imports and unused code**

Remove from imports:
- `NPCLoader`
- `WorldModuleLoader`
- `bootstrapNpcMemory`
- `decodeSceneItemsPayload`
- `initialDynamicGameState`
- `fs`, `path` (if no longer needed)
- `CoCDatabase`, `CoCDatabaseAdapter`
- `scopeIdByModule`, `stripModuleScope`
- `SceneCondition`
- `DynamicScene`, `ModuleSetup` (if not used directly)

Remove old functions:
- `loadModuleSetupFromFiles()`
- `normalizeIdToModuleScope()`
- `loadDynamicGameState()` (the old one)
- The entire old `initializeCompleteDynamicGameState()` body

- [ ] **Step 3: Verify build**

Run: `pnpm build`

- [ ] **Step 4: Commit**

```bash
git add src/dynamicworldagent/state/DynamicGameStateLoader.ts
git commit -m "refactor(loader): rewrite initializeCompleteDynamicGameState to use three-step moduleLoader API"
```

### Task 5: Delete bootstrapNpcMemory.ts and clean up

**Files:**
- Delete: `src/dynamicworldagent/memory/bootstrapNpcMemory.ts`
- Modify: `src/dynamicworldagent/memory/index.ts`

- [ ] **Step 1: Delete bootstrapNpcMemory.ts**

```bash
rm src/dynamicworldagent/memory/bootstrapNpcMemory.ts
```

- [ ] **Step 2: Remove export from index.ts**

Remove this line from `src/dynamicworldagent/memory/index.ts`:
```typescript
export { bootstrapNpcMemory } from "./bootstrapNpcMemory.js";
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: delete bootstrapNpcMemory — logic now in moduleLoader.createSession"
```

### Task 6: Final verification

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 2: Run lint/format**

Run: `pnpm check`

- [ ] **Step 3: Update CLAUDE.md**

Update the Module Loading section to document the new three-step API and the new table structure. Remove references to WorldModuleLoader, NPCLoader, old tables.

- [ ] **Step 4: Update state/README.md**

Document the new loading flow.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: update CLAUDE.md and README for new module loading architecture"
```
