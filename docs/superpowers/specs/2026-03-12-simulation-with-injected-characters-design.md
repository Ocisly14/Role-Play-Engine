# NPC Autonomous Simulation with Player-Injected Characters — Design Spec

**Date:** 2026-03-12
**Status:** Draft
**Hard Prerequisite:** Simulation plan Chunk 1 (Tasks 1–3) must be implemented first — `playerCharacter` optional, `sessionType` field, Prisma `SimulationEvent` model.
**Context:** Backend design for simulation mode where NPCs run autonomously and players can inject custom AI-controlled characters. Builds on existing simulation plan (`docs/superpowers/plans/2026-03-11-npc-autonomous-simulation.md`) and map viewer spec (`docs/superpowers/specs/2026-03-12-simulation-map-viewer-design.md`).

---

## Overview

A simulation mode where all characters (module NPCs + player-injected characters) run autonomously via the existing NPC planning pipeline. Players observe the simulation and can pause to adjust their injected characters' long-term intents, then resume. This is a backend-only spec — frontend/UI is out of scope.

**Key principles:**
- Injected characters are stored as NPCs (`isPlayerInjected` flag) — zero pipeline changes
- Player directives are written directly to `npcLongTermIntent` table
- Pause → adjust intent → resume cycle (turn-based feel)
- Single player, multiple injected characters per simulation
- All endpoints require JWT authentication

---

## Data Model

### DynamicNPCProfile Extension

Two new optional fields on `DynamicNPCProfile` in `src/dynamicworldagent/world_builder/types.ts`:

```typescript
export interface DynamicNPCProfile extends DynamicCharacterProfile {
  // ... existing fields ...
  isNPC: true;

  // New fields
  isPlayerInjected?: boolean;  // true = player-created character in simulation
}
```

Injected characters participate fully in the NPC ecosystem: relationship graph, unplanned encounters, memory system, knowledge discovery.

### DynamicGameState Extension

```typescript
interface DynamicGameState {
  // ... existing fields ...
  sessionType?: "player_game" | "simulation";  // new
  // npcCharacters already exists — injected characters go here
}
```

### Prisma Schema

Extend `Session` model with `sessionType` (from existing simulation plan). No additional Prisma changes beyond what the simulation plan already specifies.

---

## Simulation Lifecycle

### Full Flow

```
Create simulation (select module, auth required)
  → Inject characters (0–N, with attributes/skills/backstory/intents)
  → Initialize (generate day-1 schedules for all NPCs + injected characters)
  → Start simulation
  → [auto loop] tick → tick → tick ...
  → Player pauses
  → Adjust character intents / inject new characters
  → Resume (reviseSchedule for modified characters, then continue ticks)
  → ...
  → Stop (manual / max days / trigger event)
```

### SimulationRunner Extensions

Building on the `SimulationRunner` from the existing simulation plan, add:

