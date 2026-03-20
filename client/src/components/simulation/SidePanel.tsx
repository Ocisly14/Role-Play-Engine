import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SimulationEvent } from "../../hooks/useSimulationWebSocket";
import type {
  NpcStatusInfo,
  SimulationEventFilters,
} from "../../services/simulationApi";
import * as simApi from "../../services/simulationApi";
import { EventLog } from "./EventLog";
import { GameClock } from "./GameClock";
import { NpcCard } from "./NpcCard";
import { NpcDetail } from "./NpcDetail";

type SimTabType = "npcs" | "events";

interface EventFilterDraft {
  startDay: string;
  startTime: string;
  endDay: string;
  endTime: string;
  npcId: string;
  parentLocationId: string;
}

interface EventLocationOption {
  id: string;
  name: string;
}

const EMPTY_EVENT_FILTER_DRAFT: EventFilterDraft = {
  startDay: "",
  startTime: "",
  endDay: "",
  endTime: "",
  npcId: "",
  parentLocationId: "",
};

const HIDDEN_EVENT_TYPES = new Set([
  "npc_position_snapshot",
  "playback_buffering",
  "playback_resumed",
]);

function timeToMinutes(hhmm: string): number | null {
  const [hoursPart, minutesPart] = hhmm.split(":");
  const hours = Number.parseInt(hoursPart ?? "", 10);
  const minutes = Number.parseInt(minutesPart ?? "", 10);
  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }
  return hours * 60 + minutes;
}

function buildTimeKey(gameDay: number, gameTime: string): number | null {
  const minutes = timeToMinutes(gameTime);
  if (minutes === null) return null;
  return gameDay * 1440 + minutes;
}

function buildEventFilters(
  draft: EventFilterDraft
): SimulationEventFilters {
  const next: SimulationEventFilters = {};

  if (draft.npcId) next.npcId = draft.npcId;
  if (draft.parentLocationId) next.parentLocationId = draft.parentLocationId;

  const parsedStartDay = Number.parseInt(draft.startDay, 10);
  if (!Number.isNaN(parsedStartDay)) {
    next.startDay = parsedStartDay;
    if (draft.startTime) next.startTime = draft.startTime;
  }

  const parsedEndDay = Number.parseInt(draft.endDay, 10);
  if (!Number.isNaN(parsedEndDay)) {
    next.endDay = parsedEndDay;
    if (draft.endTime) next.endTime = draft.endTime;
  }

  return next;
}

function matchesFilters(
  event: SimulationEvent,
  filters: SimulationEventFilters,
  locationParentById: Record<string, string>
): boolean {
  if (HIDDEN_EVENT_TYPES.has(event.type)) {
    return false;
  }

  if (filters.npcId && event.actorNpcId !== filters.npcId) {
    return false;
  }

  const startKey =
    typeof filters.startDay === "number"
      ? buildTimeKey(filters.startDay, filters.startTime ?? "00:00")
      : null;
  const endKey =
    typeof filters.endDay === "number"
      ? buildTimeKey(filters.endDay, filters.endTime ?? "23:59")
      : null;
  const eventKey = buildTimeKey(event.gameDay, event.gameTime);

  if ((startKey !== null || endKey !== null) && eventKey === null) {
    return false;
  }
  if (startKey !== null && eventKey !== null && eventKey < startKey) {
    return false;
  }
  if (endKey !== null && eventKey !== null && eventKey > endKey) {
    return false;
  }

  if (filters.parentLocationId) {
    const parentLocationId =
      locationParentById[event.location] ??
      (event.location === "OUTDOOR" ? "OUTDOOR" : event.location);
    if (parentLocationId !== filters.parentLocationId) {
      return false;
    }
  }

  return true;
}

interface SidePanelProps {
  sessionId: string | null;
  gameDay: number;
  timeOfDay: string;
  simulationState: string;
  npcStatuses: NpcStatusInfo[];
  displayTick: number;
  locationOptions: EventLocationOption[];
  locationParentById: Record<string, string>;
  selectedNpcId: string | null;
  eventLog: SimulationEvent[];
  onSelectNpc: (npcId: string | null) => void;
  onZoomToNpc: (npcId: string) => void;
  isMobile: boolean;
  isOpen: boolean;
  onClose: () => void;
}

