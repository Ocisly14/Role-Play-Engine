import type React from "react";

interface LanguageToggleProps {
  language: "en" | "zh";
  onLanguageChange: (language: "en" | "zh") => void;
}

export const LanguageToggle: React.FC<LanguageToggleProps> = ({
  language,
  onLanguageChange,
}) => {
  return (
    <div
      style={{
        position: "fixed",
        bottom: "24px",
        right: "24px",
        zIndex: 9999,
        display: "flex",
        gap: "8px",
        background: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(10px)",
        padding: "8px 12px",
        borderRadius: "20px",
        border: "1px solid rgba(255, 255, 255, 0.1)",
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
      }}
    >
      <button
        onClick={() => onLanguageChange("en")}
        style={{
          padding: "6px 16px",
          borderRadius: "14px",
          border: "none",
          background:
            language === "en" ? "rgba(59, 130, 246, 0.8)" : "transparent",
          color: language === "en" ? "#fff" : "rgba(255, 255, 255, 0.7)",
          fontWeight: language === "en" ? "600" : "400",
          fontSize: "14px",
          cursor: "pointer",
          transition: "all 0.2s",
        }}
        onMouseEnter={(e) => {
          if (language !== "en") {
            e.currentTarget.style.background = "rgba(255, 255, 255, 0.1)";
          }
        }}
        onMouseLeave={(e) => {
          if (language !== "en") {
            e.currentTarget.style.background = "transparent";
          }
        }}
      >
        EN
      </button>
      <button
        onClick={() => onLanguageChange("zh")}
        style={{
          padding: "6px 16px",
          borderRadius: "14px",
          border: "none",
          background:
            language === "zh" ? "rgba(59, 130, 246, 0.8)" : "transparent",
          color: language === "zh" ? "#fff" : "rgba(255, 255, 255, 0.7)",
          fontWeight: language === "zh" ? "600" : "400",
          fontSize: "14px",
          cursor: "pointer",
          transition: "all 0.2s",
        }}
        onMouseEnter={(e) => {
          if (language !== "zh") {
            e.currentTarget.style.background = "rgba(255, 255, 255, 0.1)";
          }
        }}
        onMouseLeave={(e) => {
          if (language !== "zh") {
            e.currentTarget.style.background = "transparent";
          }
        }}
      >
        中文
      </button>
    </div>
  );
};
