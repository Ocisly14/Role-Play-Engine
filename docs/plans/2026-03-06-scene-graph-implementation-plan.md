# Scene Graph Module Generation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor module generation with two-level scene architecture (macro locations + sub-scenes), inverted pipeline (world first, then story), and tick processor pathfinding.

**Architecture:** ScenarioOutline becomes a pure container (macro location). DynamicScene gains `connections` and `parentLocationId` for scene graph. Transport network carries travel times. Pipeline inverted: setting seed → physical world → truth timeline → knowledge matrix → NPCs → clue placement. Tick processor gains BFS pathfinding for multi-hop movement.

**Tech Stack:** TypeScript, LangGraph, Prisma (SQLite), LangChain

**Design doc:** `docs/plans/2026-03-06-scene-graph-module-generation-design.md`

---

## Phase A: Foundation — Types & Config

### Task 1: Update `types.ts` — ScenarioOutline simplified, DynamicScene gains connections

**Files:**
- Modify: `src/dynamicworldagent/world_builder/types.ts`

**Step 1: Add `parentLocationId` and `connections` to `DynamicScene` (lines 81-91)**

Replace:
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
```

With:
```typescript
export interface DynamicScene {
  id: string;
  name: string;
  description: string;
  parentLocationId: string;
  items: SceneItem[];
  clues: ScenarioClue[];
  conditions: ScenarioCondition[];
  connections: string[];
  sceneImage?: SceneImage;
  events: string[];
}
```

**Step 2: Simplify `ScenarioOutline` (lines 236-251)**

Replace:
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
  showMap?: boolean;
  mapImagePath?: string;
  estimatedShortActions?: number;
  timeRestriction?: string;
}
```

With:
```typescript
export interface ScenarioOutline {
  id: string;
  name: string;
  description: string;
  sourcePlaceId?: string;
  sourcePlaceName?: string;
  residents?: string[];
  subSceneCount: number;
  entrySceneId?: string;
}
```

**Step 3: Add `TransportEdge` interface (after ScenarioOutline)**

```typescript
export interface TransportEdge {
  fromLocationId: string;
  toLocationId: string;
  streetSceneId: string;
  travelTimeMinutes: number;
}
```

**Step 4: Add `residence` to `DynamicNPCProfile` (lines 67-79)**

Add field after existing fields:
```typescript
residence?: string;  // macroLocationId
```

**Step 5: Update `StartingSceneSelection` (lines 271-276)**

Keep as-is — it already references `scene: DynamicScene`.

**Step 6: Update `WorldGenerationResult` (lines 318-338)**

Replace with:
```typescript
export interface WorldGenerationResult {
  macroScene: MacroSceneStructure;
  storyPremise: string;
  mythosEvents: MythosEvent[];
  endState: EndStateDefinition;
  scenarios: ScenarioOutline[];
  scenes: Map<string, DynamicScene>;
  transportEdges: TransportEdge[];
  truthTimeline: TruthEvent[];
  knowledgeMatrix: KnowledgeHolder[];
  redHerrings: RedHerring[];
  startingScene: StartingSceneSelection | null;
  npcs: DynamicNPCProfile[];
  generatedFiles: {
    macroSceneFile: string;
    scenariosFile: string;
    scenesDir: string;
    transportFile: string;
    truthTimelineFile: string;
    knowledgeMatrixFile: string;
    startingSceneFile: string | null;
    npcsDir: string;
    moduleDigestFile?: string | null;
  };
}
```

**Step 7: Remove `ScenarioConnection`, `ScenarioConnectionType`, `ScenarioClueSeed` if no longer used**

Check if these types are still imported elsewhere. `ScenarioConnection` was used by old `ScenarioOutline.connections` — delete if unused. Keep `ScenarioClueSeed` if used by clue placement agent.

**Step 8: Build**

Run: `pnpm build 2>&1 | head -80`
Expected: Type errors in files using old `ScenarioOutline` shape and `DynamicScene` without `parentLocationId`/`connections`. These will be fixed in subsequent tasks.

**Step 9: Commit**

```bash
git add src/dynamicworldagent/world_builder/types.ts
git commit -m "refactor: update ScenarioOutline and DynamicScene for scene graph architecture"
```

---

### Task 2: Create `moduleSizeConfig.ts`

**Files:**
- Create: `src/dynamicworldagent/world_builder/moduleSizeConfig.ts`

**Step 1: Create the file**

```typescript
export interface ModuleSizeConfig {
  size: "small" | "medium" | "large";
  macroLocationCount: [number, number];
  subSceneRange: [number, number];
  totalSceneCap: number;
}

export const MODULE_SIZE_CONFIGS: Record<string, ModuleSizeConfig> = {
  small: {
    size: "small",
    macroLocationCount: [4, 6],
    subSceneRange: [1, 3],
    totalSceneCap: 25,
  },
  medium: {
    size: "medium",
    macroLocationCount: [7, 12],
    subSceneRange: [2, 4],
    totalSceneCap: 50,
  },
  large: {
    size: "large",
    macroLocationCount: [13, 20],
    subSceneRange: [2, 5],
    totalSceneCap: 80,
  },
};

export function getModuleSizeConfig(size: string): ModuleSizeConfig {
  return MODULE_SIZE_CONFIGS[size] ?? MODULE_SIZE_CONFIGS.medium;
}
```

**Step 2: Build**

Run: `pnpm build 2>&1 | head -20`

**Step 3: Commit**

```bash
git add src/dynamicworldagent/world_builder/moduleSizeConfig.ts
git commit -m "feat: add module size config for scene graph generation"
```

---

