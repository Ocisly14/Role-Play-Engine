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
        className="text-xs text-gray-400 hover:text-gray-200 mb-2"
      >
        &larr; Back to list
      </button>
      <h3 className="text-lg font-bold text-amber-200 mb-2">{npc.name}</h3>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between text-gray-300">
          <span>HP</span>
          <span>
            {npc.hp} / {npc.maxHp}
          </span>
        </div>
        <div className="flex justify-between text-gray-300">
          <span>SAN</span>
          <span>
            {npc.sanity} / {npc.maxSanity}
          </span>
        </div>
        <div className="text-gray-400">
          <span className="text-gray-500">Location:</span> {npc.location}
        </div>
        {npc.currentAction && (
          <div className="text-gray-400">
            <span className="text-gray-500">Action:</span> {npc.currentAction}
          </div>
        )}
        {npc.inventory.length > 0 && (
          <div>
            <span className="text-gray-500 text-xs">Inventory:</span>
            <ul className="text-xs text-gray-400 mt-1">
              {npc.inventory.map((item) => (
                <li key={item.id}>{item.name}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <button
        onClick={() => onZoomTo(npc.npcId)}
        className="mt-3 text-xs text-amber-400 hover:text-amber-200"
      >
        Zoom to location &rarr;
      </button>
    </div>
  );
}
