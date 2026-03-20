interface GameClockProps {
  gameDay: number;
  timeOfDay: string;
  simulationState: string;
}

export function GameClock({
  gameDay,
  timeOfDay,
  simulationState,
}: GameClockProps) {
  return (
    <div className="p-3 pr-14 border-b border-slate-200/60 flex items-center justify-between">
      <div>
        <span className="text-lg font-bold text-amber-700">Day {gameDay}</span>
        <span className="ml-3 text-lg text-slate-600">{timeOfDay}</span>
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