### Task 3: Update `DynamicGameState.ts` — replace connectionStates, add new fields

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameState.ts`

**Step 1: Remove `ScenarioConnectionState` interface (lines 41-46)**

Delete:
```typescript
export interface ScenarioConnectionState {
  fromScenarioId: string;
  toScenarioId: string;
  blocked: boolean;
  conditions: string[];
}
```

**Step 2: Update `DynamicGameState` interface**

Replace `connectionStates` field (line 161):
```typescript
connectionStates: ScenarioConnectionState[];
```

With:
```typescript
blockedConnections: Map<string, string>;
npcResidences: Record<string, string>;
transportEdges: TransportEdge[];
```

Add import for `TransportEdge`:
```typescript
import type { TransportEdge } from "../world_builder/types.js";
```

**Step 3: Update `initialDynamicGameState` factory**

Replace:
```typescript
connectionStates: [],
```

With:
```typescript
blockedConnections: new Map(),
npcResidences: {},
transportEdges: [],
```

**Step 4: Update helper methods**

Replace `isConnectionBlocked` method:
```typescript
isConnectionBlocked(fromId: string, toId: string): boolean {
  const key1 = `${fromId}::${toId}`;
  const key2 = `${toId}::${fromId}`;
  return this.state.blockedConnections.has(key1) || this.state.blockedConnections.has(key2);
}
```

Replace `setConnectionBlocked` method:
```typescript
setConnectionBlocked(fromId: string, toId: string, blocked: boolean, reason: string): void {
  const key = `${fromId}::${toId}`;
  if (blocked) {
    this.state.blockedConnections.set(key, reason);
  } else {
    this.state.blockedConnections.delete(key);
    this.state.blockedConnections.delete(`${toId}::${fromId}`);
  }
  this.state.lastUpdated = new Date();
}
```

**Step 5: Update `serialize()` method (lines 526-545)**

Replace `connectionStates` serialization — serialize `blockedConnections` Map:
```typescript
const blockedConnsObj: Record<string, string> = {};
this.state.blockedConnections.forEach((reason, key) => {
  blockedConnsObj[key] = reason;
});
```

Add `blockedConnections: blockedConnsObj` to the return object. Remove `connectionStates`.

Add `npcResidences` and `transportEdges` to the return object.

**Step 6: Update `deserialize()` static method (lines 554-651)**

Add reconstruction of `blockedConnections` Map:
```typescript
const blockedConnections = new Map<string, string>();
if (data.blockedConnections) {
  if (data.blockedConnections instanceof Map) {
    data.blockedConnections.forEach((v: string, k: string) => blockedConnections.set(k, v));
  } else {
    Object.entries(data.blockedConnections).forEach(([k, v]) => blockedConnections.set(k, v as string));
  }
}
```

Add `npcResidences` and `transportEdges` to the returned state.

**Step 7: Build**

Run: `pnpm build 2>&1 | head -80`
Expected: Errors where `connectionStates` is referenced. Note them for fixing in later tasks.

**Step 8: Commit**

```bash
git add src/dynamicworldagent/state/DynamicGameState.ts
git commit -m "refactor: replace connectionStates with blockedConnections, add transportEdges and npcResidences"
```

---

## Phase B: World Generation Pipeline — Scene Building

### Task 4: Modify `macroSceneAgent.ts` — lighter output, story seed

**Files:**
- Modify: `src/dynamicworldagent/world_builder/macroSceneAgent.ts`
- Modify: `src/dynamicworldagent/world_builder/macroSceneTemplate.ts`

**Step 1: Split `generate()` into two methods**

Keep existing `generate()` method but split into:

```typescript
/**
 * Phase 1: Setting + story seed only.
 * Generates MacroSceneStructure, MythosEvents, EndState, and a story premise paragraph.
 * Does NOT generate truth timeline or knowledge matrix (deferred to after scenes).
 */
async generateSettingSeed(
  settingType: MacroSceneSettingType,
  creativePromptOrElements: string | StructuredStoryElements,
  progressCallback?: ProgressCallback
): Promise<{
  macroScene: MacroSceneStructure;
  mythosEvents: MythosEvent[];
  endState: EndStateDefinition;
  storyPremise: string;
}>
```

This calls steps 1 (generateTownStructure), 2 (generateHistoricalMythos), 6 (generateEndState), plus a new step to generate a story premise paragraph.

```typescript
/**
 * Phase 6-8: Story weaving — truth timeline + knowledge matrix + red herrings.
 * Called AFTER scenes are generated, with scene context injected.
 */
