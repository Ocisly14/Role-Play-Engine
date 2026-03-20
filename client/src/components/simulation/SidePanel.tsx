import type { SimulationEvent } from "../../hooks/useSimulationWebSocket";
import type { NpcStatusInfo } from "../../services/simulationApi";
import { EventLog } from "./EventLog";
import { GameClock } from "./GameClock";
import { NpcCard } from "./NpcCard";
import { NpcDetail } from "./NpcDetail";

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
  const selectedNpc = selectedNpcId
    ? npcStatuses.find((n) => n.npcId === selectedNpcId)
    : null;

  const isPreparing = simulationState === "paused" && eventLog.length === 0;

  const drawerClass = isOpen ? "sim-sidebar-open" : "sim-sidebar-closed";

  return (
    <div
      className={`sim-sidebar backdrop-blur-sm bg-white/50 border border-slate-200 shadow-lg rounded-lg flex flex-col ${drawerClass}`}
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

      {isPreparing ? (
        <PreparationPanel npcStatuses={npcStatuses} onSelectNpc={onSelectNpc} />
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
              <div className="px-3 py-2 text-xs font-medium text-slate-500 border-b border-slate-200/60">
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
  npcStatuses,
  onSelectNpc,
}: {
  npcStatuses: NpcStatusInfo[];
  onSelectNpc: (npcId: string | null) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-3 py-2 text-xs font-medium text-slate-500 border-b border-slate-200/60">
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
  );
}
