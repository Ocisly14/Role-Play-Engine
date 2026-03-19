import { useState } from "react";
import type { SimulationEvent } from "../../hooks/useSimulationWebSocket";
import type { NpcStatusInfo } from "../../services/simulationApi";
import * as simApi from "../../services/simulationApi";
import { EventLog } from "./EventLog";
import { GameClock } from "./GameClock";
import { NpcCard } from "./NpcCard";
import { NpcDetail } from "./NpcDetail";

const SPEED_OPTIONS = [
  { label: "1x", ms: 60000 },
  { label: "2x", ms: 30000 },
  { label: "5x", ms: 12000 },
  { label: "10x", ms: 6000 },
];

const WEATHER_OPTIONS = [
  { value: "clear", label: "Clear" },
  { value: "rain", label: "Rain" },
  { value: "fog", label: "Fog" },
  { value: "storm", label: "Storm" },
  { value: "snow", label: "Snow" },
  { value: "extreme_heat", label: "Extreme Heat" },
  { value: "extreme_cold", label: "Extreme Cold" },
] as const;

interface SidePanelProps {
  sessionId: string;
  gameDay: number;
  timeOfDay: string;
  simulationState: string;
  npcStatuses: NpcStatusInfo[];
  selectedNpcId: string | null;
  eventLog: SimulationEvent[];
  onSelectNpc: (npcId: string | null) => void;
  onZoomToNpc: (npcId: string) => void;
}

export function SidePanel({
  sessionId,
  gameDay,
  timeOfDay,
  simulationState,
  npcStatuses,
  selectedNpcId,
  eventLog,
  onSelectNpc,
  onZoomToNpc,
}: SidePanelProps) {
  const selectedNpc = selectedNpcId
    ? npcStatuses.find((n) => n.npcId === selectedNpcId)
    : null;

  const isPreparing = simulationState === "paused" && eventLog.length === 0;

  return (
    <div className="w-80 bg-gray-900 border-l border-gray-700 flex flex-col h-full">
      <GameClock
        gameDay={gameDay}
        timeOfDay={timeOfDay}
        simulationState={simulationState}
      />

      {isPreparing ? (
        <PreparationPanel sessionId={sessionId} npcStatuses={npcStatuses} onSelectNpc={onSelectNpc} />
      ) : (
        <>
          {selectedNpc ? (
            <NpcDetail
              npc={selectedNpc}
              onBack={() => onSelectNpc(null)}
              onZoomTo={onZoomToNpc}
            />
          ) : (
            <div className="flex-1 overflow-y-auto">
              <div className="px-3 py-2 text-xs font-medium text-gray-500 border-b border-gray-800">
                NPCs ({npcStatuses.length})
              </div>
              {npcStatuses.map((npc) => (
                <NpcCard
                  key={npc.npcId}
                  npc={npc}
                  isSelected={npc.npcId === selectedNpcId}
                  onClick={() => onSelectNpc(npc.npcId)}
                />
              ))}
            </div>
          )}

          <EventLog events={eventLog} />
        </>
      )}
    </div>
  );
}

function PreparationPanel({
  sessionId,
  npcStatuses,
  onSelectNpc,
}: {
  sessionId: string;
  npcStatuses: NpcStatusInfo[];
  onSelectNpc: (npcId: string | null) => void;
}) {
  const [tickSpeed, setTickSpeed] = useState(60000);
  const [maxDays, setMaxDays] = useState(7);
  const [weather, setWeather] = useState("clear");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      // Apply config before starting
      await simApi.updateSpeed(sessionId, tickSpeed);
      await simApi.startSimulation(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
      setStarting(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      {/* Config Section */}
      <div className="p-4 space-y-4 border-b border-gray-800">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Configuration
        </h3>

        {/* Tick Speed */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">
            Tick Speed
          </label>
          <div className="flex gap-1.5">
            {SPEED_OPTIONS.map(({ label, ms }) => (
              <button
                key={label}
                type="button"
                onClick={() => setTickSpeed(ms)}
                className={`flex-1 py-1.5 rounded text-xs font-medium transition-all ${
                  tickSpeed === ms
                    ? "bg-amber-600 text-white"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Max Days */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">
            Max Days: {maxDays}
          </label>
          <input
            type="range"
            min={1}
            max={30}
            value={maxDays}
            onChange={(e) => setMaxDays(Number(e.target.value))}
            className="w-full accent-amber-600"
          />
          <div className="flex justify-between text-xs text-gray-600">
            <span>1</span>
            <span>30</span>
          </div>
        </div>

        {/* Weather */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">
            Weather
          </label>
          <select
            value={weather}
            onChange={(e) => setWeather(e.target.value)}
            className="w-full py-1.5 px-2 rounded bg-gray-800 text-gray-300 border border-gray-700 text-sm"
          >
            {WEATHER_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        {error && (
          <p className="text-red-400 text-xs">{error}</p>
        )}

        <button
          type="button"
          onClick={handleStart}
          disabled={starting}
          className="w-full py-2.5 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-50 transition-all text-sm"
        >
          {starting ? "Starting..." : "Start Simulation"}
        </button>
      </div>

      {/* NPC List */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-3 py-2 text-xs font-medium text-gray-500 border-b border-gray-800">
          NPCs ({npcStatuses.length})
        </div>
        {npcStatuses.map((npc) => (
          <NpcCard
            key={npc.npcId}
            npc={npc}
            isSelected={false}
            onClick={() => onSelectNpc(npc.npcId)}
          />
        ))}
      </div>
    </div>
  );
}
