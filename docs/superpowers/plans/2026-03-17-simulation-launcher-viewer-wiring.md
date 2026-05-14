# Simulation Launcher & Map Viewer Wiring Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the traditional game flow with simulation-first mode — homepage launches simulations directly, Map Viewer becomes the primary game interface.

**Architecture:** Homepage buttons launch New/Continue Simulation flows. New Simulation goes through module selection → config page → create API → Map Viewer. Continue Simulation shows a modal listing existing simulations. The existing Phaser TownScene/InteriorScene are wired to load tilemap assets via events emitted by SimulationPage.

**Tech Stack:** React 18, TypeScript, Phaser 3, Vite, Tailwind CSS, Express, Prisma, SQLite

**Spec:** `docs/superpowers/specs/2026-03-17-simulation-launcher-and-viewer-wiring-design.md`

---

## Chunk 1: Backend — Prisma + Persistence + Weather

### Task 1: Add `moduleName` to Prisma schema and runtime persistence

**Files:**
- Modify: `prisma/schema.prisma` (SimulationRuntime model)
- Modify: `src/dynamicworldagent/simulation/types.ts` (SimulationRuntimeRecord)
- Modify: `src/dynamicworldagent/simulation/runtimePersistence.ts` (persist/load/list functions)

- [ ] **Step 1: Add `moduleName` column to Prisma schema**

In `prisma/schema.prisma`, add a nullable `moduleName` field to `SimulationRuntime`:

```prisma
model SimulationRuntime {
  sessionId       String   @id @map("session_id")
  tick            Int
  simulationState String   @map("simulation_state")
  stopReason      String?  @map("stop_reason")
  language        String
  moduleName      String?  @map("module_name")
  config          Json
  gameState       Json     @map("game_state")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  session Session @relation(fields: [sessionId], references: [sessionId], onDelete: Cascade)

  @@index([simulationState])
  @@map("simulation_runtime")
}
```

- [ ] **Step 2: Apply schema change**

Run: `npx prisma db push`
Expected: Schema applied successfully, `module_name` column added to `simulation_runtime` table.

- [ ] **Step 3: Add `moduleName` to `SimulationRuntimeRecord` type**

In `src/dynamicworldagent/simulation/types.ts`, add `moduleName` to the interface:

```typescript
export interface SimulationRuntimeRecord {
  sessionId: string;
  tick: number;
  simulationState: SimulationState;
  stopReason?: StopReason;
  language: string;
  moduleName?: string;          // NEW
  config: SimulationConfig;
  gameState: Record<string, unknown>;
}
```

- [ ] **Step 4: Update `persistSimulationRuntime` to write `moduleName`**

In `src/dynamicworldagent/simulation/runtimePersistence.ts`, add `moduleName` parameter and include it in upsert:

```typescript
export async function persistSimulationRuntime(params: {
  prisma: PrismaClient;
  sessionId: string;
  tick: number;
  simulationState: SimulationState;
  stopReason?: StopReason;
  language: string;
  moduleName?: string;           // NEW
  config: SimulationConfig;
  gameState: Record<string, unknown>;
}): Promise<void> {
  await (params.prisma as any).simulationRuntime.upsert({
    where: { sessionId: params.sessionId },
    create: {
      sessionId: params.sessionId,
      tick: params.tick,
      simulationState: params.simulationState,
      stopReason: params.stopReason,
      language: params.language,
      moduleName: params.moduleName,   // NEW
      config: params.config,
      gameState: params.gameState,
    },
    update: {
      tick: params.tick,
      simulationState: params.simulationState,
      stopReason: params.stopReason,
      language: params.language,
      moduleName: params.moduleName,   // NEW
      config: params.config,
      gameState: params.gameState,
    },
  });
}
```

- [ ] **Step 5: Update `loadSimulationRuntime` to read `moduleName`**

In the same file, add `moduleName` to the returned object:

```typescript
return {
  sessionId: row.sessionId,
  tick: row.tick,
  simulationState: row.simulationState as SimulationState,
  stopReason: (row.stopReason ?? undefined) as StopReason | undefined,
  language: row.language,
  moduleName: row.moduleName ?? undefined,   // NEW
  config: row.config as unknown as SimulationConfig,
  gameState: row.gameState as Record<string, unknown>,
};
```

