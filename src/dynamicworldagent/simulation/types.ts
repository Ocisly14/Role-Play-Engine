// src/dynamicworldagent/simulation/types.ts

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
  | "simulation_state_changed"
  | "npc_moved"
  | "npc_position_snapshot"
  | "playback_buffering"
  | "playback_resumed";

export interface SimulationEvent {
  id: string;
  sessionId: string;
  tick: number;
  gameDay: number;
  gameTime: string;
  type: SimulationEventType;
  actorNpcId: string;
  targetNpcId?: string;
  location: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

export type SimulationState = "running" | "paused" | "stopped" | "completed";
export type StopReason = "manual" | "max_days" | "event_triggered";

export interface SimulationConfig {
  sessionId: string;
  moduleId: string;
  mode: "realtime" | "paused";
  tickIntervalMs?: number;
  maxDays?: number;
  stopEvents?: string[];
  /** Display rhythm in ms — how fast events are released to frontend (default 60000 = 1x) */
  displayIntervalMs?: number;
  /** Minimum buffered ticks before playback starts (default 5) */
  minBufferTicks?: number;
  /** Minimum delay between simulation ticks in ms (default 50, yields event loop) */
  simulationDelayMs?: number;
  /** Sync game time to real wall-clock time */
  syncRealTime?: boolean;
  /** Buffer minutes ahead of real time (default 5). Game starts at now + this value */
  realTimeBufferMinutes?: number;
  /** Wall-clock timestamp (ms) when playback should begin releasing events */
  displayStartTime?: number;
}

export interface SimulationStatus {
  state: SimulationState;
  currentDay: number;
  currentTime: string;
  ticksExecuted: number;
  stopReason?: StopReason;
}

export interface SimulationRuntimeRecord {
  sessionId: string;
  tick: number;
  simulationState: SimulationState;
  stopReason?: StopReason;
  language: string;
  moduleName?: string;
  config: SimulationConfig;
  gameState: Record<string, unknown>;
}

export const DEFAULT_TICK_INTERVAL_MS = 60_000;
export const SIMULATION_EVENT_TYPES: readonly SimulationEventType[] = [
  "action_executed",
  "action_failed",
  "encounter",
  "relationship_changed",
  "clue_discovered",
  "plan_revised",
  "memory_created",
  "scene_updated",
  "day_transition",
  "feature_triggered",
  "npc_death",
  "simulation_state_changed",
  "npc_moved",
  "npc_position_snapshot",
  "playback_buffering",
  "playback_resumed",
] as const;

export interface PlaybackStatus {
  buffered: number;
  displayTick: number;
  simulationTick: number;
  isPlaying: boolean;
  /** Wall-clock timestamp (ms) when playback starts releasing events */
  displayStartTime?: number;
  /** Milliseconds until playback starts (0 = already started) */
  timeUntilStart?: number;
}
