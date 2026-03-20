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
  gameDay: number;
  timeOfDay: string;
  simulationState: SimulationStatus["state"];
  moduleName: string | null;
  mapsPrefix: string | null;
  eventLog: SimulationEvent[];
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
    gameDay: 1,
    timeOfDay: "08:00",
    simulationState: "paused",
    moduleName: null,
    mapsPrefix: null,
    eventLog: [],
    isLoading: true,
    error: null,
  });

  useEffect(() => {
    if (!sessionId) return;

    async function loadInitialState() {
      try {
        const [topology, positions, statuses, status] = await Promise.all([
          simApi.fetchTopology(sessionId),
          simApi.fetchPositions(sessionId),
          simApi.fetchNpcStatuses(sessionId),
          simApi.fetchStatus(sessionId),
        ]);
        setState((prev) => ({
          ...prev,
          topology,
          npcPositions: positions,
          npcStatuses: statuses,
          gameDay: status.currentDay,
          timeOfDay: status.currentTime,
          simulationState: status.state,
          moduleName: status.moduleName ?? null,
          mapsPrefix: status.mapsPrefix ?? null,
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
      newState.gameDay = event.gameDay;
      newState.timeOfDay = event.gameTime;
      newState.eventLog = [event, ...prev.eventLog].slice(0, MAX_EVENT_LOG);

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
            npc.npcId === event.actorNpcId
              ? { ...npc, isAlive: false, hp: 0 }
              : npc
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
