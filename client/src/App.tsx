import React, { useEffect, useRef, useCallback } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  useLocation,
  Navigate,
} from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { GameSessionProvider } from "./contexts/GameSessionContext";
import { AppSettingsProvider } from "./contexts/AppSettingsContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import Login from "./views/auth/Login";
import Register from "./views/auth/Register";
import ForgotPassword from "./views/auth/ForgotPassword";
import ResetPassword from "./views/auth/ResetPassword";
import { HomePage } from "./views/HomePage";
import { CharacterCreationPage } from "./views/CharacterCreationPage";
import { CharacterSelectionPage } from "./views/CharacterSelectionPage";
import { ModSelectionPage } from "./views/ModSelectionPage";
import { ModuleIntroPage } from "./views/ModuleIntroPage";
import { StoryCreatorPage } from "./views/StoryCreatorPage";
import { GamePage } from "./views/GamePage";
import { MainLayout } from "./components/layout/MainLayout";
import { findAvailableImage } from "./utils/imageLoader";
import { setBackgroundWithTransition } from "./utils/backgroundTransition";
import { useGameSession } from "./hooks/useGameSession";
import { authFetch } from "./utils/authFetch";

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

  // Fetch current scenario sceneImage and set as background when on game page
  useEffect(() => {
    if (location.pathname !== "/game" || !gameSession.sessionId) {
      // Reset to default background when not on game page
      if (currentBackgroundImageRef.current) {
        setDefaultBackground();
        currentBackgroundImageRef.current = null;
      }
      return;
    }

    const fetchGameState = async () => {
      try {
        const response = await authFetch("/api/gamestate");
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
      if (location.pathname !== "/game") {
        setDefaultBackground();
        currentBackgroundImageRef.current = null;
      }
    };
  }, [
    location.pathname,
    gameSession.sessionId,
    gameSession.sidebarRefreshTrigger,
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
          <Route
            path="/character/create"
            element={<CharacterCreationPage />}
          />
          <Route
            path="/character/select"
            element={<CharacterSelectionPage />}
          />
          <Route path="/mod/select" element={<ModSelectionPage />} />
          <Route path="/mod/intro" element={<ModuleIntroPage />} />
          <Route path="/story/create" element={<StoryCreatorPage />} />
          <Route path="/game" element={<GamePage />} />
        </Route>
      </Routes>
    </>
  );
};

const App: React.FC = () => (
  <BrowserRouter>
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
