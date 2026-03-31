import type React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CharacterForm } from "../components/character/CharacterForm";
import { useCharacterCreation } from "../hooks/useCharacterCreation";

export const CharacterCreationPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const editingCharacterId = searchParams.get("characterId") || undefined;

  const characterCreation = useCharacterCreation({
    characterId: editingCharacterId,
    onCharacterCreated: () => {
      navigate("/");
    },
  });

  const handleCancel = () => {
    navigate("/");
  };

  return <CharacterForm {...characterCreation} onCancel={handleCancel} />;
};
