# Simplified Scene Architecture — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `DynamicScenarioSnapshot` (14 fields, snapshot history, Director-driven updates) with a flat `DynamicScene` (9 fields, single mutable state per scene, tick-driven).

**Architecture:** A new `DynamicScene` interface replaces `DynamicScenarioSnapshot`. State changes from `currentScenario` object + `updatedDynamicScenarioSnapshots` history Map to `currentSceneId` string + `scenes` flat Map. Character presence is derived from NPC `currentLocation` instead of being stored on the scene. The tick processor becomes the single scene writer.

**Tech Stack:** TypeScript, LangGraph, Prisma (SQLite)

**Scope:** Single-player only. Multiplayer equivalents are a separate follow-up.

---

### Task 1: Replace `DynamicScenarioSnapshot` with `DynamicScene` in types.ts

**Files:**
- Modify: `src/dynamicworldagent/world_builder/types.ts:86-120`

**Step 1: Replace the interface**

Replace `DynamicScenarioSnapshot` (lines 86-120) with:

```typescript
export interface DynamicScene {
  id: string;
  name: string;
  description: string;
  domain?: string;
  items: SceneItem[];
  clues: ScenarioClue[];
  conditions: ScenarioCondition[];
  sceneImage?: SceneImage;
  events: string[];
}

export interface SceneItem {
  id: string;
  name: string;
  description?: string;
}
```

Keep `SceneImage` interface (lines 122-126) as-is.

Remove the `StartingSceneSelection` interface (line 289-294) — it references `snapshot: DynamicScenarioSnapshot`. Replace with:

```typescript
export interface StartingSceneSelection {
  scenarioId: string;
  scenarioName: string;
  selectionReason?: string;
  scene: DynamicScene;
}
```

Add fields to `ScenarioOutline` (line 259-269) for properties moved from snapshot:

```typescript
export interface ScenarioOutline {
  id: string;
  name: string;
  description: string;
  sourcePlaceId?: string;
  sourcePlaceName?: string;
  tags?: string[];
  evidence?: string[];
  clues?: ScenarioClueSeed[];
  connections: ScenarioConnection[];
  // Moved from DynamicScenarioSnapshot:
  showMap?: boolean;
  mapImagePath?: string;
  estimatedShortActions?: number;
  timeRestriction?: string;
}
```

**Step 2: Update all re-exports**

Search all `index.ts` files that re-export `DynamicScenarioSnapshot` and update to `DynamicScene`. Key file:
- `src/dynamicworldagent/world_builder/index.ts` (if it re-exports)
- `src/dynamicworldagent/state/index.ts` (if it re-exports)

---

### Task 2: Update `DynamicGameState` interface and manager — state fields

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameState.ts`

**Step 1: Update imports**

Replace all `DynamicScenarioSnapshot` imports with `DynamicScene` from `../world_builder/types.js`.

**Step 2: Update `DynamicGameState` interface (around line 50-160)**

Replace:
```typescript
currentScenario: DynamicScenarioSnapshot | null;
```
with:
```typescript
currentSceneId: string | null;
scenes: Map<string, DynamicScene>;
```

Remove:
```typescript
updatedDynamicScenarioSnapshots: Map<string, DynamicScenarioSnapshot[]>;
```

In `temporaryInfo`, remove:
```typescript
previousScenario: DynamicScenarioSnapshot | null;
```

**Step 3: Update `initialDynamicGameState` factory (around line 180-240)**

Replace:
```typescript
currentScenario: null,
updatedDynamicScenarioSnapshots: new Map(),
```
with:
```typescript
currentSceneId: null,
scenes: new Map(),
```

Remove `previousScenario: null` from temporaryInfo.

**Step 4: Add helper getter on DynamicGameStateManager**

```typescript
/** Get current scene (convenience getter) */
getCurrentScene(): DynamicScene | null {
  if (!this.state.currentSceneId) return null;
  return this.state.scenes.get(this.state.currentSceneId) ?? null;
}

/** Get scene by ID */
getScene(sceneId: string): DynamicScene | null {
  return this.state.scenes.get(sceneId) ?? null;
}

/** Set current scene ID (scene switch) */
setCurrentSceneId(sceneId: string): void {
  this.state.currentSceneId = sceneId;
  this.state.lastUpdated = new Date();
}

