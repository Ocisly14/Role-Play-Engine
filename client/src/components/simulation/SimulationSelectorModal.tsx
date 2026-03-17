import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type SimulationListItem, listSimulations } from "../../services/simulationApi";

interface SimulationSelectorModalProps {
  open: boolean;
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: "bg-green-100 text-green-700 border-green-300",
  paused: "bg-yellow-100 text-yellow-700 border-yellow-300",
  stopped: "bg-gray-100 text-gray-600 border-gray-300",
  completed: "bg-blue-100 text-blue-700 border-blue-300",
};

export function SimulationSelectorModal({ open, onClose }: SimulationSelectorModalProps) {
  const navigate = useNavigate();
  const [simulations, setSimulations] = useState<SimulationListItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listSimulations()
      .then(setSimulations)
      .catch((err) => console.error("Failed to load simulations:", err))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-5"
      onClick={onClose}
    >
      <div
        className="max-w-[700px] w-full max-h-[80vh] overflow-y-auto rounded-2xl p-8 bg-white/80 backdrop-blur-lg border border-white/50 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold" style={{ color: "var(--title, #3d2f1f)" }}>
            Continue Simulation
          </h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl">
            &times;
          </button>
        </div>

        {loading ? (
          <p className="text-center text-gray-500 py-8">Loading...</p>
        ) : simulations.length === 0 ? (
          <p className="text-center text-gray-500 py-8">No simulations found</p>
        ) : (
          <div className="space-y-3">
            {simulations.map((sim) => (
              <button
                type="button"
                key={sim.sessionId}
                onClick={() => {
                  onClose();
                  navigate(`/simulation/${sim.sessionId}`);
                }}
                className="w-full text-left p-4 rounded-xl border border-gray-200 bg-white/50 hover:bg-white/80 hover:border-gray-300 transition-all"
              >
                <div className="flex justify-between items-center">
                  <span className="font-medium" style={{ color: "var(--title, #3d2f1f)" }}>
                    {sim.moduleName ?? "Unknown Module"}
                  </span>
                  <span className={`text-xs px-2 py-1 rounded-full border ${STATUS_COLORS[sim.state] ?? ""}`}>
                    {sim.state}
                  </span>
                </div>
                <div className="text-sm text-gray-500 mt-1">
                  Day {sim.currentDay} &middot; {sim.currentTime} &middot; {sim.ticksExecuted} ticks
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
