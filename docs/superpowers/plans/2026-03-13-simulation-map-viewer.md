# Simulation Map Viewer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Phaser 3 pixel-art map viewer page for observing NPC autonomous simulation in real-time — unified zoomable town map with building interiors, NPC movement visualization, and side panel status display.

**Architecture:** Backend extends existing simulation API with topology/position/status endpoints and wires `npc_moved` events through WebSocket. Frontend adds a new `/simulation/:sessionId` route with a Phaser 3 canvas (TownScene + InteriorScene) alongside React side panel and floating controls. NPC positions stream via WebSocket and drive sprite/dot movement on the Tiled map.

**Tech Stack:** TypeScript, Phaser 3, React 18, Tailwind CSS, Vite, WebSocket, Express, Prisma

**Spec:** `docs/superpowers/specs/2026-03-12-simulation-map-viewer-design.md`

---

## File Structure

```
New files:
  src/dynamicworldagent/simulation/mapViewerTypes.ts           # MapLayout, NpcStatusInfo types
  client/server/simulation/mapController.ts                     # Map viewer API handlers
  client/server/simulation/mapService.ts                        # Map viewer business logic
  client/server/simulation/mapRoutes.ts                         # Unauthenticated map viewer routes
  client/src/views/SimulationPage.tsx                           # Main simulation viewer page
  client/src/components/simulation/PhaserContainer.tsx          # Phaser game wrapper
  client/src/components/simulation/TownScene.ts                 # Phaser Scene: town map (Level 1 & 2)
  client/src/components/simulation/InteriorScene.ts             # Phaser Scene: building interior (Level 3)
  client/src/components/simulation/SidePanel.tsx                # Right panel: NPC list + event log
  client/src/components/simulation/NpcCard.tsx                  # Single NPC status card
  client/src/components/simulation/NpcDetail.tsx                # Expanded NPC detail view
  client/src/components/simulation/EventLog.tsx                 # Event timeline
  client/src/components/simulation/ControlPanel.tsx             # Floating play/pause/step/speed
  client/src/components/simulation/SubSceneTabs.tsx             # Building sub-scene tab bar
  client/src/components/simulation/GameClock.tsx                # Day/time display
  client/src/hooks/useSimulationWebSocket.ts                    # WS hook for simulation events
  client/src/hooks/useSimulationState.ts                        # State management hook
  client/src/services/simulationApi.ts                          # API client functions

Modified files:
  src/dynamicworldagent/simulation/types.ts                     # Add "npc_moved" event type
  src/dynamicworldagent/simulation/SimulationEventEmitter.ts    # Fix discoveries field name
  src/dynamicworldagent/engine/handlers/movementHandler.ts      # Emit npc_moved event
  src/dynamicworldagent/state/types.ts                          # Add sceneMapBindings/spriteBindings to ModuleDigest
  client/server/simulation/service.ts                           # Wire event persistence + WS broadcast
  client/server/websocket/WebSocketManager.ts                   # Add simulation client map
  client/server/maps/routes.ts                                  # Allow .json/.tsx extensions for Tiled assets
  client/server.ts                                              # Mount map viewer routes
  client/src/App.tsx                                            # Add /simulation route
  client/package.json                                           # Add phaser dependency
```

---

## Chunk 1: Backend — Event System & WebSocket Broadcasting

### Task 1: Add `npc_moved` event type and fix `actionsToEvents`

**Files:**
- Modify: `src/dynamicworldagent/simulation/types.ts`
- Modify: `src/dynamicworldagent/simulation/SimulationEventEmitter.ts`

- [ ] **Step 1: Add `npc_moved` to SimulationEventType**

In `src/dynamicworldagent/simulation/types.ts`, add `"npc_moved"` to the `SimulationEventType` union:

```typescript
export type SimulationEventType =
  | "action_executed"
  | "action_failed"
  | "encounter"
  | "relationship_changed"
  | "clue_discovered"
  | "plan_revised"
  | "memory_created"
  | "scene_updated"
  | "day_transition"
  | "feature_triggered"
  | "npc_death"
  | "all_clues_discovered"
  | "simulation_state_changed"
  | "npc_moved";  // NEW
```

Also add it to the `SIMULATION_EVENT_TYPES` array.

- [ ] **Step 2: Fix `actionsToEvents` in SimulationEventEmitter**

In `SimulationEventEmitter.ts`, the `actionsToEvents` method references `action.discoveredClues` but the actual `CharacterAction` field is `discoveries`. Fix:

```typescript
// In actionsToEvents, change the data mapping:
data: {
  action: action.action,
  actionType: action.actionType,
  outcome: action.outcome,
  successLevel: action.successLevel,
  discoveries: action.discoveries,  // was: discoveredClues
},
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: No type errors.

---

### Task 2: Emit `npc_moved` events from movement handler

**Files:**
- Modify: `src/dynamicworldagent/engine/handlers/movementHandler.ts`

The movement handler needs access to the `SimulationEventEmitter` to emit `npc_moved` events. The emitter is available via `ExecutionContext`.

- [ ] **Step 1: Check if ExecutionContext carries the emitter**

Read `src/dynamicworldagent/engine/types.ts` to see what `ExecutionContext` contains. If it doesn't have an emitter field, we need to add one.

- [ ] **Step 2: Add optional `simulationEmitter` to ExecutionContext**

In `src/dynamicworldagent/engine/types.ts`, add an optional property to the `ExecutionContext` interface (after the existing method signatures, before the closing `}`):

```typescript
import type { SimulationEventEmitter } from "../simulation/SimulationEventEmitter.js";

// Add at the end of ExecutionContext interface (before closing brace):
/** Set by SimulationRunner to enable npc_moved event emission from handlers */
simulationEmitter?: SimulationEventEmitter;
```

- [ ] **Step 3: Wire emitter into context in SimulationRunner constructor**

The `ExecutionContext` is a plain object created by `createExecutionContext(registry)` in `src/dynamicworldagent/engine/executionContext.ts`. The `ctx` is stored as `private readonly ctx` on `SimulationRunner`, but since the object itself is mutable (only the reference is readonly), we can set the property after creation.

In `SimulationRunner.ts` constructor (after `this.events = new SimulationEventEmitter(this.sessionId);` at line ~74), add:

```typescript
// Wire emitter into execution context so handlers can emit npc_moved events
this.ctx.simulationEmitter = this.events;
```

- [ ] **Step 4: Emit `npc_moved` in movementHandler.ts**

At line ~97 of `movementHandler.ts`, after `dgsm.setCharacterPosition(node.characterId, targetPos)`:

```typescript
// Emit npc_moved event for simulation viewers
if (ctx.simulationEmitter) {
  const state = dgsm.getState();
  ctx.simulationEmitter.emitSimulationEvent(
    "npc_moved",
    node.characterId,
    node.location,
    state.gameDay,
    state.timeOfDay,
    {
      fromPosition: currentPos,
      toPosition: targetPos,
    }
  );
}
```

- [ ] **Step 5: Verify build**

Run: `pnpm build`
Expected: No type errors.

---

### Task 3: Wire event persistence and WebSocket broadcasting

**Files:**
- Modify: `client/server/websocket/WebSocketManager.ts`
- Modify: `client/server/simulation/service.ts`

- [ ] **Step 1: Add simulation client map to WebSocketManager**

In `WebSocketManager.ts`, add alongside existing maps:

```typescript
private simulationClients: Map<string, Map<string, WSClient>> = new Map();

registerSimulationClient(sessionId: string, clientId: string, client: WSClient): void {
  if (!this.simulationClients.has(sessionId)) {
    this.simulationClients.set(sessionId, new Map());
  }
  this.simulationClients.get(sessionId)!.set(clientId, client);
}

removeSimulationClient(sessionId: string, clientId: string): void {
  const clients = this.simulationClients.get(sessionId);
  if (clients) {
    clients.delete(clientId);
    if (clients.size === 0) this.simulationClients.delete(sessionId);
  }
}

