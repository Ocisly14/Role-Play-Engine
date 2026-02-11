import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
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
    return stored === "en" || stored === "zh" ? stored : "zh";
  });

  const [currentBackground, setCurrentBackground] = useState<string>("");

  // Persist language to localStorage
  useEffect(() => {
    localStorage.setItem("app.language", language);
  }, [language]);

  // Handler to update language both locally and on server
  const handleLanguageChange = useCallback(
    async (newLanguage: "en" | "zh") => {
      // Update local state first for immediate UI feedback
      setLanguage(newLanguage);

      // Try to update server-side session metadata
      try {
        const response = await authFetch("/api/game/update-language", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language: newLanguage }),
        });

        if (!response.ok) {
          console.error("Failed to update language on server");
        }
      } catch (error) {
        console.error("Error updating language on server:", error);
        // Continue anyway - local state is updated
      }
    },
    []
  );

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
