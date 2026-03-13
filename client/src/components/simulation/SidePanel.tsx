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
}: SidePanelProps) {
  const selectedNpc = selectedNpcId
    ? npcStatuses.find((n) => n.npcId === selectedNpcId)
    : null;

  return (
    <div className="w-80 bg-gray-900 border-l border-gray-700 flex flex-col h-full">
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
    </div>
  );
}
