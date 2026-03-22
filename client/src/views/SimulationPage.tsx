import type Phaser from "phaser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { SidebarToggleButton } from "../components/layout/SidebarToggleButton";
import { ConfigPanel } from "../components/simulation/ConfigPanel";
import { ControlPanel } from "../components/simulation/ControlPanel";
import { PhaserContainer } from "../components/simulation/PhaserContainer";
import { SidePanel } from "../components/simulation/SidePanel";
import { SubSceneTabs } from "../components/simulation/SubSceneTabs";
import { WeatherOverlay } from "../components/simulation/WeatherOverlay";
import { useMobileSidebar } from "../hooks/useMobileSidebar";
import { useSimulationState } from "../hooks/useSimulationState";
import { useSimulationWebSocket } from "../hooks/useSimulationWebSocket";
import { api } from "../services/api";

const NPC_DOT_COLORS = [
  "#ff6b6b", "#4ecdc4", "#ffe66d", "#a29bfe",
  "#fd79a8", "#00b894", "#e17055", "#6c5ce7",
];

const MAPS_BASE = "/api/maps";
const AUTH_KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
const UUID_SESSION_ID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface SceneConfig {
  background: string;
  npcAreas: Array<{ x: number; y: number; width: number; height: number }>;
}

interface ScenarioConfig {
  x: number;
  y: number;
  thumbnail: string;
}

interface SimulationPageProps {
  mode?: "owner" | "public";
}

function normalizeSessionId(rawSessionId: string | undefined): string | null {
  const trimmed = rawSessionId?.trim();
  if (!trimmed) return null;
  const matchedUuid = trimmed.match(UUID_SESSION_ID_PATTERN)?.[0];
  return matchedUuid ?? trimmed;
}

