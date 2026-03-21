import { api } from "./api.js";
import type { SimulationEvent } from "../hooks/useSimulationWebSocket.js";

// Local type definition — mirrors backend CharacterPosition union.
// Do NOT import from src/ — that breaks Vite bundling.
export type CharacterPosition =
  | { type: "junction"; junctionId: string }
  | { type: "road"; roadId: string; position: number }
  | { type: "scene"; sceneId: string };

export interface TopologyResponse {
  junctions: Array<{
    id: string;
    name: string;
    parentLocationId: string;
    connectedSceneIds: string[];
  }>;
  roads: Array<{
    id: string;
    name: string;
    parentLocationId: string;
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
  scenarioOutlines: Array<{
    id: string;
    name: string;
    entrySceneId?: string;
    residents?: string[];
    subSceneCount: number;
  }>;
  transportEdges: Array<{
    fromLocationId: string;
    toLocationId: string;
    streetSceneId: string;
    travelTimeMinutes: number;
  }>;
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
  moduleName?: string;
  mapsPrefix?: string;
}

export interface SimulationListItem {
  sessionId: string;
  moduleName?: string;
  state: "running" | "paused" | "stopped" | "completed";
  currentDay: number;
  currentTime: string;
  ticksExecuted: number;
}

// Simulation lifecycle
export async function createSimulation(params: {
  moduleName: string;
  language?: string;
  config?: {
    tickIntervalMs?: number;
    maxDays?: number;
    weather?: "clear" | "rain" | "fog" | "storm" | "snow" | "extreme_heat" | "extreme_cold";
    syncRealTime?: boolean;
    realTimeBufferMinutes?: number;
  };
}): Promise<{ sessionId: string }> {
  const { data } = await api.post("/simulation", params);
  return data;
}

export async function listSimulations(): Promise<SimulationListItem[]> {
  const { data } = await api.get("/simulations");
  return data.simulations;
}

export async function deleteSimulation(sessionId: string): Promise<void> {
  await api.delete(`/simulation/${sessionId}`);
}

// Map viewer API calls
export async function fetchTopology(
  sessionId: string
): Promise<TopologyResponse> {
  const { data } = await api.get(`/simulation/${sessionId}/topology`);
  return data;
}

export async function fetchPositions(
  sessionId: string
): Promise<Record<string, CharacterPosition>> {
  const { data } = await api.get(`/simulation/${sessionId}/positions`);
  return data.positions;
}

export async function fetchNpcStatuses(
  sessionId: string
): Promise<NpcStatusInfo[]> {
  const { data } = await api.get(`/simulation/${sessionId}/npc-statuses`);
  return data.statuses;
}

export async function fetchStatus(
  sessionId: string
): Promise<SimulationStatus> {
  const { data } = await api.get(`/simulation/${sessionId}/status`);
  return data;
}

export async function startSimulation(sessionId: string): Promise<void> {
  await api.post(`/simulation/${sessionId}/start`);
}

export async function pauseSimulation(sessionId: string): Promise<void> {
  await api.post(`/simulation/${sessionId}/pause`);
}

export async function stepSimulation(
  sessionId: string,
  ticks = 1
): Promise<void> {
  await api.post(`/simulation/${sessionId}/step`, { ticks });
}

export async function stopSimulation(sessionId: string): Promise<void> {
  await api.post(`/simulation/${sessionId}/stop`);
}

export async function updateSpeed(
  sessionId: string,
  tickIntervalMs: number
): Promise<void> {
  await api.put(`/simulation/${sessionId}/config`, { tickIntervalMs });
}

export async function updateMaxDays(
  sessionId: string,
  maxDays: number
): Promise<void> {
  await api.put(`/simulation/${sessionId}/config`, { maxDays });
}

export async function updateSyncRealTime(
  sessionId: string,
  syncRealTime: boolean,
  realTimeBufferMinutes?: number
): Promise<void> {
  await api.put(`/simulation/${sessionId}/config`, {
    syncRealTime,
    realTimeBufferMinutes,
  });
}

export interface PlaybackStatus {
  buffered: number;
  displayTick: number;
  simulationTick: number;
  isPlaying: boolean;
  displayStartTime?: number;
  timeUntilStart?: number;
  displayGameDay?: number;
  displayGameTime?: string;
}

export async function fetchPlaybackStatus(
  sessionId: string
): Promise<PlaybackStatus> {
  const { data } = await api.get(`/simulation/${sessionId}/playback-status`);
  return data;
}

export interface SimulationEventFilters {
  npcId?: string;
  startDay?: number;
  startTime?: string;
  endDay?: number;
  endTime?: string;
  maxTick?: number;
  parentLocationId?: string;
}

export async function fetchEvents(
  sessionId: string,
  filters?: SimulationEventFilters
): Promise<SimulationEvent[]> {
  const { data } = await api.get(`/simulation/${sessionId}/events`, {
    params: filters,
  });
  return data.events;
}