/** Update a scene in the scenes Map */
updateScene(sceneId: string, scene: DynamicScene): void {
  this.state.scenes.set(sceneId, scene);
  this.state.lastUpdated = new Date();
}
```

**Step 5: Remove old snapshot CRUD methods**

Delete these methods from `DynamicGameStateManager`:
- `setUpdatedDynamicScenarioSnapshot()` (around line 1804)
- `getUpdatedDynamicScenarioSnapshot()` (around line 1845)
- `getHistoricalSnapshots()` (around line 1860)
- `getAllUpdatedDynamicScenarioSnapshots()` (around line 1867)
- `refreshCurrentScenarioSnapshot()` (around line 1094)
- `saveOldSnapshotToDatabase()` (if exists)
- `stabilizeSnapshotClues()` standalone function (around line 260)

**Step 6: Update methods that read `this.state.currentScenario`**

Every reference to `this.state.currentScenario` becomes `this.getCurrentScene()`. Key methods:
- `markScenarioClueDiscovered()` (line ~1951): change `this.state.currentScenario?.clues` → `this.getCurrentScene()?.clues`
- `damageScenarioClue()` (line ~1964): same pattern
- `updateScenarioState()` (line ~1611): rewrite to read from `this.getCurrentScene()`
- `getScenarioShortActionCap()` (line ~1412): move to read from `ScenarioOutline` instead
- Any method accessing `this.state.currentScenario.id`, `.name`, `.clues`, `.conditions`, `.characters` — update to use `getCurrentScene()`

**Step 7: Update `switchToScenario()` method (around line 1070)**

Currently sets `this.state.currentScenario = newScenario`. Change to:
```typescript
this.state.currentSceneId = sceneId;
// Scene data is already in this.state.scenes
```

Remove `updateNpcLocationsForScenario()` call (characters no longer on scene).

**Step 8: Update serialization (`toJSON` / `fromJSON`)**

The `fromJSON` deserializer (around line 580-711) currently reconstructs `updatedDynamicScenarioSnapshots` from object. Replace with:
```typescript
// Reconstruct scenes Map
const scenes = new Map<string, DynamicScene>();
if (data.scenes) {
  if (data.scenes instanceof Map) {
    data.scenes.forEach((scene, id) => scenes.set(id, scene));
  } else {
    Object.entries(data.scenes).forEach(([id, scene]) => {
      scenes.set(id, scene as DynamicScene);
    });
  }
}
```

---

### Task 3: Update `DynamicGameStateLoader`

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameStateLoader.ts`

**Step 1: Update imports**

Replace `DynamicScenarioSnapshot` with `DynamicScene`.

**Step 2: Update `buildSnapshotFromRow()` helper (around line 550)**

Rename to `buildSceneFromRow()`. Instead of constructing a full `DynamicScenarioSnapshot`, construct a `DynamicScene`:

```typescript
async function buildSceneFromRow(
  prisma: PrismaClient,
  row: any
): Promise<DynamicScene> {
  // Query clues
  const clueRows = await prisma.scenarioClue.findMany({ where: { snapshotId: row.snapshotId } });
  // Query conditions
  const conditionRows = await prisma.scenarioCondition.findMany({ where: { snapshotId: row.snapshotId } });

  return {
    id: row.scenarioId,
    name: row.snapshotName,
    description: row.description || "",
    domain: undefined,  // Not yet populated from module data
    items: [],          // Initially empty, populated by tick
    clues: clueRows.map(c => ({
      id: c.clueId,
      clueText: c.clueText,
      category: c.category as any,
      difficulty: c.difficulty as any,
      location: c.location || "",
      discoveryMethod: c.discoveryMethod || undefined,
      reveals: c.reveals ? JSON.parse(c.reveals) : undefined,
      discovered: c.discovered || false,
      discoveryDetails: c.discoveryDetails ? JSON.parse(c.discoveryDetails) : undefined,
      damaged: false,
    })),
    conditions: conditionRows.map(c => ({
      type: c.type as any,
      description: c.description,
      mechanicalEffect: c.mechanicalEffect || undefined,
    })),
    sceneImage: row.sceneImagePath ? { path: row.sceneImagePath } : undefined,
    events: [],
  };
}
```

Skip loading `ScenarioCharacter` rows — characters no longer on scene.

**Step 3: Update scene loading into flat Map**

