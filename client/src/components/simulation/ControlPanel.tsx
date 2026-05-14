import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as simApi from "../../services/simulationApi";
import type { SimulationStatus } from "../../services/simulationApi";

interface ControlPanelProps {
  sessionId: string;
  simulationState: SimulationStatus["state"];
  onStateChange?: () => Promise<void> | void;
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
  const [isPausing, setIsPausing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isRunning = simulationState === "running";
  const isPaused = simulationState === "paused";
  const isTerminal =
    simulationState === "stopped" || simulationState === "completed";
  const controlsDisabled = isPausing || (!isRunning && !isPaused);

  useEffect(() => {
    setIsPausing(false);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    if (simulationState === "paused" || isTerminal) {
      setIsPausing(false);
      setError(null);
    }
  }, [isTerminal, simulationState]);

  async function handlePlayPause() {
    setError(null);

    if (isRunning) {
      setIsPausing(true);
      try {
        await simApi.pauseSimulation(sessionId);
      } catch (err) {
        setIsPausing(false);
        setError(err instanceof Error ? err.message : t("control.pauseFailed"));
        return;
      }

      void onStateChange?.();
    } else if (isPaused) {
      await simApi.startSimulation(sessionId);
      await onStateChange?.();
    }
  }

  async function handleStep() {
    if (isPaused) {
      await simApi.stepSimulation(sessionId);
      await onStateChange?.();
    }
  }

  async function handleSpeedChange(ms: number) {
    await simApi.updateSpeed(sessionId, ms);
  }

  return (
    <div
      className="fixed bottom-4 left-4 z-10 backdrop-blur-xl bg-white/50 border border-white/30 rounded-2xl px-4 py-2 flex items-center gap-3 shadow-lg"
      data-weather-obstacle="control-panel"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={handlePlayPause}
        className="text-xl text-slate-600 hover:text-amber-600 transition-colors disabled:opacity-30"
        disabled={controlsDisabled}
        title={isPausing ? t("control.pausing") : undefined}
      >
        {isRunning ? "\u23F8" : "\u25B6"}
      </button>

      {isPausing && (
        <span
          className="text-xs font-medium text-amber-700 whitespace-nowrap"
          role="status"
          aria-live="polite"
        >
          {t("control.pausing")}
        </span>
      )}

      <button
        type="button"
        onClick={handleStep}
        className="text-xl text-slate-600 hover:text-amber-600 transition-colors disabled:opacity-30"
        disabled={!isPaused || isPausing}
        title={t("control.stepOneTick")}
      >
        {"\u23ED"}
      </button>

      <div className="border-l border-slate-200/60 pl-3 flex gap-1">
        {SPEEDS.map(({ label, ms }) => (
          <button
            key={label}
            type="button"
            onClick={() => handleSpeedChange(ms)}
            className="text-xs px-2 py-1 rounded-lg hover:bg-white/50 text-slate-500 hover:text-slate-700 disabled:opacity-30"
            disabled={isPausing}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <span className="text-red-400 text-xs whitespace-nowrap">{error}</span>
      )}
    </div>
  );
}