async generateStoryInWorld(
  macroScene: MacroSceneStructure,
  mythosEvents: MythosEvent[],
  endState: EndStateDefinition,
  storyPremise: string,
  scenarios: ScenarioOutline[],
  scenes: Map<string, DynamicScene>,
  creativePromptOrElements: string | StructuredStoryElements,
  progressCallback?: ProgressCallback
): Promise<{
  truthTimeline: TruthEvent[];
  knowledgeMatrix: KnowledgeHolder[];
  redHerrings: RedHerring[];
}>
```

This calls steps 3 (generateTruthTimeline), 4 (generateKnowledgeMatrix), 5 (generateRedHerrings) — but with scene context injected into prompts.

**Step 2: Add `generateStoryPremise()` method**

```typescript
private async generateStoryPremise(
  macroScene: MacroSceneStructure,
  mythosEvents: MythosEvent[],
  endState: EndStateDefinition,
  storyElements?: StructuredStoryElements
): Promise<string> {
  const prompt = buildStoryPremisePrompt({
    macroScene,
    mythosEvents,
    endState,
    storyElements,
  });

  return await generateText({
    runtime: this.runtime,
    context: prompt,
    modelClass: ModelClass.SMALL,
  });
}
```

**Step 3: Update templates**

In `macroSceneTemplate.ts`, add `buildStoryPremisePrompt()` — a prompt that takes the setting + mythos events + end state and generates a 1-2 paragraph story premise describing the mystery without detailed plot.

Update `buildTruthTimelinePrompt()`, `buildKnowledgeMatrixPrompt()`, `buildRedHerringsPrompt()` to accept an additional `scenesContext: string` parameter that lists all existing scenes and macro locations.

**Step 4: Keep old `generate()` method as deprecated wrapper**

For backward compatibility during transition:
```typescript
/** @deprecated Use generateSettingSeed() + generateStoryInWorld() instead */
async generate(...): Promise<{...}> {
  const seed = await this.generateSettingSeed(...);
  // Cannot call generateStoryInWorld without scenes — return partial
  const story = await this.generateStoryInWorld(
    seed.macroScene, seed.mythosEvents, seed.endState, seed.storyPremise,
    [], new Map(), creativePromptOrElements, progressCallback
  );
  return { ...seed, ...story };
}
```

**Step 5: Build**

Run: `pnpm build 2>&1 | head -80`

**Step 6: Commit**

```bash
git add src/dynamicworldagent/world_builder/macroSceneAgent.ts src/dynamicworldagent/world_builder/macroSceneTemplate.ts
git commit -m "refactor: split macroSceneAgent into setting seed + story weaving phases"
```

---

### Task 5: Modify `scenarioBuilderAgent.ts` — generates macro locations

**Files:**
- Modify: `src/dynamicworldagent/world_builder/scenarioBuilderAgent.ts`
- Modify: `src/dynamicworldagent/world_builder/scenarioBuilderTemplate.ts`

**Step 1: Rewrite `generate()` to produce macro locations**

The method no longer takes truth timeline or knowledge matrix (those don't exist yet). Instead it takes the setting + story premise:

```typescript
async generate(
  macroScene: MacroSceneStructure,
  storyPremise: string,
  moduleSize: ModuleSizeConfig,
  storyElements?: StructuredStoryElements,
  progressCallback?: ProgressCallback
): Promise<ScenarioOutline[]>
```

The LLM prompt describes the setting and asks for macro locations (buildings/areas) with:
- `id`, `name`, `description`
- `subSceneCount` (how many rooms/floors)
- No clues, no evidence, no connections

The module size config constrains macro location count.

**Step 2: Update the prompt template**

In `scenarioBuilderTemplate.ts`, rewrite the scenario generation prompt:
- Input: setting description, story premise, module size constraints
- Output: JSON array of `{ id, name, description, subSceneCount }`
- Guidelines: include residential locations, commercial areas, public spaces, plus investigation-relevant locations suggested by the premise
- Should generate a range of location types (not all investigation-focused)

**Step 3: Remove or deprecate `generateStartingScene()`**

Starting scene selection moves to a later phase (after sub-scenes exist). For now, keep the method but mark deprecated.

**Step 4: Remove or deprecate `assignNpcsToScenarios()`**

NPC assignment now happens after NPCs are generated (Phase 9). Keep but mark deprecated.

**Step 5: Build**

Run: `pnpm build 2>&1 | head -80`

**Step 6: Commit**

```bash
git add src/dynamicworldagent/world_builder/scenarioBuilderAgent.ts src/dynamicworldagent/world_builder/scenarioBuilderTemplate.ts
git commit -m "refactor: scenarioBuilder generates macro locations from setting + story premise"
```

---

### Task 6: Create `sceneGraphBuilder.ts` — transport network generation

**Files:**
- Create: `src/dynamicworldagent/world_builder/sceneGraphBuilder.ts`
- Create: `src/dynamicworldagent/world_builder/sceneGraphBuilderTemplate.ts`

**Step 1: Create template**

`sceneGraphBuilderTemplate.ts`:

```typescript
export interface TransportNetworkParams {
  macroLocations: Array<{ id: string; name: string; description: string }>;
  settingDescription: string;
  storyPremise: string;
}

export function buildTransportNetworkPrompt(params: TransportNetworkParams): string {
  return `You are designing the transportation network for a tabletop horror RPG tabletop RPG setting.

## Setting
${params.settingDescription}

## Story Premise
${params.storyPremise}

## Macro Locations (buildings/areas)
${params.macroLocations.map((l) => `- ${l.id}: "${l.name}" — ${l.description}`).join("\n")}

## Task
Generate outdoor/street scenes that connect these locations, plus travel time between each pair.

## Requirements
- Generate road/street scenes as needed to connect all macro locations (decide the count based on the layout)
- Every macro location must be reachable (no isolated buildings)
- Travel times should be realistic for the setting (walking in a small town: 2-15 minutes between locations)
- Streets/squares are real places where NPCs can encounter each other

## Output Format
Return JSON:
\`\`\`json
{
  "outdoorScenes": [
    { "id": "street_main", "name": "Main Street", "description": "..." }
  ],
  "transportEdges": [
    { "fromLocationId": "loc_bar", "toLocationId": "loc_hospital", "streetSceneId": "street_main", "travelTimeMinutes": 5 }
  ]
}
\`\`\``;
}
```

**Step 2: Create agent**

`sceneGraphBuilder.ts`:

```typescript
import { createRuntime, generateText, ModelClass } from "../../models/runtime.js";
import type { MacroSceneStructure, ScenarioOutline, TransportEdge, DynamicScene } from "./types.js";
import { buildTransportNetworkPrompt } from "./sceneGraphBuilderTemplate.js";
import { parseJsonResponse } from "./utils.js";
import type { Runtime } from "../../models/types.js";

export class SceneGraphBuilder {
  private runtime: Runtime;

  constructor() {
    this.runtime = createRuntime();
  }

