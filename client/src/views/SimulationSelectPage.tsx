import { useNavigate } from "react-router-dom";
import { ModSelector } from "../components/ModSelector";

export default function SimulationSelectPage() {
  const navigate = useNavigate();

  return (
    <ModSelector
      onSelectMod={(modName: string) => {
        navigate("/simulation/config", { state: { moduleName: modName } });
      }}
    />
  );
}