getSimulationClients(sessionId: string): Map<string, WSClient> {
  return this.simulationClients.get(sessionId) ?? new Map();
}
```

- [ ] **Step 2: Handle simulation WebSocket connections**

In the WebSocket connection handler (`setupConnectionHandling`), add simulation branch before auth check:

```typescript
const type = request.url ? new URL(request.url, "http://localhost").searchParams.get("type") : null;

if (type === "simulation" && sessionId) {
  const clientId = randomUUID();
  const client: WSClient = { ws, sessionId, lastHeartbeat: new Date() };
  this.registerSimulationClient(sessionId, clientId, client);
  ws.on("close", () => this.removeSimulationClient(sessionId, clientId));
  ws.send(JSON.stringify({ type: "connected", sessionId }));
  return;
}
```

- [ ] **Step 3: Wire persistence and broadcast in simulation service**

In `service.ts`, add a `wireEventListener` function and call it in `createSimulation` after creating the runner:

```typescript
import { WebSocketManager } from "../websocket/WebSocketManager.js";

function wireEventListener(
  sessionId: string,
  runner: SimulationRunner,
  prisma: PrismaClient
): void {
  runner.events.on("simulation_event", async (event: SimulationEvent) => {
    // Persist to DB
    try {
      await prisma.simulationEvent.create({
        data: {
          id: event.id,
          sessionId: event.sessionId,
          tick: event.tick,
          gameDay: event.gameDay,
          gameTime: event.gameTime,
          type: event.type,
          actorNpcId: event.actorNpcId,
          targetNpcId: event.targetNpcId,
          location: event.location,
          data: event.data as any,
          timestamp: event.timestamp,
        },
      });
    } catch (err) {
      console.error("[simulation] Failed to persist event:", err);
    }

    // Broadcast via WebSocket
    const wsManager = WebSocketManager.getInstance();
    if (wsManager) {
      const clients = wsManager.getSimulationClients(sessionId);
      const message = JSON.stringify({ type: "simulation_event", data: event });
      for (const [, client] of clients) {
        if (client.ws.readyState === 1) { // WebSocket.OPEN
          client.ws.send(message);
        }
      }
    }
  });
}
```

In `createSimulation`, after `runners.set(sessionId, runner)`, add:
```typescript
wireEventListener(sessionId, runner, prisma);
```

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add src/dynamicworldagent/simulation/ src/dynamicworldagent/engine/ client/server/simulation/service.ts client/server/websocket/WebSocketManager.ts
git commit -m "feat(simulation): add npc_moved event, persistence, and WebSocket broadcast"
```

---

## Chunk 2: Backend — Map Viewer API Endpoints

### Task 4: Map viewer types

**Files:**
- Create: `src/dynamicworldagent/simulation/mapViewerTypes.ts`

- [ ] **Step 1: Create map viewer types file**

```typescript
// src/dynamicworldagent/simulation/mapViewerTypes.ts

import type { Item } from "../state/types.js";

export interface MapLayout {
  junctions: Record<string, { x: number; y: number }>;
}

export interface NpcStatusInfo {
  npcId: string;
  name: string;
  hp: number;
  maxHp: number;
  sanity: number;
  maxSanity: number;
  currentAction: string | null;
  location: string;
  inventory: Item[];
  isAlive: boolean;
}

export interface TopologyResponse {
  junctions: Array<{
    id: string;
    name: string;
    connectedSceneIds: string[];
  }>;
  roads: Array<{
    id: string;
    name: string;
    endpointA: string;
    endpointB: string;
    travelTimeMinutes: number;
    alongConnections: Array<{ sceneId: string; position: number }>;
  }>;
  scenes: Array<{
    id: string;
    name: string;
    parentLocationId: string;
    connections: string[];
  }>;
}
```

---

### Task 5: Map viewer service layer

**Files:**
- Create: `client/server/simulation/mapService.ts`

- [ ] **Step 1: Create map service**

```typescript
// client/server/simulation/mapService.ts

import type { SimulationRunner } from "../../../src/dynamicworldagent/simulation/SimulationRunner.js";
import type { DynamicGameStateManager } from "../../../src/dynamicworldagent/state/DynamicGameState.js";
import type { CharacterPosition } from "../../../src/dynamicworldagent/state/topologyTypes.js";
import type {
  MapLayout,
  NpcStatusInfo,
  TopologyResponse,
} from "../../../src/dynamicworldagent/simulation/mapViewerTypes.js";
import { getRunner } from "./service.js";
import * as fs from "node:fs";
import * as path from "node:path";

/** Re-export getRunner for the map controller's updateConfig handler */
export function getRunnerById(sessionId: string): SimulationRunner | undefined {
  return getRunner(sessionId);
}

export function getTopology(sessionId: string): TopologyResponse | null {
  const runner = getRunner(sessionId);
  if (!runner) return null;

  // Access dgsm from runner — need to expose it or access via runner method
  const dgsm = runner.getDgsm();
  const topology = dgsm.getTopology();
  if (!topology) return null;

  const junctions = Array.from(topology.junctions.values()).map((j) => ({
    id: j.id,
    name: j.name,
    connectedSceneIds: j.connectedSceneIds,
  }));

  const roads = Array.from(topology.roads.values()).map((r) => ({
    id: r.id,
    name: r.name,
    endpointA: r.endpointA,
    endpointB: r.endpointB,
    travelTimeMinutes: r.travelTimeMinutes,
    alongConnections: r.alongConnections,
  }));

  const scenes = Array.from(dgsm.getState().scenes.values()).map((s) => ({
    id: s.id,
    name: s.name,
    parentLocationId: s.parentLocationId,
    connections: s.connections ?? [],
  }));

  return { junctions, roads, scenes };
}

export function getMapLayout(sessionId: string): MapLayout | null {
  const runner = getRunner(sessionId);
  if (!runner) return null;

  // Load map_layout.json from module's Maps directory
  const modulePath = runner.getModulePath();
  if (!modulePath) return null;

  const mapsDir = findMapsDirectory(modulePath);
  if (!mapsDir) return null;

  const layoutPath = path.join(mapsDir, "map_layout.json");
  if (!fs.existsSync(layoutPath)) return null;

  return JSON.parse(fs.readFileSync(layoutPath, "utf-8")) as MapLayout;
}

export function getPositions(
  sessionId: string
): Record<string, CharacterPosition> | null {
  const runner = getRunner(sessionId);
  if (!runner) return null;

  const dgsm = runner.getDgsm();
  return dgsm.getState().characterPositions;
}

export function getNpcStatuses(sessionId: string): NpcStatusInfo[] | null {
  const runner = getRunner(sessionId);
  if (!runner) return null;

  const dgsm = runner.getDgsm();
  const state = dgsm.getState();
  const statuses: NpcStatusInfo[] = [];

  for (const npc of state.npcCharacters ?? []) {
    const stats = state.npcStats?.[npc.id];
    const inventory = state.npcInventories?.[npc.id] ?? [];
    const position = state.characterPositions?.[npc.id];

    // Resolve human-readable location name
    let locationName = "Unknown";
    if (position) {
      locationName = resolveLocationName(position, dgsm);
    }

    statuses.push({
      npcId: npc.id,
      name: npc.name,
      hp: stats?.hp ?? 0,
      maxHp: npc.status?.maxHp ?? 0,
      sanity: stats?.san ?? 0,
      maxSanity: npc.status?.maxSanity ?? 0,
      currentAction: null, // Populated from latest tick actions
      location: locationName,
      inventory,
      isAlive: (stats?.hp ?? 0) > 0,
    });
  }

  return statuses;
}

function resolveLocationName(
  position: CharacterPosition,
  dgsm: DynamicGameStateManager
): string {
  const topology = dgsm.getTopology();
  if (!topology) return "Unknown";

  switch (position.type) {
    case "junction": {
      const junction = topology.junctions.get(position.junctionId);
      return junction?.name ?? position.junctionId;
    }
    case "road": {
      const road = topology.roads.get(position.roadId);
      return road?.name ?? position.roadId;
    }
    case "scene": {
      const scene = dgsm.getState().scenes.get(position.sceneId);
      return scene?.name ?? position.sceneId;
    }
  }
}

function findMapsDirectory(modulePath: string): string | null {
  // Module path is like: data/Mods/[Module Name]
  // Maps dir is: data/Mods/[Module Name]/[Module]_Maps/
  const entries = fs.readdirSync(modulePath);
  const mapsDir = entries.find((e) => e.endsWith("_Maps"));
  if (!mapsDir) return null;
  return path.join(modulePath, mapsDir);
}
```

