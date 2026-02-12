import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Import translation resources
import enCommon from './locales/en/common.json';
import enAuth from './locales/en/auth.json';
import enHome from './locales/en/home.json';
import enGame from './locales/en/game.json';
import enCharacter from './locales/en/character.json';
import enCheckpoint from './locales/en/checkpoint.json';
import enModule from './locales/en/module.json';

import zhCommon from './locales/zh/common.json';
import zhAuth from './locales/zh/auth.json';
import zhHome from './locales/zh/home.json';
import zhGame from './locales/zh/game.json';
import zhCharacter from './locales/zh/character.json';
import zhCheckpoint from './locales/zh/checkpoint.json';
import zhModule from './locales/zh/module.json';

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
        character: enCharacter,
        checkpoint: enCheckpoint,
        module: enModule,
      },
      zh: {
        common: zhCommon,
        auth: zhAuth,
        home: zhHome,
        game: zhGame,
        character: zhCharacter,
        checkpoint: zhCheckpoint,
        module: zhModule,
      },
    },
    fallbackLng: 'en',
    defaultNS: 'common',
    interpolation: {
      escapeValue: false, // React already escapes
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'app.language',
    },
  });

export default i18n;