Replace the `moduleSnapshotsMap: Map<string, DynamicScenarioSnapshot[]>` with `scenesMap: Map<string, DynamicScene>`:

```typescript
const scenesMap = new Map<string, DynamicScene>();
for (const row of snapshotRows) {
  const scene = await buildSceneFromRow(prisma, row);
  scenesMap.set(scene.id, scene);
}
```

No deduplication or array logic needed — one scene per ID.

**Step 4: Update `currentScenario` → `currentSceneId`**

Replace:
```typescript
let currentScenario: DynamicScenarioSnapshot | null = null;
// ...
currentScenario = snapshotsById.get(startSnapshotRow.snapshotId) || null;
```
with:
```typescript
let currentSceneId: string | null = null;
// ...
if (startSnapshotRow) {
  currentSceneId = startSnapshotRow.scenarioId;
}
```

**Step 5: Update final state construction**

Replace:
```typescript
currentScenario,
updatedDynamicScenarioSnapshots: mergedSnapshots,
```
with:
```typescript
currentSceneId,
scenes: scenesMap,
```

**Step 6: Update NPC location initialization (around line 812)**

Currently reads `snapshot.characters` to set NPC locations. Change to read from the NPC profiles' initial locations set during world building, or from the scenario outline's NPC assignments.

---

### Task 4: Update tick processor — scene item and event mutations

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

**Step 1: Update scene access pattern**

Replace all `dgsm.getState().currentScenario` with `dgsm.getCurrentScene()`:

```typescript
// Before
const scenario = dgsm.getState().currentScenario;
// After
const scene = dgsm.getCurrentScene();
```

This affects:
- `discoverClues()` (line ~446): `const scenario = state.currentScenario` → `const scene = dgsm.getCurrentScene()`
- Fumble damage (line ~993, ~1270): same pattern
- Player scene check (line ~1027, ~1302): `state.currentScenario?.id` → `state.currentSceneId`

**Step 2: Add scene item mutations to `executeNode()`**

In `object_interaction` handler (around line 767-810), update:

```typescript
// pickup: move item from scene to character inventory
if (payload.action === "pickup" && payload.itemId) {
  dgsm.addItemToNpc(node.characterId, payload.itemId);
  // Remove from scene items
  const scene = dgsm.getCurrentScene();
  if (scene) {
    scene.items = scene.items.filter(i => i.id !== payload.itemId);
  }
}
// place: move item from character inventory to scene
if (payload.action === "place" && payload.itemId) {
  dgsm.removeItemFromNpc(node.characterId, payload.itemId);
  const scene = dgsm.getCurrentScene();
  if (scene) {
    scene.items.push({ id: payload.itemId, name: payload.itemId });
  }
}
// destroy: remove from inventory (already done), log event
if (payload.action === "destroy" && payload.itemId) {
  dgsm.removeItemFromNpc(node.characterId, payload.itemId);
  const scene = dgsm.getCurrentScene();
  if (scene) {
    scene.events.push(`${node.characterName} destroyed ${payload.itemId}`);
  }
}
```

**Step 3: Add scene event logging for notable actions**

After action execution, for high-impact actions in the same scene:

```typescript
if (action.status === "completed" && action.impact >= 2) {
  const scene = dgsm.getScene(node.location);
  if (scene) {
    scene.events.push(`${node.characterName}: ${action.outcome}`);
  }
}
```

---

### Task 5: Update character agent — derive presence from NPC currentLocation

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/character/characterAgent.ts`

**Step 1: Rewrite `extractSceneCharactersForTemplate()` (lines 50-122)**

Replace the current logic that reads `scenario.characters` with:

```typescript
extractSceneCharactersForTemplate(dynamicState: DynamicGameState) {
  const currentSceneId = dynamicState.currentSceneId;
  if (!currentSceneId) return [];

  return dynamicState.npcCharacters
    .filter(npc => npc.currentLocation === currentSceneId)
    .map(npc => ({
      id: npc.id,
      name: npc.name,
      role: npc.occupation || "unknown",
      status: npc.status || "active",
      location: currentSceneId,
    }));
}
```

**Step 2: Rewrite `extractSceneNPCs()` (lines 200-288)**

Same approach — filter NPCs by `currentLocation`:

```typescript
extractSceneNPCs(dynamicState: DynamicGameState) {
  const currentSceneId = dynamicState.currentSceneId;
  if (!currentSceneId) return [];

  return dynamicState.npcCharacters
    .filter(npc => npc.currentLocation === currentSceneId);
}
```

Remove all the actionLog-based "left"/"arrived" detection logic — NPC `currentLocation` is the single source of truth, updated by the tick processor when NPCs move.

**Step 3: Remove `scenario.characters` references throughout the file**

Search for any remaining `scenario.characters` or `currentScenario.characters` references and replace with the NPC filtering approach.

---

### Task 6: Update keeper agent — read from scenes Map

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/keeper/keeperAgent.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/keeper/keeperTemplate.ts`

