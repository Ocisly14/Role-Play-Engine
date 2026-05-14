import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import i18n from "../i18n/config.js";

interface AppSettingsContextType {
  language: "en" | "zh";
  setLanguage: (lang: "en" | "zh") => void;
  handleLanguageChange: (newLanguage: "en" | "zh") => void;
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

  // Handler to update language locally (persisted via localStorage, picked up on next simulation creation)
  const handleLanguageChange = useCallback((newLanguage: "en" | "zh") => {
    setLanguage(newLanguage);
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