- [ ] **Step 6: Update `listSimulationRuntimeRecords` to include `moduleName`**

In the same file, add `moduleName` to the mapping:

```typescript
return rows.map((row: any) => ({
  sessionId: row.sessionId,
  tick: row.tick,
  simulationState: row.simulationState as SimulationState,
  stopReason: (row.stopReason ?? undefined) as StopReason | undefined,
  language: row.language,
  moduleName: row.moduleName ?? undefined,   // NEW
  config: row.config as SimulationConfig,
  gameState: row.gameState as Record<string, unknown>,
}));
```

- [ ] **Step 7: Update `SimulationRunner.saveRuntime` to pass `moduleName`**

In `src/dynamicworldagent/simulation/SimulationRunner.ts`, find `saveRuntime()` and add `moduleName: this.moduleName` to the `persistSimulationRuntime` call.

- [ ] **Step 8: Update `getRunner` in `service.ts` to restore `moduleName` on DB-recovered runners**

In `client/server/simulation/service.ts`, in the `getRunner` function (around line 138-166), after `runner.hydrateFromRuntime(...)`, add:

```typescript
runner.setModuleName(runtime.moduleName ?? "");
```

This ensures that simulations loaded from the database after a server restart have their `moduleName` set, which is required for `getStatus` to return `moduleName` and `getModulePath` to resolve the maps directory.

- [ ] **Step 9: Fix ordering in `service.ts` — `setModuleName` before `saveRuntime`**

In `client/server/simulation/service.ts`, in `createSimulation()`, move `runner.setModuleName(moduleName)` to BEFORE `runner.saveRuntime()`:

```typescript
// Before (wrong order):
// await runner.saveRuntime();   // line ~234
// runner.setModuleName(moduleName);  // line ~237

// After (correct order):
runner.setModuleName(moduleName);
await runner.saveRuntime();
```

- [ ] **Step 10: Build to verify**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 11: Commit**

```bash
git add prisma/schema.prisma src/dynamicworldagent/simulation/types.ts src/dynamicworldagent/simulation/runtimePersistence.ts src/dynamicworldagent/simulation/SimulationRunner.ts client/server/simulation/service.ts
git commit -m "feat: persist moduleName in SimulationRuntime"
```

---

### Task 2: Export weather helpers and add `applyGlobalWeather` to service

**Files:**
- Modify: `src/dynamicworldagent/engine/features/weatherFeature.ts` (export helpers)
- Modify: `client/server/simulation/service.ts` (add applyGlobalWeather, accept weather config)

- [ ] **Step 1: Export `getWeatherLabel` and `computeSkillPenalties` from weatherFeature**

In `src/dynamicworldagent/engine/features/weatherFeature.ts`, change these from plain `function` to `export function`:

```typescript
export function computeSkillPenalties(
  weatherType: WeatherType,
  intensity: number
): Array<{ skill: string; delta: number }> {
  // ... existing implementation unchanged
}

export function getWeatherLabel(weatherType: WeatherType, intensity: number): string {
  // ... existing implementation unchanged
}
```

- [ ] **Step 2: Add `applyGlobalWeather` to `service.ts`**

In `client/server/simulation/service.ts`, add the import and function:

```typescript
import {
  type WeatherType,
  getWeatherLabel,
  computeSkillPenalties,
} from "../../../src/dynamicworldagent/engine/features/weatherFeature.js";
```

Then add the function:

```typescript
function applyGlobalWeather(dgsm: DynamicGameStateManager, weather: WeatherType): void {
  const topology = dgsm.getTopology();
  if (!topology) return;

  const DEFAULT_INTENSITY = 3;
  const outdoorIds = [
    ...Array.from(topology.junctions.keys()),
    ...Array.from(topology.roads.keys()),
  ];

  const label = getWeatherLabel(weather, DEFAULT_INTENSITY);
  const penalties = computeSkillPenalties(weather, DEFAULT_INTENSITY);

  for (const sceneId of outdoorIds) {
    // Clear existing weather conditions
    const state = dgsm.getState();
    const conditions = state.scenarioConditions[sceneId] ?? [];
    state.scenarioConditions[sceneId] = conditions.filter(
      (c: any) => !c.description.startsWith("[Weather]")
    );

    // Append new weather condition
    dgsm.appendSceneCondition(sceneId, {
      description: `[Weather] ${label}`,
      mechanicalEffect: penalties.length > 0 ? { skillPenalty: penalties } : undefined,
    });
  }
}
```