**Step 1: Update `generateNarrative()` scene access**

Replace:
```typescript
const dynamicState = gameStateManager.getState();
```
Keep that, but everywhere it reads `dynamicState.currentScenario`, use:
```typescript
const currentScene = gameStateManager.getCurrentScene();
```

**Step 2: Rewrite `extractCompleteScenarioInfo()` (line ~499)**

```typescript
private extractCompleteScenarioInfo(dynamicState: DynamicGameState) {
  const scene = dynamicState.scenes.get(dynamicState.currentSceneId ?? "");
  if (!scene) {
    return { hasScenario: false, message: "No current scene loaded" };
  }

  // Look up connections from ScenarioOutline
  const outline = dynamicState.scenarioOutlines.find(o => o.id === scene.id);
  const connections = (outline?.connections || []).map(conn => {
    const target = dynamicState.scenarioOutlines.find(
      o => o.name === conn.scenarioName || o.id === conn.scenarioName
    );
    return {
      scenarioName: target?.name || conn.scenarioName,
      scenarioId: target?.id || conn.scenarioName,
      relationshipType: conn.relationshipType,
      description: conn.description,
      blocked: conn.blocked,
      blockReason: conn.blockReason,
    };
  });

  // Derive characters present from NPC currentLocation
  const presentNpcs = dynamicState.npcCharacters
    .filter(npc => npc.currentLocation === scene.id)
    .map(npc => ({ id: npc.id, name: npc.name }));

  return {
    id: scene.id,
    name: scene.name,
    description: scene.description,
    domain: scene.domain,
    conditions: scene.conditions,
    items: scene.items,
    events: scene.events,
    connections,
    presentNpcs,
  };
}
```

Note: `clues` are NOT included (tick handles discovery, Keeper gets `discoveredCluesThisTurn` separately).

**Step 3: Rewrite `extractPreviousScenarioInfo()` (line ~545)**

```typescript
private extractPreviousScenarioInfo(
  dynamicState: DynamicGameState,
  previousSceneId: string
) {
  const outline = dynamicState.scenarioOutlines.find(o => o.id === previousSceneId);
  if (!outline) return null;

  const connections = (outline.connections || []).map(conn => {
    const target = dynamicState.scenarioOutlines.find(
      o => o.name === conn.scenarioName || o.id === conn.scenarioName
    );
    return {
      scenarioName: target?.name || conn.scenarioName,
      scenarioId: target?.id || conn.scenarioName,
      relationshipType: conn.relationshipType,
      description: conn.description,
      blocked: conn.blocked,
      blockReason: conn.blockReason,
    };
  });

  return {
    id: outline.id,
    name: outline.name,
    description: outline.description,
    connections,
  };
}
```

**Step 4: Update `extractActionRelatedNpcsFromCharacterActions()` (line ~582)**

Remove `allowRegularPlusClues` parameter (already done on tick branch). Remove any remaining `scenario.characters` reads — NPC profiles come from `dynamicState.npcCharacters`.

**Step 5: Update `extractCompleteCharacterAttributes()` (line ~652)**

Remove `clues` field from output (NPC clues are tick-engine-only, not for Keeper).

**Step 6: Add events to keeper template**

In `keeperTemplate.ts`, add after the `hasDamagedClueThisTurn` section:

```handlebars
{{#if hasSceneEvents}}
### Recent Scene Changes
The following physical changes have occurred at this location. Incorporate relevant ones naturally.
{{#each sceneEvents}}
- {{this}}
{{/each}}
{{/if}}
```

In `keeperAgent.ts`, add to template context:

```typescript
hasSceneEvents: currentScene?.events?.length > 0,
sceneEvents: currentScene?.events ?? [],
```

