import { useState } from "react";
import type { SimulationEvent } from "../../hooks/useSimulationWebSocket";
import type { NpcStatusInfo } from "../../services/simulationApi";
import { EventLog } from "./EventLog";
import { GameClock } from "./GameClock";
import { NpcCard } from "./NpcCard";
import { NpcDetail } from "./NpcDetail";

type SimTabType = "npcs" | "events";

interface SidePanelProps {
  gameDay: number;
  timeOfDay: string;
  simulationState: string;
  npcStatuses: NpcStatusInfo[];
  selectedNpcId: string | null;
  eventLog: SimulationEvent[];
  onSelectNpc: (npcId: string | null) => void;
  onZoomToNpc: (npcId: string) => void;
  isMobile: boolean;
  isOpen: boolean;
  onClose: () => void;
}

export function SidePanel({
  gameDay,
  timeOfDay,
  simulationState,
  npcStatuses,
  selectedNpcId,
  eventLog,
  onSelectNpc,
  onZoomToNpc,
  isMobile,
  isOpen,
  onClose,
}: SidePanelProps) {
  const [activeTab, setActiveTab] = useState<SimTabType>("npcs");

  const selectedNpc = selectedNpcId
    ? npcStatuses.find((n) => n.npcId === selectedNpcId)
    : null;

  const drawerClass = isOpen ? "sim-sidebar-open" : "sim-sidebar-closed";

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
            <EventLog events={eventLog} />
          )}
        </>
      )}
    </div>
  );
}

