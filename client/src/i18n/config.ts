import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import enAuth from "./locales/en/auth.json";
// Import translation resources
import enCommon from "./locales/en/common.json";
import enGame from "./locales/en/game.json";
import enHome from "./locales/en/home.json";
import enModule from "./locales/en/module.json";
import enSimulation from "./locales/en/simulation.json";

import zhAuth from "./locales/zh/auth.json";
import zhCommon from "./locales/zh/common.json";
import zhGame from "./locales/zh/game.json";
import zhHome from "./locales/zh/home.json";
import zhModule from "./locales/zh/module.json";
import zhSimulation from "./locales/zh/simulation.json";

i18n
  .use(LanguageDetector) // Auto-detect browser language
  .use(initReactI18next) // React integration
  .init({
    resources: {
      en: {
        common: enCommon,
        auth: enAuth,
        home: enHome,
        game: enGame,
        module: enModule,
        simulation: enSimulation,
      },
      zh: {
        common: zhCommon,
        auth: zhAuth,
        home: zhHome,
        game: zhGame,
        module: zhModule,
        simulation: zhSimulation,
      },
    },
    fallbackLng: "en",
    defaultNS: "common",
    interpolation: {
      escapeValue: false, // React already escapes
    },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "app.language",
    },
  });

export default i18n;
