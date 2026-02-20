import type React from "react";
import { useNavigate } from "react-router-dom";
import { ModuleIntroModal } from "../components/modals/ModuleIntroModal";
import { useGameSession } from "../hooks/useGameSession";

export const ModuleIntroPage: React.FC = () => {
  const navigate = useNavigate();
  const gameSession = useGameSession();

  return (
    <ModuleIntroModal
      moduleIntroduction={gameSession.moduleIntroduction}
      onClose={() => navigate("/mod/select")}
      onNext={() => navigate("/character/select")}
    />
  );
};
