import React from "react";
import { useTranslation } from "react-i18next";

interface ModLoadProgressData {
  stage: string;
  progress: number;
  message: string;
}

interface ModLoadingModalProps {
  loading: boolean;
  progress: ModLoadProgressData | null;
  onClose?: () => void;
}

export const ModLoadingModal: React.FC<ModLoadingModalProps> = ({
  loading,
  progress,
  onClose,
}) => {
  const { t } = useTranslation('module');

  if (!loading) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm supports-[backdrop-filter]:bg-black/30 supports-[backdrop-filter]:backdrop-blur-sm flex items-center justify-center p-5">
      <div className="fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] max-w-[600px] w-[90%] rounded-3xl p-12 supports-[backdrop-filter]:backdrop-blur-lg border border-white/50 bg-white/80 shadow-[0_30px_80px_rgba(15,23,42,0.25)] supports-[backdrop-filter]:bg-white/55">
        <div className="mb-6">
          <h2 className="text-2xl font-semibold m-0 text-center w-full">
            {t('loading')}
          </h2>
        </div>

        {progress && (
          <>
            <div className="mb-5">
              <div className="flex justify-between mb-2.5 text-sm text-gray-700">
                <span>{progress.stage}</span>
                <span>{progress.progress}%</span>
              </div>
              <div className="w-full h-6 bg-gray-300 rounded-xl overflow-hidden border-2 border-gray-400">
                <div
                  className="h-full bg-gray-600 transition-all duration-300 flex items-center justify-center text-xs font-bold text-white"
                  style={{ width: `${progress.progress}%` }}
                >
                  {progress.progress >= 10 && `${progress.progress}%`}
                </div>
              </div>
            </div>

            <div className="text-center text-base min-h-[40px] flex items-center justify-center text-gray-700">
              {progress.message}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
