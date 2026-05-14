import type React from "react";
import { useTranslation } from "react-i18next";

interface ModuleIntroduction {
  introduction: string;
  moduleNotes: string;
}

interface ModuleIntroModalProps {
  moduleIntroduction: ModuleIntroduction | null;
  onClose: () => void;
  onNext: () => void;
}

export const ModuleIntroModal: React.FC<ModuleIntroModalProps> = ({
  moduleIntroduction,
  onClose,
  onNext,
}) => {
  const { t } = useTranslation("module");

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm supports-[backdrop-filter]:bg-black/30 supports-[backdrop-filter]:backdrop-blur-sm flex items-center justify-center p-5">
      <div className="fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] max-w-[800px] max-h-[90vh] w-[90%] overflow-y-auto rounded-3xl p-12 supports-[backdrop-filter]:backdrop-blur-lg border border-white/50 bg-white/80 shadow-[0_30px_80px_rgba(15,23,42,0.25)] supports-[backdrop-filter]:bg-white/55">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-semibold m-0 border-b-2 border-gray-300 pb-3 w-full">
            {t("intro.title")}
          </h2>
          <button
            onClick={onClose}
            className="close-button"
            aria-label={t("intro.closeAria")}
          >
            ×
          </button>
        </div>

        {moduleIntroduction && (
          <>
            <div style={{ marginBottom: "30px" }}>
              <h3
                style={{
                  color: "#5a4a3a",
                  marginBottom: "10px",
                  fontSize: "1.2rem",
                }}
              >
                {t("manager.preview.storyIntro")}
              </h3>
              <div
                style={{
                  backgroundColor: "#fff",
                  padding: "20px",
                  borderRadius: "4px",
                  border: "1px solid #ddd",
                  lineHeight: "1.8",
                  color: "#2c2c2c",
                  whiteSpace: "pre-wrap",
                }}
              >
                {moduleIntroduction.introduction}
              </div>
            </div>

            <div style={{ marginBottom: "30px" }}>
              <h3
                style={{
                  color: "#5a4a3a",
                  marginBottom: "10px",
                  fontSize: "1.2rem",
                }}
              >
                {t("manager.preview.creationGuide")}
              </h3>
              <div
                style={{
                  backgroundColor: "#fff",
                  padding: "20px",
                  borderRadius: "4px",
                  border: "1px solid #ddd",
                  lineHeight: "1.8",
                  color: "#2c2c2c",
                  whiteSpace: "pre-wrap",
                }}
              >
                {moduleIntroduction.moduleNotes}
              </div>
            </div>
          </>
        )}

        <div className="flex gap-3 mt-8">
          <button
            onClick={onClose}
            className="flex-1 px-5 py-3.5 backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all text-base font-bold cursor-pointer"
          >
            {t("intro.backToSelection")}
          </button>
          <button
            onClick={onNext}
            className="flex-[2] px-5 py-3.5 backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg hover:bg-white/70 transition-all text-base font-bold cursor-pointer"
          >
            {t("intro.nextSelectCharacter")}
          </button>
        </div>
      </div>
    </div>
  );
};
