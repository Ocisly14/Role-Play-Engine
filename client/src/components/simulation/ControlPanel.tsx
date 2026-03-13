import * as simApi from "../../services/simulationApi";

interface ControlPanelProps {
  sessionId: string;
  simulationState: string;
  onStateChange?: () => void;
}

const SPEEDS = [
  { label: "1x", ms: 60000 },
  { label: "2x", ms: 30000 },
  { label: "5x", ms: 12000 },
  { label: "10x", ms: 6000 },
];

export function ControlPanel({
  sessionId,
  simulationState,
  onStateChange,
}: ControlPanelProps) {
  const isRunning = simulationState === "running";
  const isPaused = simulationState === "paused";

  async function handlePlayPause() {
    if (isRunning) {
      await simApi.pauseSimulation(sessionId);
    } else if (isPaused) {
      await simApi.startSimulation(sessionId);
    }
    onStateChange?.();
  }

  async function handleStep() {
    if (isPaused) {
      await simApi.stepSimulation(sessionId);
      onStateChange?.();
    }
  }

  async function handleSpeedChange(ms: number) {
    await simApi.updateSpeed(sessionId, ms);
  }

  return (
    <div className="fixed bottom-4 left-4 z-50 bg-gray-900/95 border border-gray-700 rounded-lg px-4 py-2 flex items-center gap-3 shadow-lg">
      <button
        onClick={handlePlayPause}
        className="text-xl hover:text-amber-400 transition-colors"
        disabled={!isRunning && !isPaused}
      >
        {isRunning ? "\u23F8" : "\u25B6"}
      </button>

      <button
        onClick={handleStep}
        className="text-xl hover:text-amber-400 transition-colors disabled:opacity-30"
        disabled={!isPaused}
        title="Step one tick"
      >
        {"\u23ED"}
      </button>

      <div className="border-l border-gray-700 pl-3 flex gap-1">
        {SPEEDS.map(({ label, ms }) => (
          <button
            key={label}
            onClick={() => handleSpeedChange(ms)}
            className="text-xs px-2 py-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
