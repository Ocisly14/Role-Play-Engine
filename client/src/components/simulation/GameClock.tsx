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
    <div className="p-3 border-b border-gray-700 flex items-center justify-between">
      <div>
        <span className="text-lg font-bold text-amber-200">Day {gameDay}</span>
        <span className="ml-3 text-lg text-gray-300">{timeOfDay}</span>
      </div>
      <span
        className={`text-xs px-2 py-1 rounded ${
          simulationState === "running"
            ? "bg-green-800 text-green-200"
            : simulationState === "paused"
              ? "bg-yellow-800 text-yellow-200"
              : "bg-red-800 text-red-200"
        }`}
      >
        {simulationState}
      </span>
    </div>
  );
}
