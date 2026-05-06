import { useTranslation } from "react-i18next";

interface GameClockProps {
  gameDateTime: string;
  simulationState: string;
}

export function GameClock({ gameDateTime, simulationState }: GameClockProps) {
  const { t } = useTranslation("simulation");
  const gameDate = gameDateTime.slice(0, 10);
  const gameTime = gameDateTime.slice(11, 16);

  return (
    <div className="p-3 pr-14 border-b border-slate-200/60 flex items-center justify-between">
      <div>
        <span className="text-lg font-bold text-amber-700">
          {t("clock.date", { date: gameDate })}
        </span>
        <span className="ml-3 text-lg text-slate-600">{gameTime}</span>
      </div>
      <span
        className={`text-xs px-2 py-1 rounded-lg ${
          simulationState === "running"
            ? "bg-green-100 text-green-700 border border-green-300"
            : simulationState === "paused"
              ? "bg-yellow-100 text-yellow-700 border border-yellow-300"
              : "bg-red-100 text-red-700 border border-red-300"
        }`}
      >
        {simulationState}
      </span>
    </div>
  );
}