- [ ] **Step 3: Update `createSimulation` to accept and apply weather**

In `client/server/simulation/service.ts`, update the `createSimulation` function signature and body. Add weather application after `buildSimulationBundle` and before `seedLongTermIntents`:

```typescript
export async function createSimulation(
  prisma: PrismaClient,
  moduleName: string,
  _userId: string,
  language = "en",
  config?: Partial<SimulationConfig> & { weather?: WeatherType }
): Promise<{ sessionId: string; status: SimulationStatus }> {
  // ... existing logic through buildSimulationBundle ...

  // Apply initial weather if specified
  if (config?.weather && config.weather !== "clear") {
    applyGlobalWeather(dgsm, config.weather);
  }

  // ... rest of existing logic (seedLongTermIntents, saveRuntime, etc.) ...
}
```

- [ ] **Step 4: Build to verify**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add src/dynamicworldagent/engine/features/weatherFeature.ts client/server/simulation/service.ts
git commit -m "feat: add weather config support for simulation creation"
```

---

### Task 3: Update backend `getStatus` and `listSimulations` to return `moduleName` + `mapsPrefix`

**Files:**
- Modify: `client/server/simulation/controller.ts`
- Modify: `client/server/simulation/service.ts` (listSimulations)
- Modify: `client/server/simulation/mapService.ts` (export findMapsDirectory)

- [ ] **Step 1: Export `findMapsDirectory` from mapService**

In `client/server/simulation/mapService.ts`, change `function findMapsDirectory` to `export function findMapsDirectory`.

- [ ] **Step 2: Update `getStatus` in controller to include `moduleName` and `mapsPrefix`**

In `client/server/simulation/controller.ts`, update the `getStatus` handler:

```typescript
import * as path from "node:path";
import { findMapsDirectory } from "./mapService.js";

export async function getStatus(req: Request, res: Response) {
  try {
    const prisma = getPrismaClient();
    const runner = await simulationService.getRunner(prisma, req.params.id);
    if (!runner) {
      return res.status(404).json({ error: `Simulation ${req.params.id} not found` });
    }
    const status = runner.getStatus();
    const moduleName = runner.getModuleName();
    const modulePath = runner.getModulePath();

    let mapsPrefix: string | null = null;
    if (modulePath) {
      const mapsDir = findMapsDirectory(modulePath);
      if (mapsDir) {
        mapsPrefix = path.basename(mapsDir);
      }
    }

    return res.json({ ...status, moduleName, mapsPrefix });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const httpStatus = message.includes("not found") ? 404 : 500;
    return res.status(httpStatus).json({ error: message });
  }
}
```

Note: This requires `getRunner` to be exported from `service.ts` — it already is.

- [ ] **Step 3: Update `listSimulations` in service to include `moduleName`**

In `client/server/simulation/service.ts`, update `listSimulations`:

```typescript
export async function listSimulations(
  prisma: PrismaClient
): Promise<(SimulationStatus & { sessionId: string; moduleName?: string })[]> {
  const runtimes = await listSimulationRuntimeRecords(prisma);

  return runtimes.map((runtime) => {
    const liveRunner = runners.get(runtime.sessionId);
    const effectiveRuntime =
      !liveRunner && runtime.simulationState === "running"
        ? { ...runtime, simulationState: "paused" as const }
        : runtime;
    return {
      sessionId: runtime.sessionId,
      moduleName: liveRunner?.getModuleName() ?? runtime.moduleName,
      ...(liveRunner
        ? liveRunner.getStatus()
        : runtimeToStatus(effectiveRuntime)),
    };
  });
}
```

- [ ] **Step 4: Build to verify**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add client/server/simulation/controller.ts client/server/simulation/service.ts client/server/simulation/mapService.ts
git commit -m "feat: return moduleName and mapsPrefix in simulation status API"
```