**Note:** The `runner.getDgsm()` and `runner.getModulePath()` methods may not exist yet on `SimulationRunner`. They need to be added as simple getters.

- [ ] **Step 2: Add getter methods to SimulationRunner**

In `SimulationRunner.ts`, add a `moduleName` field and getter methods.

First, add to constructor params and field declarations:

```typescript
// Add to field declarations (after "private readonly prisma"):
private readonly moduleName: string;

// In constructor params type, add:
moduleName: string;

// In constructor body, add:
this.moduleName = params.moduleName;
```

Then add the getter methods:

```typescript
getDgsm(): DynamicGameStateManager {
  return this.dgsm;
}

getModuleName(): string {
  return this.moduleName;
}

getModulePath(): string {
  // Modules live at data/Mods/[moduleName]
  return path.join(process.cwd(), "data", "Mods", this.moduleName);
}
```

Add import at top of SimulationRunner.ts: `import * as path from "node:path";`

- [ ] **Step 3: Pass moduleName from service.ts**

In `client/server/simulation/service.ts`, the `createSimulation` function receives `moduleName` as a parameter. Pass it to the runner constructor:

```typescript
// In the SimulationRunner constructor call (line ~78), add:
moduleName,
```

---

### Task 6: Map viewer controller and routes

**Files:**
- Create: `client/server/simulation/mapController.ts`
- Modify: `client/server/simulation/routes.ts`
- Modify: `client/server.ts`

- [ ] **Step 1: Create map controller**

```typescript
// client/server/simulation/mapController.ts

import type { Request, Response } from "express";
import * as mapService from "./mapService.js";

export function getTopology(req: Request, res: Response) {
  const topology = mapService.getTopology(req.params.id);
  if (!topology) return res.status(404).json({ error: "Simulation not found or no topology" });
  return res.json(topology);
}

export function getMapLayout(req: Request, res: Response) {
  const layout = mapService.getMapLayout(req.params.id);
  if (!layout) return res.status(404).json({ error: "Map layout not found" });
  return res.json(layout);
}

export function getPositions(req: Request, res: Response) {
  const positions = mapService.getPositions(req.params.id);
  if (!positions) return res.status(404).json({ error: "Simulation not found" });
  return res.json({ positions });
}

export function getNpcStatuses(req: Request, res: Response) {
  const statuses = mapService.getNpcStatuses(req.params.id);
  if (!statuses) return res.status(404).json({ error: "Simulation not found" });
  return res.json({ statuses });
}

export function updateConfig(req: Request, res: Response) {
  try {
    const runner = mapService.getRunnerById(req.params.id);
    if (!runner) return res.status(404).json({ error: "Simulation not found" });

    const { tickIntervalMs } = req.body;
    if (typeof tickIntervalMs === "number" && tickIntervalMs > 0) {
      runner.updateTickInterval(tickIntervalMs);
    }
    return res.json({ success: true, status: runner.getStatus() });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown" });
  }
}
```

- [ ] **Step 2: Add `updateTickInterval` to SimulationRunner**

In `SimulationRunner.ts`:

```typescript
updateTickInterval(ms: number): void {
  (this.config as { tickIntervalMs?: number }).tickIntervalMs = ms;
  // If running, restart the tick timer (SimulationRunner uses setTimeout, not setInterval)
  if (this.state === "running" && this.intervalId) {
    clearTimeout(this.intervalId);
    this.intervalId = null;
    this.scheduleNextTick();
  }
}
```

- [ ] **Step 3: Create separate unauthenticated map viewer routes**

The existing `client/server/simulation/routes.ts` applies `router.use(authenticate)` to ALL routes. The map viewer page requires no auth (consistent with the spec). Create a **new file** `client/server/simulation/mapRoutes.ts`:

```typescript
// client/server/simulation/mapRoutes.ts
import { Router } from "express";
import * as mapController from "./mapController.js";

const router = Router();

// Map viewer READ endpoints — no authentication (public viewer page)
router.get("/simulation/:id/topology", mapController.getTopology);
router.get("/simulation/:id/map-layout", mapController.getMapLayout);
router.get("/simulation/:id/positions", mapController.getPositions);
router.get("/simulation/:id/npc-statuses", mapController.getNpcStatuses);

export default router;
```

Then mount it in `client/server.ts` alongside the existing maps route (BEFORE the authenticated routes):

```typescript
import simulationMapRoutes from "./server/simulation/mapRoutes.js";

// After existing "/api/maps" route and before authenticated routes:
app.use("/api", simulationMapRoutes); // /api/simulation/:id/* — Map viewer (no auth, read-only)
```

