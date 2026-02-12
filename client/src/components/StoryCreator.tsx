import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

export interface StoryCreatorProps {
  apiBaseUrl?: string;
  onComplete: (moduleName: string) => void;
  onCancel: () => void;
}

type SettingType =
  | "small_town"
  | "city"
  | "academic"
  | "isolated"
  | "single_structure"
  | "route";

/** Story length: short / medium / long */
export type StoryLength = "short" | "medium" | "long";

const STORY_LENGTH_OPTIONS: {
  value: StoryLength;
  labelKey: string;
  descriptionKey: string;
  icon: string;
}[] = [
  {
    value: "short",
    labelKey: "storyCreator.length.short.label",
    descriptionKey: "storyCreator.length.short.description",
    icon: "📖",
  },
  {
    value: "medium",
    labelKey: "storyCreator.length.medium.label",
    descriptionKey: "storyCreator.length.medium.description",
    icon: "📚",
  },
  {
    value: "long",
    labelKey: "storyCreator.length.long.label",
    descriptionKey: "storyCreator.length.long.description",
    icon: "🗂️",
  },
];

interface ProgressUpdate {
  stage: string;
  progress: number;
  message: string;
}

interface QuotaStatus {
  phase: "initial" | "weekly";
  totalUsed: number;
  totalLimit: number;
  mediumUsed: number;
  mediumLimit: number;
  largeUsed: number;
  largeLimit: number;
}

const SETTING_TYPES: {
  value: SettingType;
  labelKey: string;
  descriptionKey: string;
  icon: string;
}[] = [
  {
    value: "small_town",
    labelKey: "storyCreator.setting.small_town.label",
    descriptionKey: "storyCreator.setting.small_town.description",
    icon: "🏘️",
  },
  {
    value: "city",
    labelKey: "storyCreator.setting.city.label",
    descriptionKey: "storyCreator.setting.city.description",
    icon: "🌆",
  },
  {
    value: "academic",
    labelKey: "storyCreator.setting.academic.label",
    descriptionKey: "storyCreator.setting.academic.description",
    icon: "🎓",
  },
  {
    value: "isolated",
    labelKey: "storyCreator.setting.isolated.label",
    descriptionKey: "storyCreator.setting.isolated.description",
    icon: "🏔️",
  },
  {
    value: "single_structure",
    labelKey: "storyCreator.setting.single_structure.label",
    descriptionKey: "storyCreator.setting.single_structure.description",
    icon: "🏰",
  },
  {
    value: "route",
    labelKey: "storyCreator.setting.route.label",
    descriptionKey: "storyCreator.setting.route.description",
    icon: "🚂",
  },
];

