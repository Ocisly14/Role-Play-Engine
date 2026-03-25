// src/dynamicworldagent/simulation/types.ts

export type SimulationEventType =
  | "action_executed"
  | "action_failed"
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

export type SimulationState =
  | "initializing"
  | "running"
  | "paused"
  | "stopped"
  | "completed";
export type StopReason = "manual" | "max_days" | "event_triggered";

export interface SimulationConfig {
  sessionId: string;
  moduleId: string;
  mode: "realtime" | "paused";
  tickIntervalMs?: number;
  maxDays?: number;
  stopEvents?: string[];
  /** Deprecated: old playback release interval. Retained for runtime compatibility only. */
  displayIntervalMs?: number;
  /** Deprecated: old playback buffer size. Retained for runtime compatibility only. */
  minBufferTicks?: number;
  /** Deprecated: old fast-sim loop delay. Retained for runtime compatibility only. */
  simulationDelayMs?: number;
  /** Sync game time to real wall-clock time */
  syncRealTime?: boolean;
  /** Buffer minutes ahead of real time (default 0). */
  realTimeBufferMinutes?: number;
  /** Authoritative wall-clock timestamp (ms) when real-time mode begins running. */
  displayStartTime?: number;
}

export interface SimulationStatus {
  state: SimulationState;
  currentDay: number;
  currentTime: string;
  ticksExecuted: number;
  stopReason?: StopReason;
  weather?: string;
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
  /** Wall-clock timestamp (ms) when real-time mode is scheduled to begin. */
  displayStartTime?: number;
  /** Milliseconds until the scheduled real-time start (0 = already started). */
  timeUntilStart?: number;
  displayGameDay?: number;
  displayGameTime?: string;
}
