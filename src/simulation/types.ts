// src/simulation/types.ts

import type { PlayerState } from "../player/playerState.js";

export type SimulationEventType =
  | "action_executed"
  | "action_failed"
  | "action_interrupted"
  | "scene_updated"
  | "day_transition"
  | "feature_triggered"
  | "npc_death"
  | "simulation_state_changed"
  | "npc_moved"
  /** One character's rendered paragraph for one tick. Persisted so a resumed
   *  session can hand the renderer and the character back the day they lived;
   *  not broadcast — it is per-character, and 28 paragraphs a tick would
   *  swamp the socket. */
  | "npc_perceived"
  /** One character's own condensed account of their earlier paragraphs,
   *  written when their stream passed the prompt budget. `data.coversThrough`
   *  is the `gameDateTime` of the last paragraph it speaks for. Additive: the
   *  paragraphs it covers stay in the log, and only the view handed to the
   *  prompts is shortened. Not broadcast, for the same reason. */
  | "npc_perception_compacted"
  | "npc_position_snapshot"
  | "playback_buffering"
  | "playback_resumed"
  /** The player's own rendered paragraph, broadcast the moment it is rendered
   *  (there is one player, so it cannot swamp the socket). Never persisted:
   *  the same paragraph is already stored as the player's `npc_perceived`
   *  row. */
  | "player_perceived"
  /** The world is waiting on the player: `data.pending` is the decision or
   *  the question they must answer. */
  | "player_pending"
  /** The player's state changed (queue, mode, pending, friend log, map). */
  | "player_state"
  /** The player reached a place or walked a road for the first time. */
  | "player_map_updated"
  /** The player's character went to sleep: the moment to take an autosave. */
  | "player_autosave_requested"
  /** The player's character died. The world is paused. */
  | "player_died";

export interface SimulationEvent {
  id: string;
  sessionId: string;
  tick: number;
  gameDateTime: string;
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
  /** Sync game time to real wall-clock time */
  syncRealTime?: boolean;
  /** Buffer minutes ahead of real time (default 0). */
  realTimeBufferMinutes?: number;
  /** Authoritative wall-clock timestamp (ms) when real-time mode begins running. */
  displayStartTime?: number;
}

export interface SimulationStatus {
  state: SimulationState;
  currentDateTime: string;
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
  "action_interrupted",
  "scene_updated",
  "day_transition",
  "feature_triggered",
  "npc_death",
  "simulation_state_changed",
  "npc_moved",
  "npc_position_snapshot",
  "playback_buffering",
  "playback_resumed",
  "player_perceived",
  "player_pending",
  "player_state",
  "player_map_updated",
  "player_autosave_requested",
  "player_died",
] as const;

/** Why the runner is paused. `player`: it is waiting on the player's answer,
 *  and resumes by itself once they give it. `manual`: someone pressed pause
 *  (or the session was loaded paused) — answering the player does not resume
 *  it. `dead`: the player's character died. */
export type PauseReason = "player" | "manual" | "dead";

export interface PlayerView {
  state: PlayerState;
  alive: boolean;
  currentAction: {
    description: string;
    progressMinutes: number;
    resolvedDurationTicks?: number;
  } | null;
  /** The player's whole stream, oldest first — every paragraph, compaction
   *  notwithstanding (compaction shortens only the prompt's view). */
  perceptions: Array<{
    gameDateTime: string;
    location: string;
    narrative: string;
  }>;
  paused: boolean;
}

export interface PlaybackStatus {
  buffered: number;
  displayTick: number;
  simulationTick: number;
  isPlaying: boolean;
  /** Wall-clock timestamp (ms) when real-time mode is scheduled to begin. */
  displayStartTime?: number;
  /** Milliseconds until the scheduled real-time start (0 = already started). */
  timeUntilStart?: number;
  displayGameDateTime?: string;
}
