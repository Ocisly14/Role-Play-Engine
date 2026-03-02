import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import i18n from "../i18n/config.js";
import { authFetch } from "../utils/authFetch";

interface AppSettingsContextType {
  language: "en" | "zh";
  setLanguage: (lang: "en" | "zh") => void;
  handleLanguageChange: (newLanguage: "en" | "zh") => Promise<void>;
  currentBackground: string;
  setBackground: (url: string) => void;
}

const AppSettingsContext = createContext<AppSettingsContextType | undefined>(
  undefined
);

export const AppSettingsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [language, setLanguage] = useState<"en" | "zh">(() => {
    const stored = localStorage.getItem("app.language");
    return stored === "en" || stored === "zh" ? stored : "en";
  });

  const [currentBackground, setCurrentBackground] = useState<string>("");

  // Initialize i18n language on mount
  useEffect(() => {
    i18n.changeLanguage(language);
  }, []);

  // Persist language to localStorage and sync with i18next
  useEffect(() => {
    localStorage.setItem("app.language", language);
    i18n.changeLanguage(language);
  }, [language]);

  // Handler to update language both locally and on server
  const handleLanguageChange = useCallback(async (newLanguage: "en" | "zh") => {
    // Update local state first for immediate UI feedback
    setLanguage(newLanguage);

    // Try to update server-side session metadata
    try {
      // Detect multiplayer context from current URL
      const multiMatch = window.location.pathname.match(
        /\/multiplayer\/game\/([^/]+)/
      );

      if (multiMatch) {
        // Multiplayer mode: call the room-scoped endpoint
        const roomId = multiMatch[1];
        const response = await authFetch(
          `/api/multiplayer/rooms/${roomId}/game/update-language`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ language: newLanguage }),
          }
        );
        if (!response.ok) {
          console.error("Failed to update language on multiplayer server");
        }
      } else {
        // Single-player mode
        const response = await authFetch("/api/game/update-language", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language: newLanguage }),
        });
        if (!response.ok) {
          console.error("Failed to update language on server");
        }
      }
    } catch (error) {
      console.error("Error updating language on server:", error);
      // Continue anyway - local state is updated
    }
  }, []);

  const setBackground = useCallback((url: string) => {
    setCurrentBackground(url);
  }, []);

  const value: AppSettingsContextType = {
    language,
    setLanguage,
    handleLanguageChange,
    currentBackground,
    setBackground,
  };

  return (
    <AppSettingsContext.Provider value={value}>
      {children}
    </AppSettingsContext.Provider>
  );
};

export const useAppSettings = (): AppSettingsContextType => {
  const context = useContext(AppSettingsContext);
  if (context === undefined) {
    throw new Error("useAppSettings must be used within AppSettingsProvider");
  }
  return context;
};
