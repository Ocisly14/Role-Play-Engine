import type { NpcStatusInfo } from "../../services/simulationApi";

interface NpcCardProps {
  npc: NpcStatusInfo;
  isSelected: boolean;
  onClick: () => void;
}

export function NpcCard({ npc, isSelected, onClick }: NpcCardProps) {
  return (
    <div
      className={`p-2 cursor-pointer border-b border-slate-200/60 hover:bg-white/40 transition-colors ${
        isSelected ? "bg-amber-50/60 border-l-2 border-l-amber-400" : ""
      }`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <span
          className={`font-medium ${npc.isAlive ? "text-slate-700" : "text-red-500 line-through"}`}
        >
          {npc.name}
        </span>
        <span className="text-xs text-slate-400">{npc.location}</span>
      </div>
      {npc.isAlive && (
        <div className="text-xs text-slate-500 mt-1">
          HP: {npc.hp}/{npc.maxHp} SAN: {npc.sanity}/{npc.maxSanity}
          {npc.currentAction && (
            <div className="text-slate-400 mt-0.5 truncate">
              {npc.currentAction}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
