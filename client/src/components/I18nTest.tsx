import type React from "react";
import { useTranslation } from "react-i18next";
import { useAppSettings } from "../contexts/AppSettingsContext";

/**
 * Simple test component to verify i18n is working
 * Add this to HomePage to test language switching
 */
export const I18nTest: React.FC = () => {
  const { t, i18n } = useTranslation(["common", "home", "game"]);
  const { language } = useAppSettings();

  return (
    <div
      style={{
        position: "fixed",
        top: "20px",
        left: "20px",
        background: "rgba(0, 0, 0, 0.8)",
        color: "white",
        padding: "20px",
        borderRadius: "10px",
        zIndex: 10000,
        maxWidth: "400px",
      }}
    >
      <h3 style={{ margin: "0 0 10px 0", color: "#4ade80" }}>
        🧪 {t("common:i18nTest.title")}
      </h3>

      <div style={{ fontSize: "14px", lineHeight: "1.6" }}>
        <p>
          <strong>{t("common:i18nTest.currentLanguage")}</strong> {language}
        </p>
        <p>
          <strong>{t("common:i18nTest.i18nLanguage")}</strong> {i18n.language}
        </p>

        <hr style={{ margin: "10px 0", opacity: 0.3 }} />

        <p>
          <strong>{t("common:i18nTest.commonNamespace")}</strong>
        </p>
        <ul style={{ margin: "5px 0", paddingLeft: "20px" }}>
          <li>{t("common:button.save")}</li>
          <li>{t("common:button.cancel")}</li>
          <li>{t("common:loading.loading")}</li>
        </ul>

        <p>
          <strong>{t("common:i18nTest.homeNamespace")}</strong>
        </p>
        <ul style={{ margin: "5px 0", paddingLeft: "20px" }}>
          <li>{t("home:menu.manageModules")}</li>
          <li>{t("home:menu.newSimulation")}</li>
          <li>{t("home:characters.title")}</li>
        </ul>

        <p>
          <strong>{t("common:i18nTest.gameNamespace")}</strong>
        </p>
        <ul style={{ margin: "5px 0", paddingLeft: "20px" }}>
          <li>{t("game:dice.roll")}</li>
          <li>{t("game:dice.success")}</li>
        </ul>

        <p style={{ fontSize: "12px", opacity: 0.7, marginTop: "10px" }}>
          ✅ {t("common:i18nTest.successHint")}
        </p>
        <p style={{ fontSize: "12px", opacity: 0.7 }}>
          ❌ {t("common:i18nTest.failureHint")}
        </p>
      </div>
    </div>
  );
};
