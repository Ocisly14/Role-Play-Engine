import type React from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ModManager } from "../components/ModManager";
import { LanguageToggle } from "../components/layout/LanguageToggle";
import { SimulationSelectorModal } from "../components/simulation/SimulationSelectorModal";
import { useAppSettings } from "../contexts/AppSettingsContext";
import Homes from "./Homes";

export const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const { language, handleLanguageChange } = useAppSettings();

  const [showSimulationSelector, setShowSimulationSelector] = useState(false);
  const [showModManager, setShowModManager] = useState(false);

  return (
    <>
      <Homes
        onCreate={() => navigate("/character/create")}
        onNewSimulation={() => navigate("/simulation/select")}
        onContinueSimulation={() => setShowSimulationSelector(true)}
        onManageMods={() => setShowModManager(true)}
      />

      {showModManager && (
        <ModManager onClose={() => setShowModManager(false)} />
      )}

      <SimulationSelectorModal
        open={showSimulationSelector}
        onClose={() => setShowSimulationSelector(false)}
      />

      <LanguageToggle
        language={language}
        onLanguageChange={handleLanguageChange}
      />
    </>
  );
};
