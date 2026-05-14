import { useTranslation } from "react-i18next";
import type { NpcStatusInfo } from "../../services/simulationApi";

interface NpcCardProps {
  npc: NpcStatusInfo;
  isSelected: boolean;
  onClick: () => void;
}

export function NpcCard({ npc, isSelected, onClick }: NpcCardProps) {
  const { t } = useTranslation("simulation");

  return (
    <div
      className={`p-2 cursor-pointer border-b border-slate-200/60 hover:bg-white/40 transition-colors ${
        isSelected ? "bg-amber-50/60 border-l-2 border-l-amber-400" : ""
      }`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <span
          className={`font-medium ${npc.isAlive ? "text-slate-900" : "text-red-600 line-through"}`}
        >
          {npc.name}
        </span>
        <span className="text-xs text-slate-700">{npc.location}</span>
      </div>
      {npc.isAlive && (
        <div className="text-xs text-slate-800 mt-1">
          <span className="text-rose-500">
            {t("npc.hp")}: {npc.hp}/{npc.maxHp}
          </span>{" "}
          <span className="text-sky-500">
            {t("npc.san")}: {npc.san}/{npc.maxSan}
          </span>
          {npc.currentAction && (
            <div className="text-slate-900 mt-0.5 truncate">
              {t("npc.currentAction")}: {npc.currentAction}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