  async generateTransportNetwork(
    macroLocations: ScenarioOutline[],
    macroScene: MacroSceneStructure,
    storyPremise: string
  ): Promise<{
    outdoorScenes: DynamicScene[];
    transportEdges: TransportEdge[];
    outdoorMacroLocation: ScenarioOutline;
  }> {
    const prompt = buildTransportNetworkPrompt({
      macroLocations: macroLocations.map((l) => ({
        id: l.id,
        name: l.name,
        description: l.description,
      })),
      settingDescription: `${macroScene.locationName}: ${macroScene.geographicFeatures}`,
      storyPremise,
    });

    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    const parsed = parseJsonResponse<{
      outdoorScenes: Array<{ id: string; name: string; description: string }>;
      transportEdges: TransportEdge[];
    }>(response);

    // Create a macro location container for outdoor scenes
    const outdoorMacroLocation: ScenarioOutline = {
      id: "outdoor_streets",
      name: "Streets & Paths",
      description: "Outdoor areas connecting buildings and locations",
      subSceneCount: parsed.outdoorScenes.length,
    };

    // Convert outdoor scenes to DynamicScene
    const outdoorScenes: DynamicScene[] = parsed.outdoorScenes.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      parentLocationId: "outdoor_streets",
      items: [],
      clues: [],
      conditions: [],
      connections: [],  // Will be wired in graph assembly
      events: [],
    }));

    return {
      outdoorScenes,
      transportEdges: parsed.transportEdges,
      outdoorMacroLocation,
    };
  }
}
```

**Step 3: Build**

Run: `pnpm build 2>&1 | head -20`

**Step 4: Commit**

```bash
git add src/dynamicworldagent/world_builder/sceneGraphBuilder.ts src/dynamicworldagent/world_builder/sceneGraphBuilderTemplate.ts
git commit -m "feat: add sceneGraphBuilder for transport network generation"
```

---

### Task 7: Create `subSceneBuilder.ts` — parallel sub-scene content generation

**Files:**
- Create: `src/dynamicworldagent/world_builder/subSceneBuilder.ts`
- Create: `src/dynamicworldagent/world_builder/subSceneBuilderTemplate.ts`

**Step 1: Create template**

`subSceneBuilderTemplate.ts`:

```typescript
export interface SubSceneParams {
  macroLocation: { id: string; name: string; description: string; subSceneCount: number; residents?: string[] };
  settingDescription: string;
  connectedStreetScenes: Array<{ id: string; name: string }>;
}

export function buildSubScenePrompt(params: SubSceneParams): string {
  const hasResidents = params.macroLocation.residents && params.macroLocation.residents.length > 0;

  return `You are designing the interior layout of a location for a tabletop horror RPG tabletop RPG.

## Setting
${params.settingDescription}

## Location
Name: "${params.macroLocation.name}"
Description: ${params.macroLocation.description}
Number of sub-scenes to generate: ${params.macroLocation.subSceneCount}
${hasResidents ? `This is a residential location. Generate appropriate living spaces (bedrooms, etc.).` : ""}

## Connected Street Scenes (outside this building)
${params.connectedStreetScenes.map((s) => `- ${s.id}: "${s.name}"`).join("\n")}

## Task
Generate ${params.macroLocation.subSceneCount} sub-scenes (rooms, floors, areas) within this location.

## Requirements
- Each sub-scene needs: id, name, description, items (physical objects present), conditions (environmental state)
- Define internal connections between sub-scenes (which rooms connect to which)
- Exactly ONE sub-scene must be the entry point, connected to the street scenes listed above
- Mark the entry scene with "isEntry": true
- Sub-scene IDs should be prefixed with the location ID (e.g., "${params.macroLocation.id}_floor1")
- Items should have id, name, and optional description
- No clues — clues are placed separately later
${hasResidents ? "- Include at least one bedroom/private room suitable for sleeping" : ""}

## Output Format
Return JSON:
\`\`\`json
{
  "subScenes": [
    {
      "id": "${params.macroLocation.id}_lobby",
      "name": "Lobby",
      "description": "A dimly lit entrance hall...",
      "isEntry": true,
      "items": [{ "id": "item_reception_desk", "name": "Reception Desk", "description": "..." }],
      "conditions": [{ "type": "environment", "description": "Dusty air hangs heavy" }],
      "internalConnections": ["${params.macroLocation.id}_floor2"]
    }
  ]
}
\`\`\``;
}
```

**Step 2: Create agent**

`subSceneBuilder.ts`:

```typescript
import { createRuntime, generateText, ModelClass } from "../../models/runtime.js";
import type { ScenarioOutline, DynamicScene, MacroSceneStructure } from "./types.js";
import { buildSubScenePrompt } from "./subSceneBuilderTemplate.js";
import { parseJsonResponse } from "./utils.js";
import type { Runtime } from "../../models/types.js";

interface SubSceneRaw {
  id: string;
  name: string;
  description: string;
  isEntry?: boolean;
  items?: Array<{ id: string; name: string; description?: string }>;
  conditions?: Array<{ type?: string; description: string; mechanicalEffect?: any }>;
  internalConnections?: string[];
}

export class SubSceneBuilder {
  private runtime: Runtime;

  constructor() {
    this.runtime = createRuntime();
  }

  /**
   * Generate sub-scenes for a single macro location.
   * Call this in parallel for all macro locations.
   */
  async generateSubScenes(
    macroLocation: ScenarioOutline,
    macroScene: MacroSceneStructure,
    connectedStreetScenes: Array<{ id: string; name: string }>
  ): Promise<{ scenes: DynamicScene[]; entrySceneId: string }> {
    const prompt = buildSubScenePrompt({
      macroLocation: {
        id: macroLocation.id,
        name: macroLocation.name,
        description: macroLocation.description,
        subSceneCount: macroLocation.subSceneCount,
        residents: macroLocation.residents,
      },
      settingDescription: `${macroScene.locationName}: ${macroScene.geographicFeatures}`,
      connectedStreetScenes,
    });

    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    const parsed = parseJsonResponse<{ subScenes: SubSceneRaw[] }>(response);

    let entrySceneId = "";
    const scenes: DynamicScene[] = parsed.subScenes.map((raw) => {
      if (raw.isEntry) entrySceneId = raw.id;
      return {
        id: raw.id,
        name: raw.name,
        description: raw.description,
        parentLocationId: macroLocation.id,
        items: raw.items ?? [],
        clues: [],
        conditions: (raw.conditions ?? []).map((c) => ({
          type: c.type ?? "environment",
          description: c.description,
          mechanicalEffect: c.mechanicalEffect,
        })),
        connections: raw.internalConnections ?? [],
        events: [],
      };
    });

    // Fallback: first scene is entry if none marked
    if (!entrySceneId && scenes.length > 0) {
      entrySceneId = scenes[0].id;
    }

    return { scenes, entrySceneId };
  }

