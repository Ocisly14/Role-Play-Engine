# Simulation Launcher & Map Viewer Wiring Design

## Summary

Replace the current game flow (New Game / Continue Game → chat-based GamePage) with a simulation-first flow. The homepage launches simulations directly; the Map Viewer (`SimulationPage`) becomes the primary game interface.

## Goals

1. Homepage provides "New Simulation" and "Continue Simulation" as primary actions
2. New Simulation: select module → configure (tick speed, max days, weather) → create & redirect to Map Viewer
3. Continue Simulation: list existing simulations → select → redirect to Map Viewer
4. Wire the existing Phaser scenes to load tilemap assets (currently listeners exist but nothing emits the events)
5. Preserve "Create Character" and "Manage Modules" on homepage for future use

## User Flow

### New Simulation

```
HomePage ("New Simulation" button)
  → /simulation/select (module picker, reuses ModSelector component)
  → /simulation/config (tick speed, max days, weather)
  → POST /api/simulation (create simulation)
  → redirect → /simulation/:sessionId (Map Viewer)
```

### Continue Simulation

```
HomePage ("Continue Simulation" button)
  → SimulationSelectorModal (overlay on homepage)
    → GET /api/simulations (list with status, moduleName, day/time)
    → select one → redirect → /simulation/:sessionId
```

## Route Changes

### New Routes

| Route | Component | Purpose |
|-------|-----------|---------|
| `/simulation/select` | `SimulationSelectPage` | Module picker for new simulation |
| `/simulation/config` | `SimulationConfigPage` | Configure tick speed, max days, weather |
| `/simulation/:sessionId` | `SimulationPage` | Map Viewer (already exists) |

### Removed Routes

| Route | Component | Reason |
|-------|-----------|--------|
| `/mod/select` | `ModSelectionPage` | Replaced by `/simulation/select` |
| `/mod/intro` | `ModuleIntroPage` | Not needed in simulation flow |
| `/game` | `GamePage` | Replaced by `SimulationPage` |

### Preserved Routes

| Route | Component | Reason |
|-------|-----------|--------|
| `/character/create` | `CharacterCreationPage` | Future player injection |
| `/character/select` | `CharacterSelectionPage` | Future player injection (decouple from main flow) |

## New Frontend Files

### `views/SimulationSelectPage.tsx`

Wraps the existing `ModSelector` component. On module selection, navigates to `/simulation/config` with `moduleName` in route state.

No module loading/streaming needed — the simulation backend handles module initialization during `POST /api/simulation`.

### `views/SimulationConfigPage.tsx`

Receives `moduleName` from route state. Displays three configuration controls:

| Config | Control | Default | Options |
|--------|---------|---------|---------|
| Tick Speed | Button group | 1x | 1x (60000ms), 2x (30000ms), 5x (12000ms), 10x (6000ms) |
| Max Days | Number input or slider | 7 | 1–30 |
| Weather | Dropdown select | clear | clear, rain, fog, storm, snow, extreme_heat, extreme_cold (matches `WeatherType` enum in weatherFeature.ts) |

Buttons:
- "Back" → navigate to `/simulation/select`
- "Start Simulation" → call `createSimulation()` → redirect to `/simulation/:sessionId`

### `components/simulation/SimulationSelectorModal.tsx`

Modal overlay triggered from HomePage "Continue Simulation" button. Calls `GET /api/simulations`. Each row shows:
- Module name
- Current day / time
- Status badge (running / paused / stopped / completed)

Click a row → navigate to `/simulation/:sessionId`.

## Modified Frontend Files

### `views/HomePage.tsx` + `views/Homes.tsx`

The actual button labels and callbacks are in `Homes.tsx` (via `HomeProps` interface: `onStartGame`, `onContinueGame`). Both files need changes:

**`HomePage.tsx`:** Replace `handleStartGame` to navigate to `/simulation/select`. Replace `handleContinueGame` to open `SimulationSelectorModal`.

**`Homes.tsx`:** Update button labels via i18n keys (or replace directly). Remove or adapt the `handleStartGame` wrapper. The `HomeProps` callbacks (`onStartGame` → `onNewSimulation`, `onContinueGame` → `onContinueSimulation`) should be renamed for clarity.

Final button set:
- "New Simulation" → navigates to `/simulation/select`
- "Continue Simulation" → opens `SimulationSelectorModal`
- "Manage Modules" → keep as-is
- "Create Character" → keep as-is
- "View Characters" → keep as-is

### `services/simulationApi.ts`

Add two new functions:

```typescript
export async function createSimulation(params: {
  moduleName: string;
  language?: string;
  config?: {
    tickIntervalMs?: number;
    maxDays?: number;
    weather?: "clear" | "rain" | "fog" | "storm" | "snow" | "extreme_heat" | "extreme_cold";
  };
}): Promise<{ sessionId: string }> {
  const { data } = await api.post("/simulation", params);
  return data;
}

export async function listSimulations(): Promise<Array<{
  sessionId: string;
  moduleName: string;
  state: "running" | "paused" | "stopped" | "completed";
  currentDay: number;
  currentTime: string;
  ticksExecuted: number;
}>> {
  const { data } = await api.get("/simulations");
  return data.simulations;
}
```