export function SidePanel({
  sessionId,
  gameDay,
  timeOfDay,
  simulationState,
  npcStatuses,
  displayTick,
  locationOptions,
  locationParentById,
  selectedNpcId,
  eventLog,
  onSelectNpc,
  onZoomToNpc,
  isMobile,
  isOpen,
  onClose,
}: SidePanelProps) {
  const [activeTab, setActiveTab] = useState<SimTabType>("npcs");
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState<EventFilterDraft>(
    EMPTY_EVENT_FILTER_DRAFT
  );
  const [activeFilters, setActiveFilters] = useState<SimulationEventFilters>({});
  const [displayedEvents, setDisplayedEvents] = useState<SimulationEvent[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [isEventsLoading, setIsEventsLoading] = useState(false);
  const hasLoadedEventsRef = useRef(false);

  const selectedNpc = selectedNpcId
    ? npcStatuses.find((n) => n.npcId === selectedNpcId)
    : null;

  const drawerClass = isOpen ? "sim-sidebar-open" : "sim-sidebar-closed";
  const hasActiveFilters = useMemo(
    () => Object.keys(activeFilters).length > 0,
    [activeFilters]
  );

  const loadEvents = useCallback(
    async (filters: SimulationEventFilters) => {
      if (!sessionId) return;

      setIsEventsLoading(true);
      setEventsError(null);

      try {
        const events = await simApi.fetchEvents(sessionId, {
          ...filters,
          maxTick: displayTick,
        });
        hasLoadedEventsRef.current = true;
        const historyEvents = [...events]
          .filter((event) => !HIDDEN_EVENT_TYPES.has(event.type))
          .reverse();
        const seenIds = new Set(historyEvents.map((event) => event.id));
        const incoming = eventLog.filter(
          (event) =>
            !seenIds.has(event.id) &&
            matchesFilters(event, filters, locationParentById)
        );
        setDisplayedEvents(
          incoming.length > 0 ? [...incoming, ...historyEvents] : historyEvents
        );
      } catch (error) {
        setEventsError(
          error instanceof Error ? error.message : "Failed to load events"
        );
      } finally {
        setIsEventsLoading(false);
      }
    },
    [displayTick, eventLog, locationParentById, sessionId]
  );

  useEffect(() => {
    hasLoadedEventsRef.current = false;
    setDisplayedEvents([]);
    setEventsError(null);
    setIsEventsLoading(false);
    setIsFilterPanelOpen(false);
    setFilterDraft(EMPTY_EVENT_FILTER_DRAFT);
    setActiveFilters({});
  }, [sessionId]);

  useEffect(() => {
    if (activeTab !== "events" || !sessionId || hasLoadedEventsRef.current) {
      return;
    }
    void loadEvents(activeFilters);
  }, [activeFilters, activeTab, loadEvents, sessionId]);

  useEffect(() => {
    if (activeTab !== "events" || !hasLoadedEventsRef.current || eventLog.length === 0) {
      return;
    }

    setDisplayedEvents((prev) => {
      const seenIds = new Set(prev.map((event) => event.id));
      const incoming = eventLog.filter(
        (event) =>
          !seenIds.has(event.id) &&
          matchesFilters(event, activeFilters, locationParentById)
      );

      return incoming.length > 0 ? [...incoming, ...prev] : prev;
    });
  }, [activeFilters, activeTab, eventLog, locationParentById]);

  const handleDraftChange = useCallback(
    (field: keyof EventFilterDraft, value: string) => {
      setFilterDraft((prev) => ({
        ...prev,
        [field]: value,
      }));
    },
    []
  );

  const handleApplyFilters = useCallback(async () => {
    const nextFilters = buildEventFilters(filterDraft);
    setActiveFilters(nextFilters);
    await loadEvents(nextFilters);
  }, [filterDraft, loadEvents]);

  const handleClearFilters = useCallback(async () => {
    setFilterDraft(EMPTY_EVENT_FILTER_DRAFT);
    setActiveFilters({});
    await loadEvents({});
  }, [loadEvents]);

  return (
    <div
      className={`sim-sidebar backdrop-blur-sm bg-white/50 border border-slate-200 shadow-lg rounded-lg flex flex-col ${drawerClass}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        className="sim-sidebar-close"
        onClick={onClose}
        aria-label="Close sidebar"
      >
        ×
      </button>

      <GameClock
        gameDay={gameDay}
        timeOfDay={timeOfDay}
        simulationState={simulationState}
      />

      {selectedNpc ? (
        <NpcDetail
          npc={selectedNpc}
          onBack={() => onSelectNpc(null)}
          onZoomTo={onZoomToNpc}
        />
      ) : (
        <>
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all ${activeTab === "npcs" ? "active" : ""}`}
              onClick={() => setActiveTab("npcs")}
            >
              NPCs
            </button>
            <button
              className={`sidebar-tab backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all ${activeTab === "events" ? "active" : ""}`}
              onClick={() => setActiveTab("events")}
            >
              Events
            </button>
          </div>

          {activeTab === "npcs" ? (
            <div className="flex-1 overflow-y-auto">
              {npcStatuses.map((npc) => (
                <NpcCard
                  key={npc.npcId}
                  npc={npc}
                  isSelected={npc.npcId === selectedNpcId}
                  onClick={() => onSelectNpc(npc.npcId)}
                />
              ))}
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="px-2 pt-2 pb-1 border-b border-slate-200/60 bg-white/30">
                <button
                  type="button"
                  onClick={() => setIsFilterPanelOpen((prev) => !prev)}
                  className="w-full flex items-center justify-between rounded-md border border-slate-200 bg-white/60 px-3 py-2 text-xs text-slate-600 transition-colors hover:bg-white/80"
                >
                  <span className="font-medium">Filters</span>
                  <span className="flex items-center gap-2">
                    {hasActiveFilters && (
                      <span className="text-[11px] text-amber-600">
                        Filters active
                      </span>
                    )}
                    <span>{isFilterPanelOpen ? "Hide" : "Show"}</span>
                  </span>
                </button>

                {isFilterPanelOpen && (
                  <>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <label className="flex flex-col gap-1 text-[11px] text-slate-500">
                        <span>Start Day</span>
                        <input
                          type="number"
                          min="1"
                          value={filterDraft.startDay}
                          onChange={(event) =>
                            handleDraftChange("startDay", event.target.value)
                          }
                          className="rounded-md border border-slate-200 bg-white/70 px-2 py-1 text-xs text-slate-700 outline-none focus:border-amber-400"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-[11px] text-slate-500">
                        <span>Start Time</span>
                        <input
                          type="time"
                          value={filterDraft.startTime}
                          onChange={(event) =>
                            handleDraftChange("startTime", event.target.value)
                          }
                          className="rounded-md border border-slate-200 bg-white/70 px-2 py-1 text-xs text-slate-700 outline-none focus:border-amber-400"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-[11px] text-slate-500">
                        <span>End Day</span>
                        <input
                          type="number"
                          min="1"
                          value={filterDraft.endDay}
                          onChange={(event) =>
                            handleDraftChange("endDay", event.target.value)
                          }
                          className="rounded-md border border-slate-200 bg-white/70 px-2 py-1 text-xs text-slate-700 outline-none focus:border-amber-400"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-[11px] text-slate-500">
                        <span>End Time</span>
                        <input
                          type="time"
                          value={filterDraft.endTime}
                          onChange={(event) =>
                            handleDraftChange("endTime", event.target.value)
                          }
                          className="rounded-md border border-slate-200 bg-white/70 px-2 py-1 text-xs text-slate-700 outline-none focus:border-amber-400"
                        />
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <label className="flex flex-col gap-1 text-[11px] text-slate-500">
                        <span>Character</span>
                        <select
                          value={filterDraft.npcId}
                          onChange={(event) =>
                            handleDraftChange("npcId", event.target.value)
                          }
                          className="rounded-md border border-slate-200 bg-white/70 px-2 py-1 text-xs text-slate-700 outline-none focus:border-amber-400"
                        >
                          <option value="">All characters</option>
                          {npcStatuses.map((npc) => (
                            <option key={npc.npcId} value={npc.npcId}>
                              {npc.name}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="flex flex-col gap-1 text-[11px] text-slate-500">
                        <span>Location</span>
                        <select
                          value={filterDraft.parentLocationId}
                          onChange={(event) =>
                            handleDraftChange("parentLocationId", event.target.value)
                          }
                          className="rounded-md border border-slate-200 bg-white/70 px-2 py-1 text-xs text-slate-700 outline-none focus:border-amber-400"
                        >
                          <option value="">All locations</option>
                          {locationOptions.map((location) => (
                            <option key={location.id} value={location.id}>
                              {location.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleApplyFilters()}
                        disabled={!sessionId || isEventsLoading}
                        className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleClearFilters()}
                        disabled={!sessionId || isEventsLoading}
                        className="rounded-md border border-slate-200 bg-white/70 px-3 py-1.5 text-xs text-slate-600 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:text-slate-300"
                      >
                        Clear
                      </button>
                      {isEventsLoading && (
                        <span className="text-[11px] text-slate-400">Loading…</span>
                      )}
                    </div>
                  </>
                )}

                {eventsError && (
                  <div className="mt-2 rounded-md border border-red-200 bg-red-50/70 px-2 py-1.5 text-[11px] text-red-500">
                    {eventsError}
                  </div>
                )}
              </div>

              <EventLog events={displayedEvents} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