```typescript
class SimulationRunner {
  // --- Existing methods (from simulation plan) ---
  start(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;        // extended: reviseSchedule for modified characters before resuming
  step(ticks?: number): Promise<SimulationEvent[]>;
  stop(): void;
  getStatus(): SimulationStatus;

  // --- Internal tracking ---
  private modifiedCharacterIds: Set<string> = new Set();

  // --- New: character injection ---
  injectCharacter(profile: DynamicNPCProfile): Promise<void>;
  // Only callable when state is "paused" or before start
  // 1. Add to dgsm.npcCharacters (with isPlayerInjected: true, isNPC: true)
  // 2. Initialize ALL per-NPC state maps:
  //    - npcLocations[id] = residence (macro location ID)
  //    - npcStats[id] = { hp: derived from CON/SIZ, san: POW }
  //    - npcResidences[id] = residence
  //    - npcInventories[id] = []
  //    - npcDiscoveredKnowledge[id] = []
  //    - npcRelationshipGraph[id] = {} (empty — relationships form naturally via encounters)
  //    - characterPositions[id] = { type: "scene", sceneId: entrySceneId }
  // 3. Upsert npcLongTermIntent with deterministic ID `${sessionId}_${characterId}`
  //    matching existing seedLongTermIntents convention (NO LLM call)
  // 4. Generate day-1 schedule only (one LLM call via generateSingleNpcSchedule)

  removeCharacter(characterId: string): void;
  // Only callable when paused
  // In-memory cleanup (all per-NPC state maps):
  //   - npcCharacters: filter out
  //   - npcLocations: delete key
  //   - npcStats: delete key
  //   - npcResidences: delete key
  //   - npcInventories: delete key
  //   - npcDiscoveredKnowledge: delete key
  //   - characterPositions: delete key
  //   - npcRelationshipGraph: delete graph[id] AND delete graph[*][id] (bidirectional)
  // Prisma cleanup:
  //   - Delete npcLongTermIntent rows for (sessionId, npcId)
  //   - Delete npcDailyPlan rows for (sessionId, npcId)
  //   - Delete NpcMemory rows for (sessionId, npcId)

  // --- New: intent management ---
  updateIntent(characterId: string, intent: string): void;
  // Only callable when paused
  // Upsert npcLongTermIntent with ID `${sessionId}_${characterId}` (same convention)
  // Add characterId to this.modifiedCharacterIds

  clearIntent(characterId: string): void;
  // Remove from modifiedCharacterIds, reset intent to original goals

  getInjectedCharacters(): DynamicNPCProfile[];
  // Return all characters where isPlayerInjected === true
}
```

### Resume Behavior

When `resume()` is called:
1. Drain `modifiedCharacterIds` set
2. For each modified character, call `npcPlanningAgent.reviseSchedule(dgsm, sessionId, charId, "Player updated character intent", language)`
3. Clear `modifiedCharacterIds`
4. Then continue the tick loop (delegate to `start()`)

---

## Player Intent Flow

### On Character Injection

1. Player provides full `DynamicNPCProfile` including desired intents (as free-text)
2. System upserts `npcLongTermIntent` with deterministic ID `${sessionId}_${characterId}` — skips `generateLongTermIntents()` LLM call. The `moduleId` is resolved from the simulation session context.
3. System calls `generateSingleNpcSchedule()` to create day-1 schedule (one LLM call)
4. Character is ready to participate in tick execution

**Note on relationships:** Existing module NPCs will have no initial relationship entries pointing to the injected character. Relationships form naturally when encounters occur (via `updateRelationshipViaLLM` in the tick processor). This is correct behavior — a newly arrived character is unknown to residents.

### On Intent Update (During Pause)

1. Player calls `PUT /api/simulation/:id/characters/:charId/intent` with new intent text
2. System upserts `npcLongTermIntent.intent` using deterministic ID `${sessionId}_${charId}`
3. Character ID added to `modifiedCharacterIds` set
4. On resume, `reviseSchedule()` is called for that character — the updated intent feeds into the existing schedule revision prompt naturally

### Pipeline Changes: None

The existing NPC planning pipeline already:
- Reads `longTermIntent` from `npcLongTermIntent` table via `getLongTermIntent()`
- Uses it in `generateDailySchedule()` and `reviseSchedule()` prompts
- Generates `PlanNode` objects that the tick processor executes

Injected characters flow through the exact same path. No template changes, no tick processor changes.

---

## API Design

All endpoints require JWT authentication. Simulation is owned by the creating user.

### Existing Simulation Endpoints (from simulation plan, unchanged)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/simulation` | Create simulation (select module) |
| POST | `/api/simulation/:id/start` | Start simulation |
| POST | `/api/simulation/:id/pause` | Pause simulation |
| POST | `/api/simulation/:id/resume` | Resume (+ reviseSchedule for modified chars) |
| POST | `/api/simulation/:id/step` | Manual step N ticks |
| POST | `/api/simulation/:id/stop` | Stop simulation |
| GET | `/api/simulation/:id/status` | Get simulation status |
| GET | `/api/simulation/:id/events` | Query simulation events |
| GET | `/api/simulations` | List user's simulations |