---

## Chunk 2: Frontend — API, State, Routes

### Task 4: Add `createSimulation` and `listSimulations` to frontend API + update types

**Files:**
- Modify: `client/src/services/simulationApi.ts`

- [ ] **Step 1: Add `moduleName` and `mapsPrefix` to `SimulationStatus` interface**

```typescript
export interface SimulationStatus {
  state: "running" | "paused" | "stopped" | "completed";
  currentDay: number;
  currentTime: string;
  ticksExecuted: number;
  stopReason?: string;
  moduleName?: string;     // NEW
  mapsPrefix?: string;     // NEW
}
```

- [ ] **Step 2: Add `createSimulation` function**

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
```

- [ ] **Step 3: Add `listSimulations` function**

```typescript
export interface SimulationListItem {
  sessionId: string;
  moduleName?: string;
  state: "running" | "paused" | "stopped" | "completed";
  currentDay: number;
  currentTime: string;
  ticksExecuted: number;
}

export async function listSimulations(): Promise<SimulationListItem[]> {
  const { data } = await api.get("/simulations");
  return data.simulations;
}
```

- [ ] **Step 4: Commit**

```bash
git add client/src/services/simulationApi.ts
git commit -m "feat: add createSimulation and listSimulations API functions"
```

---

### Task 5: Update `useSimulationState` to store `moduleName` and `mapsPrefix`

**Files:**
- Modify: `client/src/hooks/useSimulationState.ts`

- [ ] **Step 1: Add fields to `SimulationViewState`**

```typescript
export interface SimulationViewState {
  // ... existing fields ...
  moduleName: string | null;    // NEW
  mapsPrefix: string | null;    // NEW
}
```

Initialize both as `null` in the default state.

- [ ] **Step 2: Store values from `fetchStatus` response**

In `loadInitialState()`, update the state setter:

```typescript
setState((prev) => ({
  ...prev,
  topology,
  mapLayout,
  npcPositions: positions,
  npcStatuses: statuses,
  gameDay: status.currentDay,
  timeOfDay: status.currentTime,
  simulationState: status.state,
  moduleName: status.moduleName ?? null,     // NEW
  mapsPrefix: status.mapsPrefix ?? null,     // NEW
  isLoading: false,
}));
```

- [ ] **Step 3: Commit**

```bash
git add client/src/hooks/useSimulationState.ts
git commit -m "feat: store moduleName and mapsPrefix in simulation view state"
```

---

### Task 6: Wire tilemap loading in `SimulationPage`

**Files:**
- Modify: `client/src/views/SimulationPage.tsx`

- [ ] **Step 1: Add `load-town-map` emission on topology + mapLayout + mapsPrefix ready**

Add a new `useEffect` after the existing `npcPositions` effect:

```typescript
// Load town tilemap when all data is ready
useEffect(() => {
  if (!gameRef.current || !state.topology || !state.mapLayout || !state.mapsPrefix) return;
  gameRef.current.events.emit("load-town-map", {
    mapUrl: `/api/maps/${state.mapsPrefix}/town.json`,
    tilesetUrl: `/api/maps/${state.mapsPrefix}/tilesets/outdoor.png`,
    tilesetKey: "outdoor",
  });
}, [state.topology, state.mapLayout, state.mapsPrefix]);
```

- [ ] **Step 2: Add a `mapsPrefixRef` to avoid stale closure**

The `building-clicked` handler is registered inside `handleGameReady` (a `useCallback`), so `state.mapsPrefix` would be captured as `null` at registration time and never update. Use a ref instead:

```typescript
// At the top of the component, alongside gameRef:
const mapsPrefixRef = useRef<string | null>(null);

