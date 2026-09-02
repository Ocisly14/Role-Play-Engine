import type React from "react";
import { useTranslation } from "react-i18next";
import { FrameImage } from "../components/FrameImage";

interface HomeProps {
  onNewSimulation: () => void;
  onContinueSimulation: () => void;
}

const Homes: React.FC<HomeProps> = ({
  onNewSimulation,
  onContinueSimulation,
}) => {
  const { t } = useTranslation("home");

  return (
    <div className="home">
      <div className="home-frame">
        <FrameImage />
        <div className="home-actions">
          <button className="primary" onClick={onNewSimulation}>
            {t("menu.newSimulation")}
          </button>
          <button className="primary" onClick={onContinueSimulation}>
            {t("menu.continueSimulation")}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Homes;