  /**
   * Generate sub-scenes for ALL macro locations in parallel.
   */
  async generateAllSubScenes(
    macroLocations: ScenarioOutline[],
    macroScene: MacroSceneStructure,
    streetScenesByLocation: Map<string, Array<{ id: string; name: string }>>
  ): Promise<Map<string, { scenes: DynamicScene[]; entrySceneId: string }>> {
    const results = new Map<string, { scenes: DynamicScene[]; entrySceneId: string }>();

    await Promise.all(
      macroLocations.map(async (loc) => {
        const connectedStreets = streetScenesByLocation.get(loc.id) ?? [];
        const result = await this.generateSubScenes(loc, macroScene, connectedStreets);
        results.set(loc.id, result);
      })
    );

    return results;
  }
}
```

**Step 3: Build**

Run: `pnpm build 2>&1 | head -20`

**Step 4: Commit**

```bash
git add src/dynamicworldagent/world_builder/subSceneBuilder.ts src/dynamicworldagent/world_builder/subSceneBuilderTemplate.ts
git commit -m "feat: add subSceneBuilder for parallel sub-scene content generation"
```

---

### Task 8: Create graph assembly logic

**Files:**
- Create: `src/dynamicworldagent/world_builder/graphAssembly.ts`

**Step 1: Create the assembly function**

```typescript
import type { DynamicScene, ScenarioOutline, TransportEdge } from "./types.js";

export interface GraphAssemblyResult {
  allScenes: Map<string, DynamicScene>;
  scenarioOutlines: ScenarioOutline[];
  transportEdges: TransportEdge[];
  errors: string[];
}

/**
 * Phase 5: Pure code — merges sub-scenes + outdoor scenes + transport edges.
 * Wires entry scenes to outdoor connectors. Validates connectivity.
 */
export function assembleSceneGraph(
  macroLocations: ScenarioOutline[],
  subScenesByLocation: Map<string, { scenes: DynamicScene[]; entrySceneId: string }>,
  outdoorScenes: DynamicScene[],
  outdoorMacroLocation: ScenarioOutline,
  transportEdges: TransportEdge[]
): GraphAssemblyResult {
  const allScenes = new Map<string, DynamicScene>();
  const errors: string[] = [];

  // 1. Add all sub-scenes
  for (const [locationId, { scenes, entrySceneId }] of subScenesByLocation) {
    const outline = macroLocations.find((l) => l.id === locationId);
    if (outline) {
      outline.entrySceneId = entrySceneId;
    }
    for (const scene of scenes) {
      allScenes.set(scene.id, scene);
    }
  }

  // 2. Add outdoor scenes
  for (const scene of outdoorScenes) {
    allScenes.set(scene.id, scene);
  }

  // 3. Wire entry scenes to outdoor connectors via transport edges
  for (const edge of transportEdges) {
    const fromOutline = macroLocations.find((l) => l.id === edge.fromLocationId);
    const toOutline = macroLocations.find((l) => l.id === edge.toLocationId);
    const streetScene = allScenes.get(edge.streetSceneId);

    if (!streetScene) {
      errors.push(`Transport edge references missing street scene: ${edge.streetSceneId}`);
      continue;
    }

    // Wire: fromLocation entry scene <-> street scene
    if (fromOutline?.entrySceneId) {
      const entryScene = allScenes.get(fromOutline.entrySceneId);
      if (entryScene) {
        addConnection(entryScene, streetScene.id);
        addConnection(streetScene, entryScene.id);
      }
    }

    // Wire: street scene <-> toLocation entry scene
    if (toOutline?.entrySceneId) {
      const entryScene = allScenes.get(toOutline.entrySceneId);
      if (entryScene) {
        addConnection(streetScene, entryScene.id);
        addConnection(entryScene, streetScene.id);
      }
    }
  }

  // 4. Validate connectivity (BFS from first scene)
  const visited = new Set<string>();
  const firstScene = allScenes.keys().next().value;
  if (firstScene) {
    const queue = [firstScene];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const scene = allScenes.get(current);
      if (scene) {
        for (const conn of scene.connections) {
          if (!visited.has(conn)) queue.push(conn);
        }
      }
    }
  }

  const orphans = [...allScenes.keys()].filter((id) => !visited.has(id));
  if (orphans.length > 0) {
    errors.push(`Orphan scenes (unreachable): ${orphans.join(", ")}`);
  }

  // 5. Build final outlines list
  const scenarioOutlines = [...macroLocations, outdoorMacroLocation];

  return { allScenes, scenarioOutlines, transportEdges, errors };
}