export default function SimulationPage({
  mode = "owner",
}: SimulationPageProps) {
  const { sessionId: routeSessionId } = useParams<{ sessionId: string }>();
  const { t } = useTranslation("simulation");
  const navigate = useNavigate();
  const isPublicMode = mode === "public";
  const sessionId = useMemo(
    () => normalizeSessionId(routeSessionId),
    [routeSessionId]
  );
  const { isSidebarOpen, toggleSidebar, closeSidebar } =
    useMobileSidebar();
  const [previewWeather, setPreviewWeather] = useState<string | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const mapsPrefixRef = useRef<string | null>(null);

  // Scene image popup state
  const [sceneConfigs, setSceneConfigs] = useState<Record<string, SceneConfig> | null>(null);
  const [scenarioConfigs, setScenarioConfigs] = useState<Record<string, ScenarioConfig> | null>(null);
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);

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

  // Wrap handleEvent to also forward action events to Phaser as bubbles
  const handleEventWithBubble = useCallback(
    (event: Parameters<typeof handleEvent>[0]) => {
      handleEvent(event);
      if (
        (event.type === "action_executed" || event.type === "action_failed") &&
        event.data.action &&
        gameRef.current
      ) {
        gameRef.current.events.emit("npc-action-update", {
          npcId: event.actorNpcId,
          action: event.data.action as string,
        });
      }
    },
    [handleEvent]
  );

  useSimulationWebSocket({
    sessionId: sessionId ?? null,
    onEvent: handleEventWithBubble,
    onConnected: resync,
  });

  useEffect(() => {
    if (isPublicMode || !sessionId) return;

    let cancelled = false;
    const keepAuthAlive = async () => {
      try {
        await api.get("/auth/me");
      } catch {
        if (cancelled) return;
      }
    };

    void keepAuthAlive();
    const intervalId = window.setInterval(
      keepAuthAlive,
      AUTH_KEEPALIVE_INTERVAL_MS
    );

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isPublicMode, sessionId]);

  useEffect(() => {
    if (!routeSessionId || !sessionId || routeSessionId === sessionId) return;
    const targetPath = isPublicMode
      ? `/simulation/public/${sessionId}`
      : `/simulation/${sessionId}`;
    navigate(targetPath, { replace: true });
  }, [isPublicMode, navigate, routeSessionId, sessionId]);

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
        currentAction: n.currentAction,
      })),
      scenes: state.topology.scenes ?? [],
      junctions: state.topology.junctions ?? [],
      transportEdges: state.topology.transportEdges ?? [],
      displayIntervalMs: state.displayIntervalMs,
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
        currentAction: npc.currentAction,
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

  const eventLocationOptions = useMemo(() => {
    if (!state.topology) return [];

    const labelById = new Map<string, string>();
    for (const outline of state.topology.scenarioOutlines ?? []) {
      labelById.set(outline.id, outline.name);
    }

    const parentIds = new Set<string>();
    for (const scene of state.topology.scenes ?? []) {
      parentIds.add(scene.parentLocationId);
    }
    for (const road of state.topology.roads ?? []) {
      parentIds.add(road.parentLocationId);
    }
    for (const junction of state.topology.junctions ?? []) {
      parentIds.add(junction.parentLocationId);
    }

    return Array.from(parentIds)
      .filter((id) => id && id !== "global")
      .map((id) => ({
        id,
        name: id === "OUTDOOR" ? "Outdoor" : (labelById.get(id) ?? id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [state.topology]);

  const eventLocationParentById = useMemo(() => {
    if (!state.topology) return {};

    const parentById: Record<string, string> = {};
    for (const scene of state.topology.scenes ?? []) {
      parentById[scene.id] = scene.parentLocationId;
    }
    for (const road of state.topology.roads ?? []) {
      parentById[road.id] = road.parentLocationId;
    }
    for (const junction of state.topology.junctions ?? []) {
      parentById[junction.id] = junction.parentLocationId;
    }
    for (const outline of state.topology.scenarioOutlines ?? []) {
      parentById[outline.id] = outline.id;
    }
    parentById.OUTDOOR = "OUTDOOR";

    return parentById;
  }, [state.topology]);

  // Real-time sync countdown
  const [countdownNow, setCountdownNow] = useState(Date.now());
  useEffect(() => {
    if (!state.displayStartTime) return;
    const id = setInterval(() => setCountdownNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state.displayStartTime]);
  const countdown = useMemo(() => {
    if (!state.displayStartTime) return null;
    const remaining = Math.max(0, state.displayStartTime - countdownNow);
    if (remaining <= 0) return null;
    const mins = Math.floor(remaining / 60_000);
    const secs = Math.floor((remaining % 60_000) / 1000);
    return { mins, secs, remaining };
  }, [state.displayStartTime, countdownNow]);

  const showConfigPanel =
    !isPublicMode &&
    Boolean(sessionId) &&
    state.simulationState === "paused" &&
    state.displayTick === 0 &&
    state.eventLog.length === 0;

  const showControlPanel =
    !isPublicMode && Boolean(sessionId) && !showConfigPanel && !countdown;


  useEffect(() => {
    if (!shareFeedback) return;
    const timeoutId = window.setTimeout(() => setShareFeedback(null), 2500);
    return () => window.clearTimeout(timeoutId);
  }, [shareFeedback]);

  const handleShare = useCallback(async () => {
    if (!sessionId) return;

    const publicUrl = new URL(
      `/simulation/public/${sessionId}`,
      window.location.origin
    ).toString();

    try {
      if (navigator.share) {
        await navigator.share({
          url: publicUrl,
        });
        setShareFeedback("Public link shared");
        return;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
    }

    try {
      await navigator.clipboard.writeText(publicUrl);
      setShareFeedback("Public link copied");
    } catch {
      setShareFeedback("Copy failed");
    }
  }, [sessionId]);

  return (
    <div className={`sim-page${state.focusedBuildingId ? " sim-page--has-popup" : ""}`}>
      {/* Full-viewport Phaser canvas — the interactive game area */}
      <div className="sim-canvas-layer">
        <PhaserContainer
          onGameReady={handleGameReady}
          sessionKey={sessionId ?? ""}
        />
      </div>

      {/* Weather animation overlay */}
      <WeatherOverlay weather={previewWeather ?? state.weather} />

      {/* Loading / Error overlays */}
      {state.isLoading && (
        <div className="sim-overlay">
          <span className="text-white/80 text-lg">{t("page.loadingSimulation")}</span>
        </div>
      )}
      {state.error && (
        <div className="sim-overlay">
          <span className="text-red-300 text-lg">{t("page.error", { message: state.error })}</span>
        </div>
      )}

      {/* Floating header */}
      <div className="sim-header backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg" onPointerDown={(e) => e.stopPropagation()}>
        {isPublicMode ? (
          <div className="sim-header-spacer sim-header-spacer--back" aria-hidden="true" />
        ) : (
          <button
            onClick={() => navigate("/simulation/select")}
            className="back-button backdrop-blur-md bg-white/50 border border-slate-200 shadow-md rounded-xl hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 transition-all"
            style={{ padding: "8px 12px" }}
            aria-label={t("page.backToSelection")}
          >
            ←
          </button>
        )}

        <div className="sim-header-center">
          <h1>{t("page.title")}</h1>
          <span className="sim-header-separator">·</span>
          <span className="sim-header-info font-bold text-amber-700">{t("clock.day", { day: state.gameDay })}</span>
          <span className="sim-header-info text-slate-600">{state.timeOfDay}</span>
          <span className="sim-header-separator">·</span>
          <span className="sim-header-info text-slate-500">{t(`weather.${state.weather}`)}</span>
        </div>

        {!isSidebarOpen && (
          <SidebarToggleButton onClick={toggleSidebar} />
        )}
        {isSidebarOpen && (
          <div className="sim-header-spacer sim-header-spacer--menu" aria-hidden="true" />
        )}
      </div>

      {/* Click map to close popup — only covers canvas, below all UI */}
      {state.focusedBuildingId && (
        <div className="sim-popup-backdrop" onClick={exitBuilding} onPointerDown={(e) => e.stopPropagation()} />
      )}

      {/* Scene image popup */}
      {state.focusedBuildingId && (
        <div className={`sim-scene-popup ${isSidebarOpen ? "sim-scene-popup-shifted" : ""}`} onPointerDown={(e) => e.stopPropagation()}>
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
            <div className="relative flex-1 overflow-hidden flex items-center justify-center">
              {sceneImageUrl ? (
                <img
                  src={sceneImageUrl}
                  alt={focusedSceneName ?? focusedBuildingName ?? ""}
                  className="w-full max-h-full object-cover"
                />
              ) : (
                  <div className="text-slate-400 text-sm p-6">{t("page.noImage")}</div>
                )}
              {buildingNpcs.length > 0 && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3">
                  <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/30 via-black/10 to-transparent" />
                  <div className="relative flex items-end gap-3 flex-wrap">
                    {buildingNpcs.map((npc) => (
                      <div
                        key={npc.npcId}
                        className="pointer-events-auto flex flex-col items-start gap-1 cursor-pointer hover:opacity-80 transition-opacity max-w-[240px]"
                        onClick={() => setSelectedNpc(npc.npcId)}
                      >
                        {npc.currentAction && (
                          <div className="rounded-2xl border border-white/70 bg-white/30 px-3 py-2 text-[11px] leading-4 text-slate-900 shadow-lg backdrop-blur-xl">
                            {npc.currentAction}
                          </div>
                        )}
                        <div className="flex items-center gap-1.5 rounded-full border border-white/70 bg-white/30 px-2.5 py-1 text-xs text-slate-800 shadow-md backdrop-blur-xl">
                          <span
                            className="inline-block w-3 h-3 rounded-full border border-white/60 shrink-0"
                            style={{ backgroundColor: npc.color }}
                          />
                          <span className="drop-shadow-[0_1px_1px_rgba(255,255,255,0.35)]">
                            {npc.name}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Config panel (pre-start) */}
      {showConfigPanel && sessionId && (
        <ConfigPanel sessionId={sessionId} onStarted={resync} onWeatherChange={setPreviewWeather} />
      )}

      {/* Real-time sync countdown */}
      {countdown && state.simulationState === "running" && (
        <div className="fixed bottom-4 left-4 z-10 backdrop-blur-xl bg-white/50 border border-white/30 rounded-2xl px-4 py-2 shadow-lg flex items-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
          <span className="text-xs text-slate-500">{t("page.preparing")}</span>
          <span className="text-sm font-medium text-amber-600">
            {countdown.mins}m {String(countdown.secs).padStart(2, "0")}s
          </span>
        </div>
      )}

      {/* Simulation control panel */}
      {showControlPanel && sessionId && (
        <ControlPanel
          sessionId={sessionId}
          simulationState={state.simulationState}
          onStateChange={resync}
        />
      )}

      {!isPublicMode && sessionId && (
        <button
          type="button"
          onClick={() => void handleShare()}
          className="fixed bottom-4 right-4 z-10 backdrop-blur-xl bg-white/50 border border-white/30 rounded-2xl px-4 py-2 shadow-lg flex items-center gap-2 text-sm font-medium text-slate-700 hover:bg-white/70 transition-all"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span>{t("page.copyPublicLink")}</span>
          {shareFeedback && (
            <span className="text-xs text-amber-700">{shareFeedback}</span>
          )}
        </button>
      )}

      {/* Sidebar */}
      {isSidebarOpen && (
        <div className="sim-sidebar-backdrop" onClick={closeSidebar} onPointerDown={(e) => e.stopPropagation()} />
      )}

      <SidePanel
        sessionId={sessionId ?? null}
        gameDay={state.gameDay}
        timeOfDay={state.timeOfDay}
        simulationState={state.simulationState}
        npcStatuses={state.npcStatuses}
        displayTick={state.displayTick}
        locationOptions={eventLocationOptions}
        locationParentById={eventLocationParentById}
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
