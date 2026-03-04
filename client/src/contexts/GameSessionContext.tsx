import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { DiceRollInfo } from "../components/DiceAnimation";
import { authFetch } from "../utils/authFetch";

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

interface LoadCheckpointResult {
  success: boolean;
  notice?: string;
  error?: string;
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
  loadCheckpoint: (
    checkpointId: string,
    language: string
  ) => Promise<LoadCheckpointResult>;
  restoreLatestSession: () => Promise<boolean>;
  clearSession: () => void;

  // Sidebar refresh trigger
  sidebarRefreshTrigger: number;
  triggerSidebarRefresh: () => void;

  // Multiplayer: which scene room tab the user is currently viewing (null = own room)
  viewedMultiplayerSceneRoomId: string | null;
  setViewedMultiplayerSceneRoomId: (id: string | null) => void;

  // Loading states
  isRestoringSession: boolean;
}

const GameSessionContext = createContext<GameSessionContextType | undefined>(
  undefined
);

export const GameSessionProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { t } = useTranslation(["game", "checkpoint", "common"]);
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState<string>("");
  const [characterName, setCharacterName] = useState<string>(
    t("game:session.defaultCharacter")
  );
  const [currentModuleName, setCurrentModuleName] = useState<string>("");
  const [selectedModName, setSelectedModName] = useState<string>("");
  const [conversationHistory, setConversationHistory] = useState<
    Message[] | null
  >(null);
  const [moduleIntroduction, setModuleIntroduction] =
    useState<ModuleIntroduction | null>(null);
  const [sidebarRefreshTrigger, setSidebarRefreshTrigger] = useState(0);
  const [viewedMultiplayerSceneRoomId, setViewedMultiplayerSceneRoomId] = useState<string | null>(null);
  const [isRestoringSession, setIsRestoringSession] = useState(false);
  const hasInitialized = useRef(false);

  const triggerSidebarRefresh = useCallback(() => {
    setSidebarRefreshTrigger((prev) => prev + 1);
  }, []);

  const clearSession = useCallback(() => {
    setSessionId("");
    setCharacterName(t("game:session.defaultCharacter"));
    setCurrentModuleName("");
    setSelectedModName("");
    setConversationHistory(null);
    setModuleIntroduction(null);
    hasInitialized.current = false;
  }, [t]);

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
          alert(
            `${t("game:errors.initFailed")}: ${data.error || t("common:error.generic")}`
          );
        }
      } catch (error) {
        console.error("Error initializing game:", error);
        alert(t("common:error.network"));
      }
    },
    [navigate, t]
  );

  // Load from checkpoint
  const loadCheckpoint = useCallback(
    async (
      checkpointId: string,
      language: string
    ): Promise<LoadCheckpointResult> => {
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

          const languageLabel =
            language === "zh"
              ? t("game:session.language.chinese")
              : t("game:session.language.english");
          return {
            success: true,
            notice: `${t("checkpoint:success.loaded")}\n${t("game:session.languageRestored", { language: languageLabel })}`,
          };
        } else {
          return {
            success: false,
            error: `${t("checkpoint:errors.loadFailed")}: ${
              data.error || t("common:error.generic")
            }`,
          };
        }
      } catch (error) {
        console.error("Error loading checkpoint:", error);
        return {
          success: false,
          error: t("common:error.network"),
        };
      }
    },
    [t]
  );

  // Restore latest session on mount
  const restoreLatestSession = useCallback(async (): Promise<boolean> => {
    if (hasInitialized.current) {
      return false;
    }

    hasInitialized.current = true;
    setIsRestoringSession(true);

    try {
      const response = await authFetch("/api/sessions/latest");
      const raw = await response.text();
      let data: any = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        console.error("Invalid JSON from /api/sessions/latest:", raw);
      }

      if (response.ok && data.success && data.session?.sessionId) {
        console.log("Restored session:", data.session.sessionId);
        setSessionId(data.session.sessionId);

        if (data.session.characterName) {
          setCharacterName(data.session.characterName);
        }

        // Note: /api/sessions/latest doesn't return gameState or conversationHistory
        // Those are only available from /api/checkpoints/load

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
    viewedMultiplayerSceneRoomId,
    setViewedMultiplayerSceneRoomId,
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
