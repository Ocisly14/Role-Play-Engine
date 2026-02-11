import React from "react";
import { useNavigate } from "react-router-dom";
import { StoryCreator } from "../components/StoryCreator";

export const StoryCreatorPage: React.FC = () => {
  const navigate = useNavigate();

  return (
    <StoryCreator
      onComplete={(moduleName) => {
        alert(`Module generated: ${moduleName}`);
        navigate("/mod/select");
      }}
      onCancel={() => navigate("/mod/select")}
    />
  );
};
