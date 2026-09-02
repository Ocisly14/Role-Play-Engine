import type React from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LanguageToggle } from "../components/layout/LanguageToggle";
import { SimulationSelectorModal } from "../components/simulation/SimulationSelectorModal";
import { useAppSettings } from "../contexts/AppSettingsContext";
import Homes from "./Homes";

export const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const { language, handleLanguageChange } = useAppSettings();

  const [showSimulationSelector, setShowSimulationSelector] = useState(false);

  return (
    <>
      <Homes
        onNewSimulation={() => navigate("/simulation/select")}
        onContinueSimulation={() => setShowSimulationSelector(true)}
      />

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
