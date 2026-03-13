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
  | "npc_moved";

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
] as const;
