import { useGameSession as useGameSessionContext } from "../contexts/GameSessionContext";

/**
 * Custom hook for accessing game session data
 * Provides convenient computed properties
 */
export const useGameSession = () => {
  const session = useGameSessionContext();

  return {
    ...session,
    hasActiveSession: Boolean(session.sessionId),
    isInGame: Boolean(session.sessionId && session.characterName),
  };
};