Add the `PUT /simulation/:id/config` route to the **existing authenticated** `client/server/simulation/routes.ts` (since it's a write operation):

```typescript
import * as mapController from "./mapController.js";

// After existing routes (line ~38):
router.put("/simulation/:id/config", mapController.updateConfig);
```

- [ ] **Step 4: Extend existing `/api/maps` route to serve tilemap assets**

The existing `client/server/maps/routes.ts` only allows `.jpg`, `.jpeg`, `.png`, `.webp` extensions. The map viewer also needs `.json` (Tiled maps) and `.tsx` (Tiled tilesets). Update the allowed extensions:

In `client/server/maps/routes.ts`, change the extension whitelist (line ~41):

```typescript
// Was: if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext))
if (![".jpg", ".jpeg", ".png", ".webp", ".json", ".tsx"].includes(ext)) {
```

This allows the frontend to load Tiled JSON maps via existing URLs like:
`/api/maps/[Module]_Maps/town.json`

- [ ] **Step 5: Extend ModuleDigest interface**

In `src/dynamicworldagent/state/types.ts`, add to the `ModuleDigest` interface (line ~392):

```typescript
sceneMapBindings?: Record<string, string>;  // sceneId → relative path to interior Tiled JSON
spriteBindings?: Record<string, string>;    // npcId → relative path to sprite sheet
```

- [ ] **Step 6: Verify build**

Run: `pnpm build`
Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add src/dynamicworldagent/simulation/ src/dynamicworldagent/state/types.ts client/server/simulation/ client/server.ts
git commit -m "feat(simulation): add map viewer API endpoints and types"
```

---

## Chunk 3: Frontend — Infrastructure & Hooks

### Task 7: Add Phaser 3 dependency

**Files:**
- Modify: `client/package.json`

- [ ] **Step 1: Install Phaser**

```bash
cd client && pnpm add phaser
```

- [ ] **Step 2: Verify install**

Run: `cd client && pnpm build`
Expected: Build succeeds. Phaser is tree-shakeable by Vite.

---

### Task 8: Simulation API client

**Files:**
- Create: `client/src/services/simulationApi.ts`

- [ ] **Step 1: Create API service**

```typescript
// client/src/services/simulationApi.ts

import { api } from "./api.js";

// Local type definition — mirrors backend CharacterPosition union.
// Do NOT import from src/ — that breaks Vite bundling.
export type CharacterPosition =
  | { type: "junction"; junctionId: string }
  | { type: "road"; roadId: string; position: number }
  | { type: "scene"; sceneId: string };

// Types matching backend responses
export interface TopologyResponse {
  junctions: Array<{
    id: string;
    name: string;
    connectedSceneIds: string[];
  }>;
  roads: Array<{
    id: string;
    name: string;
    endpointA: string;
    endpointB: string;
    travelTimeMinutes: number;
    alongConnections: Array<{ sceneId: string; position: number }>;
  }>;
  scenes: Array<{
    id: string;
    name: string;
    parentLocationId: string;
    connections: string[];
  }>;
}

export interface MapLayout {
  junctions: Record<string, { x: number; y: number }>;
}

export interface NpcStatusInfo {
  npcId: string;
  name: string;
  hp: number;
  maxHp: number;
  sanity: number;
  maxSanity: number;
  currentAction: string | null;
  location: string;
  inventory: Array<{ id: string; name: string; description?: string }>;
  isAlive: boolean;
}

export interface SimulationStatus {
  state: "running" | "paused" | "stopped" | "completed";
  currentDay: number;
  currentTime: string;
  ticksExecuted: number;
  stopReason?: string;
}

// API calls
export async function fetchTopology(sessionId: string): Promise<TopologyResponse> {
  const { data } = await api.get(`/simulation/${sessionId}/topology`);
  return data;
}

export async function fetchMapLayout(sessionId: string): Promise<MapLayout> {
  const { data } = await api.get(`/simulation/${sessionId}/map-layout`);
  return data;
}

export async function fetchPositions(
  sessionId: string
): Promise<Record<string, CharacterPosition>> {
  const { data } = await api.get(`/simulation/${sessionId}/positions`);
  return data.positions;
}

export async function fetchNpcStatuses(sessionId: string): Promise<NpcStatusInfo[]> {
  const { data } = await api.get(`/simulation/${sessionId}/npc-statuses`);
  return data.statuses;
}

export async function fetchStatus(sessionId: string): Promise<SimulationStatus> {
  const { data } = await api.get(`/simulation/${sessionId}/status`);
  return data;
}

export async function startSimulation(sessionId: string): Promise<void> {
  await api.post(`/simulation/${sessionId}/start`);
}

export async function pauseSimulation(sessionId: string): Promise<void> {
  await api.post(`/simulation/${sessionId}/pause`);
}

export async function stepSimulation(sessionId: string, ticks = 1): Promise<void> {
  await api.post(`/simulation/${sessionId}/step`, { ticks });
}

export async function stopSimulation(sessionId: string): Promise<void> {
  await api.post(`/simulation/${sessionId}/stop`);
}

export async function updateSpeed(sessionId: string, tickIntervalMs: number): Promise<void> {
  await api.put(`/simulation/${sessionId}/config`, { tickIntervalMs });
}
```

---

### Task 9: WebSocket hook for simulation

**Files:**
- Create: `client/src/hooks/useSimulationWebSocket.ts`

- [ ] **Step 1: Create simulation WebSocket hook**

```typescript
// client/src/hooks/useSimulationWebSocket.ts

import { useEffect, useRef, useCallback } from "react";

export interface SimulationEvent {
  id: string;
  sessionId: string;
  tick: number;
  gameDay: number;
  gameTime: string;
  type: string;
  actorNpcId: string;
  targetNpcId?: string;
  location: string;
  data: Record<string, unknown>;
  timestamp: string;
}

interface UseSimulationWebSocketParams {
  sessionId: string | null;
  onEvent: (event: SimulationEvent) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export function useSimulationWebSocket({
  sessionId,
  onEvent,
  onConnected,
  onDisconnected,
}: UseSimulationWebSocketParams) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const reconnectDelayRef = useRef(1000);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    if (!sessionId) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws?sessionId=${sessionId}&type=simulation`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectDelayRef.current = 1000; // Reset backoff
      onConnected?.();
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "simulation_event" && message.data) {
          onEventRef.current(message.data);
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      onDisconnected?.();
      // Auto-reconnect with exponential backoff
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30000);
        connect();
      }, reconnectDelayRef.current);
    };
  }, [sessionId, onConnected, onDisconnected]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect]);
}
```

---

### Task 10: Simulation state management hook

**Files:**
- Create: `client/src/hooks/useSimulationState.ts`

- [ ] **Step 1: Create state hook**

```typescript
// client/src/hooks/useSimulationState.ts

import { useState, useCallback, useEffect } from "react";
import type { SimulationEvent } from "./useSimulationWebSocket.js";
import type {
  TopologyResponse,
  MapLayout,
  NpcStatusInfo,
  SimulationStatus,
  CharacterPosition,
} from "../services/simulationApi.js";
import * as simApi from "../services/simulationApi.js";

export interface SimulationViewState {
  topology: TopologyResponse | null;
  mapLayout: MapLayout | null;
  npcPositions: Record<string, CharacterPosition>;
  npcStatuses: NpcStatusInfo[];
  currentLevel: 1 | 2 | 3;
  focusedBuildingId: string | null;
  focusedSubSceneId: string | null;
  selectedNpcId: string | null;
  gameDay: number;
  timeOfDay: string;
  simulationState: SimulationStatus["state"];
  eventLog: SimulationEvent[];
  isLoading: boolean;
  error: string | null;
}

const MAX_EVENT_LOG = 200;

export function useSimulationState(sessionId: string | null) {
  const [state, setState] = useState<SimulationViewState>({
    topology: null,
    mapLayout: null,
    npcPositions: {},
    npcStatuses: [],
    currentLevel: 1,
    focusedBuildingId: null,
    focusedSubSceneId: null,
    selectedNpcId: null,
    gameDay: 1,
    timeOfDay: "08:00",
    simulationState: "paused",
    eventLog: [],
    isLoading: true,
    error: null,
  });

  // Initial data fetch
  useEffect(() => {
    if (!sessionId) return;

    async function loadInitialState() {
      try {
        const [topology, mapLayout, positions, statuses, status] = await Promise.all([
          simApi.fetchTopology(sessionId!),
          simApi.fetchMapLayout(sessionId!).catch(() => null),
          simApi.fetchPositions(sessionId!),
          simApi.fetchNpcStatuses(sessionId!),
          simApi.fetchStatus(sessionId!),
        ]);

        setState((prev) => ({
          ...prev,
          topology,
          mapLayout,
          npcPositions: positions,
          npcStatuses: statuses,
          gameDay: status.currentDay,
          timeOfDay: status.currentTime,
          simulationState: status.state,
          isLoading: false,
        }));
      } catch (err) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: err instanceof Error ? err.message : "Failed to load simulation",
        }));
      }
    }

    loadInitialState();
  }, [sessionId]);

  // Handle incoming WebSocket events
  const handleEvent = useCallback((event: SimulationEvent) => {
    setState((prev) => {
      const newState = { ...prev };

      // Always update time
      newState.gameDay = event.gameDay;
      newState.timeOfDay = event.gameTime;

      // Append to event log (capped)
      newState.eventLog = [event, ...prev.eventLog].slice(0, MAX_EVENT_LOG);

      // Type-specific updates
      switch (event.type) {
        case "npc_moved": {
          const data = event.data as {
            fromPosition: CharacterPosition;
            toPosition: CharacterPosition;
          };
          newState.npcPositions = {
            ...prev.npcPositions,
            [event.actorNpcId]: data.toPosition,
          };
          break;
        }
        case "simulation_state_changed": {
          const data = event.data as { state: SimulationStatus["state"] };
          newState.simulationState = data.state;
          break;
        }
        case "npc_death": {
          newState.npcStatuses = prev.npcStatuses.map((npc) =>
            npc.npcId === event.actorNpcId ? { ...npc, isAlive: false, hp: 0 } : npc
          );
          break;
        }
        case "action_executed":
        case "action_failed": {
          const data = event.data as { action?: string };
          if (data.action) {
            newState.npcStatuses = prev.npcStatuses.map((npc) =>
              npc.npcId === event.actorNpcId
                ? { ...npc, currentAction: data.action ?? null }
                : npc
            );
          }
          break;
        }
      }

      return newState;
    });
  }, []);

  // UI actions
  const setSelectedNpc = useCallback((npcId: string | null) => {
    setState((prev) => ({ ...prev, selectedNpcId: npcId }));
  }, []);

  const setCurrentLevel = useCallback((level: 1 | 2 | 3) => {
    setState((prev) => ({ ...prev, currentLevel: level }));
  }, []);

  const enterBuilding = useCallback((buildingId: string, subSceneId: string) => {
    setState((prev) => ({
      ...prev,
      currentLevel: 3,
      focusedBuildingId: buildingId,
      focusedSubSceneId: subSceneId,
    }));
  }, []);

  const exitBuilding = useCallback(() => {
    setState((prev) => ({
      ...prev,
      currentLevel: 2,
      focusedBuildingId: null,
      focusedSubSceneId: null,
    }));
  }, []);

  const switchSubScene = useCallback((subSceneId: string) => {
    setState((prev) => ({ ...prev, focusedSubSceneId: subSceneId }));
  }, []);

  // Re-sync on WebSocket reconnect
  const resync = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [positions, statuses, status] = await Promise.all([
        simApi.fetchPositions(sessionId),
        simApi.fetchNpcStatuses(sessionId),
        simApi.fetchStatus(sessionId),
      ]);
      setState((prev) => ({
        ...prev,
        npcPositions: positions,
        npcStatuses: statuses,
        gameDay: status.currentDay,
        timeOfDay: status.currentTime,
        simulationState: status.state,
      }));
    } catch {
      // Ignore re-sync errors
    }
  }, [sessionId]);

  return {
    state,
    handleEvent,
    setSelectedNpc,
    setCurrentLevel,
    enterBuilding,
    exitBuilding,
    switchSubScene,
    resync,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/services/simulationApi.ts client/src/hooks/useSimulationWebSocket.ts client/src/hooks/useSimulationState.ts client/package.json
git commit -m "feat(simulation): add frontend hooks and API client for map viewer"
```

---

## Chunk 4: Frontend — Phaser Scenes

### Task 11: PhaserContainer wrapper

**Files:**
- Create: `client/src/components/simulation/PhaserContainer.tsx`

- [ ] **Step 1: Create Phaser wrapper component**

This component initializes a Phaser game instance and manages its lifecycle within React.

```typescript
// client/src/components/simulation/PhaserContainer.tsx

import { useEffect, useRef } from "react";
import Phaser from "phaser";
import { TownScene } from "./TownScene.js";
import { InteriorScene } from "./InteriorScene.js";

interface PhaserContainerProps {
  onGameReady: (game: Phaser.Game) => void;
  moduleName: string;
}

export function PhaserContainer({ onGameReady, moduleName }: PhaserContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      backgroundColor: "#111118",
      scene: [TownScene, InteriorScene],
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      render: {
        pixelArt: true,
        antialias: false,
      },
    });

    gameRef.current = game;
    onGameReady(game);

    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
  }, [onGameReady, moduleName]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ imageRendering: "pixelated" }}
    />
  );
}
```

---

### Task 12: TownScene (Phaser Scene)

**Files:**
- Create: `client/src/components/simulation/TownScene.ts`

- [ ] **Step 1: Create TownScene**

This is the main Phaser scene handling the town map (Level 1 & 2). Loads `town.json` Tiled map and manages NPC sprites/dots.

```typescript
// client/src/components/simulation/TownScene.ts

import Phaser from "phaser";

interface NpcSpriteData {
  dot: Phaser.GameObjects.Arc;
  sprite?: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  npcId: string;
  color: number;
}

const ZOOM_SPRITE_THRESHOLD = 0.5;
const NPC_COLORS = [0xff6b6b, 0x4ecdc4, 0xffe66d, 0xa29bfe, 0xfd79a8, 0x00b894, 0xe17055, 0x6c5ce7];

export class TownScene extends Phaser.Scene {
  private npcSprites: Map<string, NpcSpriteData> = new Map();
  private mapLoaded = false;
  private junctionCoords: Record<string, { x: number; y: number }> = {};
  private colorIndex = 0;

  constructor() {
    super({ key: "TownScene" });
  }

  init() {
    // Listen for events from React
    this.game.events.on("load-town-map", this.handleLoadTownMap, this);
    this.game.events.on("npc-position-update", this.handleNpcPositionUpdate, this);
    this.game.events.on("set-junction-coords", this.handleSetJunctionCoords, this);
    this.game.events.on("zoom-to", this.handleZoomTo, this);
    this.game.events.on("enter-building", this.handleEnterBuilding, this);
  }

  create() {
    // Setup camera controls
    this.input.on("wheel", (
      _pointer: Phaser.Input.Pointer,
      _gameObjects: Phaser.GameObjects.GameObject[],
      _deltaX: number,
      deltaY: number
    ) => {
      const cam = this.cameras.main;
      const newZoom = Phaser.Math.Clamp(cam.zoom + (deltaY > 0 ? -0.1 : 0.1), 0.1, 2);
      cam.setZoom(newZoom);
      this.updateNpcRenderMode(newZoom);
    });

    // Drag to pan
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (pointer.isDown) {
        const cam = this.cameras.main;
        cam.scrollX -= (pointer.x - pointer.prevPosition.x) / cam.zoom;
        cam.scrollY -= (pointer.y - pointer.prevPosition.y) / cam.zoom;
      }
    });
  }

  private handleLoadTownMap(data: { mapUrl: string; tilesetUrl: string; tilesetKey: string }) {
    // Load Tiled JSON map
    this.load.tilemapTiledJSON("town", data.mapUrl);
    this.load.image(data.tilesetKey, data.tilesetUrl);
    this.load.once("complete", () => {
      this.createTilemap(data.tilesetKey);
    });
    this.load.start();
  }

  private createTilemap(tilesetKey: string) {
    const map = this.make.tilemap({ key: "town" });
    const tileset = map.addTilesetImage(map.tilesets[0].name, tilesetKey);
    if (!tileset) return;

    // Create layers (order matters for z-depth)
    const layerNames = ["ground", "roads", "buildings", "decoration"];
    for (const name of layerNames) {
      const layer = map.createLayer(name, tileset);
      if (layer) layer.setDepth(layerNames.indexOf(name));
    }

    // Fit camera to map
    this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    this.cameras.main.centerOn(map.widthInPixels / 2, map.heightInPixels / 2);
    this.cameras.main.setZoom(
      Math.min(
        this.scale.width / map.widthInPixels,
        this.scale.height / map.heightInPixels
      )
    );

    // Parse building entrances object layer
    const entrancesLayer = map.getObjectLayer("building_entrances");
    if (entrancesLayer) {
      for (const obj of entrancesLayer.objects) {
        const sceneId = obj.properties?.find((p: any) => p.name === "sceneId")?.value;
        if (sceneId && obj.x !== undefined && obj.y !== undefined) {
          // Create clickable zone
          const zone = this.add.zone(obj.x, obj.y, obj.width ?? 32, obj.height ?? 32)
            .setInteractive()
            .setOrigin(0, 0);
          zone.on("pointerdown", () => {
            this.game.events.emit("building-clicked", sceneId);
          });
        }
      }
    }

    this.mapLoaded = true;
  }

  private handleSetJunctionCoords(coords: Record<string, { x: number; y: number }>) {
    this.junctionCoords = coords;
  }

  private handleNpcPositionUpdate(data: {
    npcId: string;
    name: string;
    position: { type: string; junctionId?: string; roadId?: string; position?: number; sceneId?: string };
    roads?: any[];
  }) {
    const pixelPos = this.resolvePixelPosition(data.position, data.roads);
    if (!pixelPos) return;

    let npcData = this.npcSprites.get(data.npcId);
    if (!npcData) {
      // Create new NPC representation
      const color = NPC_COLORS[this.colorIndex % NPC_COLORS.length];
      this.colorIndex++;

      const dot = this.add.circle(pixelPos.x, pixelPos.y, 6, color).setDepth(10);
      const label = this.add.text(pixelPos.x, pixelPos.y + 10, data.name, {
        fontSize: "10px",
        color: "#ffffff",
        backgroundColor: "rgba(0,0,0,0.5)",
        padding: { x: 2, y: 1 },
      }).setOrigin(0.5, 0).setDepth(11);

      dot.setInteractive();
      dot.on("pointerdown", () => {
        this.game.events.emit("npc-clicked", data.npcId);
      });

      npcData = { dot, label, npcId: data.npcId, color };
      this.npcSprites.set(data.npcId, npcData);
    }

    // Animate movement
    this.tweens.add({
      targets: [npcData.dot, npcData.label],
      x: pixelPos.x,
      y: (target: any) => target === npcData!.label ? pixelPos.y + 10 : pixelPos.y,
      duration: 500,
      ease: "Power2",
    });
  }

  private resolvePixelPosition(
    position: { type: string; junctionId?: string; roadId?: string; position?: number; sceneId?: string },
    roads?: any[]
  ): { x: number; y: number } | null {
    switch (position.type) {
      case "junction": {
        const coords = this.junctionCoords[position.junctionId!];
        return coords ?? null;
      }
      case "road": {
        // Find road endpoints and interpolate
        const road = roads?.find((r: any) => r.id === position.roadId);
        if (!road) return null;
        const a = this.junctionCoords[road.endpointA];
        const b = this.junctionCoords[road.endpointB];
        if (!a || !b) return null;
        const t = position.position ?? 0.5;
        return {
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
        };
      }
      case "scene": {
        // Scene positions handled by building entrance coords or topology fallback
        // For now, return null — indoor NPCs not shown on town map
        return null;
      }
      default:
        return null;
    }
  }

  private handleZoomTo(data: { x: number; y: number; zoom: number }) {
    this.cameras.main.pan(data.x, data.y, 500, "Power2");
    this.cameras.main.zoomTo(data.zoom, 500);
  }

  private handleEnterBuilding(_data: { sceneId: string }) {
    // Transition to InteriorScene
    this.scene.start("InteriorScene");
  }

  private updateNpcRenderMode(zoom: number) {
    const useSprites = zoom >= ZOOM_SPRITE_THRESHOLD;
    // In v1, always use dots. Sprite rendering is a future enhancement.
    // Emit level change
    this.game.events.emit("zoom-level-changed", useSprites ? 2 : 1);
  }
}
```

---

### Task 13: InteriorScene (Phaser Scene)

**Files:**
- Create: `client/src/components/simulation/InteriorScene.ts`

- [ ] **Step 1: Create InteriorScene**

```typescript
// client/src/components/simulation/InteriorScene.ts

import Phaser from "phaser";

export class InteriorScene extends Phaser.Scene {
  private currentSceneId: string | null = null;

  constructor() {
    super({ key: "InteriorScene" });
  }

  init() {
    this.game.events.on("load-interior", this.handleLoadInterior, this);
    this.game.events.on("switch-sub-scene", this.handleSwitchSubScene, this);
    this.game.events.on("exit-building", this.handleExitBuilding, this);
    this.game.events.on("npc-position-update-interior", this.handleNpcUpdate, this);
  }

  create() {
    // Back button hint
    this.add.text(10, 10, "← Back (click or press Esc)", {
      fontSize: "14px",
      color: "#888",
    }).setScrollFactor(0).setDepth(100).setInteractive()
      .on("pointerdown", () => this.handleExitBuilding());

    this.input.keyboard?.on("keydown-ESC", () => this.handleExitBuilding());
  }

  private handleLoadInterior(data: {
    sceneId: string;
    mapUrl: string;
    tilesetUrl: string;
    tilesetKey: string;
  }) {
    this.currentSceneId = data.sceneId;

    // Clear existing map
    this.children.removeAll();
    this.create(); // Re-add back button

    // Load interior tilemap
    const mapKey = `interior_${data.sceneId}`;
    this.load.tilemapTiledJSON(mapKey, data.mapUrl);

    if (!this.textures.exists(data.tilesetKey)) {
      this.load.image(data.tilesetKey, data.tilesetUrl);
    }

    this.load.once("complete", () => {
      const map = this.make.tilemap({ key: mapKey });
      const tileset = map.addTilesetImage(map.tilesets[0].name, data.tilesetKey);
      if (!tileset) return;

      for (const name of ["ground", "walls", "furniture"]) {
        const layer = map.createLayer(name, tileset);
        if (layer) layer.setDepth(["ground", "walls", "furniture"].indexOf(name));
      }

      this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
      this.cameras.main.centerOn(map.widthInPixels / 2, map.heightInPixels / 2);
      this.cameras.main.setZoom(
        Math.min(
          this.scale.width / map.widthInPixels,
          this.scale.height / map.heightInPixels
        ) * 0.9
      );
    });

    this.load.start();
  }

  private handleSwitchSubScene(data: { subSceneId: string }) {
    // Delegate to React to load new sub-scene data
    this.currentSceneId = data.subSceneId;
    // React will call load-interior again with the new sub-scene data
  }

  private handleExitBuilding() {
    this.currentSceneId = null;
    this.scene.start("TownScene");
    this.game.events.emit("building-exited");
  }

  private handleNpcUpdate(data: {
    npcId: string;
    name: string;
    sceneId: string;
    x: number;
    y: number;
  }) {
    if (data.sceneId !== this.currentSceneId) return;

    // Simple dot representation for interior NPCs
    // Full sprite support is a future enhancement
    const existing = this.children.getByName(data.npcId) as Phaser.GameObjects.Arc;
    if (existing) {
      this.tweens.add({ targets: existing, x: data.x, y: data.y, duration: 300 });
    } else {
      const dot = this.add.circle(data.x, data.y, 8, 0x4ecdc4).setDepth(10);
      dot.setName(data.npcId);
      this.add.text(data.x, data.y + 12, data.name, {
        fontSize: "10px",
        color: "#fff",
      }).setOrigin(0.5, 0).setDepth(11);
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/simulation/PhaserContainer.tsx client/src/components/simulation/TownScene.ts client/src/components/simulation/InteriorScene.ts
git commit -m "feat(simulation): add Phaser scenes for town map and building interiors"
```

---

## Chunk 5: Frontend — React UI Components

### Task 14: Side panel components

**Files:**
- Create: `client/src/components/simulation/GameClock.tsx`
- Create: `client/src/components/simulation/NpcCard.tsx`
- Create: `client/src/components/simulation/NpcDetail.tsx`
- Create: `client/src/components/simulation/EventLog.tsx`
- Create: `client/src/components/simulation/SidePanel.tsx`

- [ ] **Step 1: Create GameClock**

```typescript
// client/src/components/simulation/GameClock.tsx

interface GameClockProps {
  gameDay: number;
  timeOfDay: string;
  simulationState: string;
}

export function GameClock({ gameDay, timeOfDay, simulationState }: GameClockProps) {
  return (
    <div className="p-3 border-b border-gray-700 flex items-center justify-between">
      <div>
        <span className="text-lg font-bold text-amber-200">Day {gameDay}</span>
        <span className="ml-3 text-lg text-gray-300">{timeOfDay}</span>
      </div>
      <span className={`text-xs px-2 py-1 rounded ${
        simulationState === "running" ? "bg-green-800 text-green-200" :
        simulationState === "paused" ? "bg-yellow-800 text-yellow-200" :
        "bg-red-800 text-red-200"
      }`}>
        {simulationState}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Create NpcCard**

```typescript
// client/src/components/simulation/NpcCard.tsx

import type { NpcStatusInfo } from "../../services/simulationApi.js";

interface NpcCardProps {
  npc: NpcStatusInfo;
  isSelected: boolean;
  onClick: () => void;
}

export function NpcCard({ npc, isSelected, onClick }: NpcCardProps) {
  return (
    <div
      className={`p-2 cursor-pointer border-b border-gray-800 hover:bg-gray-800/50 ${
        isSelected ? "bg-gray-800 border-l-2 border-l-amber-400" : ""
      }`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <span className={`font-medium ${npc.isAlive ? "text-gray-200" : "text-red-400 line-through"}`}>
          {npc.isAlive ? "📍" : "💀"} {npc.name}
        </span>
        <span className="text-xs text-gray-500">{npc.location}</span>
      </div>
      {npc.isAlive && (
        <div className="text-xs text-gray-400 mt-1">
          HP: {npc.hp}/{npc.maxHp} SAN: {npc.sanity}/{npc.maxSanity}
          {npc.currentAction && (
            <div className="text-gray-500 mt-0.5 truncate">{npc.currentAction}</div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create NpcDetail**

```typescript
// client/src/components/simulation/NpcDetail.tsx

import type { NpcStatusInfo } from "../../services/simulationApi.js";

interface NpcDetailProps {
  npc: NpcStatusInfo;
  onBack: () => void;
  onZoomTo: (npcId: string) => void;
}

export function NpcDetail({ npc, onBack, onZoomTo }: NpcDetailProps) {
  return (
    <div className="p-3">
      <button onClick={onBack} className="text-xs text-gray-400 hover:text-gray-200 mb-2">
        ← Back to list
      </button>
      <h3 className="text-lg font-bold text-amber-200 mb-2">{npc.name}</h3>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between text-gray-300">
          <span>HP</span>
          <span>{npc.hp} / {npc.maxHp}</span>
        </div>
        <div className="flex justify-between text-gray-300">
          <span>SAN</span>
          <span>{npc.sanity} / {npc.maxSanity}</span>
        </div>
        <div className="text-gray-400">
          <span className="text-gray-500">Location:</span> {npc.location}
        </div>
        {npc.currentAction && (
          <div className="text-gray-400">
            <span className="text-gray-500">Action:</span> {npc.currentAction}
          </div>
        )}
        {npc.inventory.length > 0 && (
          <div>
            <span className="text-gray-500 text-xs">Inventory:</span>
            <ul className="text-xs text-gray-400 mt-1">
              {npc.inventory.map((item) => (
                <li key={item.id}>• {item.name}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <button
        onClick={() => onZoomTo(npc.npcId)}
        className="mt-3 text-xs text-amber-400 hover:text-amber-200"
      >
        Zoom to location →
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Create EventLog**

```typescript
// client/src/components/simulation/EventLog.tsx

import type { SimulationEvent } from "../../hooks/useSimulationWebSocket.js";

interface EventLogProps {
  events: SimulationEvent[];
}

const EVENT_LABELS: Record<string, string> = {
  action_executed: "✅",
  action_failed: "❌",
  npc_moved: "🚶",
  npc_death: "💀",
  day_transition: "🌅",
  clue_discovered: "🔍",
  encounter: "🤝",
  relationship_changed: "💬",
  simulation_state_changed: "⚙️",
};

export function EventLog({ events }: EventLogProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-3 py-2 text-xs font-medium text-gray-500 border-b border-gray-800">
        Event Log
      </div>
      {events.map((event) => (
        <div key={event.id} className="px-3 py-1.5 text-xs border-b border-gray-900 hover:bg-gray-800/30">
          <div className="flex items-center gap-1">
            <span>{EVENT_LABELS[event.type] ?? "•"}</span>
            <span className="text-gray-500">{event.gameTime}</span>
            <span className="text-gray-300 truncate">
              {formatEventText(event)}
            </span>
          </div>
        </div>
      ))}
      {events.length === 0 && (
        <div className="px-3 py-4 text-xs text-gray-600 text-center">
          No events yet
        </div>
      )}
    </div>
  );
}

function formatEventText(event: SimulationEvent): string {
  const data = event.data;
  switch (event.type) {
    case "npc_moved":
      return `${event.actorNpcId} moved to ${event.location}`;
    case "action_executed":
    case "action_failed":
      return `${event.actorNpcId}: ${(data.action as string) ?? event.type}`;
    case "npc_death":
      return `${(data.npcName as string) ?? event.actorNpcId} died`;
    case "day_transition":
      return `Day ${event.gameDay}`;
    default:
      return event.type;
  }
}
```

- [ ] **Step 5: Create SidePanel**

```typescript
// client/src/components/simulation/SidePanel.tsx

import { GameClock } from "./GameClock.js";
import { NpcCard } from "./NpcCard.js";
import { NpcDetail } from "./NpcDetail.js";
import { EventLog } from "./EventLog.js";
import type { NpcStatusInfo } from "../../services/simulationApi.js";
import type { SimulationEvent } from "../../hooks/useSimulationWebSocket.js";

interface SidePanelProps {
  gameDay: number;
  timeOfDay: string;
  simulationState: string;
  npcStatuses: NpcStatusInfo[];
  selectedNpcId: string | null;
  eventLog: SimulationEvent[];
  onSelectNpc: (npcId: string | null) => void;
  onZoomToNpc: (npcId: string) => void;
}

export function SidePanel({
  gameDay, timeOfDay, simulationState,
  npcStatuses, selectedNpcId, eventLog,
  onSelectNpc, onZoomToNpc,
}: SidePanelProps) {
  const selectedNpc = selectedNpcId
    ? npcStatuses.find((n) => n.npcId === selectedNpcId)
    : null;

  return (
    <div className="w-80 bg-gray-900 border-l border-gray-700 flex flex-col h-full">
      <GameClock gameDay={gameDay} timeOfDay={timeOfDay} simulationState={simulationState} />

      {selectedNpc ? (
        <NpcDetail
          npc={selectedNpc}
          onBack={() => onSelectNpc(null)}
          onZoomTo={onZoomToNpc}
        />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="px-3 py-2 text-xs font-medium text-gray-500 border-b border-gray-800">
            NPCs ({npcStatuses.length})
          </div>
          {npcStatuses.map((npc) => (
            <NpcCard
              key={npc.npcId}
              npc={npc}
              isSelected={npc.npcId === selectedNpcId}
              onClick={() => onSelectNpc(npc.npcId)}
            />
          ))}
        </div>
      )}

      <EventLog events={eventLog} />
    </div>
  );
}
```

---

### Task 15: Control panel and sub-scene tabs

**Files:**
- Create: `client/src/components/simulation/ControlPanel.tsx`
- Create: `client/src/components/simulation/SubSceneTabs.tsx`

- [ ] **Step 1: Create ControlPanel**

```typescript
// client/src/components/simulation/ControlPanel.tsx

import * as simApi from "../../services/simulationApi.js";

interface ControlPanelProps {
  sessionId: string;
  simulationState: string;
  onStateChange?: () => void;
}

const SPEEDS = [
  { label: "1x", ms: 60000 },
  { label: "2x", ms: 30000 },
  { label: "5x", ms: 12000 },
  { label: "10x", ms: 6000 },
];

export function ControlPanel({ sessionId, simulationState, onStateChange }: ControlPanelProps) {
  const isRunning = simulationState === "running";
  const isPaused = simulationState === "paused";

  async function handlePlayPause() {
    if (isRunning) {
      await simApi.pauseSimulation(sessionId);
    } else if (isPaused) {
      await simApi.startSimulation(sessionId);
    }
    onStateChange?.();
  }

  async function handleStep() {
    if (isPaused) {
      await simApi.stepSimulation(sessionId);
      onStateChange?.();
    }
  }

  async function handleSpeedChange(ms: number) {
    await simApi.updateSpeed(sessionId, ms);
  }

  return (
    <div className="fixed bottom-4 left-4 z-50 bg-gray-900/95 border border-gray-700 rounded-lg px-4 py-2 flex items-center gap-3 shadow-lg">
      <button
        onClick={handlePlayPause}
        className="text-xl hover:text-amber-400 transition-colors"
        disabled={!isRunning && !isPaused}
      >
        {isRunning ? "⏸" : "▶"}
      </button>

      <button
        onClick={handleStep}
        className="text-xl hover:text-amber-400 transition-colors disabled:opacity-30"
        disabled={!isPaused}
        title="Step one tick"
      >
        ⏭
      </button>

      <div className="border-l border-gray-700 pl-3 flex gap-1">
        {SPEEDS.map(({ label, ms }) => (
          <button
            key={label}
            onClick={() => handleSpeedChange(ms)}
            className="text-xs px-2 py-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create SubSceneTabs**

```typescript
// client/src/components/simulation/SubSceneTabs.tsx

interface SubSceneTabsProps {
  subScenes: Array<{ id: string; name: string }>;
  activeSubSceneId: string | null;
  onSelect: (subSceneId: string) => void;
  onBack: () => void;
}

export function SubSceneTabs({ subScenes, activeSubSceneId, onSelect, onBack }: SubSceneTabsProps) {
  if (subScenes.length === 0) return null;

  return (
    <div className="absolute top-0 left-0 right-0 z-40 bg-gray-900/90 border-b border-gray-700 px-3 py-1 flex items-center gap-2">
      <button
        onClick={onBack}
        className="text-xs text-gray-400 hover:text-gray-200 mr-2"
      >
        ← Town
      </button>
      {subScenes.map((scene) => (
        <button
          key={scene.id}
          onClick={() => onSelect(scene.id)}
          className={`text-xs px-2 py-1 rounded ${
            scene.id === activeSubSceneId
              ? "bg-amber-700 text-amber-100"
              : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          }`}
        >
          {scene.name}
        </button>
      ))}
    </div>
  );
}
```

---

### Task 16: SimulationPage and routing

**Files:**
- Create: `client/src/views/SimulationPage.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Create SimulationPage**

```typescript
// client/src/views/SimulationPage.tsx

import { useCallback, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import Phaser from "phaser";
import { PhaserContainer } from "../components/simulation/PhaserContainer.js";
import { SidePanel } from "../components/simulation/SidePanel.js";
import { ControlPanel } from "../components/simulation/ControlPanel.js";
import { SubSceneTabs } from "../components/simulation/SubSceneTabs.js";
import { useSimulationWebSocket } from "../hooks/useSimulationWebSocket.js";
import { useSimulationState } from "../hooks/useSimulationState.js";

export default function SimulationPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const gameRef = useRef<Phaser.Game | null>(null);

  const {
    state,
    handleEvent,
    setSelectedNpc,
    setCurrentLevel,
    enterBuilding,
    exitBuilding,
    switchSubScene,
    resync,
  } = useSimulationState(sessionId ?? null);

  // WebSocket connection
  useSimulationWebSocket({
    sessionId: sessionId ?? null,
    onEvent: handleEvent,
    onConnected: resync,
  });

  // Phaser game ready — store ref and register Phaser → React listeners.
  // Do NOT send data here (state may still be loading). Use separate useEffects.
  const handleGameReady = useCallback((game: Phaser.Game) => {
    gameRef.current = game;

    // Listen for Phaser → React events
    game.events.on("npc-clicked", (npcId: string) => setSelectedNpc(npcId));
    game.events.on("building-clicked", (sceneId: string) => {
      // enterBuilding uses latest state via ref/callback
      enterBuilding(sceneId, sceneId);
    });
    game.events.on("building-exited", () => exitBuilding());
    game.events.on("zoom-level-changed", (level: number) => setCurrentLevel(level as 1 | 2));
  }, [setSelectedNpc, enterBuilding, exitBuilding, setCurrentLevel]);

  // Send junction coords to Phaser when mapLayout loads (separate from game init)
  useEffect(() => {
    if (!gameRef.current || !state.mapLayout) return;
    gameRef.current.events.emit("set-junction-coords", state.mapLayout.junctions);
  }, [state.mapLayout]);

  // Sync NPC positions to Phaser whenever they change
  useEffect(() => {
    if (!gameRef.current || !state.topology) return;
    const roads = state.topology.roads;
    for (const [npcId, position] of Object.entries(state.npcPositions)) {
      const npc = state.npcStatuses.find((n) => n.npcId === npcId);
      gameRef.current.events.emit("npc-position-update", {
        npcId,
        name: npc?.name ?? npcId,
        position,
        roads,
      });
    }
  }, [state.npcPositions, state.topology, state.npcStatuses]);

  const handleZoomToNpc = useCallback((npcId: string) => {
    const pos = state.npcPositions[npcId];
    if (!pos || !gameRef.current || !state.mapLayout) return;

    let x = 0, y = 0;
    if (pos.type === "junction" && pos.junctionId) {
      const coords = state.mapLayout.junctions[pos.junctionId];
      if (coords) { x = coords.x; y = coords.y; }
    }
    gameRef.current.events.emit("zoom-to", { x, y, zoom: 1.0 });
    setSelectedNpc(npcId);
  }, [state.npcPositions, state.mapLayout, setSelectedNpc]);

  if (state.isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950 text-gray-400">
        Loading simulation...
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950 text-red-400">
        Error: {state.error}
      </div>
    );
  }

  // Find sub-scenes for current building
  const buildingSubScenes = state.focusedBuildingId
    ? state.topology?.scenes
        .filter((s) => s.parentLocationId === state.focusedBuildingId)
        .map((s) => ({ id: s.id, name: s.name })) ?? []
    : [];

  return (
    <div className="flex h-screen bg-gray-950">
      {/* Phaser Canvas */}
      <div className="flex-1 relative">
        <PhaserContainer
          onGameReady={handleGameReady}
          moduleName={sessionId ?? ""}
        />

        {/* Sub-scene tabs (Level 3 only) */}
        {state.currentLevel === 3 && (
          <SubSceneTabs
            subScenes={buildingSubScenes}
            activeSubSceneId={state.focusedSubSceneId}
            onSelect={switchSubScene}
            onBack={exitBuilding}
          />
        )}
      </div>

      {/* Side Panel */}
      <SidePanel
        gameDay={state.gameDay}
        timeOfDay={state.timeOfDay}
        simulationState={state.simulationState}
        npcStatuses={state.npcStatuses}
        selectedNpcId={state.selectedNpcId}
        eventLog={state.eventLog}
        onSelectNpc={setSelectedNpc}
        onZoomToNpc={handleZoomToNpc}
      />

      {/* Floating Control Panel */}
      {sessionId && (
        <ControlPanel
          sessionId={sessionId}
          simulationState={state.simulationState}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add route in App.tsx**

In `client/src/App.tsx`, add the simulation route **outside** `ProtectedRoute`, alongside the auth routes:

```typescript
import { lazy, Suspense } from "react";

const SimulationPage = lazy(() => import("./views/SimulationPage.js"));

// In the Routes section, add before the ProtectedRoute block:
<Route
  path="/simulation/:sessionId"
  element={
    <Suspense fallback={<div className="flex items-center justify-center h-screen bg-gray-950 text-gray-400">Loading...</div>}>
      <SimulationPage />
    </Suspense>
  }
/>
```

- [ ] **Step 3: Verify build**

Run: `cd client && pnpm build`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/views/SimulationPage.tsx client/src/components/simulation/ client/src/App.tsx
git commit -m "feat(simulation): add map viewer page with Phaser canvas, side panel, and controls"
```

---

## Chunk 6: Integration & Verification

### Task 17: Full build verification

- [ ] **Step 1: Backend build**

Run: `pnpm build`
Expected: Clean build, no type errors.

- [ ] **Step 2: Frontend build**

Run: `cd client && pnpm build`
Expected: Clean build, no type errors.

- [ ] **Step 3: Format and lint**

Run: `pnpm check`
Expected: No lint errors (or only pre-existing ones).

- [ ] **Step 4: Manual smoke test**

Start the dev server with `pnpm chat:dev`.

1. Create a simulation via API:
```bash
curl -X POST http://localhost:3000/api/simulation \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"moduleName": "Cassandra"}'
```

2. Note the returned `sessionId`.

3. Open browser to `http://localhost:5173/simulation/<sessionId>`.

4. Verify:
   - Page loads without errors
   - Side panel shows NPC list
   - Control panel is visible at bottom-left
   - If module has map assets, Phaser canvas renders

5. Step the simulation:
```bash
curl -X POST http://localhost:3000/api/simulation/<sessionId>/step \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"ticks": 1}'
```

6. Verify events appear in the side panel event log.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(simulation): simulation map viewer — Phaser 3 pixel art map with NPC tracking"
```