export function StoryCreator({
  apiBaseUrl = "/api",
  onComplete,
  onCancel,
}: StoryCreatorProps) {
  const { t } = useTranslation("module");
  const [creativePrompt, setCreativePrompt] = useState("");
  const [settingType, setSettingType] = useState<SettingType>("small_town");
  const [storyLength, setStoryLength] = useState<StoryLength>("medium");
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("accessToken");
    fetch(`${apiBaseUrl}/mods/quota`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.quota) setQuota(data.quota);
      })
      .catch(() => {});
  }, [apiBaseUrl]);

  const isLengthDisabled = (value: StoryLength): boolean => {
    if (!quota) return false;
    if (quota.totalUsed >= quota.totalLimit) return true;
    if (value === "medium" && quota.mediumUsed >= quota.mediumLimit)
      return true;
    if (value === "long" && quota.largeUsed >= quota.largeLimit) return true;
    return false;
  };

  const runGeneration = async (
    endpoint: string,
    payload: Record<string, string>
  ) => {
    const token = localStorage.getItem("accessToken");
    const response = await fetch(`${apiBaseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(
        t("storyCreator.errors.http", { status: response.status })
      );
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      throw new Error(t("storyCreator.errors.noResponseBody"));
    }

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.substring(6));
            setProgress(data);

            if (data.stage === "complete") {
              return data;
            }

            if (data.stage === "error") {
              throw new Error(
                data.message || t("storyCreator.errors.generationFailed")
              );
            }
          } catch (parseError) {
            console.error("Failed to parse SSE data:", parseError);
          }
        }
      }
    }

    return null;
  };

  const handleGenerateWorld = async () => {
    if (!creativePrompt.trim()) {
      setError(t("storyCreator.errors.ideaRequired"));
      return;
    }

    setError(null);
    setIsGenerating(true);
    setProgress({
      stage: "starting",
      progress: 0,
      message: t("storyCreator.progress.startingGeneration"),
    });

    try {
      const data = await runGeneration("/module/generate-world", {
        settingType,
        storyLength,
        creativePrompt: creativePrompt.trim(),
      });

      if (data?.stage === "complete") {
        const moduleName =
          data.result?.moduleName || t("storyCreator.defaultModuleName");
        setIsGenerating(false);
        setTimeout(() => {
          onComplete(moduleName);
        }, 1000);
      }
    } catch (err) {
      console.error("Error generating world:", err);
      setError((err as Error).message || t("storyCreator.errors.generationFailed"));
      setIsGenerating(false);
    }
  };

  const getProgressPercentage = () => {
    if (!progress) return 0;
    return progress.progress || 0;
  };

  const getStageLabel = (stage: string) => {
    switch (stage) {
      case "macro_scene":
        return t("storyCreator.progress.stages.macro_scene");
      case "npc_builder":
        return t("storyCreator.progress.stages.npc_builder");
      case "persistence":
        return t("storyCreator.progress.stages.persistence");
      case "complete":
        return t("storyCreator.progress.stages.complete");
      case "error":
        return t("storyCreator.progress.stages.error");
      default:
        return t("storyCreator.progress.stages.processing");
    }
  };

  return (
    <>
      <div className="story-creator-overlay">
        <div className="story-creator-modal">
          <div className="modal-header">
            <div className="modal-header-content">
              <img
                src="/asset/icon.png"
                alt={t("storyCreator.createStoryAlt")}
                className="header-icon"
              />
              <div className="header-text">
                <h2>{t("storyCreator.title")}</h2>
                <p className="header-subtitle">
                  {t("storyCreator.subtitle")}
                </p>
              </div>
            </div>
            <button
              onClick={onCancel}
              className="close-button"
              aria-label={t("storyCreator.closeAria")}
              disabled={isGenerating}
            >
              ×
            </button>
          </div>

          <div className="modal-content">
            {!isGenerating ? (
              <>
                {error && <div className="error-message">{error}</div>}

                {quota && (
                  <div
                    className={`quota-banner ${quota.totalUsed >= quota.totalLimit ? "exhausted" : ""}`}
                  >
                    <div className="quota-row">
                      <span className="quota-title">
                        {t("storyCreator.quota.title")}
                      </span>
                      <span className="quota-remaining">
                        {quota.totalUsed >= quota.totalLimit
                          ? t("storyCreator.quota.exhausted")
                          : t("storyCreator.quota.chancesLeft", {
                              count: quota.totalLimit - quota.totalUsed,
                            })}
                      </span>
                    </div>
                    <p className="quota-rule">
                      {quota.phase === "initial"
                        ? t("storyCreator.quota.initialRule", {
                            total: quota.totalLimit,
                            medium: quota.mediumLimit,
                            large: quota.largeLimit,
                          })
                        : t("storyCreator.quota.weeklyRule", {
                            total: quota.totalLimit,
                            medium: quota.mediumLimit,
                            large: quota.largeLimit,
                          })}
                    </p>
                    <div className="quota-details">
                      <span
                        className={`quota-tag ${quota.mediumUsed >= quota.mediumLimit ? "used-up" : ""}`}
                      >
                        {t("storyCreator.length.medium.label")}:{" "}
                        {quota.mediumUsed >= quota.mediumLimit
                          ? t("storyCreator.quota.limitReached")
                          : t("storyCreator.quota.available", {
                              count: quota.mediumLimit - quota.mediumUsed,
                            })}
                      </span>
                      <span
                        className={`quota-tag ${quota.largeUsed >= quota.largeLimit ? "used-up" : ""}`}
                      >
                        {t("storyCreator.length.long.label")}:{" "}
                        {quota.largeUsed >= quota.largeLimit
                          ? t("storyCreator.quota.limitReached")
                          : t("storyCreator.quota.available", {
                              count: quota.largeLimit - quota.largeUsed,
                            })}
                      </span>
                    </div>
                    <div className="quota-refresh">
                      {quota.phase === "initial"
                        ? t("storyCreator.quota.initialRefresh")
                        : t("storyCreator.quota.weeklyRefresh")}
                    </div>
                  </div>
                )}

                <>
                  <div className="form-section">
                    <label htmlFor="storyLength" className="form-label">
                      {t("storyCreator.length.title")}
                    </label>
                    <div className="story-length-grid">
                      {STORY_LENGTH_OPTIONS.map((opt) => {
                        const disabled = isLengthDisabled(opt.value);
                        return (
                          <div
                            key={opt.value}
                            className={`setting-card ${storyLength === opt.value ? "selected" : ""} ${disabled ? "disabled" : ""}`}
                            onClick={() =>
                              !disabled && setStoryLength(opt.value)
                            }
                          >
                            <div className="setting-icon">{opt.icon}</div>
                            <div className="setting-content">
                              <div className="setting-label">
                                {t(opt.labelKey)}
                              </div>
                              <div className="setting-description">
                                {t(opt.descriptionKey)}
                              </div>
                              {disabled && (
                                <div className="quota-limit-badge">
                                  {t("storyCreator.quota.limitReached")}
                                </div>
                              )}
                            </div>
                            {storyLength === opt.value && !disabled && (
                              <div className="setting-checkmark">✓</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="form-section">
                    <label htmlFor="settingType" className="form-label">
                      {t("storyCreator.setting.title")}
                    </label>
                    <div className="setting-grid">
                      {SETTING_TYPES.map((setting) => (
                        <div
                          key={setting.value}
                          className={`setting-card ${settingType === setting.value ? "selected" : ""}`}
                          onClick={() => setSettingType(setting.value)}
                        >
                          <div className="setting-icon">{setting.icon}</div>
                          <div className="setting-content">
                            <div className="setting-label">
                              {t(setting.labelKey)}
                            </div>
                            <div className="setting-description">
                              {t(setting.descriptionKey)}
                            </div>
                          </div>
                          {settingType === setting.value && (
                            <div className="setting-checkmark">✓</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="form-section">
                    <label htmlFor="creativePrompt" className="form-label">
                      {t("storyCreator.ideaLabel")}{" "}
                      <span className="required">*</span>
                    </label>
                    <textarea
                      id="creativePrompt"
                      value={creativePrompt}
                      onChange={(e) => setCreativePrompt(e.target.value)}
                      placeholder={t("storyCreator.ideaPlaceholder")}
                      className="form-textarea"
                      rows={8}
                    />
                    <p className="form-hint">
                      {t("storyCreator.ideaHint")}
                    </p>
                  </div>
                </>

                <div className="modal-footer">
                  <button onClick={onCancel} className="btn-secondary">
                    {t("common:button.cancel")}
                  </button>
                  <button
                    onClick={handleGenerateWorld}
                    className="btn-primary"
                    disabled={
                      !creativePrompt.trim() || isLengthDisabled(storyLength)
                    }
                  >
                    {t("storyCreator.generateButton")} →
                  </button>
                </div>
              </>
            ) : (
              <div className="generation-progress">
                <div className="progress-header">
                  <h3>
                    {progress
                      ? getStageLabel(progress.stage)
                      : t("storyCreator.progress.generating")}
                  </h3>
                  <div className="progress-percentage">
                    {getProgressPercentage()}%
                  </div>
                </div>

                <div className="progress-bar-container">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${getProgressPercentage()}%` }}
                  />
                </div>

                <div className="progress-message">
                  {progress?.message || t("storyCreator.progress.starting")}
                </div>

                <div className="progress-info">
                  <p>
                    {t("storyCreator.progress.mayTakeTime")}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        .story-creator-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 20px;
        }

        @supports (backdrop-filter: blur(4px)) {
          .story-creator-overlay {
            background: rgba(0, 0, 0, 0.3);
          }
        }

        .story-creator-modal {
          background: rgba(255, 255, 255, 0.8);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.5);
          box-shadow: 0 30px 80px rgba(15, 23, 42, 0.25);
          max-width: 900px;
          width: 100%;
          max-height: 90vh;
          display: flex;
          flex-direction: column;
          border-radius: 1.5rem;
          overflow: hidden;
        }

        @supports (backdrop-filter: blur(16px)) {
          .story-creator-modal {
            background: rgba(255, 255, 255, 0.55);
          }
        }

        @keyframes modalSlideIn {
          from {
            opacity: 0;
            transform: translateY(-30px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        .modal-header {
          padding: 24px 28px;
          background: transparent;
          border-bottom: 1px solid rgba(226, 232, 240, 0.5);
          display: flex;
          justify-content: space-between;
          align-items: center;
          position: relative;
        }

        .modal-header-content {
          display: flex;
          align-items: center;
          gap: 16px;
        }

        .header-icon {
          width: 180px;
          height: 180px;
          object-fit: contain;
          filter: drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3));
        }

        .header-text {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .modal-header h2 {
          margin: 0;
          letter-spacing: 2px;
          font-size: 1.8rem;
          color: var(--title, #3d2f1f);
          text-transform: uppercase;
          font-weight: 700;
          text-shadow: 1px 1px 2px rgba(255, 255, 255, 0.5);
        }

        .header-subtitle {
          margin: 0;
          font-size: 0.95rem;
          color: #5a4a3a;
          font-style: italic;
          letter-spacing: 0.5px;
        }

        .close-button {
          width: 40px;
          height: 40px;
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          background: rgba(255, 255, 255, 0.3);
          border: 1px solid rgba(226, 232, 240, 0.8);
          color: rgba(0, 0, 0, 0.7);
          font-size: 1.5rem;
          line-height: 1;
          cursor: pointer;
          transition: all 0.2s ease-in-out;
          border-radius: 0.75rem;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          opacity: 0.7;
          box-shadow: 0 2px 4px -1px rgba(0, 0, 0, 0.1);
        }

        .close-button:hover:not(:disabled) {
          opacity: 1;
          background: rgba(255, 255, 255, 0.5);
          border-color: rgba(203, 213, 225, 1);
        }

        .close-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .modal-content {
          padding: 32px 28px;
          overflow-y: auto;
          flex: 1;
          background: transparent;
        }

        .error-message {
          background: #f8d7da;
          color: #721c24;
          padding: 12px 16px;
          border-radius: 4px;
          margin-bottom: 20px;
          border: 1px solid #f5c6cb;
        }

        /* ── quota banner ── */
        .quota-banner {
          background: rgba(255, 248, 230, 0.95);
          border: 1px solid rgba(139, 115, 85, 0.35);
          border-radius: 8px;
          padding: 14px 18px;
          margin-bottom: 20px;
        }

        .quota-banner.exhausted {
          background: rgba(255, 235, 235, 0.95);
          border-color: rgba(200, 35, 51, 0.4);
        }

        .quota-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 4px;
        }

        .quota-rule {
          margin: 0 0 10px;
          font-size: 0.85rem;
          color: #5a4a3a;
          line-height: 1.45;
        }

        .quota-title {
          font-weight: 700;
          font-size: 0.95rem;
          color: var(--title, #3d2f1f);
        }

        .quota-remaining {
          font-weight: 700;
          font-size: 0.95rem;
          color: var(--accent, #8b7355);
        }

        .quota-banner.exhausted .quota-remaining {
          color: #c82333;
        }

        .quota-details {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .quota-tag {
          font-size: 0.82rem;
          background: rgba(255, 255, 255, 0.7);
          border: 1px solid rgba(139, 115, 85, 0.25);
          padding: 3px 10px;
          border-radius: 12px;
          color: #5a4a3a;
        }

        .quota-tag.used-up {
          background: rgba(248, 215, 218, 0.8);
          border-color: rgba(200, 35, 51, 0.35);
          color: #721c24;
          font-weight: 600;
        }

        .quota-refresh {
          font-size: 0.78rem;
          color: #888;
          font-style: italic;
          margin-top: 6px;
        }

        /* ── disabled story-length card ── */
        .setting-card.disabled {
          opacity: 0.45;
          cursor: not-allowed;
          background: #f3f0ec;
        }

        .setting-card.disabled:hover {
          transform: none;
          box-shadow: none;
          border-color: var(--border, #3d2f1f);
        }

        .quota-limit-badge {
          display: inline-block;
          margin-top: 5px;
          font-size: 0.72rem;
          font-weight: 600;
          background: #f8d7da;
          color: #721c24;
          padding: 2px 7px;
          border-radius: 10px;
        }

        .form-section {
          margin-bottom: 28px;
        }

        .form-label {
          display: block;
          font-size: 1.1rem;
          font-weight: 700;
          color: var(--title, #3d2f1f);
          margin-bottom: 8px;
          font-family: var(--serif);
          letter-spacing: 0.5px;
        }

        .required {
          color: #c82333;
        }

        .form-input {
          width: 100%;
          padding: 12px 16px;
          border: 2px solid var(--border, #3d2f1f);
          border-radius: 6px;
          font-size: 1rem;
          font-family: inherit;
          background: white;
          transition: all 0.2s;
          box-sizing: border-box;
        }

        .form-input:focus {
          outline: none;
          border-color: var(--accent, #8b7355);
          box-shadow: 0 0 0 3px rgba(139, 115, 85, 0.2);
        }

        .form-textarea {
          width: 100%;
          padding: 12px 16px;
          border: 2px solid var(--border, #3d2f1f);
          border-radius: 6px;
          font-size: 1rem;
          font-family: inherit;
          background: white;
          transition: all 0.2s;
          resize: vertical;
          min-height: 120px;
          box-sizing: border-box;
        }

        .form-textarea:focus {
          outline: none;
          border-color: var(--accent, #8b7355);
          box-shadow: 0 0 0 3px rgba(139, 115, 85, 0.2);
        }

        .form-hint {
          margin: 8px 0 0;
          font-size: 0.9rem;
          color: #5a4a3a;
          font-style: italic;
        }

        .story-length-grid,
        .setting-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 12px;
        }

        .story-length-grid {
          grid-template-columns: repeat(3, 1fr);
        }

        @media (max-width: 768px) {
          .story-length-grid {
            grid-template-columns: 1fr;
          }
        }

        .setting-card {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px;
          background: white;
          border: 2px solid var(--border, #3d2f1f);
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s;
          position: relative;
        }

        .setting-card:hover {
          border-color: var(--accent, #8b7355);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
          transform: translateY(-2px);
        }

        .setting-card.selected {
          background: linear-gradient(135deg, #fef9ed 0%, #f5ead0 100%);
          border-color: var(--accent, #8b7355);
          box-shadow: 0 0 0 3px rgba(139, 115, 85, 0.2);
        }

        .setting-icon {
          font-size: 2rem;
          flex-shrink: 0;
        }

        .setting-content {
          flex: 1;
          min-width: 0;
        }

        .setting-label {
          font-weight: 700;
          color: var(--title, #3d2f1f);
          margin-bottom: 4px;
        }

        .setting-description {
          font-size: 0.85rem;
          color: #5a4a3a;
          line-height: 1.4;
        }

        .setting-checkmark {
          position: absolute;
          top: 8px;
          right: 8px;
          width: 24px;
          height: 24px;
          background: var(--accent, #8b7355);
          color: white;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.9rem;
          font-weight: bold;
        }

        .modal-footer {
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          padding-top: 20px;
          border-top: 2px solid #e0d8c8;
        }

        .btn-secondary,
        .btn-primary {
          padding: 14px 32px;
          font-size: 1rem;
          font-weight: 700;
          letter-spacing: 1.5px;
          text-transform: uppercase;
          font-family: var(--serif);
          border-radius: 0.75rem;
          cursor: pointer;
          transition: all 0.2s ease-in-out;
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        }

        .btn-secondary {
          background: rgba(255, 255, 255, 0.5);
          border: 1px solid rgba(226, 232, 240, 1);
          color: var(--title, #3d2f1f);
        }

        .btn-secondary:hover {
          background: rgba(255, 255, 255, 0.7);
          border-color: rgba(203, 213, 225, 1);
          transform: translateY(-2px);
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
        }

        .btn-primary {
          background: rgba(255, 255, 255, 0.5);
          border: 1px solid rgba(226, 232, 240, 1);
          color: var(--title, #3d2f1f);
        }

        .btn-primary:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.7);
          border-color: rgba(203, 213, 225, 1);
          transform: translateY(-2px);
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
        }

        .btn-primary:active:not(:disabled) {
          transform: translateY(0);
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        }

        .btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
          transform: none;
        }

        .generation-progress {
          text-align: center;
          padding: 20px;
        }

        .progress-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }

        .progress-header h3 {
          margin: 0;
          font-size: 1.5rem;
          color: var(--title, #3d2f1f);
        }

        .progress-percentage {
          font-size: 1.8rem;
          font-weight: 700;
          color: var(--accent, #8b7355);
        }

        .progress-bar-container {
          width: 100%;
          height: 30px;
          background: #e0d8c8;
          border-radius: 15px;
          overflow: hidden;
          margin-bottom: 16px;
          border: 2px solid var(--border, #3d2f1f);
        }

        .progress-bar-fill {
          height: 100%;
          background: linear-gradient(90deg, var(--accent, #8b7355) 0%, #6d5840 100%);
          transition: width 0.5s ease;
          display: flex;
          align-items: center;
          justify-content: flex-end;
          padding-right: 10px;
        }

        .progress-message {
          font-size: 1.1rem;
          color: #5a4a3a;
          margin-bottom: 24px;
          font-style: italic;
        }

        .progress-info {
          background: white;
          padding: 20px;
          border-radius: 6px;
          border: 2px solid #e0d8c8;
          text-align: left;
        }

        .progress-info p {
          margin: 0 0 12px;
          font-weight: 700;
          color: var(--title, #3d2f1f);
        }

        .progress-info ul {
          margin: 0;
          padding-left: 24px;
          color: #5a4a3a;
        }

        .progress-info li {
          margin-bottom: 8px;
          line-height: 1.5;
        }

        @media (max-width: 600px) {
          .modal-header {
            padding: 20px;
          }

          .header-icon {
            width: 150px;
            height: 150px;
          }

          .modal-header h2 {
            font-size: 1.4rem;
          }

          .header-subtitle {
            font-size: 0.85rem;
          }

          .modal-content {
            padding: 24px 20px;
          }

          .setting-grid {
            grid-template-columns: 1fr;
          }

          .modal-footer {
            flex-direction: column;
          }

          .btn-secondary,
          .btn-primary {
            width: 100%;
          }
        }
      `}</style>
    </>
  );
}
