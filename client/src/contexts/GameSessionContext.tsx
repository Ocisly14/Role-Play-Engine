import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { useNavigate } from "react-router-dom";
import { authFetch } from "../utils/authFetch";
import type { DiceRollInfo } from "../components/DiceAnimation";

interface Message {
  role: "character" | "keeper";
  content: string;
  timestamp: string;
  turnNumber: number;
  diceRolls?: DiceRollInfo[] | string[];
}

interface ModuleIntroduction {
  introduction: string;
  moduleNotes: string;
}

interface GameSessionContextType {
  // Session data
  sessionId: string;
  setSessionId: (id: string) => void;
  characterName: string;
  setCharacterName: (name: string) => void;
  currentModuleName: string;
  setCurrentModuleName: (name: string) => void;
  selectedModName: string;
  setSelectedModName: (name: string) => void;
  conversationHistory: Message[] | null;
  setConversationHistory: (history: Message[] | null) => void;
  moduleIntroduction: ModuleIntroduction | null;
  setModuleIntroduction: (intro: ModuleIntroduction | null) => void;

  // Session operations
  startNewGame: (
    characterId: string,
    modName: string,
    language: string
  ) => Promise<void>;
  loadCheckpoint: (checkpointId: string, language: string) => Promise<void>;
  restoreLatestSession: () => Promise<boolean>;
  clearSession: () => void;

  // Sidebar refresh trigger
  sidebarRefreshTrigger: number;
  triggerSidebarRefresh: () => void;

  // Loading states
  isRestoringSession: boolean;
}

const GameSessionContext = createContext<GameSessionContextType | undefined>(
  undefined
);

export const GameSessionProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState<string>("");
  const [characterName, setCharacterName] = useState<string>("Investigator");
  const [currentModuleName, setCurrentModuleName] = useState<string>("");
  const [selectedModName, setSelectedModName] = useState<string>("");
  const [conversationHistory, setConversationHistory] = useState<
    Message[] | null
  >(null);
  const [moduleIntroduction, setModuleIntroduction] =
    useState<ModuleIntroduction | null>(null);
  const [sidebarRefreshTrigger, setSidebarRefreshTrigger] = useState(0);
  const [isRestoringSession, setIsRestoringSession] = useState(false);
  const hasInitialized = useRef(false);

  const triggerSidebarRefresh = useCallback(() => {
    setSidebarRefreshTrigger((prev) => prev + 1);
  }, []);

  const clearSession = useCallback(() => {
    setSessionId("");
    setCharacterName("Investigator");
    setCurrentModuleName("");
    setSelectedModName("");
    setConversationHistory(null);
    setModuleIntroduction(null);
  }, []);

  // Start a new game
  const startNewGame = useCallback(
    async (characterId: string, modName: string, language: string) => {
      try {
        const response = await authFetch("/api/game/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ characterId, modName, language }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
          setSessionId(data.sessionId);
          setCurrentModuleName(modName);

          // Extract character name from game state
          if (data.gameState?.playerCharacter?.name) {
            setCharacterName(data.gameState.playerCharacter.name);
          }

          setConversationHistory(null);
          navigate("/game");
        } else {
          alert("Failed to initialize game: " + (data.error || "Unknown error"));
        }
      } catch (error) {
        console.error("Error initializing game:", error);
        alert("Network error, unable to initialize game");
      }
    },
    [navigate]
  );

  // Load from checkpoint
  const loadCheckpoint = useCallback(
    async (checkpointId: string, language: string) => {
      try {
        const response = await authFetch("/api/checkpoints/load", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ checkpointId }),
        });

        const data = await response.json();

        if (response.ok && data.success) {
          // Restore game state
          setSessionId(data.sessionId || `session-${Date.now()}`);

          // Extract character name from game state
          if (data.gameState?.playerCharacter?.name) {
            setCharacterName(data.gameState.playerCharacter.name);
          }

          // Extract module name from game state
          if (data.gameState?.moduleName) {
            setCurrentModuleName(data.gameState.moduleName);
          }

          // Load conversation history
          if (
            data.conversationHistory &&
            Array.isArray(data.conversationHistory)
          ) {
            setConversationHistory(data.conversationHistory);
          } else {
            setConversationHistory(null);
          }

          // Don't show module introduction when loading checkpoint
          setModuleIntroduction(null);

          const languageLabel = language === "zh" ? "Chinese" : "English";
          alert(
            `Checkpoint loaded successfully!\nLanguage restored: ${languageLabel}\n`
          );

          navigate("/game");
        } else {
          alert("Failed to load checkpoint: " + (data.error || "Unknown error"));
        }
      } catch (error) {
        console.error("Error loading checkpoint:", error);
        alert("Network error, unable to load checkpoint");
      }
    },
    [navigate]
  );

  // Restore latest session on mount
  const restoreLatestSession = useCallback(async (): Promise<boolean> => {
    if (hasInitialized.current) {
      return false;
    }

    setIsRestoringSession(true);

    try {
      const response = await authFetch("/api/sessions/latest");
      const data = await response.json();

      if (response.ok && data.success && data.sessionId) {
        console.log("Restored session:", data.sessionId);
        setSessionId(data.sessionId);

        if (data.gameState) {
          if (data.gameState.playerCharacter?.name) {
            setCharacterName(data.gameState.playerCharacter.name);
          }
          if (data.gameState.moduleName) {
            setCurrentModuleName(data.gameState.moduleName);
          }
        }

        if (data.conversationHistory) {
          setConversationHistory(data.conversationHistory);
        }

        hasInitialized.current = true;
        setIsRestoringSession(false);
        return true;
      }

      setIsRestoringSession(false);
      return false;
    } catch (error) {
      console.error("Error restoring session:", error);
      setIsRestoringSession(false);
      return false;
    }
  }, []);

  const value: GameSessionContextType = {
    sessionId,
    setSessionId,
    characterName,
    setCharacterName,
    currentModuleName,
    setCurrentModuleName,
    selectedModName,
    setSelectedModName,
    conversationHistory,
    setConversationHistory,
    moduleIntroduction,
    setModuleIntroduction,
    startNewGame,
    loadCheckpoint,
    restoreLatestSession,
    clearSession,
    sidebarRefreshTrigger,
    triggerSidebarRefresh,
    isRestoringSession,
  };

  return (
    <GameSessionContext.Provider value={value}>
      {children}
    </GameSessionContext.Provider>
  );
};

export const useGameSession = (): GameSessionContextType => {
  const context = useContext(GameSessionContext);
  if (context === undefined) {
    throw new Error("useGameSession must be used within GameSessionProvider");
  }
  return context;
};
