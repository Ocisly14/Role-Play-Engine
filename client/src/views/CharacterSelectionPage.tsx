import React from "react";
import { useNavigate } from "react-router-dom";
import { CharacterSelector } from "../components/CharacterSelector";
import { useGameSession } from "../hooks/useGameSession";
import { useAppSettings } from "../contexts/AppSettingsContext";

export const CharacterSelectionPage: React.FC = () => {
  const navigate = useNavigate();
  const gameSession = useGameSession();
  const { language } = useAppSettings();

  const handleSelectCharacter = async (
    characterId: string,
    characterName: string
  ) => {
    await gameSession.startNewGame(
      characterId,
      gameSession.selectedModName,
      language
    );
  };

  return (
    <CharacterSelector
      onSelectCharacter={handleSelectCharacter}
      onCancel={() => navigate("/mod/intro")}
      onCreateNew={() => navigate("/character/create?fromGame=true")}
    />
  );
};
