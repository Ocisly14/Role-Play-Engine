import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as simApi from "../../services/simulationApi";
import type { SimulationWeather } from "../../services/simulationApi";

const SPEED_OPTIONS = [
  { label: "1x", ms: 60000 },
  { label: "2x", ms: 30000 },
  { label: "5x", ms: 12000 },
  { label: "10x", ms: 6000 },
];

const WEATHER_KEYS = [
  "clear",
  "rain",
  "fog",
  "storm",
  "snow",
  "extreme_heat",
  "extreme_cold",
] as const;

interface ConfigPanelProps {
  sessionId: string;
  onStarted?: () => Promise<void> | void;
  onWeatherChange?: (weather: string) => void;
}

export function ConfigPanel({
  sessionId,
  onStarted,
  onWeatherChange,
}: ConfigPanelProps) {
  const { t } = useTranslation("simulation");
  const [expanded, setExpanded] = useState(true);
  const [tickSpeed, setTickSpeed] = useState(60000);
  const [maxDays, setMaxDays] = useState(7);
  const [weather, setWeather] = useState<SimulationWeather>("clear");
  const [syncRealTime, setSyncRealTime] = useState(false);
  const [bufferMinutes, setBufferMinutes] = useState(0);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentSpeedLabel =
    SPEED_OPTIONS.find((o) => o.ms === tickSpeed)?.label ?? "1x";

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      const effectiveSpeed = syncRealTime ? 60000 : tickSpeed;
      await simApi.updateSpeed(sessionId, effectiveSpeed);
      await simApi.updateMaxDays(sessionId, Math.max(1, Math.floor(maxDays)));
      await simApi.updateWeather(sessionId, weather);
      if (syncRealTime) {
        await simApi.updateSyncRealTime(sessionId, true, bufferMinutes);
      }
      await simApi.startSimulation(sessionId);
      await onStarted?.();
      setStarting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
      setStarting(false);
    }
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        onPointerDown={(e) => e.stopPropagation()}
        className="fixed bottom-4 left-4 z-10 backdrop-blur-xl bg-white/50 border border-white/30 rounded-2xl px-3 py-2 flex items-center gap-1.5 shadow-lg hover:bg-white/70 transition-all"
        data-weather-obstacle="config-toggle"
      >
        <span className="text-sm">&#9881;</span>
        <span className="text-xs font-medium text-slate-600">
          {currentSpeedLabel}
        </span>
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-4 left-4 right-auto z-10 backdrop-blur-xl bg-white/50 border border-white/30 rounded-2xl px-3 py-2 flex items-center gap-2 shadow-lg max-md:left-3 max-md:right-3"
      data-weather-obstacle="config-panel"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="text-sm text-slate-500 hover:text-slate-700 transition-colors shrink-0"
        title={t("control.collapse")}
      >
        &#9881;
      </button>

      <label className="flex items-center gap-1.5 shrink-0 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={syncRealTime}
          onChange={(e) => setSyncRealTime(e.target.checked)}
          className="accent-amber-600 w-3.5 h-3.5"
        />
        <span className="text-xs text-slate-600 whitespace-nowrap">
          {t("control.realTime")}
        </span>
      </label>

      {syncRealTime && (
        <div className="flex items-center gap-1 shrink-0">
          <label className="text-xs text-slate-500 whitespace-nowrap">
            {t("control.buffer")}
          </label>
          <input
            type="number"
            min={0}
            max={10}
            value={bufferMinutes}
            onChange={(e) =>
              setBufferMinutes(
                Math.max(0, Math.min(10, Number(e.target.value)))
              )
            }
            className="w-10 py-1 px-1 rounded-lg bg-white/50 text-slate-700 border border-slate-200 text-xs text-center"
          />
          <span className="text-xs text-slate-400">
            {t("control.bufferUnit")}
          </span>
        </div>
      )}

      <div className="w-px h-5 bg-slate-200/60 shrink-0" />

      {!syncRealTime && (
        <div className="flex gap-1">
          {SPEED_OPTIONS.map(({ label, ms }) => (
            <button
              key={label}
              type="button"
              onClick={() => setTickSpeed(ms)}
              className={`px-2 py-1 rounded-lg text-xs font-medium transition-all ${
                tickSpeed === ms
                  ? "bg-amber-600 text-white"
                  : "text-slate-500 hover:bg-white/50 hover:text-slate-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {!syncRealTime && <div className="w-px h-5 bg-slate-200/60 shrink-0" />}

      <div className="flex items-center gap-1.5 shrink-0">
        <label className="text-xs text-slate-500 whitespace-nowrap">
          {t("control.days")}
        </label>
        <input
          type="number"
          min={1}
          max={30}
          value={maxDays}
          onChange={(e) => setMaxDays(Number(e.target.value))}
          className="w-12 py-1 px-1.5 rounded-lg bg-white/50 text-slate-700 border border-slate-200 text-xs text-center"
        />
      </div>

      <div className="w-px h-5 bg-slate-200/60 shrink-0" />

      <select
        value={weather}
        onChange={(e) => {
          setWeather(e.target.value as SimulationWeather);
          onWeatherChange?.(e.target.value);
        }}
        className="py-1 px-1.5 rounded-lg bg-white/50 text-slate-700 border border-slate-200 text-xs"
      >
        {WEATHER_KEYS.map((key) => (
          <option key={key} value={key}>
            {t(`weather.${key}`)}
          </option>
        ))}
      </select>

      <div className="w-px h-5 bg-slate-200/60 shrink-0" />

      <button
        type="button"
        onClick={handleStart}
        disabled={starting}
        className="px-4 py-1.5 rounded-xl bg-amber-600 text-white text-xs font-medium hover:bg-amber-700 disabled:opacity-50 transition-all shadow-md whitespace-nowrap shrink-0"
      >
        {starting ? t("control.starting") : t("control.start")}
      </button>

      {error && (
        <span className="text-red-400 text-xs whitespace-nowrap">{error}</span>
      )}
    </div>
  );
}