### `views/SimulationPage.tsx`

Wire tilemap loading. Two new `useEffect` hooks:

**1. Load town map on init:**

When `topology`, `mapLayout`, and `game` are all ready, emit `load-town-map`:

```typescript
useEffect(() => {
  if (!gameRef.current || !state.topology || !state.mapLayout || !mapsPrefix) return;
  gameRef.current.events.emit("load-town-map", {
    mapUrl: `/api/maps/${mapsPrefix}/town.json`,
    tilesetUrl: `/api/maps/${mapsPrefix}/tilesets/outdoor.png`,
    tilesetKey: "outdoor",
  });
}, [state.topology, state.mapLayout, mapsPrefix]);
```

Note: The `/api/maps/*` route searches for the relative path inside each module directory under `data/Mods/`. So a URL like `/api/maps/Simple_Town_Maps/town.json` resolves to `data/Mods/simple_town/Simple_Town_Maps/town.json`. The `mapsPrefix` value (e.g., `"Simple_Town_Maps"`) is returned by the status API — do NOT prefix it with `moduleName` (that would cause a double-path).

**2. Load interior on building click:**

Update `handleGameReady` to emit `load-interior` when a building is clicked:

```typescript
game.events.on("building-clicked", (sceneId: string) => {
  enterBuilding(sceneId, sceneId);
  if (mapsPrefix) {
    game.events.emit("load-interior", {
      sceneId,
      mapUrl: `/api/maps/${mapsPrefix}/interiors/${sceneId}.json`,
      tilesetUrl: `/api/maps/${mapsPrefix}/tilesets/interior.png`,
      tilesetKey: "interior",
    });
  }
});
```

**3. Fetch moduleName and mapsPrefix from status:**

The `useSimulationState` hook already calls `fetchStatus()`. The response will now include `moduleName` and `mapsPrefix`. Update:
- `SimulationStatus` interface in `simulationApi.ts`: add `moduleName: string` and `mapsPrefix?: string`
- `SimulationViewState` in `useSimulationState.ts`: add `moduleName: string | null` and `mapsPrefix: string | null`
- `loadInitialState()`: store both values from `fetchStatus()` response

### `App.tsx`

Update routes:
- Remove `/mod/select`, `/mod/intro`, `/game`
- Add `/simulation/select`, `/simulation/config` — inside `ProtectedRoute` (they call authenticated APIs)
- Keep `/simulation/:sessionId` — outside `ProtectedRoute` (read-only viewer, consistent with current placement)
- Keep `/character/create`, `/character/select`
- Remove `BackgroundManager` reference to `/game` path (dead code after removal)

### `hooks/useSimulationState.ts`

Add `moduleName: string | null` and `mapsPrefix: string | null` to `SimulationViewState` (initialized as `null`). In `loadInitialState()`, store both from the `fetchStatus()` response. These are consumed by `SimulationPage.tsx` for constructing tilemap URLs.

### `views/SimulationSelectPage.tsx` — `ModSelector` adaptation

The existing `ModSelector` component has an `onCreateStory` prop that shows a "Create Your Own Story" card. In the simulation context, this should be hidden — pass `onCreateStory={undefined}` or add a prop to disable it. The "Start Adventure" button label should also change to "Next" or "Configure".

## Backend Changes

### `server/simulation/controller.ts`

**`getStatus` handler:** Include `moduleName` and `mapsPrefix` in response:

```typescript
// In getStatus handler
const status = runner.getStatus();
const moduleName = runner.getModuleName();
const modulePath = runner.getModulePath();

// Resolve mapsPrefix: find the *_Maps directory name within the module folder
let mapsPrefix: string | null = null;
if (modulePath) {
  const mapsDir = findMapsDirectory(modulePath); // from mapService.ts
  if (mapsDir) {
    mapsPrefix = path.basename(mapsDir); // e.g., "Simple_Town_Maps"
  }
}

return res.json({ ...status, moduleName, mapsPrefix });
```

### `server/simulation/service.ts`

**`createSimulation` function:** Accept `weather` config and apply after game state initialization:

```typescript
export async function createSimulation(
  prisma: PrismaClient,
  moduleName: string,
  userId: string,
  language = "en",
  config?: Partial<SimulationConfig> & { weather?: WeatherType }
): Promise<{ sessionId: string; status: SimulationStatus }> {
  // ... existing creation logic ...

  // After gameState initialization, apply weather to outdoor scenes
  if (config?.weather && config.weather !== "clear") {
    applyGlobalWeather(dgsm, config.weather);
  }

  // ... rest of existing logic ...
}

function applyGlobalWeather(dgsm: DynamicGameStateManager, weather: WeatherType): void {
  // Reuse the same pattern as weatherFeature's writeWeatherConditions():
  // - Tag conditions with "[Weather]" prefix for identification
  // - Use computeSkillPenalties() and getWeatherLabel() from weatherFeature.ts
  // - Default intensity: 3 (moderate)
  const topology = dgsm.getTopology();
  if (!topology) return;

  const DEFAULT_INTENSITY = 3;
  const outdoorIds = [
    ...Array.from(topology.junctions.keys()),
    ...Array.from(topology.roads.keys()),
  ];

  // Import and reuse from weatherFeature: getWeatherLabel, computeSkillPenalties
  const label = getWeatherLabel(weather, DEFAULT_INTENSITY);
  const penalties = computeSkillPenalties(weather, DEFAULT_INTENSITY);

  for (const sceneId of outdoorIds) {
    // Clear existing weather conditions (same pattern as clearWeatherConditions)
    const state = dgsm.getState();
    const conditions = state.scenarioConditions[sceneId] ?? [];
    state.scenarioConditions[sceneId] = conditions.filter(
      (c: any) => !c.description.startsWith("[Weather]")
    );

    // Append new weather condition (SceneCondition has description + mechanicalEffect, NO type field)
    dgsm.appendSceneCondition(sceneId, {
      description: `[Weather] ${label}`,
      mechanicalEffect: penalties.length > 0 ? { skillPenalty: penalties } : undefined,
    });
  }
}
```

Weather values must match `WeatherType` from `src/dynamicworldagent/engine/features/weatherFeature.ts`: `"clear" | "rain" | "fog" | "storm" | "snow" | "extreme_heat" | "extreme_cold"`.

**`listSimulations` function:** Add `moduleName` to each record.

Approach: Add `moduleName` column to the `SimulationRuntime` Prisma model. This is a simple `String?` nullable field (backward compatible). `saveRuntime()` writes it; `loadSimulationRuntime()` and `listSimulationRuntimeRecords()` read it back. For in-memory runners, `runner.getModuleName()` already stores this value.

### Prisma Schema Change

```prisma
model SimulationRuntime {
  sessionId       String   @id @map("session_id")
  tick            Int
  simulationState String   @map("simulation_state")
  stopReason      String?  @map("stop_reason")
  language        String
  moduleName      String?  @map("module_name")  // NEW
  config          Json
  gameState       Json     @map("game_state")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  session Session @relation(fields: [sessionId], references: [sessionId], onDelete: Cascade)

  @@index([simulationState])
  @@map("simulation_runtime")
}
```

Apply with `prisma db push` (consistent with existing migration strategy).

**Implementation order in `createSimulation`:** Call `runner.setModuleName(moduleName)` BEFORE `runner.saveRuntime()` — currently `service.ts` calls `saveRuntime()` on line 234 and `setModuleName()` on line 237, which means the moduleName would not be persisted. Swap the order.

**Persistence changes required:**
- `SimulationRuntimeRecord` type in `types.ts`: add `moduleName?: string`
- `persistSimulationRuntime()` in `runtimePersistence.ts`: add `moduleName` to upsert create/update
- `loadSimulationRuntime()`: read `moduleName` from DB row
- `listSimulationRuntimeRecords()`: include `moduleName` in select/return

### `GET /api/simulations` response update

```typescript
{
  simulations: [
    {
      sessionId: string;
      moduleName: string;      // new
      state: "running" | "paused" | "stopped" | "completed";
      currentDay: number;
      currentTime: string;
      ticksExecuted: number;
    }
  ]
}
```

## Map Asset Resolution

The Maps directory name follows the convention `{PascalCase_Module_Name}_Maps` within the module directory. For `simple_town`, it's `Simple_Town_Maps`.

The `mapService.findMapsDirectory()` function already searches for `*_Maps` directories. To support the frontend constructing map URLs, add a new field to the status response:

```typescript
{
  moduleName: "simple_town",
  mapsPrefix: "Simple_Town_Maps"  // new: directory name only (NOT moduleName/dir — maps route auto-searches module dirs)
}
```

The backend resolves this via `mapService.findMapsDirectory(modulePath)` which finds the `*_Maps` directory within the module folder. The frontend uses `mapsPrefix` directly in `/api/maps/${mapsPrefix}/...` URLs. The maps route iterates all module directories and finds the matching file, so no module name prefix is needed.

## Files NOT Modified

- `TownScene.ts` / `InteriorScene.ts` — Phaser scenes already implement all needed functionality
- `SidePanel.tsx` / `ControlPanel.tsx` / `EventLog.tsx` / `NpcCard.tsx` / `NpcDetail.tsx` — already working
- `useSimulationWebSocket.ts` — already working
- `server/simulation/mapService.ts` / `mapRoutes.ts` / `mapController.ts` — already working
- `server/maps/routes.ts` — already serves static map files
- `SimulationRunner.ts` / `TickProcessor.ts` — simulation engine untouched
- Prisma schema — add `moduleName` to `SimulationRuntime` (see Backend Changes section)
- `GameSessionContext` — preserved but no longer in main flow

## Out of Scope

- Player character injection into simulation (future feature, hence preserving Create Character)
- Real tileset artwork (current placeholder 2x2 tiles are functional for testing)
- Multiplayer simulation viewing
- Mobile responsive redesign of Map Viewer