function addConnection(scene: DynamicScene, targetId: string): void {
  if (!scene.connections.includes(targetId)) {
    scene.connections.push(targetId);
  }
}
```

**Step 2: Build**

Run: `pnpm build 2>&1 | head -20`

**Step 3: Commit**

```bash
git add src/dynamicworldagent/world_builder/graphAssembly.ts
git commit -m "feat: add graph assembly for scene connectivity validation"
```

---

## Phase C: Story Weaving (after scenes exist)

### Task 9: Create `cluePlacementAgent.ts` — distribute clues across scenes

**Files:**
- Create: `src/dynamicworldagent/world_builder/cluePlacementAgent.ts`
- Create: `src/dynamicworldagent/world_builder/cluePlacementTemplate.ts`

**Step 1: Create template**

`cluePlacementTemplate.ts` — prompt that takes:
- Truth timeline (events with locations)
- Knowledge matrix (who knows what)
- All existing scenes (id, name, description, parentLocationId)
- All NPCs (id, name, location/residence)

Asks the LLM to:
- Generate `ScenarioClue[]` per scene
- Generate `NPCClue[]` per NPC
- Ensure clues are logically placed based on the story

**Step 2: Create agent**

`cluePlacementAgent.ts`:
- `placeClues()` method takes all world data + scenes + NPCs
- Calls LLM with clue placement prompt
- Distributes output clues to `DynamicScene.clues` and `DynamicNPCProfile.clues`
- Returns updated scenes and NPCs

**Step 3: Build and commit**

```bash
git add src/dynamicworldagent/world_builder/cluePlacementAgent.ts src/dynamicworldagent/world_builder/cluePlacementTemplate.ts
git commit -m "feat: add cluePlacementAgent for distributing clues across scenes"
```

---

### Task 10: Update NPC generation for residence assignment

**Files:**
- Modify: `src/dynamicworldagent/world_builder/npcBuilderAgent.ts`

**Step 1: Add residence assignment step**

After NPC generation and scenario assignment, add a step that:
1. For each `ScenarioOutline` with `residents` array, match NPC IDs
2. Set `residence` on matching `DynamicNPCProfile`
3. For NPCs not assigned a residence, use a default residential location

This can be a simple code function (no LLM needed):

```typescript
export function assignResidences(
  npcs: DynamicNPCProfile[],
  scenarios: ScenarioOutline[]
): void {
  for (const scenario of scenarios) {
    if (!scenario.residents?.length) continue;
    for (const npcId of scenario.residents) {
      const npc = npcs.find((n) => n.id === npcId);
      if (npc) {
        npc.residence = scenario.id;
      }
    }
  }
}
```

**Step 2: Build and commit**

```bash
git add src/dynamicworldagent/world_builder/npcBuilderAgent.ts
git commit -m "feat: add NPC residence assignment from ScenarioOutline.residents"
```

---

## Phase D: Pipeline Orchestration

### Task 11: Rewrite `worldBuilderService.ts` — new pipeline order

**Files:**
- Modify: `src/dynamicworldagent/world_builder/worldBuilderService.ts`

**Step 1: Update imports**

Add:
```typescript
import { SceneGraphBuilder } from "./sceneGraphBuilder.js";
import { SubSceneBuilder } from "./subSceneBuilder.js";
import { assembleSceneGraph } from "./graphAssembly.js";
import { CluePlacementAgent } from "./cluePlacementAgent.js";
import { getModuleSizeConfig } from "./moduleSizeConfig.js";
```

**Step 2: Rewrite `generateWorld()`**

New phase order:

```
Phase 0: Prompt Structurizer (unchanged)
Phase 1: Setting Seed — macroSceneAgent.generateSettingSeed()
  → macroScene, mythosEvents, endState, storyPremise
Phase 2: Macro Locations — scenarioBuilderAgent.generate()
  → ScenarioOutline[] (macro locations with subSceneCount)
Phase 3: Transport Network — sceneGraphBuilder.generateTransportNetwork()
  → outdoor scenes + TransportEdge[]
Phase 4: Sub-Scene Generation — subSceneBuilder.generateAllSubScenes() (parallel)
  → DynamicScene[] per macro location
Phase 5: Graph Assembly — assembleSceneGraph()
  → merged scene graph, validated connectivity
Phase 6: Truth Timeline — macroSceneAgent.generateStoryInWorld() (truth part)
  → TruthEvent[] placed in existing scenes
Phase 7: Knowledge Matrix — macroSceneAgent.generateStoryInWorld() (knowledge part)
  → KnowledgeHolder[] + RedHerring[]
Phase 8: NPC Generation — npcBuilderAgent.generateBatch() (mostly unchanged)
  → DynamicNPCProfile[] + residence assignment
Phase 9: NPC Assignment — assign NPCs to scenes, set residents on ScenarioOutline
Phase 10: Clue Placement — cluePlacementAgent.placeClues()
  → clues distributed to scenes + NPCs
