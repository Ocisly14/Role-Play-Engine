import type Phaser from "phaser";
import { useCallback, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { SidebarToggleButton } from "../components/layout/SidebarToggleButton";
import { ControlPanel } from "../components/simulation/ControlPanel";
import { PhaserContainer } from "../components/simulation/PhaserContainer";
import { SidePanel } from "../components/simulation/SidePanel";
import { SubSceneTabs } from "../components/simulation/SubSceneTabs";
import { useMobileSidebar } from "../hooks/useMobileSidebar";
import { useSimulationState } from "../hooks/useSimulationState";
import { useSimulationWebSocket } from "../hooks/useSimulationWebSocket";

const MAPS_BASE = "/api/maps";

export default function SimulationPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { isMobile, isSidebarOpen, toggleSidebar, closeSidebar } =
    useMobileSidebar();
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
        gameRef.current.scene.getScene("TownScene").scene.switch("InteriorScene");
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

      // Pre-launch the interior scene once so it can receive global events
      // before the first switch from the town map.
      game.scene.getScene("TownScene").scene.launch("InteriorScene");
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

  // ESC key handler for closing drawer
  useEffect(() => {
    if (!isMobile) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isSidebarOpen) {
        closeSidebar();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isMobile, isSidebarOpen, closeSidebar]);

  if (state.isLoading) {
    return (
      <div className="game-container" style={{ maxWidth: "none" }}>
        <div className="flex items-center justify-center flex-1 text-slate-500">
          Loading simulation...
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="game-container" style={{ maxWidth: "none" }}>
        <div className="flex items-center justify-center flex-1 text-red-500">
          Error: {state.error}
        </div>
      </div>
    );
  }

  const buildingSubScenes = state.focusedBuildingId
    ? (state.topology?.scenes
        .filter((s) => s.parentLocationId === state.focusedBuildingId)
        .map((s) => ({ id: s.id, name: s.name })) ?? [])
    : [];

  return (
    <div className="game-container" style={{ maxWidth: "none" }}>
      <div className="game-header backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg">
        {isMobile ? (
          <button
            onClick={() => navigate("/simulation/select")}
            className="back-button backdrop-blur-md bg-white/50 border border-slate-200 shadow-md rounded-xl hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 transition-all"
            style={{ padding: "8px 12px" }}
            aria-label="Back to selection"
          >
            ←
          </button>
        ) : (
          <div style={{ width: "52px" }} aria-hidden="true" />
        )}

        <h1>NPC Simulation</h1>

        {isMobile && !isSidebarOpen && (
          <SidebarToggleButton onClick={toggleSidebar} />
        )}
        {!isMobile && (
          <button
            onClick={() => navigate("/simulation/select")}
            className="back-button backdrop-blur-md bg-white/50 border border-slate-200 shadow-md rounded-xl hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 transition-all"
            style={{ padding: "8px 12px" }}
            aria-label="Back to selection"
          >
            ←
          </button>
        )}
      </div>

      <div className="game-main-layout">
        <div className="game-chat-container backdrop-blur-sm border border-slate-200 shadow-md rounded-lg relative overflow-hidden">
          <PhaserContainer
            onGameReady={handleGameReady}
            sessionKey={sessionId ?? ""}
          />

          {state.currentLevel === 3 && (
            <SubSceneTabs
              subScenes={buildingSubScenes}
              activeSubSceneId={state.focusedSubSceneId}
              onSelect={handleSwitchSubScene}
              onBack={exitBuilding}
            />
          )}

          {sessionId && state.eventLog.length > 0 && (
            <ControlPanel
              sessionId={sessionId}
              simulationState={state.simulationState}
            />
          )}
        </div>

        {isMobile && isSidebarOpen && (
          <div className="sidebar-backdrop" onClick={closeSidebar} />
        )}

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
          isMobile={isMobile}
          isOpen={isSidebarOpen}
          onClose={closeSidebar}
        />
      </div>
    </div>
  );
}
