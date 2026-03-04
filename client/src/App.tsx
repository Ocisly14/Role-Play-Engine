import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { MainLayout } from "./components/layout/MainLayout";
import { AppSettingsProvider } from "./contexts/AppSettingsContext";
import { AuthProvider } from "./contexts/AuthContext";
import { GameSessionProvider } from "./contexts/GameSessionContext";
import { useGameSession } from "./hooks/useGameSession";
import { authFetch } from "./utils/authFetch";
import { setBackgroundWithTransition } from "./utils/backgroundTransition";
import { findAvailableImage } from "./utils/imageLoader";
import { CharacterCreationPage } from "./views/CharacterCreationPage";
import { CharacterSelectionPage } from "./views/CharacterSelectionPage";
import { GamePage } from "./views/GamePage";
import { HomePage } from "./views/HomePage";
import { ModSelectionPage } from "./views/ModSelectionPage";
import { ModuleIntroPage } from "./views/ModuleIntroPage";
import { StoryCreatorPage } from "./views/StoryCreatorPage";
import { TutorialPage } from "./views/TutorialPage";
import { MultiplayerLobby } from "./views/MultiplayerLobby";
import { MultiplayerGamePage } from "./views/MultiplayerGamePage";
import { MultiplayerRoomWaiting } from "./views/MultiplayerRoomWaiting";
import ForgotPassword from "./views/auth/ForgotPassword";
import Login from "./views/auth/Login";
import Register from "./views/auth/Register";
import ResetPassword from "./views/auth/ResetPassword";

// Background manager component - handles dynamic backgrounds based on game state
const BackgroundManager: React.FC = () => {
  const location = useLocation();
  const gameSession = useGameSession();
  const currentBackgroundImageRef = useRef<string | null>(null);

  // Helper function to set default background
  const setDefaultBackground = useCallback(async () => {
    try {
      const imageUrl = await findAvailableImage("background");
      setBackgroundWithTransition(imageUrl, true);
    } catch (err) {
      console.error("Failed to load default background:", err);
      setBackgroundWithTransition("/asset/background.jpeg", true);
    }
  }, []);

  // Initialize default background on mount
  useEffect(() => {
    const initializeBackground = async () => {
      try {
        const imageUrl = await findAvailableImage("background");
        setBackgroundWithTransition(imageUrl, false);
      } catch (err) {
        console.error("Failed to load default background:", err);
        setBackgroundWithTransition("/asset/background.jpeg", false);
      }
    };
    initializeBackground();
  }, []);

  // Detect whether we're on a game page (single-player or multiplayer)
  const isGamePage = location.pathname === "/game";
  const multiplayerMatch = location.pathname.match(/^\/multiplayer\/game\/([^/]+)/);
  const isMultiplayerGamePage = !!multiplayerMatch;
  const multiplayerRoomId = multiplayerMatch?.[1] ?? null;
  const isAnyGamePage = isGamePage || isMultiplayerGamePage;

  // Fetch current scenario sceneImage and set as background when on game page
  useEffect(() => {
    if (!isAnyGamePage || (isGamePage && !gameSession.sessionId)) {
      // Reset to default background when not on game page
      if (currentBackgroundImageRef.current) {
        setDefaultBackground();
        currentBackgroundImageRef.current = null;
      }
      return;
    }

    const fetchGameState = async () => {
      try {
        // Choose endpoint based on single-player vs multiplayer
        let gamestateUrl: string;
        if (isMultiplayerGamePage) {
          const viewedRoom = gameSession.viewedMultiplayerSceneRoomId;
          gamestateUrl = viewedRoom
            ? `/api/multiplayer/rooms/${multiplayerRoomId}/gamestate?sceneRoomId=${encodeURIComponent(viewedRoom)}`
            : `/api/multiplayer/rooms/${multiplayerRoomId}/gamestate`;
        } else {
          gamestateUrl = "/api/gamestate";
        }
        const response = await authFetch(gamestateUrl);
        if (!response.ok) {
          return;
        }

        const data = await response.json();
        const sceneImagePath =
          data?.gameState?.currentScenario?.sceneImage?.path;

        // Extract module name from game state
        const moduleName = data?.gameState?.moduleName;
        if (moduleName) {
          gameSession.setCurrentModuleName(moduleName);
        }

        if (sceneImagePath) {
          const backgroundUrl = `/api/maps/${sceneImagePath}`;
          // Only update if the image has changed
          if (currentBackgroundImageRef.current !== backgroundUrl) {
            setBackgroundWithTransition(backgroundUrl, true, () => {
              currentBackgroundImageRef.current = backgroundUrl;
            });
          }
        } else {
          // No sceneImage, reset to default
          if (currentBackgroundImageRef.current) {
            setDefaultBackground();
            currentBackgroundImageRef.current = null;
          }
        }
      } catch (err) {
        console.error("Failed to fetch game state for background:", err);
      }
    };

    fetchGameState();

    // Cleanup: restore default background when page changes
    return () => {
      if (!isAnyGamePage) {
        setDefaultBackground();
        currentBackgroundImageRef.current = null;
      }
    };
  }, [
    location.pathname,
    isAnyGamePage,
    isGamePage,
    isMultiplayerGamePage,
    multiplayerRoomId,
    gameSession.sessionId,
    gameSession.sidebarRefreshTrigger,
    gameSession.viewedMultiplayerSceneRoomId,
    gameSession.setCurrentModuleName,
    setDefaultBackground,
  ]);

  return null;
};

// App routes component (needs to be inside providers to use BackgroundManager)
const AppRoutes: React.FC = () => {
  return (
    <>
      <BackgroundManager />
      <Routes>
        {/* Auth routes */}
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        {/* Legacy route redirects */}
        <Route path="/gamechat" element={<Navigate to="/game" replace />} />
        <Route
          path="/charactercreate"
          element={<Navigate to="/character/create" replace />}
        />

        {/* Protected app routes */}
        <Route
          element={
            <ProtectedRoute>
              <MainLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<HomePage />} />
          <Route path="/character/create" element={<CharacterCreationPage />} />
          <Route
            path="/character/select"
            element={<CharacterSelectionPage />}
          />
          <Route path="/mod/select" element={<ModSelectionPage />} />
          <Route path="/mod/intro" element={<ModuleIntroPage />} />
          <Route path="/story/create" element={<StoryCreatorPage />} />
          <Route path="/tutorial" element={<TutorialPage />} />
          <Route path="/game" element={<GamePage />} />
          <Route path="/multiplayer" element={<MultiplayerLobby />} />
          <Route path="/multiplayer/room/:roomId" element={<MultiplayerRoomWaiting />} />
          <Route path="/multiplayer/game/:roomId" element={<MultiplayerGamePage />} />
        </Route>
      </Routes>
    </>
  );
};

const App: React.FC = () => (
  <BrowserRouter
    future={{
      v7_startTransition: true,
      v7_relativeSplatPath: true,
    }}
  >
    <AuthProvider>
      <GameSessionProvider>
        <AppSettingsProvider>
          <AppRoutes />
        </AppSettingsProvider>
      </GameSessionProvider>
    </AuthProvider>
  </BrowserRouter>
);

export default App;
