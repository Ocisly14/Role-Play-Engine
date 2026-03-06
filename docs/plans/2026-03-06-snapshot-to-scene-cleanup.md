# Snapshot → Scene Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove legacy `ScenarioSnapshot`/`clueRevelations` code and unify on `DynamicScene` across single-player codebase.

**Architecture:** Three independent cleanup streams — (1) delete `ScenarioSnapshot`/`ScenarioProfile`/`ScenarioCharacter` types and update scenarioLoader to produce `DynamicScene`, (2) delete `clueRevelations` from turn pipeline and move clue RAG embedding to tick processor, (3) rename `previousScenario` → `previousScene` in keeper. Document parser is left unchanged.

**Tech Stack:** TypeScript, Prisma, LangGraph

---

### Task 1: Delete `ScenarioSnapshot`/`ScenarioProfile`/`ScenarioCharacter` from `scenarioTypes.ts`

**Files:**
- Modify: `src/shared/agents/models/scenarioTypes.ts`

**Step 1: Remove old types**

Delete these interfaces:
- `ScenarioCharacter` (lines 9-21)
- `ScenarioSnapshot` (lines 78-118)
- `ScenarioProfile` (lines 123-149)

Keep: `ScenarioClue`, `ScenarioCondition`, `ParsedScenarioSnapshot`, `ParsedScenarioData`, `ScenarioQuery`, `ScenarioSearchResult`.

**Step 2: Build and check for type errors**

Run: `pnpm build 2>&1 | head -80`
Expected: Type errors in scenarioLoader.ts (will fix in next task)

**Step 3: Commit**

```bash
git add src/shared/agents/models/scenarioTypes.ts
git commit -m "refactor: delete ScenarioSnapshot/ScenarioProfile/ScenarioCharacter types"
```

---

### Task 2: Update `scenarioLoader.ts` to output `DynamicScene`

**Files:**
- Modify: `src/shared/agents/memory/scenarioloader/scenarioLoader.ts`

**Step 1: Update imports**

Replace imports — remove `ScenarioCharacter`, `ScenarioProfile`, `ScenarioSnapshot`. Add `DynamicScene` import:
```typescript
import type {
  ParsedScenarioData,
  ScenarioClue,
  ScenarioCondition,
  ScenarioQuery,
  ScenarioSearchResult,
} from "../../models/scenarioTypes.js";
import type { DynamicScene } from "../../../../dynamicworldagent/world_builder/types.js";
```

**Step 2: Replace `convertSnapshot` with `convertToScene`**

Delete `convertSnapshot()` (lines 462-530). Replace with:

```typescript
private convertToScene(
  snapshotData: import("../../models/scenarioTypes.js").ParsedScenarioSnapshot,
  scenarioId: string,
  scenarioName: string,
): DynamicScene {
  const sceneId = `${scenarioId}-scene`;

  const clues: ScenarioClue[] = (snapshotData.clues || []).map(
    (clue, clueIndex) => ({
      id: `${sceneId}-clue-${clueIndex}`,
      clueText: clue.clueText,
      category: (clue.category as any) || "observation",
      difficulty: (clue.difficulty as any) || "regular",
      location: clue.location || scenarioName,
      discoveryMethod: clue.discoveryMethod,
      reveals: clue.reveals || [],
      discovered: false,
    })
  );

  const conditions: ScenarioCondition[] = (snapshotData.conditions || []).map(
    (cond) => ({
      type: (cond.type as any) || "other",
      description: cond.description,
      mechanicalEffect: cond.mechanicalEffect,
    })
  );

  return {
    id: sceneId,
    name: snapshotData.name || scenarioName,
    description: snapshotData.description,
    items: [],
    clues,
    conditions,
    events: snapshotData.events || [],
  };
}
```

**Step 3: Replace `convertToScenarioProfile` with `convertToDynamicScene`**

Delete `convertToScenarioProfile()` (lines 536-600). Replace with:

