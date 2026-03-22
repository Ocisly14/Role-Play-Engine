import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("simulation");
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
    <div className="fixed bottom-4 left-4 z-10 backdrop-blur-xl bg-white/50 border border-white/30 rounded-2xl px-4 py-2 flex items-center gap-3 shadow-lg" onPointerDown={(e) => e.stopPropagation()}>
      <button
        onClick={handlePlayPause}
        className="text-xl text-slate-600 hover:text-amber-600 transition-colors"
        disabled={!isRunning && !isPaused}
      >
        {isRunning ? "\u23F8" : "\u25B6"}
      </button>

      <button
        onClick={handleStep}
        className="text-xl text-slate-600 hover:text-amber-600 transition-colors disabled:opacity-30"
        disabled={!isPaused}
        title={t("control.stepOneTick")}
      >
        {"\u23ED"}
      </button>

      <div className="border-l border-slate-200/60 pl-3 flex gap-1">
        {SPEEDS.map(({ label, ms }) => (
          <button
            key={label}
            onClick={() => handleSpeedChange(ms)}
            className="text-xs px-2 py-1 rounded-lg hover:bg-white/50 text-slate-500 hover:text-slate-700"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
