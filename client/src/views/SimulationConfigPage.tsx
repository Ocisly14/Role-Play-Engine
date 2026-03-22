import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import * as simApi from "../services/simulationApi";

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

export default function SimulationConfigPage() {
  const { t } = useTranslation("simulation");
  const navigate = useNavigate();
  const location = useLocation();
  const moduleName = (location.state as { moduleName?: string })?.moduleName;

  const [tickSpeed, setTickSpeed] = useState(60000);
  const [maxDays, setMaxDays] = useState(7);
  const [weather, setWeather] = useState<string>("clear");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!moduleName) {
    navigate("/simulation/select", { replace: true });
    return null;
  }

  async function handleStart() {
    setCreating(true);
    setError(null);
    try {
      const result = await simApi.createSimulation({
        moduleName: moduleName!,
        config: {
          tickIntervalMs: tickSpeed,
          maxDays,
          weather: weather as any,
        },
      });
      navigate(`/simulation/${result.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create simulation");
      setCreating(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-md w-full space-y-8 bg-white/80 backdrop-blur-sm border border-white/50 rounded-2xl p-8 shadow-xl">
        <h1 className="text-2xl font-bold text-center" style={{ color: "var(--title, #3d2f1f)" }}>
          {t("config.title")}
        </h1>
        <p className="text-center text-gray-600">{moduleName}</p>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: "var(--title, #3d2f1f)" }}>
            {t("config.tickSpeed")}
          </label>
          <div className="flex gap-2">
            {SPEED_OPTIONS.map(({ label, ms }) => (
              <button
                key={label}
                type="button"
                onClick={() => setTickSpeed(ms)}
                className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-all ${
                  tickSpeed === ms
                    ? "bg-amber-700 text-white border-amber-700"
                    : "bg-white/50 border-gray-300 hover:bg-gray-100"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: "var(--title, #3d2f1f)" }}>
            {t("config.maxDays")}: {maxDays}
          </label>
          <input
            type="range"
            min={1}
            max={30}
            value={maxDays}
            onChange={(e) => setMaxDays(Number(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-gray-400">
            <span>1</span>
            <span>30</span>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: "var(--title, #3d2f1f)" }}>
            {t("config.weather")}
          </label>
          <select
            value={weather}
            onChange={(e) => setWeather(e.target.value)}
            className="w-full py-2 px-3 rounded-lg border border-gray-300 bg-white/50"
          >
            {WEATHER_KEYS.map((key) => (
              <option key={key} value={key}>{t(`weather.${key}`)}</option>
            ))}
          </select>
        </div>

        {error && (
          <p className="text-red-600 text-sm text-center">{error}</p>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => navigate("/simulation/select")}
            className="flex-1 py-3 rounded-lg border border-gray-300 bg-white/50 hover:bg-gray-100 font-medium transition-all"
          >
            {t("config.back")}
          </button>
          <button
            type="button"
            onClick={handleStart}
            disabled={creating}
            className="flex-1 py-3 rounded-lg bg-amber-700 text-white font-medium hover:bg-amber-800 disabled:opacity-50 transition-all"
          >
            {creating ? t("config.creating") : t("config.startSimulation")}
          </button>
        </div>
      </div>
    </div>
  );
}
