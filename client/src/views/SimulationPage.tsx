import type Phaser from "phaser";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { SidebarToggleButton } from "../components/layout/SidebarToggleButton";
import { ConfigPanel } from "../components/simulation/ConfigPanel";
import { ControlPanel } from "../components/simulation/ControlPanel";
import { PhaserContainer } from "../components/simulation/PhaserContainer";
import { SidePanel } from "../components/simulation/SidePanel";
import { SubSceneTabs } from "../components/simulation/SubSceneTabs";
import { useMobileSidebar } from "../hooks/useMobileSidebar";
import { useSimulationState } from "../hooks/useSimulationState";
import { useSimulationWebSocket } from "../hooks/useSimulationWebSocket";

const NPC_DOT_COLORS = [
  "#ff6b6b", "#4ecdc4", "#ffe66d", "#a29bfe",
  "#fd79a8", "#00b894", "#e17055", "#6c5ce7",
];

const MAPS_BASE = "/api/maps";

interface SceneConfig {
  background: string;
  npcAreas: Array<{ x: number; y: number; width: number; height: number }>;
}

interface ScenarioConfig {
  x: number;
  y: number;
  thumbnail: string;
}

export default function SimulationPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { isSidebarOpen, toggleSidebar, closeSidebar } =
    useMobileSidebar();
  const gameRef = useRef<Phaser.Game | null>(null);
  const mapsPrefixRef = useRef<string | null>(null);

  // Scene image popup state
  const [sceneConfigs, setSceneConfigs] = useState<Record<string, SceneConfig> | null>(null);
  const [scenarioConfigs, setScenarioConfigs] = useState<Record<string, ScenarioConfig> | null>(null);

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

  // Fetch map_config to get scene image URLs
  useEffect(() => {
    mapsPrefixRef.current = state.mapsPrefix;
    if (!state.mapsPrefix) return;
    fetch(`${MAPS_BASE}/${state.mapsPrefix}/map_config.json`)
      .then((res) => res.json())
      .then((config: { scenes?: Record<string, SceneConfig>; scenarios?: Record<string, ScenarioConfig> }) => {
        if (config.scenes) setSceneConfigs(config.scenes);
        if (config.scenarios) setScenarioConfigs(config.scenarios);
      })
      .catch(() => {});
  }, [state.mapsPrefix]);

  // Enter a building scene — just update React state, no Phaser scene switch
  const handleEnterScene = useCallback(
    (scenarioId: string, subSceneId: string) => {
      enterBuilding(scenarioId, subSceneId);
    },
    [enterBuilding]
  );

  const handleGameReady = useCallback(
    (game: Phaser.Game) => {
      gameRef.current = game;

      game.events.on("npc-clicked", (npcId: string) => setSelectedNpc(npcId));
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
    [setSelectedNpc, setCurrentLevel, handleEnterScene]
  );

  // Disable Phaser input while popup is open
  useEffect(() => {
    if (!gameRef.current) return;
    gameRef.current.events.emit("set-input-enabled", !state.focusedBuildingId);
  }, [state.focusedBuildingId]);

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
    (subSceneId: string | null) => {
      switchSubScene(subSceneId);
    },
    [switchSubScene]
  );

  // ESC key handler
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (state.focusedBuildingId) {
          exitBuilding();
        } else if (isSidebarOpen) {
          closeSidebar();
        }
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isSidebarOpen, closeSidebar, state.focusedBuildingId, exitBuilding]);

  // NPCs currently inside the focused building (or sub-scene)
  const buildingNpcs = (() => {
    if (!state.focusedBuildingId || !state.topology) return [];
    const subSceneIds = new Set(
      state.topology.scenes
        .filter((s) => s.parentLocationId === state.focusedBuildingId)
        .map((s) => s.id)
    );
    // Filter: if a sub-scene is focused, only show NPCs in that sub-scene
    const matchScene = (sceneId: string) =>
      state.focusedSubSceneId
        ? sceneId === state.focusedSubSceneId
        : subSceneIds.has(sceneId);

    return state.npcStatuses
      .filter((npc) => {
        const pos = state.npcPositions[npc.npcId];
        return pos?.type === "scene" && matchScene(pos.sceneId);
      })
      .map((npc, i) => ({
        npcId: npc.npcId,
        name: npc.name,
        color: NPC_DOT_COLORS[i % NPC_DOT_COLORS.length],
      }));
  })();

  const buildingSubScenes = state.focusedBuildingId
    ? (state.topology?.scenes
        .filter((s) => s.parentLocationId === state.focusedBuildingId)
        .map((s) => ({ id: s.id, name: s.name })) ?? [])
    : [];

  // Resolve scene image URL — sub-scene background or scenario thumbnail
  const sceneImageUrl = (() => {
    if (!state.mapsPrefix) return null;
    if (state.focusedSubSceneId && sceneConfigs) {
      const bg = sceneConfigs[state.focusedSubSceneId]?.background;
      return bg ? `${MAPS_BASE}/${state.mapsPrefix}/${bg}` : null;
    }
    if (state.focusedBuildingId && scenarioConfigs) {
      const thumb = scenarioConfigs[state.focusedBuildingId]?.thumbnail;
      return thumb ? `${MAPS_BASE}/${state.mapsPrefix}/${thumb}` : null;
    }
    return null;
  })();

  // Resolve scene name
  const focusedSceneName = state.focusedSubSceneId
    ? state.topology?.scenes.find((s) => s.id === state.focusedSubSceneId)?.name ?? null
    : null;

  // Resolve building (scenario) name
  const focusedBuildingName = state.focusedBuildingId
    ? state.topology?.scenarioOutlines?.find((o) => o.id === state.focusedBuildingId)?.name ?? null
    : null;

  return (
    <div className={`sim-page${state.focusedBuildingId ? " sim-page--has-popup" : ""}`}>
      {/* Full-viewport Phaser canvas — the interactive game area */}
      <div className="sim-canvas-layer">
        <PhaserContainer
          onGameReady={handleGameReady}
          sessionKey={sessionId ?? ""}
        />
      </div>

      {/* Loading / Error overlays */}
      {state.isLoading && (
        <div className="sim-overlay">
          <span className="text-white/80 text-lg">Loading simulation...</span>
        </div>
      )}
      {state.error && (
        <div className="sim-overlay">
          <span className="text-red-300 text-lg">Error: {state.error}</span>
        </div>
      )}

      {/* Floating header */}
      <div className="sim-header backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg">
        <button
          onClick={() => navigate("/simulation/select")}
          className="back-button backdrop-blur-md bg-white/50 border border-slate-200 shadow-md rounded-xl hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 transition-all"
          style={{ padding: "8px 12px" }}
          aria-label="Back to selection"
        >
          ←
        </button>

        <h1>Town Simulation</h1>

        {!isSidebarOpen && (
          <SidebarToggleButton onClick={toggleSidebar} />
        )}
        {isSidebarOpen && <div style={{ width: "52px" }} aria-hidden="true" />}
      </div>

      {/* Click map to close popup — only covers canvas, below all UI */}
      {state.focusedBuildingId && (
        <div className="sim-popup-backdrop" onClick={exitBuilding} />
      )}

      {/* Scene image popup */}
      {state.focusedBuildingId && (
        <div className={`sim-scene-popup ${isSidebarOpen ? "sim-scene-popup-shifted" : ""}`}>
          <div className="sim-scene-popup-content backdrop-blur-sm bg-white/50 border border-slate-200 shadow-lg rounded-lg overflow-hidden">
            {/* Header — scenario name + sub-scene tabs */}
            <div className="flex items-center gap-1.5 p-2 border-b border-slate-200/60 flex-wrap">
              <span
                onClick={() => switchSubScene(null)}
                className={`text-xs px-3 py-1.5 rounded-lg cursor-pointer transition-all font-bold ${
                  state.focusedSubSceneId === null
                    ? "bg-amber-600 text-white"
                    : "text-slate-500 hover:bg-white/50 hover:text-slate-700"
                }`}
              >
                {focusedBuildingName ?? state.focusedBuildingId}
              </span>
              {buildingSubScenes.length > 0 && (
                <>
                  <div className="w-px h-5 bg-slate-200/60" />
                  {buildingSubScenes.map((scene) => (
                    <button
                      key={scene.id}
                      onClick={() => handleSwitchSubScene(scene.id)}
                      className={`text-xs px-3 py-1.5 rounded-lg transition-all ${
                        scene.id === state.focusedSubSceneId
                          ? "bg-amber-600 text-white"
                          : "bg-white/50 text-slate-600 border border-slate-200 hover:bg-white/70"
                      }`}
                    >
                      {scene.name}
                    </button>
                  ))}
                </>
              )}
            </div>

            {/* Scene image */}
            <div className="flex-1 overflow-hidden flex items-center justify-center">
              {sceneImageUrl ? (
                <img
                  src={sceneImageUrl}
                  alt={focusedSceneName ?? focusedBuildingName ?? ""}
                  className="w-full max-h-full object-cover"
                />
              ) : (
                <div className="text-slate-400 text-sm p-6">No image available</div>
              )}
            </div>

            {/* NPC dots */}
            {buildingNpcs.length > 0 && (
              <div className="flex items-center gap-3 px-3 py-2 border-t border-slate-200/60 flex-wrap">
                {buildingNpcs.map((npc) => (
                  <div
                    key={npc.npcId}
                    className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => setSelectedNpc(npc.npcId)}
                  >
                    <span
                      className="inline-block w-3 h-3 rounded-full border border-white/60 shrink-0"
                      style={{ backgroundColor: npc.color }}
                    />
                    <span className="text-xs text-slate-600">{npc.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Config panel (pre-start) */}
      {sessionId && state.eventLog.length === 0 && state.simulationState === "paused" && (
        <ConfigPanel sessionId={sessionId} />
      )}

      {/* Simulation control panel */}
      {sessionId && state.eventLog.length > 0 && (
        <ControlPanel
          sessionId={sessionId}
          simulationState={state.simulationState}
        />
      )}

      {/* Sidebar */}
      {isSidebarOpen && (
        <div className="sim-sidebar-backdrop" onClick={closeSidebar} />
      )}

      <SidePanel
        gameDay={state.gameDay}
        timeOfDay={state.timeOfDay}
        simulationState={state.simulationState}
        npcStatuses={state.npcStatuses}
        selectedNpcId={state.selectedNpcId}
        eventLog={state.eventLog}
        onSelectNpc={setSelectedNpc}
        onZoomToNpc={handleZoomToNpc}
        isMobile={false}
        isOpen={isSidebarOpen}
        onClose={closeSidebar}
      />
    </div>
  );
}
