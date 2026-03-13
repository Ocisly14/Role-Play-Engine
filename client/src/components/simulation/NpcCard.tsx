import type { NpcStatusInfo } from "../../services/simulationApi";

interface NpcCardProps {
  npc: NpcStatusInfo;
  isSelected: boolean;
  onClick: () => void;
}

export function NpcCard({ npc, isSelected, onClick }: NpcCardProps) {
  return (
    <div
      className={`p-2 cursor-pointer border-b border-gray-800 hover:bg-gray-800/50 ${
        isSelected ? "bg-gray-800 border-l-2 border-l-amber-400" : ""
      }`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <span
          className={`font-medium ${npc.isAlive ? "text-gray-200" : "text-red-400 line-through"}`}
        >
          {npc.name}
        </span>
        <span className="text-xs text-gray-500">{npc.location}</span>
      </div>
      {npc.isAlive && (
        <div className="text-xs text-gray-400 mt-1">
          HP: {npc.hp}/{npc.maxHp} SAN: {npc.sanity}/{npc.maxSanity}
          {npc.currentAction && (
            <div className="text-gray-500 mt-0.5 truncate">
              {npc.currentAction}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
