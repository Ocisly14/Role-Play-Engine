import type Phaser from "phaser";
import { useCallback, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { ControlPanel } from "../components/simulation/ControlPanel";
import { PhaserContainer } from "../components/simulation/PhaserContainer";
import { SidePanel } from "../components/simulation/SidePanel";
import { SubSceneTabs } from "../components/simulation/SubSceneTabs";
import { useSimulationState } from "../hooks/useSimulationState";
import { useSimulationWebSocket } from "../hooks/useSimulationWebSocket";

// In dev mode, load map images directly from the backend to bypass Vite proxy
// (Vite proxy corrupts large binary responses like 8MB+ JPEGs)
const MAPS_BASE = import.meta.env.DEV
  ? `${window.location.protocol}//${window.location.hostname}:3000/api/maps`
  : "/api/maps";

export default function SimulationPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const gameRef = useRef<Phaser.Game | null>(null);
  const mapsPrefixRef = useRef<string | null>(null);

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

  useSimulationWebSocket({
    sessionId: sessionId ?? null,
    onEvent: handleEvent,
    onConnected: resync,
  });

  useEffect(() => {
    mapsPrefixRef.current = state.mapsPrefix;
  }, [state.mapsPrefix]);

  // Enter a building scene from side panel or town node click
  const handleEnterScene = useCallback(
    (scenarioId: string, subSceneId: string) => {
      enterBuilding(scenarioId, subSceneId);
      const mapsPrefix = mapsPrefixRef.current;
      if (gameRef.current && mapsPrefix) {
        gameRef.current.events.emit("load-interior", {
          sceneId: subSceneId,
          configUrl: `${MAPS_BASE}/${mapsPrefix}/map_config.json`,
          baseUrl: `${MAPS_BASE}/${mapsPrefix}/`,
        });
      }
    },
    [enterBuilding]
  );

  const handleGameReady = useCallback(
    (game: Phaser.Game) => {
      gameRef.current = game;

      game.events.on("npc-clicked", (npcId: string) => setSelectedNpc(npcId));
      game.events.on("building-exited", () => exitBuilding());
      game.events.on("zoom-level-changed", (level: number) =>
        setCurrentLevel(level as 1 | 2)
      );
      game.events.on(
        "building-clicked",
        (data: { scenarioId: string; entrySceneId?: string }) => {
          if (data.entrySceneId) {
            handleEnterScene(data.scenarioId, data.entrySceneId);
          }
        }
      );
    },
    [setSelectedNpc, exitBuilding, setCurrentLevel, handleEnterScene]
  );

  // Forward NPC positions to interior scene
  useEffect(() => {
    if (!gameRef.current) return;
    for (const [npcId, position] of Object.entries(state.npcPositions)) {
      if (position.type !== "scene") continue;
      const npc = state.npcStatuses.find((n) => n.npcId === npcId);
      gameRef.current.events.emit("npc-position-update-interior", {
        npcId,
        name: npc?.name ?? npcId,
        sceneId: position.sceneId,
      });
    }
  }, [state.npcPositions, state.npcStatuses]);

  // Forward NPC positions to town scene
  useEffect(() => {
    if (!gameRef.current || !state.topology) return;
    gameRef.current.events.emit("npc-position-update-town", {
      positions: state.npcPositions,
      npcStatuses: state.npcStatuses.map((n) => ({
        npcId: n.npcId,
        name: n.name,
      })),
      scenes: state.topology.scenes ?? [],
      junctions: state.topology.junctions ?? [],
      transportEdges: state.topology.transportEdges ?? [],
    });
  }, [state.npcPositions, state.npcStatuses, state.topology]);

  // Load town map with topology data
  useEffect(() => {
    if (!gameRef.current || !state.mapsPrefix || !state.topology) return;
    gameRef.current.events.emit("load-town-map", {
      configUrl: `${MAPS_BASE}/${state.mapsPrefix}/map_config.json`,
      baseUrl: `${MAPS_BASE}/${state.mapsPrefix}/`,
      scenarioOutlines: state.topology.scenarioOutlines ?? [],
      transportEdges: state.topology.transportEdges ?? [],
      scenes: state.topology.scenes ?? [],
      junctions: state.topology.junctions ?? [],
    });
  }, [state.mapsPrefix, state.topology]);

  const handleZoomToNpc = useCallback(
    (npcId: string) => {
      setSelectedNpc(npcId);
      // If NPC is in a scene, navigate to that scene
      const pos = state.npcPositions[npcId];
      if (pos?.type === "scene") {
        const scene = state.topology?.scenes.find((s) => s.id === pos.sceneId);
        if (scene) {
          handleEnterScene(scene.parentLocationId, pos.sceneId);
        }
      }
    },
    [state.npcPositions, state.topology, setSelectedNpc, handleEnterScene]
  );

  const handleSwitchSubScene = useCallback(
    (subSceneId: string) => {
      switchSubScene(subSceneId);
      const mapsPrefix = mapsPrefixRef.current;
      if (gameRef.current && mapsPrefix) {
        gameRef.current.events.emit("switch-sub-scene", {
          subSceneId,
          configUrl: `${MAPS_BASE}/${mapsPrefix}/map_config.json`,
          baseUrl: `${MAPS_BASE}/${mapsPrefix}/`,
        });
      }
    },
    [switchSubScene]
  );

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

  const buildingSubScenes = state.focusedBuildingId
    ? (state.topology?.scenes
        .filter((s) => s.parentLocationId === state.focusedBuildingId)
        .map((s) => ({ id: s.id, name: s.name })) ?? [])
    : [];

  return (
    <div className="flex h-screen bg-gray-950">
      <div className="flex-1 relative">
        <PhaserContainer
          onGameReady={handleGameReady}
          moduleName={sessionId ?? ""}
        />

        {state.currentLevel === 3 && (
          <SubSceneTabs
            subScenes={buildingSubScenes}
            activeSubSceneId={state.focusedSubSceneId}
            onSelect={handleSwitchSubScene}
            onBack={exitBuilding}
          />
        )}
      </div>

      <SidePanel
        sessionId={sessionId ?? ""}
        gameDay={state.gameDay}
        timeOfDay={state.timeOfDay}
        simulationState={state.simulationState}
        npcStatuses={state.npcStatuses}
        selectedNpcId={state.selectedNpcId}
        eventLog={state.eventLog}
        onSelectNpc={setSelectedNpc}
        onZoomToNpc={handleZoomToNpc}
      />

      {sessionId && state.eventLog.length > 0 && (
        <ControlPanel
          sessionId={sessionId}
          simulationState={state.simulationState}
        />
      )}
    </div>
  );
}