```typescript
private convertToDynamicScene(parsedData: ParsedScenarioData): { scene: DynamicScene; metadata: ParsedScenarioData } {
  const scenarioId = this.generateScenarioId(parsedData.name);

  if (!parsedData.snapshot) {
    throw new Error(`Scenario "${parsedData.name}" has no snapshot`);
  }

  const scene = this.convertToScene(parsedData.snapshot, scenarioId, parsedData.name);
  return { scene, metadata: parsedData };
}
```

**Step 4: Update all methods that return `ScenarioProfile[]` to return `DynamicScene[]`**

- `loadScenariosFromJSONDirectory()`: return `DynamicScene[]`
- `loadScenariosFromDirectory()`: return `DynamicScene[]`
- `getAllScenarios()`: return `DynamicScene[]`
- `getScenarioById()`: return `DynamicScene | null`
- `findInitialScenarioByFileName()`: return `DynamicScene | null`
- `searchScenarios()`: update `ScenarioSearchResult.scenarios` to use `DynamicScene[]`

Update `saveScenarioToDatabase()` to accept `{ scene: DynamicScene; metadata: ParsedScenarioData }` instead of `ScenarioProfile`.

Update `getScenarioById()` to construct `DynamicScene` instead of `ScenarioSnapshot`/`ScenarioProfile`.

**Step 5: Build**

Run: `pnpm build 2>&1 | head -80`
Fix any downstream type errors in files importing from scenarioLoader.

**Step 6: Commit**

```bash
git add src/shared/agents/memory/scenarioloader/scenarioLoader.ts
git commit -m "refactor: scenarioLoader outputs DynamicScene instead of ScenarioProfile"
```

---

### Task 3: Delete `clueRevelations` from turn pipeline

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/memory/turnManager.ts`
- Modify: `src/shared/agents/memory/database/CoCDatabaseAdapter.ts`
- Modify: `src/shared/agents/memory/database/operations.ts`

**Step 1: Remove from `turnManager.ts`**

- Delete `clueRevelations?: any` from `TurnOutput` interface (line 40)
- Delete `clueRevelations: any | null` from `GameTurn` interface (line 61)
- In `completeTurn()` (line 178-205): remove `output.clueRevelations` from `this.db.completeTurn()` call — change to:
  ```typescript
  this.db.completeTurn(turnId, mergedNarrative, output.gameDay, output.gameTime);
  ```

**Step 2: Remove from `CoCDatabaseAdapter.ts`**

- In `toCachedTurn()` (line 68-94): delete `clueRevelations: turn.clueRevelations` (line 81)
- In `createTurn()` (line 218-282): delete `clueRevelations: null` from cache object (line 244)
- In `completeTurn()` (line 333-368):
  - Remove `clueRevelations?: any` parameter (line 336)
  - Delete `clueRevelations: clueRevelations ?? null` from both cache update (line 346) and Prisma update (line 358)
- In `formatTurn()` (line 687-711): delete `clue_revelations: turn.clueRevelations` (line 699)

**Step 3: Remove from `operations.ts`**

- In `getTurnById()` result mapping (line 97): delete `clue_revelations: turn.clueRevelations`
- In `formatTurn()` (line 525): delete `clue_revelations: turn.clueRevelations`

**Step 4: Build**

Run: `pnpm build 2>&1 | head -80`
Expected: Errors where `completeTurn` is called with old arg count — fix callers.

**Step 5: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/memory/turnManager.ts src/shared/agents/memory/database/CoCDatabaseAdapter.ts src/shared/agents/memory/database/operations.ts
git commit -m "refactor: delete clueRevelations from turn pipeline"
```

---