**Step 7: Remove `updateClueStates()` method**

Already removed on tick branch. Verify it's gone.

---

### Task 7: Update dynamic graph

**Files:**
- Modify: `src/dynamicworldagent/graph/dynamicGraph.ts`

**Step 1: Update Director node (around line 557-689)**

Replace `currentScenario` references with `getCurrentScene()`:

```typescript
// Scene change detection
const beforeSceneId = beforeState.currentSceneId;
const afterSceneId = afterState.currentSceneId;
const sceneChanged = beforeSceneId !== afterSceneId;

if (sceneChanged) {
  const afterScene = afterState.scenes.get(afterSceneId!);
  // Generate scene image
  // ...
  if (afterScene) {
    afterScene.sceneImage = { path: imagePath, ... };
  }
}
```

Remove `updatedDynamicScenarioSnapshots` references (line ~626).

**Step 2: Update Keeper node**

Replace `result.clueRevelations` with `null` (already done on tick branch). Replace `state.dynamicGameState.currentScenario` with scene from Map.

**Step 3: Update turn persistence calls**

Where `completeTurn()` is called, update to pass `null` for `clueRevelations` (already done).

---

### Task 8: Update scene image generation

**Files:**
- Modify: `src/dynamicworldagent/visual/sceneImage.ts`

**Step 1: Replace `DynamicScenarioSnapshot` with `DynamicScene`**

Update all function signatures:

```typescript
function sanitizeScene(scene: DynamicScene): Partial<DynamicScene> {
  const { clues, ...rest } = scene;
  return rest;
}

function buildSceneImagePrompt(scene: DynamicScene, ...): string { ... }

async function generateSceneImage(scene: DynamicScene, ...): Promise<...> { ... }
```

Remove references to `scenario.gameTime` — use the game state's `timeOfDay` passed as a separate parameter.
Remove references to `scenario.keeperNotes`.

---

### Task 9: Update checkpoint serialization

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/memory/checkpoint.ts`

**Step 1: Update serialization**

Replace `updatedDynamicScenarioSnapshots` serialization (around line 191) with:

```typescript
// Serialize scenes Map
const serializedScenes: Record<string, any> = {};
for (const [sceneId, scene] of state.scenes) {
  serializedScenes[sceneId] = scene;
}
// ...
return { ...serialized, scenes: serializedScenes, currentSceneId: state.currentSceneId };
```

Remove the historical snapshot database persistence logic — no more snapshot history.
Remove `ScenarioCharacter` database writes from checkpoint saves (characters no longer on scene).

**Step 2: Update deserialization**

Reconstruct `scenes: Map<string, DynamicScene>` from the serialized object.

---

### Task 10: Update world module loader

**Files:**
- Modify: `src/dynamicworldagent/world_builder/worldModuleLoader.ts`

**Step 1: Rename `loadDynamicScenarioSnapshots` → `loadDynamicScenes`**

Update the method (around line 420) to return `Map<string, DynamicScene>` instead of `Map<string, DynamicScenarioSnapshot>`.

When constructing scenes from JSON files, map to the new interface:

```typescript
const scene: DynamicScene = {
  id: data.id,
  name: data.name,
  description: data.description || "",
  domain: data.domain,
  items: data.items || [],
  clues: data.clues || [],
  conditions: data.conditions || [],
  sceneImage: data.sceneImage,
  events: [],
};
```

**Step 2: Rename `saveDynamicScenarioSnapshots` → `saveDynamicScenes`**

Update database persistence (around line 952) to save `DynamicScene` fields:
- Save `domain` as a new field
- Save `items` as JSON
- Save `events` as JSON (or skip — events are runtime-only)
- Remove `ScenarioCharacter` creation (no characters on scene)
- Remove `keeperNotes`, `timeRestriction`, `showMap`, etc. from snapshot table

**Step 3: Update `DynamicWorldModule` type**

Replace:
```typescript
scenarioSnapshots: Map<string, DynamicScenarioSnapshot>;
```
with:
```typescript
scenes: Map<string, DynamicScene>;
```

And `startingScene.snapshot` → `startingScene.scene`.

---

### Task 11: Update scenario builder agent

**Files:**
- Modify: `src/dynamicworldagent/world_builder/scenarioBuilderAgent.ts`

**Step 1: Update `generateStartingSceneSnapshot()` → `generateStartingScene()`**

Construct `DynamicScene` instead of `DynamicScenarioSnapshot`:

```typescript
const scene: DynamicScene = {
  id: selectedScenario.id,
  name: selectedScenario.name,
  description: parsed.description || selectedScenario.description,
  domain: parsed.domain,
  items: parsed.items || [],
  clues: (parsed.clues || []).map(c => ({
    id: c.id || `clue_${crypto.randomUUID().slice(0, 8)}`,
    clueText: c.clueText || "Unspecified clue",
    category: c.category || "environment",
    difficulty: c.difficulty || "regular",
    location: c.location || selectedScenario.name,
    discovered: false,
  })),
  conditions: parsed.conditions || [],
  sceneImage: undefined,
  events: [],
};
```

Remove `characters` population — NPCs are separate entities with `currentLocation`.

**Step 2: Update the LLM prompt template for scene generation**

Update `scenarioBuilderTemplate.ts` (around line 258) to remove `characters` from the expected output format and add `domain`, `items`, `events` fields.

---

### Task 12: Update template.ts

**Files:**
- Modify: `src/template.ts`

**Step 1: Replace import**

```typescript
// Before
import type { DynamicScenarioSnapshot } from "./dynamicworldagent/world_builder/types.js";
// After
import type { DynamicScene } from "./dynamicworldagent/world_builder/types.js";
```

**Step 2: Update `MultiplayerSceneScopedState` type (line ~87)**

```typescript
// Before
currentScenario: DynamicScenarioSnapshot | null;
// After
currentSceneId: string | null;
scenes: Map<string, DynamicScene>;
```

**Step 3: Update `collectScenarioImages()` (line ~203)**

Replace `state.currentScenario?.mapImagePath` with lookup from `ScenarioOutline`:

```typescript
const currentSceneId = dynamicState?.currentSceneId;
const outline = dynamicState?.scenarioOutlines.find(o => o.id === currentSceneId);
const mapImagePath = outline?.mapImagePath;
```

---

### Task 13: Clean up Director templates

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/director/`

