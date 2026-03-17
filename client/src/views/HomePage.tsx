import type React from "react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ModManager } from "../components/ModManager";
import { LanguageToggle } from "../components/layout/LanguageToggle";
import { SimulationSelectorModal } from "../components/simulation/SimulationSelectorModal";
import { getTutorialSeenStorageKey } from "../constants/tutorial";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useAuth } from "../contexts/AuthContext";
import Homes from "./Homes";

export const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { language, handleLanguageChange } = useAppSettings();

  const [showSimulationSelector, setShowSimulationSelector] = useState(false);
  const [showModManager, setShowModManager] = useState(false);

  useEffect(() => {
    const storageKey = getTutorialSeenStorageKey(user?.email);
    const hasSeenTutorial = window.localStorage.getItem(storageKey) === "1";
    if (hasSeenTutorial) {
      return;
    }

    window.localStorage.setItem(storageKey, "1");
    navigate("/tutorial", { replace: true });
  }, [navigate, user?.email]);

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

      <button
        type="button"
        className="tutorial-entry-btn"
        onClick={() => navigate("/tutorial")}
        aria-label="Tutorial"
      >
        <span className="tutorial-entry-icon">🎓</span>
        <span>Tutorial</span>
      </button>

      <LanguageToggle
        language={language}
        onLanguageChange={handleLanguageChange}
      />

      <style>{`
        .tutorial-entry-btn {
          position: fixed;
          left: 24px;
          bottom: 24px;
          z-index: 9999;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          border-radius: 999px;
          border: 1px solid rgba(226, 232, 240, 0.95);
          background: rgba(255, 255, 255, 0.82);
          color: var(--title, #3d2f1f);
          font-size: 0.86rem;
          font-weight: 700;
          font-family: var(--serif);
          cursor: pointer;
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          box-shadow: 0 6px 18px rgba(15, 23, 42, 0.2);
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        .tutorial-entry-btn:hover {
          transform: translateY(-1px);
          box-shadow: 0 10px 22px rgba(15, 23, 42, 0.25);
        }
        .tutorial-entry-icon {
          font-size: 1rem;
          line-height: 1;
        }
      `}</style>
    </>
  );
};