### Task 4: Clean up `TurnRagAgent` — delete `collectClueChunkDrafts`

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/knowledge/turnRagAgent.ts`

**Step 1: Delete clue-related code**

Delete these functions:
- `hasRevealUpdates()` (lines 25-35)
- `collectClueChunkDrafts()` (lines 94-183)
- The `ClueChunkDraft` type (lines 13-19)

In `recordTurn()`: remove the `collectClueChunkDrafts` call and the clue chunk building block (lines 257-283). Keep the narrative and action log chunk logic.

**Step 2: Build**

Run: `pnpm build 2>&1 | head -80`

**Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/knowledge/turnRagAgent.ts
git commit -m "refactor: remove clueRevelations from TurnRagAgent"
```

---

### Task 5: Add clue RAG embedding to tick processor

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts`

**Step 1: Add clue RAG embedding after clue discovery**

Import `SessionRagService`:
```typescript
import { type SessionRagChunkInput, SessionRagService } from "../knowledge/sessionRagService.js";
```

Create a helper function:

```typescript
function embedDiscoveredClues(
  clues: DiscoveredClueEntry[],
  dgsm: DynamicGameStateManager,
  language: string
): void {
  const ragService = new SessionRagService();
  const state = dgsm.getState();
  const ragChunks: SessionRagChunkInput[] = clues.map((entry) => ({
    sessionId: state.sessionId,
    chunkType: "clue" as const,
    role: "system" as const,
    content: [
      `Clue Discovered`,
      `Type: ${entry.source}`,
      `Source: ${entry.sourceName}`,
      `Content: ${entry.clueText}`,
    ].join("\n"),
    metadata: {
      clueType: entry.source,
      sourceName: entry.sourceName,
      discoveredAt: `Day ${state.gameDay}, ${state.timeOfDay}`,
    },
    sourceKey: `clue:${entry.clueId}`,
    language,
  }));
  void ragService.upsertChunks(ragChunks).catch((err) =>
    console.error("[TickProcessor] Failed to embed clue:", err)
  );
}
```

Call `embedDiscoveredClues(clues, dgsm, language)` after each clue discovery site (around line 979-1000 and ~1268).

**Step 2: Build**

Run: `pnpm build 2>&1 | head -80`

**Step 3: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts
git commit -m "feat: embed discovered clues into RAG from tick processor"
```

---

### Task 6: Rename `previousScenario` → `previousScene` in keeper

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/keeper/keeperAgent.ts`
- Modify: `src/dynamicworldagent/dynamicBasicAgent/keeper/keeperTemplate.ts`

**Step 1: Rename in keeperAgent.ts**

- Line 88: `previousScenarioInfo` → `previousSceneInfo`
- Line 89: `extractPreviousScenarioInfo` → `extractPreviousSceneInfo`
- Line 223: `previousScenarioJson: previousScenarioInfo` → `previousSceneJson: previousSceneInfo`
- Line 224: `this.safeStringify(previousScenarioInfo)` → `this.safeStringify(previousSceneInfo)`
- Line 512: rename method `extractPreviousScenarioInfo` → `extractPreviousSceneInfo`

**Step 2: Rename in keeperTemplate.ts**

- Line 59: `{{previousScenarioJson}}` → `{{previousSceneJson}}`

**Step 3: Build**

Run: `pnpm build 2>&1 | head -80`

**Step 4: Commit**

```bash
git add src/dynamicworldagent/dynamicBasicAgent/keeper/keeperAgent.ts src/dynamicworldagent/dynamicBasicAgent/keeper/keeperTemplate.ts
git commit -m "refactor: rename previousScenario → previousScene in keeper"
```

---

### Task 7: Final build verification

**Step 1: Full build**

Run: `pnpm build`
Expected: Clean build with no errors.

**Step 2: Check for stale imports**

Run: `grep -rn "ScenarioSnapshot\|ScenarioProfile\|ScenarioCharacter\|clueRevelations\|previousScenarioJson" src/ --include="*.ts" | grep -v node_modules | grep -v multiplayerAgent | grep -v multiplayerState | grep -v multiplayerGraph | grep -v scenarioDocumentParser`

Expected: No matches (multiplayer files and document parser excluded).

**Step 3: Commit any remaining fixes**

If step 2 found straggling references, fix and commit.