Phase 11: Starting Scene Selection — pick initial player scene
Phase 12: Module Digest + Persistence
```

**Step 3: Update `saveWorldToJSON()` to save new file structure**

New output files:
- `macro_scene.json` — setting + mythos events + end state + story premise
- `scenarios_outline.json` — macro locations (simplified ScenarioOutline[])
- `transport_network.json` — outdoor scenes + TransportEdge[]
- `[ModuleName]_Scenarios/` — individual sub-scene JSON files (grouped by macro location)
- `truth_timeline.json`, `knowledge_matrix.json` — unchanged format
- `[ModuleName]_npc/` — unchanged
- `module_digest.json` — unchanged

**Step 4: Build**

Run: `pnpm build 2>&1 | head -80`
Fix any remaining type errors from the pipeline rewrite.

**Step 5: Commit**

```bash
git add src/dynamicworldagent/world_builder/worldBuilderService.ts
git commit -m "refactor: rewrite worldBuilderService with inverted pipeline — world first, then story"
```

---

## Phase E: Persistence

### Task 12: Update `worldModuleLoader.ts` — load/save new structure

**Files:**
- Modify: `src/dynamicworldagent/world_builder/worldModuleLoader.ts`

**Step 1: Update `LoadedWorldModule` interface**

Add:
```typescript
transportEdges: TransportEdge[];
storyPremise: string;
```

**Step 2: Update `loadWorldModule()`**

Add step to load `transport_network.json`:
```typescript
const transportFile = path.join(moduleDir, "transport_network.json");
const transportData = this.loadJSON<{
  outdoorScenes: Array<{ id: string; name: string; description: string }>;
  transportEdges: TransportEdge[];
}>(transportFile);
```

Update `loadDynamicScenes()` to handle new scene format with `parentLocationId` and `connections`:
```typescript
const scene: DynamicScene = {
  id: raw.id,
  name: raw.name,
  description: raw.description || "",
  parentLocationId: raw.parentLocationId || "",
  items: raw.items || [],
  clues: raw.clues || [],
  conditions: raw.conditions || [],
  connections: raw.connections || [],
  events: [],
};
```

**Step 3: Update `saveToDatabase()`**

Add transport edges to module background JSON blob. Add `parentLocationId` and `connections` to scene database writes.

**Step 4: Build and commit**

```bash
git add src/dynamicworldagent/world_builder/worldModuleLoader.ts
git commit -m "refactor: worldModuleLoader handles scene graph + transport network"
```

---

### Task 13: Update `DynamicGameStateLoader.ts`

**Files:**
- Modify: `src/dynamicworldagent/state/DynamicGameStateLoader.ts`

**Step 1: Replace `connectionStates` initialization (lines 826-838)**

Replace:
```typescript
if (completeState.connectionStates.length === 0) {
  const scenarioOutlines = completeState.scenarioOutlines ?? [];
  for (const outline of scenarioOutlines) {
    for (const conn of outline.connections ?? []) {
      completeState.connectionStates.push({...});
    }
  }
}
```

With:
```typescript
// blockedConnections: initially empty — all connections open
if (completeState.blockedConnections.size === 0) {
  // No blocked connections at game start
}
```

**Step 2: Add `npcResidences` initialization**

After NPC loop:
```typescript
for (const outline of completeState.scenarioOutlines ?? []) {
  if (outline.residents) {
    for (const npcId of outline.residents) {
      completeState.npcResidences[npcId] = outline.id;
    }
  }
}
```

**Step 3: Add `transportEdges` loading**

Load from module background JSON blob or from world data.

**Step 4: Update `buildSceneFromRow()` to include `parentLocationId` and `connections`**

```typescript
return {
  id: sceneRow.scenarioId,
  name: sceneRow.name || sceneRow.scenario?.name,
  description: sceneRow.description,
  parentLocationId: sceneRow.parentLocationId || "",
  items: Array.isArray(sceneRow.items) ? sceneRow.items : [],
  connections: Array.isArray(sceneRow.connections) ? sceneRow.connections : [],
  // ... rest unchanged
};
```

**Step 5: Build and commit**

```bash
git add src/dynamicworldagent/state/DynamicGameStateLoader.ts
git commit -m "refactor: DynamicGameStateLoader uses blockedConnections and npcResidences"
```

---

## Phase F: Runtime Integration

### Task 14: Add BFS pathfinding to `tickProcessor.ts`

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

**Step 1: Add pathfinding function**

```typescript
function findPath(
  fromSceneId: string,
  toSceneId: string,
  scenes: Map<string, DynamicScene>,
  blockedConnections: Map<string, string>
): string[] | null {
  if (fromSceneId === toSceneId) return [fromSceneId];

  const visited = new Set<string>();
  const queue: Array<{ sceneId: string; path: string[] }> = [
    { sceneId: fromSceneId, path: [fromSceneId] },
  ];

  while (queue.length > 0) {
    const { sceneId, path } = queue.shift()!;
    if (visited.has(sceneId)) continue;
    visited.add(sceneId);

    const scene = scenes.get(sceneId);
    if (!scene) continue;

    for (const connId of scene.connections) {
      if (visited.has(connId)) continue;

      // Check blocked
      const key1 = `${sceneId}::${connId}`;
      const key2 = `${connId}::${sceneId}`;
      if (blockedConnections.has(key1) || blockedConnections.has(key2)) continue;

      const newPath = [...path, connId];
      if (connId === toSceneId) return newPath;
      queue.push({ sceneId: connId, path: newPath });
    }
  }

  return null; // unreachable
}
```

**Step 2: Add travel time calculation**

```typescript
function calculateTravelTime(
  path: string[],
  scenes: Map<string, DynamicScene>,
  transportEdges: TransportEdge[]
): number {
  let totalMinutes = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const from = scenes.get(path[i]);
    const to = scenes.get(path[i + 1]);
    if (!from || !to) continue;

    if (from.parentLocationId === to.parentLocationId) {
      // Internal hop: 1-2 minutes
      totalMinutes += 1;
    } else {
      // Cross-location hop: find transport edge time
      const edge = transportEdges.find(
        (e) =>
          (e.streetSceneId === from.id || e.streetSceneId === to.id) &&
          ((e.fromLocationId === from.parentLocationId && e.toLocationId === to.parentLocationId) ||
           (e.fromLocationId === to.parentLocationId && e.toLocationId === from.parentLocationId))
      );
      totalMinutes += edge?.travelTimeMinutes ?? 5;
    }
  }
  return totalMinutes;
}
```

**Step 3: Rewrite movement handling (lines 692-705)**

Replace the current simple movement handler:

```typescript
if (node.type === "movement") {
  const state = dgsm.getState();
  const currentLocation = dgsm.getNpcLocation(node.characterId) ?? node.location;

  // Check if this is a creative movement (has actionType on movement node)
  if (node.actionType) {
    // Creative movement: single hop, requires skill check
    // ... existing skill check logic applies
    // On success:
    dgsm.setNpcLocation(node.characterId, node.location);
    return makeAction("completed", buildOutcome("completed"));
  }

  // Normal movement: pathfind
  const path = findPath(currentLocation, node.location, state.scenes, state.blockedConnections);
  if (!path) {
    return makeAction("failed", buildOutcome("failed", "no path available"), "location_blocked");
  }

  // Execute each hop
  const travelTime = calculateTravelTime(path, state.scenes, state.transportEdges);

  // Update location to destination
  dgsm.setNpcLocation(node.characterId, node.location);

  // Build outcome with travel details
  const hopCount = path.length - 1;
  return makeAction(
    "completed",
    buildOutcome("completed", `Traveled ${hopCount} hops in ~${travelTime} min`),
    undefined,
    travelTime
  );
}
```

**Step 4: Build**

Run: `pnpm build 2>&1 | head -80`

**Step 5: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "feat: add BFS pathfinding and multi-hop movement to tick processor"
```

