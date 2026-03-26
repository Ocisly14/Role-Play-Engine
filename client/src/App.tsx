import type React from "react";
import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { MainLayout } from "./components/layout/MainLayout";
import { AppSettingsProvider } from "./contexts/AppSettingsContext";
import { AuthProvider } from "./contexts/AuthContext";
import { GameSessionProvider } from "./contexts/GameSessionContext";
import { useVisitorTracking } from "./hooks/useVisitorTracking";
import { setBackgroundWithTransition } from "./utils/backgroundTransition";
import { findAvailableImage } from "./utils/imageLoader";
import { CharacterCreationPage } from "./views/CharacterCreationPage";
import { CharacterSelectionPage } from "./views/CharacterSelectionPage";
import { HomePage } from "./views/HomePage";
import { StoryCreatorPage } from "./views/StoryCreatorPage";
import { TutorialPage } from "./views/TutorialPage";
import ForgotPassword from "./views/auth/ForgotPassword";
import Login from "./views/auth/Login";
import Register from "./views/auth/Register";
import ResetPassword from "./views/auth/ResetPassword";

const SimulationPage = lazy(() => import("./views/SimulationPage"));
const SimulationSelectPage = lazy(() => import("./views/SimulationSelectPage"));
const MapEditorPage = lazy(() => import("./views/MapEditorPage"));

function renderSimulationPage(mode: "owner" | "public") {
  return (
    <Suspense
      fallback={
        <div className="game-container">
          <div className="flex items-center justify-center flex-1 text-slate-500">
            Loading...
          </div>
        </div>
      }
    >
      <SimulationPage mode={mode} />
    </Suspense>
  );
}

// Background manager component - handles dynamic backgrounds based on game state
const BackgroundManager: React.FC = () => {
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

  return null;
};

// App routes component (needs to be inside providers to use BackgroundManager)
const AppRoutes: React.FC = () => {
  useVisitorTracking();

  return (
    <>
      <BackgroundManager />
      <Routes>
        {/* Auth routes */}
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        {/* Public simulation viewer */}
        <Route
          path="/simulation/public/:sessionId"
          element={renderSimulationPage("public")}
        />

        {/* Map editor (outside ProtectedRoute) */}
        <Route
          path="/map-editor/:moduleName?"
          element={
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-screen bg-gray-950 text-gray-400">
                  Loading...
                </div>
              }
            >
              <MapEditorPage />
            </Suspense>
          }
        />

        {/* Legacy route redirects */}
        <Route path="/gamechat" element={<Navigate to="/" replace />} />
        <Route
          path="/charactercreate"
          element={<Navigate to="/character/create" replace />}
        />

        {/* Protected app routes */}
        <Route
          path="/simulation/:sessionId"
          element={
            <ProtectedRoute>{renderSimulationPage("owner")}</ProtectedRoute>
          }
        />
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
          <Route
            path="/simulation/select"
            element={
              <Suspense
                fallback={
                  <div className="flex items-center justify-center h-screen">
                    Loading...
                  </div>
                }
              >
                <SimulationSelectPage />
              </Suspense>
            }
          />
          <Route path="/story/create" element={<StoryCreatorPage />} />
          <Route path="/tutorial" element={<TutorialPage />} />
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
