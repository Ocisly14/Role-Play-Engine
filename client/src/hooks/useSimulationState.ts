import { useCallback, useEffect, useState } from "react";
import type {
  CharacterPosition,
  NpcStatusInfo,
  SimulationStatus,
  TopologyResponse,
} from "../services/simulationApi.js";
import * as simApi from "../services/simulationApi.js";
import type { SimulationEvent } from "./useSimulationWebSocket.js";

export interface SimulationViewState {
  topology: TopologyResponse | null;
  npcPositions: Record<string, CharacterPosition>;
  npcStatuses: NpcStatusInfo[];
  currentLevel: 1 | 2 | 3;
  focusedBuildingId: string | null;
  focusedSubSceneId: string | null;
  selectedNpcId: string | null;
  gameDateTime: string;
  weather: string;
  simulationState: SimulationStatus["state"];
  moduleName: string | null;
  mapsPrefix: string | null;
  eventLog: SimulationEvent[];
  displayTick: number;
  displayIntervalMs: number;
  /** Wall-clock timestamp (ms) when playback starts (real-time sync mode) */
  displayStartTime: number | null;
  isLoading: boolean;
  error: string | null;
}

const MAX_EVENT_LOG = 200;

export function useSimulationState(sessionId: string | null) {
  const [state, setState] = useState<SimulationViewState>({
    topology: null,
    npcPositions: {},
    npcStatuses: [],
    currentLevel: 1,
    focusedBuildingId: null,
    focusedSubSceneId: null,
    selectedNpcId: null,
    gameDateTime: "1900-01-01T08:00:00",
    weather: "clear",
    simulationState: "paused",
    moduleName: null,
    mapsPrefix: null,
    eventLog: [],
    displayTick: 0,
    displayIntervalMs: 60_000,
    displayStartTime: null,
    isLoading: true,
    error: null,
  });

  useEffect(() => {
    if (!sessionId) return;

    async function loadInitialState() {
      try {
        const [topology, positions, statuses, status, playback] =
          await Promise.all([
            simApi.fetchTopology(sessionId),
            simApi.fetchPositions(sessionId),
            simApi.fetchNpcStatuses(sessionId),
            simApi.fetchStatus(sessionId),
            simApi.fetchPlaybackStatus(sessionId).catch(() => null),
          ]);
        const displayStartTime =
          status.state === "running" &&
          playback?.displayStartTime &&
          playback.timeUntilStart &&
          playback.timeUntilStart > 0
            ? playback.displayStartTime
            : null;
        setState((prev) => ({
          ...prev,
          topology,
          npcPositions: positions,
          npcStatuses: statuses,
          gameDateTime: status.currentDateTime,
          weather: status.weather ?? "clear",
          simulationState: status.state,
          moduleName: status.moduleName ?? null,
          mapsPrefix: status.mapsPrefix ?? null,
          displayTick: status.ticksExecuted,
          displayStartTime,
          isLoading: false,
        }));
      } catch (err) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error:
            err instanceof Error ? err.message : "Failed to load simulation",
        }));
      }
    }
    loadInitialState();
  }, [sessionId]);

  const handleEvent = useCallback((event: SimulationEvent) => {
    setState((prev) => {
      const newState = { ...prev };

      // Update game time from all events (except transient meta events)
      if (event.gameDateTime) newState.gameDateTime = event.gameDateTime;
      if (typeof event.tick === "number") {
        newState.displayTick = Math.max(prev.displayTick, event.tick);
      }

      // Don't add high-frequency or meta events to the event log
      const skipLogTypes = new Set([
        "npc_position_snapshot",
        "playback_buffering",
        "playback_resumed",
      ]);
      if (
        !skipLogTypes.has(event.type) &&
        !prev.eventLog.some((existingEvent) => existingEvent.id === event.id)
      ) {
        newState.eventLog = [event, ...prev.eventLog].slice(0, MAX_EVENT_LOG);
      }

      switch (event.type) {
        case "npc_position_snapshot": {
          const data = event.data as {
            positions: Record<string, CharacterPosition>;
            currentActions?: Record<string, string | null>;
            displayIntervalMs?: number;
            weather?: string;
          };
          newState.npcPositions = data.positions;
          if (data.currentActions) {
            newState.npcStatuses = prev.npcStatuses.map((npc) => ({
              ...npc,
              currentAction: data.currentActions?.[npc.npcId] ?? null,
            }));
          }
          if (data.displayIntervalMs) {
            newState.displayIntervalMs = data.displayIntervalMs;
          }
          if (data.weather) {
            newState.weather = data.weather;
          }
          break;
        }
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
          const data = event.data as {
            state: SimulationStatus["state"];
            displayStartTime?: number;
            timeUntilStart?: number;
            ticksExecuted?: number;
          };
          newState.simulationState = data.state;
          if (typeof data.ticksExecuted === "number") {
            newState.displayTick = Math.max(
              newState.displayTick,
              data.ticksExecuted
            );
          }
          newState.displayStartTime =
            data.state === "running" &&
            data.displayStartTime &&
            data.timeUntilStart &&
            data.timeUntilStart > 0
              ? data.displayStartTime
              : null;
          break;
        }
        case "npc_death": {
          newState.npcStatuses = prev.npcStatuses.map((npc) =>
            npc.npcId === event.actorNpcId
              ? { ...npc, isAlive: false, hp: 0, currentAction: null }
              : npc
          );
          break;
        }
        case "action_executed":
        case "action_failed":
        case "action_interrupted": {
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

  const setSelectedNpc = useCallback((npcId: string | null) => {
    setState((prev) => ({ ...prev, selectedNpcId: npcId }));
  }, []);

  const setCurrentLevel = useCallback((level: 1 | 2 | 3) => {
    setState((prev) => ({ ...prev, currentLevel: level }));
  }, []);

  const enterBuilding = useCallback(
    (buildingId: string, _subSceneId?: string) => {
      setState((prev) => ({
        ...prev,
        currentLevel: 3,
        focusedBuildingId: buildingId,
        focusedSubSceneId: null,
      }));
    },
    []
  );

  const exitBuilding = useCallback(() => {
    setState((prev) => ({
      ...prev,
      currentLevel: 2,
      focusedBuildingId: null,
      focusedSubSceneId: null,
    }));
  }, []);

  const switchSubScene = useCallback((subSceneId: string | null) => {
    setState((prev) => ({ ...prev, focusedSubSceneId: subSceneId }));
  }, []);

  const resync = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [positions, statuses, status, playback] = await Promise.all([
        simApi.fetchPositions(sessionId),
        simApi.fetchNpcStatuses(sessionId),
        simApi.fetchStatus(sessionId),
        simApi.fetchPlaybackStatus(sessionId).catch(() => null),
      ]);
      const displayStartTime =
        status.state === "running" &&
        playback?.displayStartTime &&
        playback.timeUntilStart &&
        playback.timeUntilStart > 0
          ? playback.displayStartTime
          : null;
      setState((prev) => ({
        ...prev,
        npcPositions: positions,
        npcStatuses: statuses,
        gameDateTime: status.currentDateTime,
        weather: status.weather ?? "clear",
        simulationState: status.state,
        displayTick: status.ticksExecuted,
        displayStartTime,
      }));
    } catch {
      /* ignore re-sync errors */
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