---

### Task 15: Update `NPCPlanningAgent.ts` — scene graph context

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts`

**Step 1: Rewrite `formatSceneMap()` (lines 421-450)**

Replace with scene-graph-aware version:

```typescript
private formatSceneMap(dgsm: DynamicGameStateManager, npcId: string): string {
  const state = dgsm.getState();
  const npcLocation = state.npcLocations[npcId];
  const currentScene = npcLocation ? state.scenes.get(npcLocation) : null;

  const parts: string[] = [];

  // 1. Current scene + connections
  if (currentScene) {
    parts.push(`Current Scene: ${currentScene.id} "${currentScene.name}" — ${currentScene.description}`);

    const connScenes = currentScene.connections
      .map((id) => state.scenes.get(id))
      .filter(Boolean)
      .map((s) => `  - ${s!.id} "${s!.name}": ${s!.description}`);
    if (connScenes.length > 0) {
      parts.push("Connected Scenes:\n" + connScenes.join("\n"));
    }
  }

  // 2. Current macro location
  const currentMacro = currentScene
    ? state.scenarioOutlines.find((o) => o.id === currentScene.parentLocationId)
    : null;
  if (currentMacro) {
    parts.push(`Current Location: ${currentMacro.id} "${currentMacro.name}"`);
  }

  // 3. Nearby macro locations via transport edges
  if (currentScene) {
    const parentId = currentScene.parentLocationId;
    const nearbyEdges = state.transportEdges.filter(
      (e) => e.fromLocationId === parentId || e.toLocationId === parentId
    );
    const nearbyLocations = nearbyEdges.map((e) => {
      const targetId = e.fromLocationId === parentId ? e.toLocationId : e.fromLocationId;
      const target = state.scenarioOutlines.find((o) => o.id === targetId);
      return `  - ${targetId} "${target?.name ?? targetId}" (~${e.travelTimeMinutes} min via ${e.streetSceneId})`;
    });
    if (nearbyLocations.length > 0) {
      parts.push("Nearby Locations:\n" + nearbyLocations.join("\n"));
    }
  }

  // 4. NPC residence
  const residence = state.npcResidences[npcId];
  if (residence) {
    const residenceMacro = state.scenarioOutlines.find((o) => o.id === residence);
    parts.push(`Home/Residence: ${residence} "${residenceMacro?.name ?? residence}"`);
  }

  return parts.join("\n\n") || "No scene data.";
}
```

**Step 2: Update `generateDailyPlans()` call to pass npcId**

Change:
```typescript
const sceneMap = this.formatSceneMap(dgsm);
```
To:
```typescript
const sceneMap = this.formatSceneMap(dgsm, npc.id);
```

**Step 3: Update template — movement guidance**

In `NPCPlanningTemplate.ts`, update the "Movement & Location" section of `buildGenerateDailyPlanPrompt()`:

```
### Movement & Location
- Use "movement" nodes to change scenes. Set "location" to the destination scene ID.
- You can move to any connected scene listed above, or to a distant scene — the system will pathfind automatically.
- For creative movement (jumping from window, climbing walls), add an actionType (e.g. "environmental") — the system will require a skill check.
- To go home, move to a scene in your residence location.
- Travel time between buildings varies (shown in Nearby Locations).
```

**Step 4: Build**

Run: `pnpm build 2>&1 | head -80`

**Step 5: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts
git commit -m "refactor: NPCPlanningAgent uses scene graph context for movement planning"
```

---

## Phase G: Verification

### Task 16: Fix remaining type errors and verify full build

**Step 1: Search for all remaining `connectionStates` references**

Run: `grep -rn "connectionStates\|ScenarioConnectionState" src/ --include="*.ts" | grep -v node_modules`

Fix each reference: replace `connectionStates` reads with `blockedConnections`, remove `ScenarioConnectionState` imports.

**Step 2: Search for `DynamicScene` construction without `parentLocationId` or `connections`**

Run: `grep -rn "parentLocationId\|connections:" src/dynamicworldagent/ --include="*.ts" | grep -v node_modules`

Ensure all `DynamicScene` constructions include the new required fields.

**Step 3: Search for old `ScenarioOutline` field usage**

Run: `grep -rn "outline\.connections\|outline\.tags\|outline\.evidence\|outline\.clues\|estimatedShortActions\|timeRestriction" src/ --include="*.ts" | grep -v node_modules`

Remove or update references to removed fields.

**Step 4: Full SWC build**

Run: `pnpm build`
Expected: Clean build.

**Step 5: Full TSC build (strict type checking)**

Run: `pnpm build:tsc`
Fix any remaining type errors.

**Step 6: Commit any remaining fixes**

```bash
git add -A
git commit -m "fix: resolve all type errors for scene graph architecture"
```

---

## Notes

**Dependency order:** Tasks 1-3 must be done first (foundation). Tasks 4-8 can be done in order (pipeline). Tasks 9-10 depend on 4-8. Task 11 depends on all prior. Tasks 12-13 depend on 11. Tasks 14-15 depend on 3. Task 16 is final verification.

**Out of scope (follow-up tasks):**
- Multiplayer equivalents
- Prisma schema migrations (add `parentLocationId`, `connections` columns to scene table)
- Frontend map UI changes
- Scene image generation for sub-scenes
- Starting scene selection redesign (currently deprecated, needs new logic for sub-scene granularity)
- Orchestrator agent updates for player movement
- Player plan agent updates
