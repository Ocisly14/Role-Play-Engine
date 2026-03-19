import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ModSelector } from "../components/ModSelector";
import * as simApi from "../services/simulationApi";

export default function SimulationSelectPage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSelectMod(modName: string) {
    setCreating(true);
    setError(null);
    try {
      const result = await simApi.createSimulation({ moduleName: modName });
      navigate(`/simulation/${result.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create simulation");
      setCreating(false);
    }
  }

  return (
    <div className="relative">
      <ModSelector onSelectMod={handleSelectMod} />
      {creating && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50" style={{ zIndex: 1100 }}>
          <div className="bg-white rounded-xl px-8 py-6 shadow-xl text-center">
            <div className="animate-spin w-8 h-8 border-4 border-amber-700 border-t-transparent rounded-full mx-auto mb-3" />
            <p className="text-gray-700 font-medium">Initializing simulation...</p>
          </div>
        </div>
      )}
      {error && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-red-600 text-white px-6 py-3 rounded-lg shadow-lg" style={{ zIndex: 1100 }}>
          {error}
        </div>
      )}
    </div>
  );
}