**Step 1: Remove unused scene update templates**

The following templates are no longer used (Director doesn't update scenes):
- `sceneSwitchFlowTemplates.ts`: `getTargetSnapshotFromTimelineTemplate()`, `getSceneSwitchBackgroundSimplifiedSnapshotsTemplate()`
- `nonPlayerFlowTemplates.ts`: `getCurrentSceneReactionSnapshotTemplate()`, `getNonPlayerBackgroundSimplifiedSnapshotsTemplate()`

Remove snapshot-related template functions. Keep NPC timeline templates if still used by tick/NPC planning.

**Step 2: Remove `DynamicScenarioSnapshot` references from Director agent**

The Director agent itself (directorAgent.ts) mainly does game ending checks. Update any remaining `currentScenario` references to use `getCurrentScene()`.

---

### Task 14: Fix remaining references and verify build

**Files:**
- Various files with remaining `DynamicScenarioSnapshot` references

**Step 1: Search for all remaining references**

```bash
grep -rn "DynamicScenarioSnapshot\|currentScenario\|updatedDynamicScenarioSnapshots\|previousScenario\|refreshCurrentScenarioSnapshot" src/dynamicworldagent/ --include="*.ts"
```

Fix each remaining reference.

**Step 2: Search for `snapshot` references that should be `scene`**

```bash
grep -rn "snapshot" src/dynamicworldagent/ --include="*.ts" | grep -v node_modules | grep -v ".d.ts"
```

Rename variables from `snapshot` to `scene` where appropriate.

**Step 3: Full build (SWC)**

```bash
pnpm build
```

Fix all compilation errors.

**Step 4: Strict type check (TSC)**

```bash
pnpm build:tsc
```

The SWC build may miss type errors that TSC catches. Fix any remaining.

**Step 5: Present changes for user review**

Show `git diff --stat` and wait for user confirmation before committing.

---

### Notes

**Out of scope (follow-up tasks):**
- Prisma schema changes (add `domain`, `items` columns to ScenarioSnapshot table, remove ScenarioCharacter FK)
- ScenarioOutline Prisma migration (add `showMap`, `mapImagePath`, `estimatedShortActions`, `timeRestriction`)
- Updating orchestrator agent if it reads `scenario.characters`
- PlayerPlanAgent if it reads `currentScenario.characters`