### New Character Management Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/simulation/:id/characters` | Inject a character. Body: `DynamicNPCProfile` fields. Only when paused or before start. |
| GET | `/api/simulation/:id/characters` | List all injected characters (`isPlayerInjected === true`) |
| PUT | `/api/simulation/:id/characters/:charId/intent` | Update character intent. Body: `{ intent: string }`. Only when paused. |
| DELETE | `/api/simulation/:id/characters/:charId` | Remove injected character. Only when paused. |

### Authentication & Authorization

- All endpoints go through existing JWT auth middleware (same as `/api/game/*`)
- `POST /api/simulation` binds `session.userId` to the authenticated user
- All subsequent operations verify `session.userId === req.user.id`

---

## Relationship to Existing Plans

### Simulation Plan (`2026-03-11-npc-autonomous-simulation.md`)

This spec is an **additive extension** — everything in the simulation plan remains valid:
- SimulationRunner lifecycle, SimulationEventEmitter, event persistence, WebSocket broadcasting
- TickProcessor `mode: "simulation"` parameter, `runSimulationTick` export
- `playerCharacter` made optional on DynamicGameState
- Prisma `SimulationEvent` model

This spec adds: `isPlayerInjected` flag, character injection/removal methods, intent update API, auth requirement.

### Map Viewer Spec (`2026-03-12-simulation-map-viewer-design.md`)

Frontend is out of scope for this spec. Map viewer will need updates to support:
- "My Characters" section in side panel
- Pause-time character editing
- Auth requirement (move inside `ProtectedRoute`)

These will be designed separately.

---

## Character Creation Requirements

When injecting a character, the following fields are required:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Character name |
| `attributes` | Yes | STR, CON, SIZ, DEX, APP, INT, POW, EDU, LUCK |
| `skills` | Yes | `Record<string, number>` — CoC skill percentages |
| `backstory` | Yes | Character background narrative |
| `residence` | Yes | Starting macro location (`scenarioOutline.id`), must exist in module. Returns 400 if invalid. |
| `personality` | Recommended | Personality description (used by AI for behavior) |
| `occupation` | Recommended | Character occupation |
| `age` | Optional | Character age |
| `gender` | Optional | Character gender |

System auto-sets:
- `id`: UUID
- `isNPC: true`, `isPlayerInjected: true`
- `status`: `{ hp: derived from CON/SIZ, san: POW }`
- `inventory`: `[]`
- `knowledge`: `[]` (typed `NPCKnowledge[]`, required on `DynamicNPCProfile`)
- `relationships`: `[]` (typed `NPCRelationship[]`, required on `DynamicNPCProfile`)

State maps initialized:
- `npcStats[id]`: `{ hp, san }` matching `status`
- `npcLocations[id]`: resolved from `residence` (macro location → entry scene)
- `npcResidences[id]`: `residence`
- `npcInventories[id]`: `[]`
- `npcDiscoveredKnowledge[id]`: `[]`
- `npcRelationshipGraph[id]`: `{}`
- `characterPositions[id]`: `{ type: "scene", sceneId: entrySceneId }`

The player also provides an initial **intent** (free-text string) which is upserted to `npcLongTermIntent` with deterministic ID `${sessionId}_${characterId}`.

---

## Summary of Code Changes

### New Files
- `client/server/simulation/` — service, controller, routes (from simulation plan + character endpoints)

### Modified Files
- `src/dynamicworldagent/world_builder/types.ts` — add `isPlayerInjected` to `DynamicNPCProfile`
- `src/dynamicworldagent/state/DynamicGameState.ts` — add `sessionType`, make `playerCharacter` optional
- `src/dynamicworldagent/simulation/SimulationRunner.ts` — add `injectCharacter`, `removeCharacter`, `updateIntent`, `getInjectedCharacters`; extend `resume` to call `reviseSchedule` for modified characters
- `client/server.ts` — mount simulation routes
- `prisma/schema.prisma` — SimulationEvent model, Session.sessionType (from simulation plan)

### Unchanged
- `tickProcessor.ts` — no changes beyond what simulation plan already specifies (mode param)
- `NPCPlanningAgent.ts` — no changes, injected characters use existing methods
- `npcPlanningTemplates.ts` — no changes, existing prompts handle longTermIntent naturally
- All engine handlers and features — no changes