// Keep the ref in sync:
useEffect(() => {
  mapsPrefixRef.current = state.mapsPrefix;
}, [state.mapsPrefix]);
```

- [ ] **Step 3: Update `building-clicked` handler to emit `load-interior`**

In `handleGameReady`, update the `building-clicked` listener to use the ref:

```typescript
game.events.on("building-clicked", (sceneId: string) => {
  enterBuilding(sceneId, sceneId);
  const mapsPrefix = mapsPrefixRef.current;
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

- [ ] **Step 4: Build frontend to verify**

Run: `cd client && pnpm build`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/views/SimulationPage.tsx
git commit -m "feat: wire tilemap loading events in SimulationPage"
```

**Files:**
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Add lazy imports for new pages**

```typescript
const SimulationSelectPage = lazy(() => import("./views/SimulationSelectPage"));
const SimulationConfigPage = lazy(() => import("./views/SimulationConfigPage"));
```

Remove unused imports: `GamePage`, `ModSelectionPage`, `ModuleIntroPage`.

- [ ] **Step 2: Update routes inside `ProtectedRoute`**

Remove:
```tsx
<Route path="/mod/select" element={<ModSelectionPage />} />
<Route path="/mod/intro" element={<ModuleIntroPage />} />
<Route path="/game" element={<GamePage />} />
```

Add (inside `ProtectedRoute`):
```tsx
<Route path="/simulation/select" element={
  <Suspense fallback={<div className="flex items-center justify-center h-screen">Loading...</div>}>
    <SimulationSelectPage />
  </Suspense>
} />
<Route path="/simulation/config" element={
  <Suspense fallback={<div className="flex items-center justify-center h-screen">Loading...</div>}>
    <SimulationConfigPage />
  </Suspense>
} />
```

- [ ] **Step 3: Update legacy redirect**

Change `/gamechat` redirect from `/game` to `/`:

```tsx
<Route path="/gamechat" element={<Navigate to="/" replace />} />
```

- [ ] **Step 4: Clean up `BackgroundManager`**

Remove the `/game` path check in the `BackgroundManager` `useEffect` (it references `isGamePage` which checks `location.pathname === "/game"`). Simply remove that branch — the simulation page has its own Phaser background.

- [ ] **Step 5: Build frontend to verify**

Run: `cd client && pnpm build`
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat: update routes — remove game flow, add simulation select/config"
```

---

## Chunk 3: Frontend — New Pages, Homepage Changes & Route Wiring

### Task 7: Create `SimulationSelectPage`

**Files:**
- Create: `client/src/views/SimulationSelectPage.tsx`

- [ ] **Step 1: Create the page component**

This page wraps the existing `ModSelector` component. On module selection, it navigates to `/simulation/config` with `moduleName` in route state. Pass `onCreateStory={undefined}` to hide the "Create Your Own Story" card.

```tsx
import { useNavigate } from "react-router-dom";
import { ModSelector } from "../components/ModSelector";

export default function SimulationSelectPage() {
  const navigate = useNavigate();

  return (
    <ModSelector
      onSelectMod={(modName: string) => {
        navigate("/simulation/config", { state: { moduleName: modName } });
      }}
    />
  );
}
```

Check the `ModSelector` component's props interface to confirm `onSelectMod` is the correct prop name and signature. If `ModSelector` also has `onCreateStory`, pass `undefined` or omit it. If `ModSelector` renders a "Start Adventure" label, consider passing a custom label prop if supported, or accept it for now.

- [ ] **Step 2: Build to verify**

Run: `cd client && pnpm build`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/views/SimulationSelectPage.tsx
git commit -m "feat: add SimulationSelectPage wrapping ModSelector"
```

---

### Task 8: Create `SimulationConfigPage`

**Files:**
- Create: `client/src/views/SimulationConfigPage.tsx`

- [ ] **Step 1: Create the config page**

This page receives `moduleName` from route state and displays tick speed, max days, and weather controls. On "Start Simulation", it calls `createSimulation()` and redirects to the viewer.

```tsx
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import * as simApi from "../services/simulationApi";

const SPEED_OPTIONS = [
  { label: "1x", ms: 60000 },
  { label: "2x", ms: 30000 },
  { label: "5x", ms: 12000 },
  { label: "10x", ms: 6000 },
];

const WEATHER_OPTIONS = [
  { value: "clear", label: "Clear" },
  { value: "rain", label: "Rain" },
  { value: "fog", label: "Fog" },
  { value: "storm", label: "Storm" },
  { value: "snow", label: "Snow" },
  { value: "extreme_heat", label: "Extreme Heat" },
  { value: "extreme_cold", label: "Extreme Cold" },
] as const;

export default function SimulationConfigPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const moduleName = (location.state as { moduleName?: string })?.moduleName;

  const [tickSpeed, setTickSpeed] = useState(60000);
  const [maxDays, setMaxDays] = useState(7);
  const [weather, setWeather] = useState<string>("clear");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!moduleName) {
    navigate("/simulation/select", { replace: true });
    return null;
  }

  async function handleStart() {
    setCreating(true);
    setError(null);
    try {
      const result = await simApi.createSimulation({
        moduleName,
        config: {
          tickIntervalMs: tickSpeed,
          maxDays,
          weather: weather as any,
        },
      });
      navigate(`/simulation/${result.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create simulation");
      setCreating(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-md w-full space-y-8 bg-white/80 backdrop-blur-sm border border-white/50 rounded-2xl p-8 shadow-xl">
        <h1 className="text-2xl font-bold text-center" style={{ color: "var(--title, #3d2f1f)" }}>
          Configure Simulation
        </h1>
        <p className="text-center text-gray-600">{moduleName}</p>

        {/* Tick Speed */}
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: "var(--title, #3d2f1f)" }}>
            Tick Speed
          </label>
          <div className="flex gap-2">
            {SPEED_OPTIONS.map(({ label, ms }) => (
              <button
                key={label}
                onClick={() => setTickSpeed(ms)}
                className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-all ${
                  tickSpeed === ms
                    ? "bg-amber-700 text-white border-amber-700"
                    : "bg-white/50 border-gray-300 hover:bg-gray-100"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Max Days */}
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: "var(--title, #3d2f1f)" }}>
            Max Days: {maxDays}
          </label>
          <input
            type="range"
            min={1}
            max={30}
            value={maxDays}
            onChange={(e) => setMaxDays(Number(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-gray-400">
            <span>1</span>
            <span>30</span>
          </div>
        </div>

        {/* Weather */}
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: "var(--title, #3d2f1f)" }}>
            Weather
          </label>
          <select
            value={weather}
            onChange={(e) => setWeather(e.target.value)}
            className="w-full py-2 px-3 rounded-lg border border-gray-300 bg-white/50"
          >
            {WEATHER_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        {error && (
          <p className="text-red-600 text-sm text-center">{error}</p>
        )}

        {/* Buttons */}
        <div className="flex gap-3">
          <button
            onClick={() => navigate("/simulation/select")}
            className="flex-1 py-3 rounded-lg border border-gray-300 bg-white/50 hover:bg-gray-100 font-medium transition-all"
          >
            Back
          </button>
          <button
            onClick={handleStart}
            disabled={creating}
            className="flex-1 py-3 rounded-lg bg-amber-700 text-white font-medium hover:bg-amber-800 disabled:opacity-50 transition-all"
          >
            {creating ? "Creating..." : "Start Simulation"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build to verify**

Run: `cd client && pnpm build`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/views/SimulationConfigPage.tsx
git commit -m "feat: add SimulationConfigPage with speed, days, weather controls"
```

---

### Task 9: Create `SimulationSelectorModal`

**Files:**
- Create: `client/src/components/simulation/SimulationSelectorModal.tsx`

- [ ] **Step 1: Create the modal component**

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type SimulationListItem, listSimulations } from "../../services/simulationApi";

interface SimulationSelectorModalProps {
  open: boolean;
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: "bg-green-100 text-green-700 border-green-300",
  paused: "bg-yellow-100 text-yellow-700 border-yellow-300",
  stopped: "bg-gray-100 text-gray-600 border-gray-300",
  completed: "bg-blue-100 text-blue-700 border-blue-300",
};

export function SimulationSelectorModal({ open, onClose }: SimulationSelectorModalProps) {
  const navigate = useNavigate();
  const [simulations, setSimulations] = useState<SimulationListItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listSimulations()
      .then(setSimulations)
      .catch((err) => console.error("Failed to load simulations:", err))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-5"
      onClick={onClose}
    >
      <div
        className="max-w-[700px] w-full max-h-[80vh] overflow-y-auto rounded-2xl p-8 bg-white/80 backdrop-blur-lg border border-white/50 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold" style={{ color: "var(--title, #3d2f1f)" }}>
            Continue Simulation
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl">
            &times;
          </button>
        </div>

        {loading ? (
          <p className="text-center text-gray-500 py-8">Loading...</p>
        ) : simulations.length === 0 ? (
          <p className="text-center text-gray-500 py-8">No simulations found</p>
        ) : (
          <div className="space-y-3">
            {simulations.map((sim) => (
              <button
                key={sim.sessionId}
                onClick={() => {
                  onClose();
                  navigate(`/simulation/${sim.sessionId}`);
                }}
                className="w-full text-left p-4 rounded-xl border border-gray-200 bg-white/50 hover:bg-white/80 hover:border-gray-300 transition-all"
              >
                <div className="flex justify-between items-center">
                  <span className="font-medium" style={{ color: "var(--title, #3d2f1f)" }}>
                    {sim.moduleName ?? "Unknown Module"}
                  </span>
                  <span className={`text-xs px-2 py-1 rounded-full border ${STATUS_COLORS[sim.state] ?? ""}`}>
                    {sim.state}
                  </span>
                </div>
                <div className="text-sm text-gray-500 mt-1">
                  Day {sim.currentDay} &middot; {sim.currentTime} &middot; {sim.ticksExecuted} ticks
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build to verify**

Run: `cd client && pnpm build`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/simulation/SimulationSelectorModal.tsx
git commit -m "feat: add SimulationSelectorModal for continue simulation flow"
```

---

### Task 10: Update `HomePage` and `Homes` for simulation flow

**Files:**
- Modify: `client/src/views/HomePage.tsx`
- Modify: `client/src/views/Homes.tsx`

- [ ] **Step 1: Update `Homes.tsx` — rename props and button labels**

Update the `HomeProps` interface — rename `onStartGame` → `onNewSimulation`, `onContinueGame` → `onContinueSimulation`:

```typescript
interface HomeProps {
  onCreate: () => void;
  onNewSimulation: () => void;
  onContinueSimulation: () => void;
  onManageMods: () => void;
}
```

In the component destructuring, update to match. Then update the two primary buttons to use the new prop names and labels:

```tsx
<button className="primary" onClick={onNewSimulation}>
  New Simulation
</button>
<button className="primary" onClick={onContinueSimulation}>
  Continue Simulation
</button>
```

**Preserve all other existing functionality in `Homes.tsx`:** the "Manage Modules" button, "Create Character" button, "View Characters" button, the character browser modal, and the character sheet modal. Only the first two buttons and their prop names change.

- [ ] **Step 2: Update `HomePage.tsx` — replace game flow with simulation flow**

Replace checkpoint-related state and handlers with simulation modal state. Simplify significantly:

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { SimulationSelectorModal } from "../components/simulation/SimulationSelectorModal";
import { ModManager } from "../components/ModManager";
import { LanguageToggle } from "../components/layout/LanguageToggle";
import { useAppSettings } from "../contexts/AppSettingsContext";
import Homes from "./Homes";

export const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const { language, handleLanguageChange } = useAppSettings();
  const [showSimulationSelector, setShowSimulationSelector] = useState(false);
  const [showModManager, setShowModManager] = useState(false);

  return (
    <>
      <Homes
        onCreate={() => navigate("/character/create")}
        onNewSimulation={() => navigate("/simulation/select")}
        onContinueSimulation={() => setShowSimulationSelector(true)}
        onManageMods={() => setShowModManager(true)}
      />

      {showModManager && (
        <ModManager onClose={() => setShowModManager(false)} />
      )}

      <SimulationSelectorModal
        open={showSimulationSelector}
        onClose={() => setShowSimulationSelector(false)}
      />

      <LanguageToggle
        language={language}
        onLanguageChange={handleLanguageChange}
      />
    </>
  );
};
```

Remove all checkpoint-related state, handlers (`handleContinueGame`, `handleLoadCheckpoint`, `handleDeleteCheckpoint`, `handleBatchDeleteCheckpoints`), `loadFeedback` state, the `CheckpointSelectorModal` import, and the feedback modal JSX.

**Preserve:** The tutorial redirect `useEffect` (redirects first-time users to `/tutorial`) and the tutorial entry button (bottom-left corner). These are unrelated to the simulation change and should remain. Also keep the `useAuth` hook import if needed for the tutorial `useEffect`.

- [ ] **Step 3: Build to verify**

Run: `cd client && pnpm build`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/views/HomePage.tsx client/src/views/Homes.tsx
git commit -m "feat: update homepage for simulation flow — New/Continue Simulation buttons"
```

---

### Task 11: Update `App.tsx` routes

**Files:**
- Modify: `client/src/App.tsx`

**Note:** This task depends on Tasks 7-9 (the new page files must exist before importing them).

- [ ] **Step 1: Add lazy imports for new pages, remove old imports**

```typescript
const SimulationSelectPage = lazy(() => import("./views/SimulationSelectPage"));
const SimulationConfigPage = lazy(() => import("./views/SimulationConfigPage"));
```

Remove unused imports: `GamePage`, `ModSelectionPage`, `ModuleIntroPage`.

- [ ] **Step 2: Update routes inside `ProtectedRoute`**

Remove:
```tsx
<Route path="/mod/select" element={<ModSelectionPage />} />
<Route path="/mod/intro" element={<ModuleIntroPage />} />
<Route path="/game" element={<GamePage />} />
```

Add (inside `ProtectedRoute`):
```tsx
<Route path="/simulation/select" element={
  <Suspense fallback={<div className="flex items-center justify-center h-screen">Loading...</div>}>
    <SimulationSelectPage />
  </Suspense>
} />
<Route path="/simulation/config" element={
  <Suspense fallback={<div className="flex items-center justify-center h-screen">Loading...</div>}>
    <SimulationConfigPage />
  </Suspense>
} />
```

- [ ] **Step 3: Update legacy redirect**

Change `/gamechat` redirect from `/game` to `/`:

```tsx
<Route path="/gamechat" element={<Navigate to="/" replace />} />
```

- [ ] **Step 4: Clean up `BackgroundManager`**

Remove the `/game` path check in the `BackgroundManager` `useEffect` (it references `isGamePage` which checks `location.pathname === "/game"`). Simply remove that branch — the simulation page has its own Phaser background.

- [ ] **Step 5: Build frontend to verify**

Run: `cd client && pnpm build`
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat: update routes — remove game flow, add simulation select/config"
```

---

## Chunk 4: Integration Verification

### Task 12: End-to-end manual verification

- [ ] **Step 1: Start the dev server**

Run: `pnpm chat:dev` (or however the dev server is started)

- [ ] **Step 2: Verify homepage**

Navigate to `/`. Confirm "New Simulation" and "Continue Simulation" buttons appear. "Create Character" and "Manage Modules" should also be present.

- [ ] **Step 3: Verify New Simulation flow**

Click "New Simulation" → should navigate to `/simulation/select`. Select a module (e.g., `simple_town`) → should navigate to `/simulation/config`. Adjust tick speed, max days, weather → click "Start Simulation" → should create a simulation and redirect to `/simulation/:sessionId`.

- [ ] **Step 4: Verify Map Viewer loads tilemap**

On the simulation page, the Phaser canvas should display the town tilemap (may be placeholder colored squares). Junction coordinates should position NPC dots correctly. The SidePanel should show NPC names, HP/SAN values, and game clock.

- [ ] **Step 5: Verify Continue Simulation flow**

Navigate back to `/`. Click "Continue Simulation" → modal should show the simulation just created with its status, module name, and day/time. Click it → should navigate back to the simulation viewer.

- [ ] **Step 6: Verify ControlPanel works**

On the simulation page, click Play to start, observe NPCs move. Click Pause. Click Step to advance one tick. Verify events appear in the EventLog.

- [ ] **Step 7: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: integration fixes for simulation launcher flow"
```
