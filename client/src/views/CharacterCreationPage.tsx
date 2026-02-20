import type React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CharacterForm } from "../components/character/CharacterForm";
import { useCharacterCreation } from "../hooks/useCharacterCreation";

export const CharacterCreationPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Check if creating from game flow via URL query param
  const isCreatingFromGameFlow = searchParams.get("fromGame") === "true";

  const characterCreation = useCharacterCreation({
    onCharacterCreated: (characterId) => {
      if (isCreatingFromGameFlow) {
        // If creating from game flow, navigate back to character selection
        navigate("/character/select");
      } else {
        // If creating from home, navigate to home
        navigate("/");
      }
    },
  });

  const handleCancel = () => {
    if (isCreatingFromGameFlow) {
      navigate("/character/select");
    } else {
      navigate("/");
    }
  };

  return <CharacterForm {...characterCreation} onCancel={handleCancel} />;
};
