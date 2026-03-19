import type { NpcStatusInfo } from "../../services/simulationApi";

interface NpcDetailProps {
  npc: NpcStatusInfo;
  onBack: () => void;
  onZoomTo: (npcId: string) => void;
}

export function NpcDetail({ npc, onBack, onZoomTo }: NpcDetailProps) {
  return (
    <div className="p-3">
      <button
        onClick={onBack}
        className="text-xs text-slate-500 hover:text-slate-700 mb-2"
      >
        &larr; Back to list
      </button>
      <h3 className="text-lg font-bold text-amber-700 mb-2">{npc.name}</h3>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between text-slate-600">
          <span>HP</span>
          <span>
            {npc.hp} / {npc.maxHp}
          </span>
        </div>
        <div className="flex justify-between text-slate-600">
          <span>SAN</span>
          <span>
            {npc.sanity} / {npc.maxSanity}
          </span>
        </div>
        <div className="text-slate-500">
          <span className="text-slate-400">Location:</span> {npc.location}
        </div>
        {npc.currentAction && (
          <div className="text-slate-500">
            <span className="text-slate-400">Action:</span> {npc.currentAction}
          </div>
        )}
        {npc.inventory.length > 0 && (
          <div>
            <span className="text-slate-400 text-xs">Inventory:</span>
            <ul className="text-xs text-slate-500 mt-1">
              {npc.inventory.map((item) => (
                <li key={item.id}>{item.name}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <button
        onClick={() => onZoomTo(npc.npcId)}
        className="mt-3 text-xs text-amber-600 hover:text-amber-700"
      >
        Zoom to location &rarr;
      </button>
    </div>
  );
}
