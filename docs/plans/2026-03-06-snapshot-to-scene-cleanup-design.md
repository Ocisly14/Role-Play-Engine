# Snapshot → Scene Cleanup Design (Single-Player)

Date: 2026-03-06
Branch: tick

## Problem

The old `ScenarioSnapshot` type and `clueRevelations` output are legacy artifacts that no longer fit the tick-based architecture. `DynamicScene` has replaced snapshots in the dynamic world system, but shared types and database plumbing still carry the old structures.

## Design

### 1. Delete `ScenarioSnapshot` type family, unify with `DynamicScene`

**`src/shared/agents/models/scenarioTypes.ts`:**
- Delete `ScenarioSnapshot`, `ParsedScenarioSnapshot`, `ScenarioCharacter`, `ScenarioProfile`
- Simplify `ParsedScenarioData`: remove `snapshot`/`snapshots`, produce `DynamicScene` directly
- Keep `ScenarioClue`, `ScenarioCondition`, `ScenarioQuery`, `ScenarioSearchResult`

**`src/shared/agents/memory/scenarioloader/scenarioLoader.ts`:**
- Output `DynamicScene` instead of `ScenarioProfile`
- Remove `ScenarioSnapshot` construction logic

**`src/shared/agents/memory/scenarioloader/scenarioDocumentParser.ts`:**
- Parse documents into `DynamicScene` instead of `ParsedScenarioSnapshot`

### 2. Delete `clueRevelations` entirely

**Remove from:**
- `TurnOutput.clueRevelations` and `GameTurn.clueRevelations` in `turnManager.ts`
- `completeTurn()` — stop passing to DB
- `CoCDatabaseAdapter` — remove from `completeTurn()` and turn mapping
- `operations.ts` — remove `clue_revelations` from SQL writes
- `TurnRagAgent.collectClueChunkDrafts()` — delete function + `hasRevealUpdates()`

**Move clue RAG to tick processor:**
- When tick processor marks a clue as `discovered`, embed it into RAG via `SessionRagService`

### 3. Rename `previousScenarioInfo` → `previousSceneInfo`

- `keeperAgent.ts`: rename variable + template key `previousScenarioJson` → `previousSceneJson`
- `keeperTemplate.ts`: rename `{{previousScenarioJson}}` → `{{previousSceneJson}}`

### Affected files

| # | File | Change |
|---|---|---|
| 1 | `src/shared/agents/models/scenarioTypes.ts` | Delete `ScenarioSnapshot`, `ParsedScenarioSnapshot`, `ScenarioCharacter`, `ScenarioProfile`, simplify `ParsedScenarioData` |
| 2 | `src/shared/agents/memory/scenarioloader/scenarioLoader.ts` | Output `DynamicScene` |
| 3 | `src/shared/agents/memory/scenarioloader/scenarioDocumentParser.ts` | Parse → `DynamicScene` |
| 4 | `src/dynamicworldagent/dynamicBasicAgent/memory/turnManager.ts` | Remove `clueRevelations` from interfaces + `completeTurn()` |
| 5 | `src/dynamicworldagent/dynamicBasicAgent/knowledge/turnRagAgent.ts` | Delete `collectClueChunkDrafts()` + `hasRevealUpdates()` |
| 6 | `src/shared/agents/memory/database/CoCDatabaseAdapter.ts` | Remove `clueRevelations` params + mapping |
| 7 | `src/shared/agents/memory/database/operations.ts` | Remove `clue_revelations` from SQL |
| 8 | `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/tickProcessor.ts` | Add clue RAG embedding on discovery |
| 9 | `src/dynamicworldagent/dynamicBasicAgent/keeper/keeperAgent.ts` | Rename `previousScenarioInfo` → `previousSceneInfo` |
| 10 | `src/dynamicworldagent/dynamicBasicAgent/keeper/keeperTemplate.ts` | Rename `{{previousScenarioJson}}` → `{{previousSceneJson}}` |

### Not touched
- Multiplayer files (out of scope)
- DB column `clue_revelations` in SQLite (leave existing data, stop reading/writing)
- `ScenarioClue`, `ScenarioCondition` (shared by both systems, kept)
