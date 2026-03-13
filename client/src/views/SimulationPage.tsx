import type Phaser from "phaser";
import { useCallback, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { ControlPanel } from "../components/simulation/ControlPanel";
import { PhaserContainer } from "../components/simulation/PhaserContainer";
import { SidePanel } from "../components/simulation/SidePanel";
import { SubSceneTabs } from "../components/simulation/SubSceneTabs";
import { useSimulationState } from "../hooks/useSimulationState";
import { useSimulationWebSocket } from "../hooks/useSimulationWebSocket";

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

  useSimulationWebSocket({
    sessionId: sessionId ?? null,
    onEvent: handleEvent,
    onConnected: resync,
  });

  const handleGameReady = useCallback(
    (game: Phaser.Game) => {
      gameRef.current = game;

      game.events.on("npc-clicked", (npcId: string) => setSelectedNpc(npcId));
      game.events.on("building-clicked", (sceneId: string) => {
        enterBuilding(sceneId, sceneId);
      });
      game.events.on("building-exited", () => exitBuilding());
      game.events.on("zoom-level-changed", (level: number) =>
        setCurrentLevel(level as 1 | 2)
      );
    },
    [setSelectedNpc, enterBuilding, exitBuilding, setCurrentLevel]
  );

  useEffect(() => {
    if (!gameRef.current || !state.mapLayout) return;
    gameRef.current.events.emit(
      "set-junction-coords",
      state.mapLayout.junctions
    );
  }, [state.mapLayout]);

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

  const handleZoomToNpc = useCallback(
    (npcId: string) => {
      const pos = state.npcPositions[npcId];
      if (!pos || !gameRef.current || !state.mapLayout) return;

      let x = 0,
        y = 0;
      if (pos.type === "junction" && pos.junctionId) {
        const coords = state.mapLayout.junctions[pos.junctionId];
        if (coords) {
          x = coords.x;
          y = coords.y;
        }
      }
      gameRef.current.events.emit("zoom-to", { x, y, zoom: 1.0 });
      setSelectedNpc(npcId);
    },
    [state.npcPositions, state.mapLayout, setSelectedNpc]
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
            onSelect={switchSubScene}
            onBack={exitBuilding}
          />
        )}
      </div>

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

      {sessionId && (
        <ControlPanel
          sessionId={sessionId}
          simulationState={state.simulationState}
        />
      )}
    </div>
  );
}
